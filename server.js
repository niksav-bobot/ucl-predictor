require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ========== Google Sheets ==========
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const FOOTBALL_DATA_BASE_URL = 'https://api.football-data.org/v4';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const SEASON = process.env.FOOTBALL_SEASON || '2026';
const EVENTS_BATCH_SIZE = Number(process.env.EVENTS_BATCH_SIZE || 4);
const SYNC_INTERVAL_MS = (Number(process.env.SYNC_INTERVAL_MINUTES || 15) * 60 * 1000);
const AUTO_SYNC = String(process.env.AUTO_SYNC || '').toLowerCase() !== 'false';
const ALLOW_PLAIN_USER_ID = String(process.env.ALLOW_PLAIN_USER_ID || '').toLowerCase() !== 'false';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE_URL = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
const ODDS_SPORT_KEY = process.env.ODDS_SPORT_KEY || 'soccer_uefa_champions_league';
const ODDS_CACHE_TTL_MS = 10 * 60 * 1000;
let oddsCache = { fetchedAt: 0, events: [] };

const EXPECTED_COLUMNS = {
  Users: 16, Predictions: 11, Matches: 10, MatchEvents: 7,
  FantikiTransactions: 7, Duels: 9, DuelBets: 7, QuestsProgress: 5,
  MatchdayBonuses: 7, SeasonBadges: 6,
};

// ========== Heavy job lock ==========
let heavyJobRunning = false;

// ========== Telegram webhook ==========
const _useWebhookEnv = String(process.env.USE_WEBHOOK || '').toLowerCase();
const RENDER_HOST = process.env.RENDER_EXTERNAL_HOSTNAME || '';
const USE_WEBHOOK = !!BOT_TOKEN && (_useWebhookEnv === 'true' || (_useWebhookEnv !== 'false' && !!RENDER_HOST));
const WEBHOOK_SECRET = crypto.createHash('sha256').update(`secret:${BOT_TOKEN || 'none'}`).digest('hex').slice(0, 32);
const WEBHOOK_PATH = `/webhook/${crypto.createHash('sha256').update(`path:${BOT_TOKEN || 'none'}`).digest('hex').slice(0, 32)}`;

// ========== Кэш Sheets + retry 429 ==========
const sheetCache = new Map();
const SHEET_CACHE_TTL_MS = 45 * 1000;

async function sheetsRequestWithRetry(fn, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (error) {
      const isRateLimit = error?.code === 429 || error?.status === 429 ||
        String(error?.message || '').includes('429') ||
        String(error?.message || '').includes('Quota exceeded');
      if (!isRateLimit || attempt === maxRetries) throw error;
      const delay = Math.min(2 ** attempt * 1000 + Math.floor(Math.random() * 1000), 16000);
      console.warn(`429 Quota exceeded. Повтор через ${Math.round(delay / 1000)}с (попытка ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
function invalidateSheetCache(sheet) {
  for (const key of [...sheetCache.keys()]) if (key.startsWith(`${sheet}!`)) sheetCache.delete(key);
}
async function getSheetData(sheet, range) {
  const cacheKey = `${sheet}!${range}`;
  const cached = sheetCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const res = await sheetsRequestWithRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheet)}!${range}` })
  );
  const data = res.data.values || [];
  sheetCache.set(cacheKey, { data, expiresAt: Date.now() + SHEET_CACHE_TTL_MS });
  return data;
}
async function batchGetSheets(sheetRanges) {
  const ranges = sheetRanges.map(({ sheet, range }) => `${quoteSheetName(sheet)}!${range}`);
  const res = await sheetsRequestWithRetry(() =>
    sheets.spreadsheets.values.batchGet({ spreadsheetId: SHEET_ID, ranges })
  );
  const result = {};
  (res.data.valueRanges || []).forEach((vr, i) => {
    const { sheet, range } = sheetRanges[i];
    const key = `${sheet}!${range}`;
    const data = vr.values || [];
    sheetCache.set(key, { data, expiresAt: Date.now() + SHEET_CACHE_TTL_MS });
    result[sheet] = data;
  });
  sheetRanges.forEach(({ sheet }) => { if (!(sheet in result)) result[sheet] = []; });
  return result;
}

// ========== Вспомогательные ==========
function isNotEmpty(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
function toNum(v, f = 0) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function toScore(v) { if (v === null || v === undefined || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function quoteSheetName(n) { return `'${String(n).replace(/'/g, "''")}'`; }
function columnLetter(i) { let r = '', n = Math.max(1, Math.floor(i)); while (n > 0) { const m = (n - 1) % 26; r = String.fromCharCode(65 + m) + r; n = Math.floor((n - 1) / 26); } return r; }
function padRow(row, len) { const l = Math.max(0, Number(len) || 0); return Array.from({ length: l }, (_, i) => row?.[i] ?? ''); }
function isDataRow(row, header) { if (!Array.isArray(row) || !row.length) return false; const f = row[0]; if (!isNotEmpty(f)) return false; return header === undefined || String(f).trim() !== String(header).trim(); }
function rangeForRow(sheet, idx, cols) { return `${quoteSheetName(sheet)}!A${idx + 1}:${columnLetter(cols)}${idx + 1}`; }
function isDifferentRow(o, n, len) { for (let i = 0; i < len; i++) { if (String(o?.[i] ?? '').trim() !== String(n?.[i] ?? '').trim()) return true; } return false; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== Уровни ==========
function calculateLevel(t) {
  t = toNum(t, 0);
  if (t >= 5000) return 5;
  if (t >= 2000) return 4;
  if (t >= 1000) return 3;
  if (t >= 500)  return 2;
  if (t >= 100)  return 1;
  return 0;
}
function levelToName(l) { return ['Без уровня', 'Новичок', 'Прогнозист', 'Аналитик', 'Снайпер', 'Профи'][l] || 'Без уровня'; }
function getLevelBonus(l) { return [0, 0, 0.05, 0.10, 0.15, 0.25][l] || 0; }
function getLevelThreshold(l) { return [0, 100, 500, 1000, 2000, 5000][l] || 0; }

function getMatchdayKey(utcDate) {
  const d = new Date(utcDate);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function todayUtcKey() { return new Date().toISOString().slice(0, 10); }

// ========== Запись в Sheets ==========
async function appendRows(sheet, rows) {
  if (!rows.length) return;
  const len = EXPECTED_COLUMNS[sheet] || Math.max(...rows.map(r => r.length));
  await sheetsRequestWithRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheet)}!A:A`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      resource: { values: rows.map(r => padRow(r, len)) },
    })
  );
  invalidateSheetCache(sheet);
}
async function batchWriteRows(sheet, updates) {
  if (!updates.length) return;
  const len = EXPECTED_COLUMNS[sheet] || 26;
  for (let i = 0; i < updates.length; i += 200) {
    const chunk = updates.slice(i, i + 200).map(u => ({
      range: rangeForRow(sheet, u.rowIndex, len),
      values: [padRow(u.values, len)],
    }));
    await sheetsRequestWithRetry(() =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: chunk },
      })
    );
  }
  invalidateSheetCache(sheet);
}
async function writeRow(sheet, idx, values) { await batchWriteRows(sheet, [{ rowIndex: idx, values }]); }

const sheetIdCache = {};
async function getSheetIdByName(name) {
  if (sheetIdCache[name] !== undefined) return sheetIdCache[name];
  const res = await sheetsRequestWithRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' })
  );
  const sheet = res.data.sheets?.find(s => s.properties?.title === name);
  if (!sheet) throw new Error(`Sheet not found: ${name}`);
  sheetIdCache[name] = sheet.properties.sheetId;
  return sheetIdCache[name];
}
async function deleteRowsByRowIndices(sheet, indexes) {
  const unique = [...new Set(indexes.map(Number).filter(Number.isFinite))].sort((a, b) => b - a);
  if (!unique.length) return;
  const sheetId = await getSheetIdByName(sheet);
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    await sheetsRequestWithRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: chunk.map(idx => ({
          deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 } },
        }))},
      })
    );
  }
  invalidateSheetCache(sheet);
}

// ========== Миграция ==========
async function setupSheet(sheetName, expectedHeaders) {
  let exists = true;
  try {
    await sheetsRequestWithRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheetName)}!A1:A1`,
    }));
  } catch { exists = false; }

  if (!exists) {
    await sheetsRequestWithRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    }));
    delete sheetIdCache[sheetName];
    await sheetsRequestWithRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheetName)}!A1:${columnLetter(expectedHeaders.length)}1`,
      valueInputOption: 'RAW', requestBody: { values: [expectedHeaders] },
    }));
    invalidateSheetCache(sheetName);
    return { created: true, updated: false };
  }

  const res = await sheetsRequestWithRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheetName)}!A1:AZ1`,
  }));
  const currentHeaders = res.data.values?.[0] || [];
  const maxLen = Math.max(currentHeaders.length, expectedHeaders.length);
  const merged = [];
  for (let i = 0; i < maxLen; i++) merged.push(currentHeaders[i] ?? expectedHeaders[i] ?? '');

  const changed = merged.length !== currentHeaders.length || merged.some((h, i) => h !== (currentHeaders[i] ?? ''));
  if (!changed) return { created: false, updated: false };

  await sheetsRequestWithRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheetName)}!A1:${columnLetter(merged.length)}1`,
    valueInputOption: 'RAW', requestBody: { values: [merged] },
  }));
  invalidateSheetCache(sheetName);
  return { created: false, updated: true, headers: merged };
}

async function migrateFantiki() {
  const result = { sheetsCreated: [], columnsUpdated: [], usersInitialized: 0, predictionsInitialized: 0 };

  const newSheets = [
    { name: 'FantikiTransactions', headers: ['tx_id', 'user_id', 'amount', 'reason', 'ref_id', 'created_at', 'balance_after'] },
    { name: 'Duels', headers: ['duel_id', 'match_id', 'creator_id', 'stake', 'status', 'created_at', 'settled_at', 'pot', 'winner_ids'] },
    { name: 'DuelBets', headers: ['bet_id', 'duel_id', 'user_id', 'predicted_home', 'predicted_away', 'joined_at', 'result'] },
    { name: 'QuestsProgress', headers: ['user_id', 'quest_id', 'matchday_key', 'completed_at', 'awarded'] },
    { name: 'MatchdayBonuses', headers: ['bonus_id', 'matchday_key', 'type', 'user_id', 'place', 'amount', 'awarded_at'] },
    { name: 'SeasonBadges', headers: ['badge_id', 'user_id', 'season_label', 'badge_key', 'badge_name', 'awarded_at'] },
  ];
  for (const s of newSheets) {
    const r = await setupSheet(s.name, s.headers);
    if (r.created) result.sheetsCreated.push(s.name);
  }

  const usersHeaders = ['user_id','username','display_name','registration_date','points','total_predictions','successful','exact','difference','draws','outcomes','misses','fantiki_balance','total_earned_season','level','historical_earned'];
  const predHeaders = ['prediction_id','user_id','match_id','predicted_home','predicted_away','created_at','updated_at','points','prediction_type','fantiki_awarded','is_starred'];

  const uR = await setupSheet('Users', usersHeaders);
  if (uR.updated) result.columnsUpdated.push('Users');
  const pR = await setupSheet('Predictions', predHeaders);
  if (pR.updated) result.columnsUpdated.push('Predictions');

  const usersData = await getSheetData('Users', 'A:P');
  const userUpdates = [];
  usersData.forEach((row, idx) => {
    if (!isDataRow(row, 'user_id')) return;
    const padded = padRow(row, EXPECTED_COLUMNS.Users);
    let changed = false;
    for (const i of [12, 13, 14, 15]) if (padded[i] === '' || padded[i] == null) { padded[i] = 0; changed = true; }
    if (changed) { userUpdates.push({ rowIndex: idx, values: padded }); result.usersInitialized++; }
  });
  if (userUpdates.length) await batchWriteRows('Users', userUpdates);

  const predData = await getSheetData('Predictions', 'A:K');
  const predUpdates = [];
  predData.forEach((row, idx) => {
    if (!isDataRow(row, 'prediction_id')) return;
    const padded = padRow(row, EXPECTED_COLUMNS.Predictions);
    let changed = false;
    if (padded[9] === '' || padded[9] == null) { padded[9] = 0; changed = true; }
    if (padded[10] === '' || padded[10] == null) { padded[10] = 'FALSE'; changed = true; }
    if (changed) { predUpdates.push({ rowIndex: idx, values: padded }); result.predictionsInitialized++; }
  });
  if (predUpdates.length) await batchWriteRows('Predictions', predUpdates);

  return result;
}

// ========== Начисление фантиков ==========
async function awardFantiki(userId, amount, reason, refId = '', idempotencyKey = '') {
  const amt = toNum(amount, 0);
  if (!userId || !amt) return { success: false, error: 'Invalid params' };
  const uid = String(userId).trim();

  if (idempotencyKey) {
    const txData = await getSheetData('FantikiTransactions', 'A:G');
    const exists = txData.some(r => isDataRow(r, 'tx_id')
      && String(r[1] || '').trim() === uid
      && `${r[3]}|${r[4]}` === idempotencyKey);
    if (exists) return { success: false, error: 'Already awarded', idempotent: true };
  }

  const usersData = await getSheetData('Users', 'A:P');
  const userIndex = usersData.findIndex(r => isDataRow(r, 'user_id') && String(r[0]).trim() === uid);
  if (userIndex === -1) return { success: false, error: 'User not found' };

  const user = padRow(usersData[userIndex], EXPECTED_COLUMNS.Users);
  const oldBalance = toNum(user[12], 0);
  const oldTotalEarned = toNum(user[13], 0);
  const newBalance = Math.max(0, oldBalance + amt);
  const newTotalEarned = amt > 0 ? oldTotalEarned + amt : oldTotalEarned;
  user[12] = newBalance;
  user[13] = newTotalEarned;
  user[14] = calculateLevel(newTotalEarned);
  await writeRow('Users', userIndex, user);

  const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await appendRows('FantikiTransactions', [[txId, uid, amt, String(reason || ''), String(refId || ''), new Date().toISOString(), newBalance]]);

  return { success: true, txId, newBalance, newTotalEarned: newTotalEarned, level: user[14], levelName: levelToName(user[14]) };
}

async function getBalance(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  const usersData = await getSheetData('Users', 'A:P');
  const row = usersData.find(r => isDataRow(r, 'user_id') && String(r[0]).trim() === uid);
  if (!row) return null;
  const p = padRow(row, EXPECTED_COLUMNS.Users);
  const total = toNum(p[13], 0);
  const level = toNum(p[14], 0) || calculateLevel(total);
  return {
    userId: uid, balance: toNum(p[12], 0), totalEarnedSeason: total,
    level, levelName: levelToName(level), levelBonus: getLevelBonus(level),
    nextLevelAt: level < 5 ? getLevelThreshold(level + 1) : null,
    historicalEarned: toNum(p[15], 0),
  };
}

// ========== Прогнозы: логика ==========
function getLatestPredictionMap(data) {
  const latest = new Map();
  data.forEach((row, idx) => {
    if (!isDataRow(row, 'prediction_id')) return;
    const userId = String(row[1] || '').trim(), matchId = String(row[2] || '').trim();
    if (!userId || !matchId) return;
    const key = `${userId}|${matchId}`;
    const ts = Date.parse(row[6] || '') || Date.parse(row[5] || '') || 0;
    const cur = latest.get(key);
    if (!cur || ts > cur.ts || (ts === cur.ts && idx > cur.idx)) latest.set(key, { idx, ts, userId, matchId });
  });
  return latest;
}
function getLatestPredictionsForUser(data, userId) {
  const map = getLatestPredictionMap(data);
  const uid = String(userId || '').trim();
  const rows = [];
  for (const item of map.values()) {
    const row = data[item.idx];
    if (row && String(row[1] || '').trim() === uid) rows.push(row);
  }
  return rows;
}
function filterPredictionResponseByType(list, type) {
  const t = String(type || '').toLowerCase().trim();
  if (!t || t === 'all') return list;
  return list.filter(item => {
    if (t === 'exact') return item.prediction_type === 'exact';
    if (t === 'difference') return item.prediction_type === 'difference';
    if (t === 'draw') return item.prediction_type === 'draw';
    if (t === 'outcome') return item.prediction_type === 'outcome';
    if (t === 'miss') return item.prediction_type === 'miss' || (item.status === 'finished' && item.points === 0);
    if (t === 'successful' || t === 'points') return item.points > 0;
    if (t === 'finished') return item.status === 'finished';
    if (t === 'scheduled') return item.status === 'scheduled';
    if (t === 'live') return item.status === 'live';
    return true;
  });
}
function sortPredictionsResponse(list, sortMode) {
  const byDateAsc = (a, b) => (new Date(a.kickoff_utc).getTime() || Infinity) - (new Date(b.kickoff_utc).getTime() || Infinity);
  const s = String(sortMode || '').toLowerCase().trim();
  if (s === 'exact_first') return [...list].sort((a, b) => (b.prediction_type === 'exact' ? 1 : 0) - (a.prediction_type === 'exact' ? 1 : 0) || byDateAsc(a, b));
  if (s === 'points_desc') return [...list].sort((a, b) => b.points - a.points || byDateAsc(a, b));
  if (s === 'date_desc') return [...list].sort((a, b) => (new Date(b.kickoff_utc).getTime() || -Infinity) - (new Date(a.kickoff_utc).getTime() || -Infinity));
  return [...list].sort(byDateAsc);
}

// ========== Авторизация ==========
function getAdminIds() { return String(process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean); }
function verifyTelegramInitData(str) {
  try {
    if (!BOT_TOKEN || !str) return false;
    const p = new URLSearchParams(str);
    const hash = p.get('hash');
    if (!hash) return false;
    p.delete('hash');
    const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    const cb = Buffer.from(calc, 'hex'), hb = Buffer.from(hash, 'hex');
    if (!cb.length || hb.length !== cb.length) return false;
    if (!crypto.timingSafeEqual(cb, hb)) return false;
    const authDate = Number(p.get('auth_date') || 0);
    if (authDate && Date.now() / 1000 - authDate > 86400) return false;
    return true;
  } catch { return false; }
}
function extractAuthenticatedUser(req) {
  const initData = req.body?.initData || req.query?.initData;
  if (initData) {
    if (BOT_TOKEN && !verifyTelegramInitData(initData)) return null;
    try {
      const p = new URLSearchParams(initData);
      const user = JSON.parse(p.get('user') || 'null');
      if (user?.id) return { ...user, id: String(user.id).trim() };
    } catch { return null; }
  }
  if (ALLOW_PLAIN_USER_ID) {
    const uid = req.body?.userId || req.query?.userId;
    if (isNotEmpty(uid)) return { id: String(uid).trim(), username: req.body?.username || '', first_name: req.body?.firstName || '', last_name: req.body?.lastName || '' };
  }
  return null;
}
function extractUserId(req) { return extractAuthenticatedUser(req)?.id ?? null; }
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-api-key'] || req.body?.apiKey;
  if (ADMIN_API_KEY && key === ADMIN_API_KEY) return next();
  const user = extractAuthenticatedUser(req);
  if (user?.id && getAdminIds().includes(String(user.id).trim())) return next();
  return res.status(403).json({ error: 'Forbidden' });
}
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ========== Команды и переводы ==========
const teamTranslations = { 'Real Madrid CF': 'Реал Мадрид', 'FC Barcelona': 'Барселона', 'Manchester City FC': 'Манчестер Сити', 'Liverpool FC': 'Ливерпуль', 'FC Bayern München': 'Бавария', 'Paris Saint-Germain FC': 'ПСЖ', 'Juventus FC': 'Ювентус', 'AC Milan': 'Милан', 'Chelsea FC': 'Челси', 'Arsenal FC': 'Арсенал', 'Borussia Dortmund': 'Боруссия Дортмунд', 'Club Atlético de Madrid': 'Атлетико Мадрид', 'FC Internazionale Milano': 'Интер', 'SSC Napoli': 'Наполи', 'FC Porto': 'Порту', 'SL Benfica': 'Бенфика', 'AFC Ajax': 'Аякс', 'Olympique Lyonnais': 'Лион', 'AS Monaco FC': 'Монако', 'FC Red Bull Salzburg': 'Зальцбург', 'FK Shakhtar Donetsk': 'Шахтер', 'GNK Dinamo Zagreb': 'Динамо Загреб', 'Celtic FC': 'Селтик', 'Rangers FC': 'Рейнджерс', 'Club Brugge KV': 'Брюгге', 'Galatasaray SK': 'Галатасарай', 'Fenerbahçe SK': 'Фенербахче', 'Olympiacos FC': 'Олимпиакос', 'AEK Athens FC': 'АЕК', 'Maccabi Haifa FC': 'Маккаби Хайфа', 'FC København': 'Копенгаген', 'BSC Young Boys': 'Янг Бойз', 'FK Crvena Zvezda': 'Црвена Звезда', 'Racing Club de Lens': 'Ланс', 'Real Sociedad de Fútbol': 'Реал Сосьедад', 'PSV': 'ПСВ', 'Feyenoord Rotterdam': 'Фейеноорд', 'Sporting CP': 'Спортинг', 'Sporting Clube de Portugal': 'Спортинг', 'FC Viktoria Plzeň': 'Виктория Пльзень', 'Stade Brestois 29': 'Брест', 'VfB Stuttgart': 'Штутгарт', 'Aston Villa FC': 'Астон Вилла', 'Bologna FC 1909': 'Болонья', 'Girona FC': 'Жирона', 'RC Celta de Vigo': 'Сельта', 'Real Betis Balompié': 'Бетис', 'Sevilla FC': 'Севилья', 'Valencia CF': 'Валенсия', 'Lazio Roma': 'Лацио', 'Atalanta BC': 'Аталанта', 'AS Roma': 'Рома', 'Olympique de Marseille': 'Марсель', 'Lille OSC': 'Лилль', 'OGC Nice': 'Ницца', 'Stade Rennais FC': 'Ренн', 'RC Strasbourg Alsace': 'Страсбур', 'FC Nantes': 'Нант', 'SC Braga': 'Брага', 'RSC Anderlecht': 'Андерлехт', 'KRC Genk': 'Генк', 'Ferencvárosi TC': 'Ференцварош', 'Ludogorets Razgrad': 'Лудогорец', 'Qarabağ FK': 'Карабах', 'Sparta Praha': 'Спарта Прага', 'Slavia Praha': 'Славия Прага', 'SK Slavia Praha': 'Славия Прага', 'FC Basel 1893': 'Базель', 'Grasshopper Club Zürich': 'Грассхоппер', 'Manchester United FC': 'Манчестер Юнайтед', 'Villarreal CF': 'Вильярреал', 'PAE AEK': 'АЕК', 'LASK Linz': 'ЛАСК', 'Viking FK': 'Викинг', 'ŠK Slovan Bratislava': 'Слован Братислава', 'FK Bodø/Glimt': 'Будё-Глимт', 'Como 1907': 'Комо', 'RB Leipzig': 'РБ Лейпциг', 'Sabah FK': 'Сабах' };
const teamSynonyms = { 'мс':'Манчестер Сити','ман сити':'Манчестер Сити','мю':'Манчестер Юнайтед','ман юнайтед':'Манчестер Юнайтед','реал':'Реал Мадрид','реал мадрид':'Реал Мадрид','барса':'Барселона','барселона':'Барселона','бавария':'Бавария','дортмунд':'Боруссия Дортмунд','атлетико':'Атлетико Мадрид','интер':'Интер','наполи':'Наполи','псж':'ПСЖ','ливерпуль':'Ливерпуль','челси':'Челси','арсенал':'Арсенал','ювентус':'Ювентус','милан':'Милан','аякс':'Аякс','порту':'Порту','бенфика':'Бенфика','лион':'Лион','монако':'Монако','зальцбург':'Зальцбург','шахтер':'Шахтер','селтик':'Селтик','брюгге':'Брюгге','галатасарай':'Галатасарай','фенербахче':'Фенербахче','олимпиакос':'Олимпиакос','аек':'АЕК','копенгаген':'Копенгаген','янг бойз':'Янг Бойз','црвена звезда':'Црвена Звезда','ланс':'Ланс','реал сосьедад':'Реал Сосьедад','псв':'ПСВ','фейеноорд':'Фейеноорд','спортинг':'Спортинг','штутгарт':'Штутгарт','астон вилла':'Астон Вилла','болонья':'Болонья','жирона':'Жирона','сельта':'Сельта','бетис':'Бетис','севилья':'Севилья','валенсия':'Валенсия','лацио':'Лацио','аталанта':'Аталанта','рома':'Рома','марсель':'Марсель','лилль':'Лилль','ницца':'Ницца','ренн':'Ренн','нант':'Нант','брага':'Брага','андерлехт':'Андерлехт','генк':'Генк','ференцварош':'Ференцварош','лудогорец':'Лудогорец','карабах':'Карабах','базель':'Базель','вильярреал':'Вильярреал','ласк':'ЛАСК','викинг':'Викинг','слован братислава':'Слован Братислава','будё-глимт':'Будё-Глимт','комо':'Комо','рб лейпциг':'РБ Лейпциг','сабах':'Сабах' };
const teamAliases = new Map();
Object.entries(teamTranslations).forEach(([api, ru]) => { teamAliases.set(api.toLowerCase().trim(), ru); teamAliases.set(ru.toLowerCase().trim(), ru); });
Object.entries(teamSynonyms).forEach(([alias, ru]) => teamAliases.set(alias.toLowerCase().trim(), ru));
function translateTeam(name) { return name ? (teamTranslations[name] || name) : ''; }
function normalizeTeamName(name) {
  const lower = String(name || '').toLowerCase().trim();
  if (teamAliases.has(lower)) return teamAliases.get(lower);
  const cleaned = lower.replace(/[«»"'()]/g, '').replace(/\s+/g, ' ').trim();
  return teamAliases.has(cleaned) ? teamAliases.get(cleaned) : String(name || '').trim();
}

// ========== Odds helpers ==========
const ruToApiTeam = new Map(), apiTeamLowerMap = new Map();
Object.entries(teamTranslations).forEach(([api, ru]) => { ruToApiTeam.set(ru.toLowerCase().trim(), api); apiTeamLowerMap.set(api.toLowerCase().trim(), api); });
const oddsTeamAliases = { 'bayern munich': 'FC Bayern München', 'psg': 'Paris Saint-Germain FC', 'man city': 'Manchester City FC', 'man united': 'Manchester United FC', 'inter': 'FC Internazionale Milano', 'juventus': 'Juventus FC', 'milan': 'AC Milan', 'dortmund': 'Borussia Dortmund', 'atletico': 'Club Atlético de Madrid', 'napoli': 'SSC Napoli', 'porto': 'FC Porto', 'benfica': 'SL Benfica', 'ajax': 'AFC Ajax', 'lyon': 'Olympique Lyonnais', 'monaco': 'AS Monaco FC', 'salzburg': 'FC Red Bull Salzburg', 'shakhtar': 'FK Shakhtar Donetsk', 'celtic': 'Celtic FC', 'rangers': 'Rangers FC', 'galatasaray': 'Galatasaray SK', 'fenerbahce': 'Fenerbahçe SK', 'olympiacos': 'Olympiacos FC', 'copenhagen': 'FC København', 'young boys': 'BSC Young Boys', 'crvena zvezda': 'FK Crvena Zvezda', 'lens': 'Racing Club de Lens', 'real sociedad': 'Real Sociedad de Fútbol', 'psv': 'PSV', 'feyenoord': 'Feyenoord Rotterdam', 'sporting lisbon': 'Sporting CP', 'stuttgart': 'VfB Stuttgart', 'aston villa': 'Aston Villa FC', 'bologna': 'Bologna FC 1909', 'girona': 'Girona FC', 'celta': 'RC Celta de Vigo', 'betis': 'Real Betis Balompié', 'sevilla': 'Sevilla FC', 'valencia': 'Valencia CF', 'lazio': 'Lazio Roma', 'atalanta': 'Atalanta BC', 'roma': 'AS Roma', 'marseille': 'Olympique de Marseille', 'lille': 'Lille OSC', 'nice': 'OGC Nice', 'rennes': 'Stade Rennais FC', 'nantes': 'FC Nantes', 'braga': 'SC Braga', 'anderlecht': 'RSC Anderlecht', 'genk': 'KRC Genk', 'villarreal': 'Villarreal CF', 'lask': 'LASK Linz', 'viking': 'Viking FK', 'leipzig': 'RB Leipzig', 'real madrid': 'Real Madrid CF', 'barcelona': 'FC Barcelona', 'liverpool': 'Liverpool FC', 'chelsea': 'Chelsea FC', 'arsenal': 'Arsenal FC' };
function storedTeamToApiTeam(s) { const l = String(s || '').toLowerCase().trim(); if (!l) return ''; return ruToApiTeam.get(l) || apiTeamLowerMap.get(l) || String(s || '').trim(); }
function findOurApiTeamName(t) { const raw = String(t || '').toLowerCase().trim(); if (!raw) return null; if (oddsTeamAliases[raw]) return oddsTeamAliases[raw]; const exact = apiTeamLowerMap.get(raw); if (exact) return exact; for (const [l, n] of apiTeamLowerMap) if (l.includes(raw) || raw.includes(l)) return n; return null; }
async function fetchOddsEvents() {
  if (!ODDS_API_KEY) return [];
  const now = Date.now();
  if (now - oddsCache.fetchedAt < ODDS_CACHE_TTL_MS) return oddsCache.events;
  for (const sportKey of [...new Set([ODDS_SPORT_KEY, 'upcoming'].filter(Boolean))]) {
    try {
      const url = `${ODDS_API_BASE_URL}/sports/${encodeURIComponent(sportKey)}/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();
      if (Array.isArray(data) && data.length > 0) { oddsCache = { fetchedAt: now, events: data }; return data; }
    } catch (e) { console.error('Ошибка загрузки коэффициентов:', e.message); }
  }
  oddsCache = { fetchedAt: now, events: [] };
  return [];
}
function getOddsFromEvent(event) {
  const rows = [];
  (event.bookmakers || []).forEach(b => {
    const market = (b.markets || []).find(m => String(m.key || '').toLowerCase() === 'h2h');
    if (!market) return;
    const o = market.outcomes || [];
    const home = o.find(x => x.name === event.home_team);
    const away = o.find(x => x.name === event.away_team);
    const draw = o.find(x => String(x.name || '').toLowerCase() === 'draw');
    if (home?.price && away?.price && draw?.price) rows.push({ home: Number(home.price), draw: Number(draw.price), away: Number(away.price) });
  });
  if (!rows.length) return null;
  const avg = k => { const v = rows.map(r => r[k]).filter(Number.isFinite); if (!v.length) return null; return Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 100) / 100; };
  const home = avg('home'), draw = avg('draw'), away = avg('away');
  if (home === null || draw === null || away === null) return null;
  return { home, draw, away, bookmakers: rows.length };
}

// ========== Football Data ==========
function mapStage(s) { const m = { PRELIMINARY: 'Предварительный раунд', FIRST_QUALIFYING_ROUND: '1-й квал. раунд', SECOND_QUALIFYING_ROUND: '2-й квал. раунд', THIRD_QUALIFYING_ROUND: '3-й квал. раунд', PLAY_OFF_ROUND: 'Раунд плей-офф', GROUP_STAGE: 'Групповой этап', ROUND_OF_16: '1/8 финала', QUARTER_FINALS: '1/4 финала', SEMI_FINALS: 'Полуфинал', FINAL: 'Финал' }; return m[s] || s; }
function mapStatus(s) { if (s === 'SCHEDULED' || s === 'TIMED') return 'scheduled'; if (s === 'LIVE' || s === 'IN_PLAY' || s === 'PAUSED') return 'live'; if (s === 'FINISHED') return 'finished'; if (s === 'POSTPONED') return 'postponed'; if (s === 'SUSPENDED' || s === 'CANCELLED') return s.toLowerCase(); return String(s || '').toLowerCase(); }
async function fetchFootball(path) {
  if (!FOOTBALL_DATA_API_KEY) throw new Error('FOOTBALL_DATA_API_KEY не задан');
  const res = await fetch(`${FOOTBALL_DATA_BASE_URL}${path}`, { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY } });
  if (!res.ok) { const text = await res.text(); const e = new Error(`Football-Data.org API error: ${res.status} ${text}`); e.status = res.status; throw e; }
  return res.json();
}
function calculatePoints(ph, pa, ah, aa) {
  ph = toScore(ph); pa = toScore(pa); ah = toScore(ah); aa = toScore(aa);
  if (ph === null || pa === null || ah === null || aa === null) return { points: 0, type: 'miss' };
  if (ph === ah && pa === aa) return { points: 5, type: 'exact' };
  if (ph === pa && ah === aa) return { points: 3, type: 'draw' };
  if (ph - pa === ah - aa) return { points: 3, type: 'difference' };
  if ((ph > pa && ah > aa) || (ph < pa && ah < aa)) return { points: 1, type: 'outcome' };
  return { points: 0, type: 'miss' };
}
function emptyUserDelta() { return { points: 0, successful: 0, exact: 0, difference: 0, draws: 0, outcomes: 0, misses: 0 }; }
function addResultToDelta(d, r, sign) {
  if (!d || !r) return;
  const pts = toNum(r.points, 0);
  d.points += sign * pts;
  if (pts > 0) d.successful += sign;
  if (r.type === 'exact') d.exact += sign;
  if (r.type === 'difference') d.difference += sign;
  if (r.type === 'draw') d.draws += sign;
  if (r.type === 'outcome') d.outcomes += sign;
  if (r.type === 'miss') d.misses += sign;
}

// ========== Фантики за прогноз ==========
function calculatePredictionFantiki(type, totalGoals, userLevel) {
  let base = 0;
  if (type === 'outcome') base = 10;
  else if (type === 'difference') base = 20;
  else if (type === 'exact') { base = 50; if (totalGoals >= 8) base += 50; else if (totalGoals >= 6) base += 25; }
  if (base === 0) return 0;
  return Math.round(base * (1 + getLevelBonus(userLevel)));
}

// ========== Пересчёт по матчу ==========
async function recalculatePointsForMatch(matchId, homeScore, awayScore) {
  const ah = toScore(homeScore), aa = toScore(awayScore);
  if (ah === null || aa === null) return { predictionsUpdated: 0, fantikiAwarded: 0 };
  const matchIdStr = String(matchId).trim(), totalGoals = ah + aa;

  const { Predictions: predictionsData, Users: usersData, Matches: matchesData } = await batchGetSheets([
    { sheet: 'Predictions', range: 'A:K' },
    { sheet: 'Users', range: 'A:P' },
    { sheet: 'Matches', range: 'A:J' },
  ]);

  const matchRow = matchesData.find(r => isDataRow(r, 'match_id') && String(r[0]).trim() === matchIdStr);
  const matchdayKey = matchRow ? getMatchdayKey(matchRow[4]) : null;

  const latestMap = getLatestPredictionMap(predictionsData);
  const predictionUpdates = [], userDeltas = new Map(), fantikiDeltas = new Map();

  predictionsData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'prediction_id')) return;
    const pMatchId = String(row[2] || '').trim();
    if (pMatchId !== matchIdStr) return;
    const userId = String(row[1] || '').trim();
    if (!userId) return;
    const key = `${userId}|${pMatchId}`;
    const latest = latestMap.get(key);
    if (!latest) return;
    const oldPoints = toNum(row[7], 0), oldType = String(row[8] || '').trim(), oldFantiki = toNum(row[9], 0);
    const ensureDelta = () => { if (!userDeltas.has(userId)) userDeltas.set(userId, emptyUserDelta()); return userDeltas.get(userId); };
    const ensureFantiki = () => { if (!fantikiDeltas.has(userId)) fantikiDeltas.set(userId, 0); return fantikiDeltas; };

    if (rowIndex !== latest.idx) {
      if (oldPoints !== 0 || oldType !== 'duplicate' || oldFantiki !== 0) {
        const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
        upd[7] = 0; upd[8] = 'duplicate'; upd[9] = 0;
        predictionUpdates.push({ rowIndex, values: upd });
        addResultToDelta(ensureDelta(), { points: oldPoints, type: oldType }, -1);
        if (oldFantiki !== 0) ensureFantiki().set(userId, fantikiDeltas.get(userId) - oldFantiki);
      }
      return;
    }

    const newResult = calculatePoints(row[3], row[4], ah, aa);
    const userRow = usersData.find(r => isDataRow(r, 'user_id') && String(r[0]).trim() === userId);
    const userLevel = userRow ? toNum(padRow(userRow, EXPECTED_COLUMNS.Users)[14], 0) : 0;
    const newFantiki = calculatePredictionFantiki(newResult.type, totalGoals, userLevel);

    const pointsChanged = oldPoints !== newResult.points || oldType !== newResult.type;
    const fantikiChanged = oldFantiki !== newFantiki;

    if (pointsChanged || fantikiChanged) {
      const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
      if (pointsChanged) { upd[6] = new Date().toISOString(); upd[7] = newResult.points; upd[8] = newResult.type; }
      if (fantikiChanged) upd[9] = newFantiki;
      predictionUpdates.push({ rowIndex, values: upd });
    }
    if (pointsChanged) {
      const d = ensureDelta();
      addResultToDelta(d, { points: oldPoints, type: oldType }, -1);
      addResultToDelta(d, newResult, 1);
    }
    if (fantikiChanged) {
      const f = ensureFantiki();
      f.set(userId, (f.get(userId) || 0) + (newFantiki - oldFantiki));
    }
  });

  await batchWriteRows('Predictions', predictionUpdates);

  if (userDeltas.size > 0) {
    const userUpdates = [];
    for (const [userId, delta] of userDeltas.entries()) {
      const rowIndex = usersData.findIndex(r => isDataRow(r, 'user_id') && String(r[0]).trim() === userId);
      if (rowIndex === -1) continue;
      const user = padRow(usersData[rowIndex], EXPECTED_COLUMNS.Users);
      user[4] = Math.max(0, toNum(user[4], 0) + delta.points);
      user[6] = Math.max(0, toNum(user[6], 0) + delta.successful);
      user[7] = Math.max(0, toNum(user[7], 0) + delta.exact);
      user[8] = Math.max(0, toNum(user[8], 0) + delta.difference);
      user[9] = Math.max(0, toNum(user[9], 0) + delta.draws);
      user[10] = Math.max(0, toNum(user[10], 0) + delta.outcomes);
      user[11] = Math.max(0, toNum(user[11], 0) + delta.misses);
      userUpdates.push({ rowIndex, values: user });
    }
    await batchWriteRows('Users', userUpdates);
  }

  let totalAwarded = 0;
  for (const [userId, amount] of fantikiDeltas.entries()) {
    if (amount === 0) continue;
    await awardFantiki(userId, amount, amount > 0 ? 'prediction_award' : 'prediction_correction', matchIdStr, '');
    totalAwarded += amount;
  }

  if (matchdayKey) await checkMatchdayStreakBonus(matchdayKey).catch(console.error);

  return { predictionsUpdated: predictionUpdates.length, fantikiAwarded: totalAwarded };
}

// ========== Streak ==========
async function checkMatchdayStreakBonus(matchdayKey) {
  const matchesData = await getSheetData('Matches', 'A:J');
  const dayMatches = matchesData.filter(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === matchdayKey);
  if (!dayMatches.length) return null;
  const allDone = dayMatches.every(r => {
    const st = String(r[5] || '').trim();
    return st === 'finished' || st === 'postponed' || st === 'cancelled';
  });
  if (!allDone) return null;

  const bonusesData = await getSheetData('MatchdayBonuses', 'A:G');
  if (bonusesData.some(r => isDataRow(r, 'bonus_id')
    && String(r[1] || '').trim() === matchdayKey
    && String(r[2] || '').trim() === 'streak')) return null;

  const { Predictions: predictionsData } = await batchGetSheets([{ sheet: 'Predictions', range: 'A:K' }]);
  const dayMatchIds = new Set(dayMatches.map(r => String(r[0]).trim()));
  const latestMap = getLatestPredictionMap(predictionsData);
  const exactCountByUser = new Map();
  for (const item of latestMap.values()) {
    const row = predictionsData[item.idx];
    if (!row) continue;
    if (!dayMatchIds.has(String(row[2] || '').trim())) continue;
    if (String(row[8] || '').trim() !== 'exact') continue;
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    exactCountByUser.set(uid, (exactCountByUser.get(uid) || 0) + 1);
  }

  let totalBonus = 0, awardedCount = 0;
  for (const [uid, cnt] of exactCountByUser) {
    let bonus = 0;
    if (cnt >= 5) bonus = 300;
    else if (cnt === 4) bonus = 150;
    else if (cnt === 3) bonus = 75;
    else if (cnt === 2) bonus = 25;
    if (bonus > 0) {
      const r = await awardFantiki(uid, bonus, 'daily_streak_bonus', matchdayKey, `daily_streak|${matchdayKey}|${uid}`);
      if (r.success) { totalBonus += bonus; awardedCount++; }
    }
  }

  await appendRows('MatchdayBonuses', [[`bonus_streak_${matchdayKey}`, matchdayKey, 'streak', '', '', totalBonus, new Date().toISOString()]]);
  return { matchdayKey, awardedCount, totalBonus };
}

// ========== Призовые за тур ==========
async function checkRoundPrizes(matchdayKey) {
  const matchesData = await getSheetData('Matches', 'A:J');
  const dayMatches = matchesData.filter(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === matchdayKey);
  if (!dayMatches.length) return null;
  const allDone = dayMatches.every(r => {
    const st = String(r[5] || '').trim();
    return st === 'finished' || st === 'postponed' || st === 'cancelled';
  });
  if (!allDone) return null;

  const bonusesData = await getSheetData('MatchdayBonuses', 'A:G');
  if (bonusesData.some(r => isDataRow(r, 'bonus_id')
    && String(r[1] || '').trim() === matchdayKey
    && String(r[2] || '').trim() === 'round_prize')) return null;

  const { Predictions: predictionsData } = await batchGetSheets([{ sheet: 'Predictions', range: 'A:K' }]);
  const dayMatchIds = new Set(dayMatches.map(r => String(r[0]).trim()));
  const matchById = new Map();
  dayMatches.forEach(r => matchById.set(String(r[0]).trim(), r));

  const latestMap = getLatestPredictionMap(predictionsData);
  const pointsByUser = new Map();
  for (const item of latestMap.values()) {
    const row = predictionsData[item.idx];
    if (!row) continue;
    const matchId = String(row[2] || '').trim();
    if (!dayMatchIds.has(matchId)) continue;
    if (String(row[8] || '').trim() === 'duplicate') continue;
    const match = matchById.get(matchId);
    if (!match) continue;
    const hs = toScore(match[6]), as = toScore(match[7]);
    if (hs === null || as === null) continue;
    const result = calculatePoints(row[3], row[4], hs, as);
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    pointsByUser.set(uid, (pointsByUser.get(uid) || 0) + result.points);
  }

  // Сортировка по очкам, топ-3 позиции (с равенством: все, кто на позиции, получают приз)
  const sorted = [...pointsByUser.entries()].sort((a, b) => b[1] - a[1]);
  const prizes = new Map(); // uid -> { place, amount }
  let position = 1, i = 0;
  const placeRewards = { 1: 100, 2: 60, 3: 30 };
  while (i < sorted.length && position <= 3) {
    const points = sorted[i][1];
    const group = [];
    while (i < sorted.length && sorted[i][1] === points) { group.push(sorted[i][0]); i++; }
    const amount = placeRewards[position] || 0;
    if (amount > 0) for (const uid of group) prizes.set(uid, { place: position, amount });
    position += group.length;
  }

  let totalAwarded = 0, awardedCount = 0;
  const winnerIds = [], bonusRows = [];
  for (const [uid, { place, amount }] of prizes) {
    const r = await awardFantiki(uid, amount, 'round_prize', matchdayKey, `round_prize|${matchdayKey}|${uid}`);
    if (r.success) {
      totalAwarded += amount;
      awardedCount++;
      winnerIds.push(uid);
      bonusRows.push([`bonus_prize_${matchdayKey}_${uid}`, matchdayKey, 'round_prize', uid, place, amount, new Date().toISOString()]);
    }
  }

  if (bonusRows.length) await appendRows('MatchdayBonuses', bonusRows);
  // Маркер
  await appendRows('MatchdayBonuses', [[`bonus_prize_marker_${matchdayKey}`, matchdayKey, 'round_prize', '', '', totalAwarded, new Date().toISOString()]]);

  return { matchdayKey, awardedCount, totalAwarded, winnerIds };
}

async function checkRecentMatchdays() {
  const matchesData = await getSheetData('Matches', 'A:J');
  const daySet = new Set(), now = Date.now();
  matchesData.forEach(r => {
    if (!isDataRow(r, 'match_id')) return;
    const d = new Date(r[4] || '');
    if (!Number.isFinite(d.getTime())) return;
    const diff = now - d.getTime();
    if (diff > 0 && diff < 7 * 24 * 60 * 60 * 1000) {
      const k = getMatchdayKey(r[4]);
      if (k) daySet.add(k);
    }
  });
  const results = [];
  for (const key of daySet) {
    try {
      const s = await checkMatchdayStreakBonus(key);
      const p = await checkRoundPrizes(key);
      results.push({ key, streak: s, prize: p });
    } catch (e) { console.error(`Matchday check failed for ${key}:`, e.message); }
  }
  return results;
}

// ========== Квесты ==========
async function checkQuestsProgress(userId, matchdayKey) {
  if (!matchdayKey || !userId) return;
  const { Matches: matchesData, Predictions: predictionsData, QuestsProgress: questsData } = await batchGetSheets([
    { sheet: 'Matches', range: 'A:J' },
    { sheet: 'Predictions', range: 'A:K' },
    { sheet: 'QuestsProgress', range: 'A:E' },
  ]);
  const dayMatches = matchesData.filter(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === matchdayKey && String(r[5] || '').trim() === 'scheduled');
  const dayMatchIds = new Set(dayMatches.map(r => String(r[0]).trim()));
  if (!dayMatchIds.size) return;

  const latestMap = getLatestPredictionMap(predictionsData);
  const userPreds = [...latestMap.values()]
    .map(it => predictionsData[it.idx])
    .filter(r => r && String(r[1] || '').trim() === userId && dayMatchIds.has(String(r[2] || '').trim()));

  const hasQuest = qid => questsData.some(r => isDataRow(r, 'user_id')
    && String(r[0] || '').trim() === userId
    && String(r[1] || '').trim() === qid
    && String(r[2] || '').trim() === matchdayKey);

  const tryAward = async (qid, amount) => {
    if (hasQuest(qid)) return;
    await awardFantiki(userId, amount, `quest_${qid}`, matchdayKey, `quest|${qid}|${matchdayKey}|${userId}`);
    await appendRows('QuestsProgress', [[userId, qid, matchdayKey, new Date().toISOString(), amount]]);
  };

  if (userPreds.length >= 5) await tryAward('predict_5', 30);
  if (dayMatches.length > 0 && userPreds.length >= dayMatches.length) await tryAward('predict_all', 50);
  if (userPreds.some(r => String(r[8] || '').trim() === 'exact')) await tryAward('first_exact', 20);
  const outcomesCount = userPreds.filter(r => ['outcome', 'difference', 'exact', 'draw'].includes(String(r[8] || '').trim())).length;
  if (outcomesCount >= 3) await tryAward('three_outcomes', 15);
}

// ========== Сезонные бейджи ==========
async function calculateSeasonTitles() {
  const { Users: usersData, Predictions: predictionsData, Matches: matchesData } = await batchGetSheets([
    { sheet: 'Users', range: 'A:P' },
    { sheet: 'Predictions', range: 'A:K' },
    { sheet: 'Matches', range: 'A:J' },
  ]);

  const matchById = new Map();
  matchesData.forEach(r => { if (isDataRow(r, 'match_id')) matchById.set(String(r[0]).trim(), r); });

  const latestMap = getLatestPredictionMap(predictionsData);
  const stats = new Map(); // uid -> { totalFinished, exact, successful, riskyExact, dayExacts }

  for (const item of latestMap.values()) {
    const row = predictionsData[item.idx];
    if (!row) continue;
    if (String(row[8] || '').trim() === 'duplicate') continue;
    const match = matchById.get(String(row[2] || '').trim());
    if (!match || String(match[5] || '').trim() !== 'finished') continue;
    const hs = toScore(match[6]), as = toScore(match[7]);
    if (hs === null || as === null) continue;
    const result = calculatePoints(row[3], row[4], hs, as);
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    if (!stats.has(uid)) stats.set(uid, { totalFinished: 0, exact: 0, successful: 0, riskyExact: 0, dayExacts: new Map() });
    const s = stats.get(uid);
    s.totalFinished++;
    if (result.points > 0) s.successful++;
    if (result.type === 'exact') {
      s.exact++;
      const totalGoals = hs + as;
      if (totalGoals >= 6) s.riskyExact++;
      const day = getMatchdayKey(match[4]);
      if (day) s.dayExacts.set(day, (s.dayExacts.get(day) || 0) + 1);
    }
  }

  const titles = { sniper: null, stable: null, risky: null, wild_round: [] };
  let bestSniper = { uid: null, ratio: -1 }, bestStable = { uid: null, ratio: -1 }, bestRisky = { uid: null, cnt: -1 };

  for (const [uid, s] of stats) {
    if (s.totalFinished < 10) continue; // минимум 10 завершённых прогнозов
    const sniperRatio = s.exact / s.totalFinished;
    const stableRatio = s.successful / s.totalFinished;
    if (sniperRatio > bestSniper.ratio) bestSniper = { uid, ratio: sniperRatio, exact: s.exact, total: s.totalFinished };
    if (stableRatio > bestStable.ratio) bestStable = { uid, ratio: stableRatio, successful: s.successful, total: s.totalFinished };
    if (s.riskyExact > bestRisky.cnt) bestRisky = { uid, cnt: s.riskyExact };
    for (const [day, cnt] of s.dayExacts) {
      if (cnt >= 3) titles.wild_round.push({ uid, day, count: cnt });
    }
  }

  if (bestSniper.uid) titles.sniper = { userId: bestSniper.uid, ratio: bestSniper.ratio, exact: bestSniper.exact, total: bestSniper.total };
  if (bestStable.uid) titles.stable = { userId: bestStable.uid, ratio: bestStable.ratio, successful: bestStable.successful, total: bestStable.total };
  if (bestRisky.uid) titles.risky = { userId: bestRisky.uid, count: bestRisky.cnt };

  return titles;
}

function titleName(key) {
  return { sniper: 'Точный снайпер', stable: 'Стабильный', risky: 'Рисковый', wild_round: 'Лютый тур' }[key] || key;
}

async function getSeasonTitlesForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;

  const [current, saved] = await Promise.all([
    calculateSeasonTitles(),
    getSheetData('SeasonBadges', 'A:F').catch(() => []),
  ]);

  const badges = [];

  // Текущие (в этом сезоне)
  if (current.sniper && current.sniper.userId === uid) badges.push({ key: 'sniper', name: titleName('sniper'), scope: 'current', detail: `${current.sniper.exact}/${current.sniper.total} (${Math.round(current.sniper.ratio * 100)}%)` });
  if (current.stable && current.stable.userId === uid) badges.push({ key: 'stable', name: titleName('stable'), scope: 'current', detail: `${current.stable.successful}/${current.stable.total} (${Math.round(current.stable.ratio * 100)}%)` });
  if (current.risky && current.risky.userId === uid) badges.push({ key: 'risky', name: titleName('risky'), scope: 'current', detail: `ТС с 6+ голами: ${current.risky.count}` });
  current.wild_round.filter(w => w.uid === uid).forEach(w => badges.push({ key: 'wild_round', name: titleName('wild_round'), scope: 'current', detail: `${w.day}: ${w.count} ТС` }));

  // Прошлые сезоны
  saved.forEach(r => {
    if (!isDataRow(r, 'badge_id')) return;
    if (String(r[1] || '').trim() !== uid) return;
    badges.push({
      key: r[3] || '',
      name: r[4] || '',
      scope: 'historical',
      season: r[2] || '',
      awardedAt: r[5] || '',
    });
  });

  return { userId: uid, badges, currentTitles: current };
}

// ========== Football sync ==========
async function fetchUCLMatches() {
  const data = await fetchFootball(`/competitions/CL/matches?season=${SEASON}`);
  const apiMatches = data.matches || [];
  const matchesData = await getSheetData('Matches', 'A:J');
  const existingById = new Map();
  matchesData.forEach((row, idx) => { if (!isDataRow(row, 'match_id')) return; existingById.set(String(row[0]).trim(), { row, rowIndex: idx }); });
  const newRows = [], updates = [], recalcList = [];
  for (const apiMatch of apiMatches) {
    const matchId = String(apiMatch.id);
    const homeTeam = translateTeam(apiMatch.homeTeam?.name || 'Unknown');
    const awayTeam = translateTeam(apiMatch.awayTeam?.name || 'Unknown');
    const kickoffUtc = apiMatch.utcDate || '';
    const status = mapStatus(apiMatch.status);
    const stage = mapStage(apiMatch.stage);
    const apiHome = toScore(apiMatch.score?.fullTime?.home);
    const apiAway = toScore(apiMatch.score?.fullTime?.away);
    const existing = existingById.get(matchId);
    if (!existing) {
      let hs = '', as = '', ru = '';
      if (status === 'finished' && apiHome !== null && apiAway !== null) { hs = apiHome; as = apiAway; ru = new Date().toISOString(); }
      newRows.push([matchId, stage, homeTeam, awayTeam, kickoffUtc, status, hs, as, ru, 'FALSE']);
      if (status === 'finished' && apiHome !== null && apiAway !== null) recalcList.push({ matchId, homeScore: apiHome, awayScore: apiAway });
      continue;
    }
    const current = padRow(existing.row, EXPECTED_COLUMNS.Matches);
    if (String(current[9] || '').toUpperCase() === 'TRUE') continue;
    const oldStatus = String(current[5] || '').trim();
    const oldHome = toScore(current[6]), oldAway = toScore(current[7]);
    let hs = current[6], as = current[7], ru = current[8], shouldRecalc = false;
    if (status === 'finished' && apiHome !== null && apiAway !== null) {
      hs = apiHome; as = apiAway;
      if (oldStatus !== 'finished' || oldHome !== apiHome || oldAway !== apiAway) { ru = new Date().toISOString(); shouldRecalc = true; }
    } else if (status !== 'finished') {
      hs = ''; as = ''; ru = '';
      if (oldStatus === 'finished') shouldRecalc = true;
    }
    const updated = [matchId, stage, homeTeam, awayTeam, kickoffUtc, status, hs, as, ru, current[9] || 'FALSE'];
    if (isDifferentRow(current, updated, EXPECTED_COLUMNS.Matches)) updates.push({ rowIndex: existing.rowIndex, values: updated });
    if (shouldRecalc && apiHome !== null && apiAway !== null) recalcList.push({ matchId, homeScore: apiHome, awayScore: apiAway });
  }
  await appendRows('Matches', newRows);
  await batchWriteRows('Matches', updates);
  for (const it of recalcList) await recalculatePointsForMatch(it.matchId, it.homeScore, it.awayScore);
  return { added: newRows.length, updated: updates.length, recalculated: recalcList.length };
}

async function updateFinishedMatches() {
  const data = await fetchFootball(`/competitions/CL/matches?season=${SEASON}`);
  const apiMatches = (data.matches || []).filter(m => m.status === 'FINISHED');
  const matchesData = await getSheetData('Matches', 'A:J');
  let updatedCount = 0;
  for (const apiMatch of apiMatches) {
    const matchId = String(apiMatch.id);
    const rowIndex = matchesData.findIndex(r => isDataRow(r, 'match_id') && String(r[0]).trim() === matchId);
    if (rowIndex === -1) continue;
    const current = padRow(matchesData[rowIndex], EXPECTED_COLUMNS.Matches);
    if (String(current[9] || '').toUpperCase() === 'TRUE') continue;
    const homeScore = toScore(apiMatch.score?.fullTime?.home), awayScore = toScore(apiMatch.score?.fullTime?.away);
    if (homeScore === null || awayScore === null) continue;
    const curHome = toScore(current[6]), curAway = toScore(current[7]), curStatus = String(current[5] || '').trim();
    if (curStatus === 'finished' && curHome === homeScore && curAway === awayScore) continue;
    const updated = [...current];
    updated[5] = 'finished'; updated[6] = homeScore; updated[7] = awayScore; updated[8] = new Date().toISOString(); updated[9] = current[9] || 'FALSE';
    await writeRow('Matches', rowIndex, updated);
    await recalculatePointsForMatch(matchId, homeScore, awayScore);
    updatedCount++;
  }
  return updatedCount;
}

async function fetchMatchEvents(matchId) { const d = await fetchFootball(`/matches/${matchId}/events`); return d.events || []; }
function buildEventRows(matchId, events, homeTeam, awayTeam) {
  if (!Array.isArray(events)) return [];
  const goalTypes = new Set(['GOAL','PENALTY','OWN_GOAL','GOAL_PENALTY','SCORE_CHANGE']);
  const scoring = events.filter(e => e && goalTypes.has(String(e.type || '').toUpperCase()))
    .sort((a, b) => toNum(a.minute, 0) - toNum(b.minute, 0) || toNum(a.injuryTime, 0) - toNum(b.injuryTime, 0));
  let hs = 0, as = 0; const rows = [];
  for (const e of scoring) {
    const rawTeam = e.team?.name || '';
    const team = translateTeam(rawTeam);
    const player = e.player?.name || '';
    const minute = toNum(e.minute, 0), added = toNum(e.injuryTime, 0);
    const nt = String(team || rawTeam || '').toLowerCase().trim();
    const nh = String(homeTeam || '').toLowerCase().trim();
    const na = String(awayTeam || '').toLowerCase().trim();
    if (nt && nh && nt === nh) hs++;
    else if (nt && na && nt === na) as++;
    rows.push([matchId, 'goal', team || rawTeam, minute, added, `${hs}:${as}`, player]);
  }
  return rows;
}
async function updateMatchEventsForFinished() {
  const { Matches: matchesData, MatchEvents: ev } = await batchGetSheets([
    { sheet: 'Matches', range: 'A:J' },
    { sheet: 'MatchEvents', range: 'A:G' },
  ]);
  const finishedMatches = matchesData.filter(r => isDataRow(r, 'match_id') && String(r[5] || '').trim() === 'finished');
  const existing = new Set(ev.filter(r => isDataRow(r, 'match_id')).map(r => String(r[0]).trim()));
  const toProcess = finishedMatches.filter(r => !existing.has(String(r[0]).trim())).slice(0, EVENTS_BATCH_SIZE);
  for (const row of toProcess) {
    const matchId = String(row[0]).trim();
    const homeTeam = String(row[2] || '').trim(), awayTeam = String(row[3] || '').trim();
    try {
      const events = await fetchMatchEvents(matchId);
      const rows = buildEventRows(matchId, events, homeTeam, awayTeam);
      if (rows.length) await appendRows('MatchEvents', rows);
      else await appendRows('MatchEvents', [[matchId, 'no_events', '', 0, 0, '', '']]);
    } catch (e) {
      console.error(`Ошибка получения событий ${matchId}:`, e.message);
      if (e.status === 403 || e.status === 404) await appendRows('MatchEvents', [[matchId, 'events_unavailable', '', 0, 0, '', '']]);
    }
    if (row !== toProcess[toProcess.length - 1]) await sleep(5000);
  }
  return toProcess.length;
}

async function recalculateAll() {
  const { Users: usersData, Predictions: predictionsData, Matches: matchesData } = await batchGetSheets([
    { sheet: 'Users', range: 'A:P' },
    { sheet: 'Predictions', range: 'A:K' },
    { sheet: 'Matches', range: 'A:J' },
  ]);
  const finishedMatches = new Map();
  matchesData.forEach(row => {
    if (!isDataRow(row, 'match_id')) return;
    if (String(row[5] || '').trim() !== 'finished') return;
    const hs = toScore(row[6]), as = toScore(row[7]);
    if (hs === null || as === null) return;
    finishedMatches.set(String(row[0]).trim(), { homeScore: hs, awayScore: as });
  });
  const latestMap = getLatestPredictionMap(predictionsData);
  const userStats = new Map(), userRowByIdx = new Map();
  usersData.forEach((row, idx) => {
    if (!isDataRow(row, 'user_id')) return;
    const uid = String(row[0]).trim();
    if (!uid) return;
    userRowByIdx.set(uid, idx);
    userStats.set(uid, { totalPoints: 0, totalPredictions: 0, successfulPredictions: 0, exactScores: 0, goalDifference: 0, draws: 0, outcomes: 0, misses: 0 });
  });
  const predUpdates = [];
  predictionsData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'prediction_id')) return;
    const uid = String(row[1] || '').trim(), matchId = String(row[2] || '').trim();
    if (!uid || !matchId) return;
    const latest = latestMap.get(`${uid}|${matchId}`);
    const oldP = toNum(row[7], 0), oldT = String(row[8] || '').trim();
    if (!latest || rowIndex !== latest.idx) {
      if (oldP !== 0 || oldT !== 'duplicate') {
        const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
        upd[7] = 0; upd[8] = 'duplicate';
        predUpdates.push({ rowIndex, values: upd });
      }
      return;
    }
    const stats = userStats.get(uid);
    if (stats) stats.totalPredictions++;
    let pts = 0, typ = '';
    const fm = finishedMatches.get(matchId);
    if (fm) {
      const r = calculatePoints(row[3], row[4], fm.homeScore, fm.awayScore);
      pts = r.points; typ = r.type;
      if (stats) {
        stats.totalPoints += pts;
        if (pts > 0) stats.successfulPredictions++;
        if (typ === 'exact') stats.exactScores++;
        if (typ === 'difference') stats.goalDifference++;
        if (typ === 'draw') stats.draws++;
        if (typ === 'outcome') stats.outcomes++;
        if (typ === 'miss') stats.misses++;
      }
    }
    if (oldP !== pts || oldT !== typ) {
      const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
      upd[6] = new Date().toISOString(); upd[7] = pts; upd[8] = typ;
      predUpdates.push({ rowIndex, values: upd });
    }
  });
  const userUpdates = [];
  for (const [uid, st] of userStats) {
    const rowIndex = userRowByIdx.get(uid);
    if (rowIndex === undefined) continue;
    const u = padRow(usersData[rowIndex], EXPECTED_COLUMNS.Users);
    u[4] = st.totalPoints; u[5] = st.totalPredictions; u[6] = st.successfulPredictions;
    u[7] = st.exactScores; u[8] = st.goalDifference; u[9] = st.draws; u[10] = st.outcomes; u[11] = st.misses;
    userUpdates.push({ rowIndex, values: u });
  }
  await batchWriteRows('Predictions', predUpdates);
  await batchWriteRows('Users', userUpdates);
  return finishedMatches.size;
}

async function getUserPredictionsResponse(userId, query = {}) {
  const { Matches: matchesData, Predictions: predictionsData } = await batchGetSheets([
    { sheet: 'Matches', range: 'A:J' },
    { sheet: 'Predictions', range: 'A:K' },
  ]);
  const matches = matchesData.filter(r => isDataRow(r, 'match_id'));
  const userPredictions = getLatestPredictionsForUser(predictionsData, userId);
  let result = userPredictions.map(p => {
    const matchId = String(p[2]).trim();
    const match = matches.find(m => String(m[0]).trim() === matchId);
    if (!match) return null;
    return { match_id: matchId, stage: match[1] || '', home_team: match[2] || '', away_team: match[3] || '', kickoff_utc: match[4] || '', status: match[5] || '', home_score: toScore(match[6]), away_score: toScore(match[7]), predicted_home: toScore(p[3]), predicted_away: toScore(p[4]), points: toNum(p[7], 0), prediction_type: p[8] || '', fantiki_awarded: toNum(p[9], 0) };
  }).filter(Boolean);
  result = filterPredictionResponseByType(result, query.type);
  const sf = String(query.status || '').toLowerCase().trim();
  if (sf) result = result.filter(it => it.status === sf);
  return sortPredictionsResponse(result, query.sort);
}

// ========== Telegram ==========
let telegramOffset = 0, conflictCounter = 0;
async function callTelegram(method, params) {
  const url = `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/${method}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  if (!r.ok) { const t = await r.text(); throw new Error(`Telegram API error: ${r.status} ${t}`); }
  return r.json();
}
function parsePredictionText(text) {
  const clean = String(text || '').replace(/^\/predict(?:@\w+)?\s+/i, '').trim();
  const m = clean.match(/^(.+?)\s+[-–—]\s+(.+?)\s+(\d{1,2})\s*:\s*(\d{1,2})$/i);
  if (!m) return null;
  const home = m[1].trim(), away = m[2].trim();
  if (!home || !away) return null;
  return { home, away, homeScore: Number(m[3]), awayScore: Number(m[4]) };
}
async function processTelegramMessage(msg) {
  const chatId = msg.chat?.id, from = msg.from, text = msg.text || '';
  if (!text || !from) return;
  const userId = String(from.id), username = from.username || '';
  const usersData = await getSheetData('Users', 'A:P');
  const exists = usersData.findIndex(row => isDataRow(row, 'user_id') && String(row[0]).trim() === userId);
  if (exists === -1) {
    let displayName = from.first_name || username || 'User';
    if (from.last_name && from.first_name) displayName = `${from.first_name} ${from.last_name}`;
    await appendRows('Users', [[userId, username, displayName, new Date().toISOString(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const matchesData = await getSheetData('Matches', 'A:J');
  const matches = matchesData.filter(row => isDataRow(row, 'match_id'));
  let predictionsData = await getSheetData('Predictions', 'A:K');
  let saved = 0;
  const affected = new Set();
  for (const line of lines) {
    const p = parsePredictionText(line);
    if (!p) continue;
    const hn = normalizeTeamName(p.home), an = normalizeTeamName(p.away);
    const match = matches.find(it => String(it[2] || '').toLowerCase().trim() === hn.toLowerCase() && String(it[3] || '').toLowerCase().trim() === an.toLowerCase());
    if (!match) continue;
    const matchId = String(match[0]).trim(), status = String(match[5] || '').trim(), kickoff = new Date(match[4]);
    if (status !== 'scheduled' || !Number.isFinite(kickoff.getTime()) || Date.now() >= kickoff.getTime()) continue;
    const toDel = [];
    predictionsData.forEach((row, idx) => { if (isDataRow(row, 'prediction_id') && String(row[1]).trim() === userId && String(row[2]).trim() === matchId) toDel.push(idx); });
    await deleteRowsByRowIndices('Predictions', toDel);
    predictionsData = predictionsData.filter((_, i) => !toDel.includes(i));
    await appendRows('Predictions', [[`${userId}_${matchId}`, userId, matchId, p.homeScore, p.awayScore, new Date().toISOString(), new Date().toISOString(), 0, '', 0, 'FALSE']]);
    saved++;
    const k = getMatchdayKey(match[4]);
    if (k) affected.add(k);
  }
  if (saved > 0) {
    for (const k of affected) { try { await checkQuestsProgress(userId, k); } catch (e) { console.error('Quest check failed:', e.message); } }
    await callTelegram('sendMessage', { chat_id: chatId, text: `✅ Сохранено прогнозов: ${saved}` });
  }
}
async function startBotPolling() {
  if (!BOT_TOKEN) return;
  console.log('Запуск Telegram polling...');
  try { await callTelegram('deleteWebhook', { drop_pending_updates: false }); console.log('Webhook удалён, начинаем polling.'); }
  catch (e) { console.warn('Не удалось удалить webhook:', e.message); }
  while (true) {
    try {
      const res = await callTelegram('getUpdates', { offset: telegramOffset, timeout: 30, allowed_updates: ['message'] });
      if (res.ok && res.result.length > 0) {
        for (const update of res.result) {
          telegramOffset = update.update_id + 1;
          if (update.message) { try { await processTelegramMessage(update.message); } catch (e) { console.error('Ошибка обработки сообщения:', e.message); } }
        }
      }
      conflictCounter = 0;
    } catch (error) {
      const m = String(error?.message || '');
      const isConflict = m.includes('409') || m.includes('Conflict');
      if (isConflict) {
        conflictCounter++;
        const wait = conflictCounter <= 3 ? 10000 : 30000;
        if (conflictCounter <= 3) console.warn(`⚠️ Конфликт polling (409). Ждём ${wait/1000}с... (попытка ${conflictCounter})`);
        await sleep(wait);
      } else { console.error('Ошибка polling:', m || error); await sleep(5000); }
    }
    await sleep(1000);
  }
}
app.post(WEBHOOK_PATH, (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Forbidden' });
  res.status(200).json({ ok: true });
  if (req.body?.message) processTelegramMessage(req.body.message).catch(e => console.error('Ошибка обработки webhook:', e.message));
});

// ========== API ==========
app.get('/api/fantiki/balance/:userId', asyncHandler(async (req, res) => {
  const info = await getBalance(req.params.userId);
  if (!info) return res.status(404).json({ error: 'User not found' });
  res.json(info);
}));
app.get('/api/fantiki/transactions/:userId', asyncHandler(async (req, res) => {
  const uid = String(req.params.userId || '').trim();
  if (!uid) return res.status(400).json({ error: 'userId required' });
  const limit = Math.min(Math.max(toNum(req.query.limit, 50), 1), 200);
  const txData = await getSheetData('FantikiTransactions', 'A:G');
  res.json(txData.filter(r => isDataRow(r, 'tx_id') && String(r[1] || '').trim() === uid).slice(-limit).reverse()
    .map(r => ({ id: r[0] || '', amount: toNum(r[2], 0), reason: r[3] || '', refId: r[4] || '', createdAt: r[5] || '', balanceAfter: toNum(r[6], 0) })));
}));
app.post('/api/daily-login', asyncHandler(async (req, res) => {
  const user = extractAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const userId = String(user.id).trim();
  const todayKey = todayUtcKey();
  const matchesData = await getSheetData('Matches', 'A:J');
  if (!matchesData.some(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === todayKey))
    return res.json({ success: false, reason: 'no_matches_today', date: todayKey });
  const txData = await getSheetData('FantikiTransactions', 'A:G');
  if (txData.some(r => isDataRow(r, 'tx_id') && String(r[1] || '').trim() === userId && String(r[3] || '').trim() === 'daily_login' && String(r[4] || '').trim() === todayKey))
    return res.json({ success: false, reason: 'already_claimed_today', date: todayKey });
  const result = await awardFantiki(userId, 10, 'daily_login', todayKey, `daily_login|${userId}|${todayKey}`);
  res.json({ success: true, date: todayKey, amount: 10, ...result });
}));

// Season titles
app.get('/api/season-titles', asyncHandler(async (req, res) => {
  const titles = await calculateSeasonTitles();
  res.json(titles);
}));
app.get('/api/season-titles/:userId', asyncHandler(async (req, res) => {
  const result = await getSeasonTitlesForUser(req.params.userId);
  if (!result) return res.status(400).json({ error: 'userId required' });
  res.json(result);
}));

// Admin
app.post('/api/admin/migrate-fantiki', requireAdmin, asyncHandler(async (req, res) => {
  try { res.json({ success: true, ...(await migrateFantiki()) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
}));
app.post('/api/admin/grant-fantiki', requireAdmin, asyncHandler(async (req, res) => {
  const { userId, amount, reason } = req.body;
  if (!userId || amount == null) return res.status(400).json({ error: 'userId and amount required' });
  res.json(await awardFantiki(userId, Number(amount), reason || 'admin_grant', ''));
}));
app.post('/api/admin/finalize-matchday/:date', requireAdmin, asyncHandler(async (req, res) => {
  const key = String(req.params.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const streak = await checkMatchdayStreakBonus(key);
  const prize = await checkRoundPrizes(key);
  res.json({ success: true, matchday: key, streak, prize });
}));
app.post('/api/admin/finalize-recent', requireAdmin, asyncHandler(async (req, res) => {
  const results = await checkRecentMatchdays();
  res.json({ success: true, results });
}));
app.post('/api/admin/finalize-all', requireAdmin, asyncHandler(async (req, res) => {
  if (heavyJobRunning) return res.status(409).json({ error: 'Another heavy job is running. Try again later.' });
  const daysParam = req.query.days ? Number(req.query.days) : null;
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.floor(daysParam) : null;

  res.json({ success: true, scope: days ? `last ${days} days` : 'all matches', message: 'Started in background.' });

  (async () => {
    heavyJobRunning = true;
    try {
      const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
      const label = days ? `за ${days} дн.` : 'за всё время';
      console.log(`🔄 [finalize-all] SCOPE: ${label}`);
      const matchesData = await getSheetData('Matches', 'A:J');
      const finished = matchesData.filter(r => {
        if (!isDataRow(r, 'match_id')) return false;
        if (String(r[5] || '').trim() !== 'finished') return false;
        if (toScore(r[6]) === null || toScore(r[7]) === null) return false;
        if (!days) return true;
        const k = new Date(r[4] || '').getTime();
        return Number.isFinite(k) && k >= cutoff;
      });
      console.log(`🔄 [finalize-all] Найдено ${finished.length} матчей`);

      const days2 = new Set();
      let processed = 0, errors = 0;
      for (const row of finished) {
        const matchId = String(row[0]).trim();
        try {
          await recalculatePointsForMatch(matchId, toScore(row[6]), toScore(row[7]));
          processed++;
          const k = getMatchdayKey(row[4]);
          if (k) days2.add(k);
          if (processed % 5 === 0) console.log(`[finalize-all] ${processed}/${finished.length}`);
        } catch (e) { console.error(`[finalize-all] Match ${matchId} failed:`, e.message); errors++; }
        await sleep(500);
      }

      for (const key of days2) {
        try {
          const s = await checkMatchdayStreakBonus(key);
          const p = await checkRoundPrizes(key);
          if ((s && s.awardedCount > 0) || (p && p.awardedCount > 0))
            console.log(`[finalize-all] ${key}: streak ${s?.awardedCount || 0}, prize ${p?.awardedCount || 0}`);
        } catch (e) { console.error(`[finalize-all] Matchday ${key} failed:`, e.message); }
      }
      console.log(`✅ [finalize-all] DONE: ${processed} матчей, ${errors} ошибок`);
    } catch (e) { console.error('❌ [finalize-all] FATAL:', e); }
    finally { heavyJobRunning = false; }
  })();
}));

// Season reset
app.post('/api/admin/reset-season', requireAdmin, asyncHandler(async (req, res) => {
  const seasonLabel = String(req.body?.seasonLabel || `${SEASON}-final`).trim();

  // 1. Фиксируем текущие бейджи
  const titles = await calculateSeasonTitles();
  const badgeRows = [];
  const now = new Date().toISOString();
  const addBadge = (uid, key) => badgeRows.push([`badge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, uid, seasonLabel, key, titleName(key), now]);
  if (titles.sniper) addBadge(titles.sniper.userId, 'sniper');
  if (titles.stable) addBadge(titles.stable.userId, 'stable');
  if (titles.risky) addBadge(titles.risky.userId, 'risky');
  titles.wild_round.forEach(w => addBadge(w.uid, 'wild_round'));
  if (badgeRows.length) await appendRows('SeasonBadges', badgeRows);

  // 2. Сбрасываем баланс/уровень
  const usersData = await getSheetData('Users', 'A:P');
  const updates = [];
  usersData.forEach((row, idx) => {
    if (!isDataRow(row, 'user_id')) return;
    const u = padRow(row, EXPECTED_COLUMNS.Users);
    const earned = toNum(u[13], 0);
    u[12] = 0;
    u[13] = 0;
    u[14] = 0;
    u[15] = toNum(u[15], 0) + earned;
    updates.push({ rowIndex: idx, values: u });
  });
  if (updates.length) await batchWriteRows('Users', updates);

  res.json({ success: true, seasonLabel, badgesSaved: badgeRows.length, usersReset: updates.length, titles });
}));

// Existing endpoints
app.get('/api/standings-history', asyncHandler(async (req, res) => {
  const { Matches: m, Predictions: p } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }]);
  const fm = m.filter(r => isDataRow(r, 'match_id') && String(r[5] || '').trim() === 'finished').map(r => ({ matchId: String(r[0]).trim(), ts: new Date(r[8] || r[4] || '').getTime() || 0 })).sort((a, b) => a.ts - b.ts);
  if (!fm.length) return res.json({ previousPositions: {}, currentPositions: {} });
  const ids = fm.map(x => x.matchId), prev = ids.slice(0, -1);
  const calc = set => {
    const s = new Set(set), up = new Map();
    p.forEach(r => {
      if (!isDataRow(r, 'prediction_id')) return;
      if (!s.has(String(r[2] || '').trim())) return;
      const uid = String(r[1] || '').trim();
      if (String(r[8] || '').trim() === 'duplicate') return;
      up.set(uid, (up.get(uid) || 0) + toNum(r[7], 0));
    });
    const pos = {}; [...up.entries()].sort((a, b) => b[1] - a[1]).forEach(([u], i) => pos[u] = i + 1);
    return pos;
  };
  res.json({ previousPositions: calc(prev), currentPositions: calc(ids) });
}));
app.get('/api/user-points-history/:userId', asyncHandler(async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const { Matches: m, Predictions: p } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }]);
  const byId = new Map(); m.forEach(r => { if (isDataRow(r, 'match_id')) byId.set(String(r[0]).trim(), r); });
  const latest = getLatestPredictionMap(p);
  const daily = new Map();
  for (const it of latest.values()) {
    const row = p[it.idx];
    if (!row || String(row[1] || '').trim() !== userId) continue;
    if (String(row[8] || '').trim() === 'duplicate') continue;
    const match = byId.get(String(row[2] || '').trim());
    if (!match || String(match[5] || '').trim() !== 'finished') continue;
    const hs = toScore(match[6]), as = toScore(match[7]);
    if (hs === null || as === null) continue;
    const r = calculatePoints(row[3], row[4], hs, as);
    const d = new Date(match[8] || match[4] || '');
    if (!Number.isFinite(d.getTime())) continue;
    const k = d.toISOString().slice(0, 10);
    daily.set(k, (daily.get(k) || 0) + r.points);
  }
  res.json([...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, pts]) => ({ date: d, label: new Date(`${d}T00:00:00Z`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }), points: pts })));
}));
app.get('/api/standings-last-round', asyncHandler(async (req, res) => {
  const { Matches: m, Predictions: p, Users: u } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }, { sheet: 'Users', range: 'A:P' }]);
  const fm = m.filter(r => isDataRow(r, 'match_id') && String(r[5] || '').trim() === 'finished').map(r => ({ matchId: String(r[0]).trim(), ts: new Date(r[8] || r[4] || '').getTime() || 0 })).filter(x => x.ts > 0).sort((a, b) => b.ts - a.ts);
  if (!fm.length) return res.json([]);
  const cutoff = fm[0].ts - 3 * 86400000;
  const ids = new Set(fm.filter(x => x.ts >= cutoff).map(x => x.matchId));
  const latest = getLatestPredictionMap(p);
  const byId = new Map(); m.forEach(r => { if (isDataRow(r, 'match_id')) byId.set(String(r[0]).trim(), r); });
  const stats = new Map();
  for (const it of latest.values()) {
    const row = p[it.idx];
    if (!row) continue;
    const mid = String(row[2] || '').trim();
    if (!ids.has(mid) || String(row[8] || '').trim() === 'duplicate') continue;
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    const match = byId.get(mid);
    if (!match) continue;
    const hs = toScore(match[6]), as = toScore(match[7]);
    if (hs === null || as === null) continue;
    const r = calculatePoints(row[3], row[4], hs, as);
    if (!stats.has(uid)) stats.set(uid, { points: 0, exact: 0, difference: 0, draw: 0, outcome: 0, miss: 0 });
    const s = stats.get(uid);
    s.points += r.points;
    if (r.type === 'exact') s.exact++;
    else if (r.type === 'difference') s.difference++;
    else if (r.type === 'draw') s.draw++;
    else if (r.type === 'outcome') s.outcome++;
    else if (r.type === 'miss') s.miss++;
  }
  const nameMap = new Map();
  u.forEach(row => { if (isDataRow(row, 'user_id')) nameMap.set(String(row[0]).trim(), row[2] || row[1] || String(row[0]).trim()); });
  const table = [...stats.entries()].map(([uid, s]) => ({ userId: uid, displayName: nameMap.get(uid) || uid, ...s })).sort((a, b) => b.points - a.points || b.exact - a.exact);
  table.forEach((r, i) => r.position = i + 1);
  res.json(table);
}));
app.post('/api/auth', asyncHandler(async (req, res) => {
  const initDataString = req.body.initData;
  let user = null;
  if (initDataString) {
    if (BOT_TOKEN && !verifyTelegramInitData(initDataString)) return res.status(403).json({ error: 'Invalid initData' });
    try { user = JSON.parse(new URLSearchParams(initDataString).get('user') || 'null'); } catch { user = null; }
  }
  if (!user?.id && ALLOW_PLAIN_USER_ID && isNotEmpty(req.body.userId)) user = { id: req.body.userId, username: req.body.username || '', first_name: req.body.firstName || '', last_name: req.body.lastName || '' };
  if (!user?.id) return res.status(400).json({ error: 'userId required' });
  const userId = String(user.id).trim();
  const usersData = await getSheetData('Users', 'A:P');
  const existing = usersData.find(row => isDataRow(row, 'user_id') && String(row[0]).trim() === userId);
  if (!existing) {
    let displayName = user.first_name || user.username || 'User';
    if (user.last_name && user.first_name) displayName = `${user.first_name} ${user.last_name}`;
    await appendRows('Users', [[userId, user.username || '', displayName, new Date().toISOString(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
    return res.json({ userId, displayName });
  }
  return res.json({ userId, displayName: existing[2] || existing[1] || 'User' });
}));
app.get('/api/matches', asyncHandler(async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId).trim() : null;
  const { Matches: m, Predictions: p } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }]);
  const matches = m.filter(r => isDataRow(r, 'match_id'));
  const userPreds = userId ? getLatestPredictionsForUser(p, userId) : [];
  let result = matches.map(row => {
    const mid = String(row[0]).trim();
    const up = userPreds.find(x => String(x[2]).trim() === mid);
    return { match_id: mid, stage: row[1] || '', home_team: row[2] || '', away_team: row[3] || '', kickoff_utc: row[4] || '', status: row[5] || '', home_score: toScore(row[6]), away_score: toScore(row[7]), user_has_predicted: Boolean(up), user_prediction: up ? { home: toScore(up[3]), away: toScore(up[4]) } : null };
  });
  const incFin = String(req.query.includeFinished || 'true').toLowerCase() !== 'false';
  const sf = String(req.query.status || '').toLowerCase().trim();
  if (!incFin) result = result.filter(x => x.status !== 'finished');
  if (sf) result = result.filter(x => x.status === sf);
  result.sort((a, b) => (new Date(a.kickoff_utc).getTime() || Infinity) - (new Date(b.kickoff_utc).getTime() || Infinity));
  res.json(result);
}));
app.get('/api/my-predictions', asyncHandler(async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId).trim() : '';
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json(await getUserPredictionsResponse(userId, req.query));
}));
app.get('/api/user-predictions/:userId', asyncHandler(async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json(await getUserPredictionsResponse(userId, req.query));
}));
app.post('/api/predictions', asyncHandler(async (req, res) => {
  const userId = extractUserId(req);
  const { matchId, predictedHome, predictedAway } = req.body;
  if (!userId || !matchId || predictedHome === undefined || predictedAway === undefined) return res.status(400).json({ error: 'Missing parameters' });
  const matchesData = await getSheetData('Matches', 'A:J');
  const mIdx = matchesData.findIndex(r => isDataRow(r, 'match_id') && String(r[0]).trim() === String(matchId).trim());
  if (mIdx === -1) return res.status(404).json({ error: 'Match not found' });
  const match = padRow(matchesData[mIdx], EXPECTED_COLUMNS.Matches);
  if (String(match[5] || '').trim() !== 'scheduled') return res.status(400).json({ error: 'Match is not available' });
  const kickoff = new Date(match[4]);
  if (!Number.isFinite(kickoff.getTime()) || Date.now() >= kickoff.getTime()) return res.status(400).json({ error: 'Match already started' });
  const pH = toScore(predictedHome), pA = toScore(predictedAway);
  if (pH === null || pA === null || pH < 0 || pA < 0 || pH > 20 || pA > 20) return res.status(400).json({ error: 'Invalid score' });
  const predData = await getSheetData('Predictions', 'A:K');
  const toDel = [];
  predData.forEach((row, idx) => { if (isDataRow(row, 'prediction_id') && String(row[1]).trim() === String(userId).trim() && String(row[2]).trim() === String(matchId).trim()) toDel.push(idx); });
  await deleteRowsByRowIndices('Predictions', toDel);
  await appendRows('Predictions', [[`${userId}_${matchId}`, userId, matchId, pH, pA, new Date().toISOString(), new Date().toISOString(), 0, '', 0, 'FALSE']]);
  const k = getMatchdayKey(match[4]);
  if (k) await checkQuestsProgress(userId, k).catch(console.error);
  res.json({ success: true });
}));
app.post('/api/admin/match-result', requireAdmin, asyncHandler(async (req, res) => {
  const { matchId, homeScore, awayScore } = req.body;
  if (!matchId || homeScore === undefined || awayScore === undefined) return res.status(400).json({ error: 'Missing parameters' });
  const h = toScore(homeScore), a = toScore(awayScore);
  if (h === null || a === null || h < 0 || a < 0 || h > 20 || a > 20) return res.status(400).json({ error: 'Invalid score' });
  const matchesData = await getSheetData('Matches', 'A:J');
  const idx = matchesData.findIndex(r => isDataRow(r, 'match_id') && String(r[0]).trim() === String(matchId).trim());
  if (idx === -1) return res.status(404).json({ error: 'Match not found' });
  const um = padRow(matchesData[idx], EXPECTED_COLUMNS.Matches);
  um[5] = 'finished'; um[6] = h; um[7] = a; um[8] = new Date().toISOString(); um[9] = 'TRUE';
  await writeRow('Matches', idx, um);
  await recalculatePointsForMatch(matchId, h, a);
  res.json({ success: true });
}));
app.get('/api/match-predictions/:matchId', asyncHandler(async (req, res) => {
  const matchId = String(req.params.matchId || '').trim();
  const { Predictions: p, Users: u } = await batchGetSheets([{ sheet: 'Predictions', range: 'A:K' }, { sheet: 'Users', range: 'A:P' }]);
  const latest = getLatestPredictionMap(p);
  const mp = [...latest.values()].map(it => p[it.idx]).filter(r => r && String(r[2] || '').trim() === matchId);
  const names = new Map(); u.forEach(row => { if (isDataRow(row, 'user_id')) names.set(String(row[0]).trim(), row[2] || row[1] || String(row[0]).trim()); });
  res.json(mp.map(x => ({ userId: String(x[1] || '').trim(), displayName: names.get(String(x[1] || '').trim()) || x[1], predictedHome: toScore(x[3]), predictedAway: toScore(x[4]), points: toNum(x[7], 0), predictionType: x[8] || '', fantikiAwarded: toNum(x[9], 0) })));
}));
app.get('/api/match-events/:matchId', asyncHandler(async (req, res) => {
  const matchId = String(req.params.matchId || '').trim();
  const data = await getSheetData('MatchEvents', 'A:G');
  const filtered = data.filter(r => isDataRow(r, 'match_id') && String(r[0]).trim() === matchId && !['no_events','events_unavailable'].includes(String(r[1] || '').trim()));
  const result = filtered.map(e => ({ matchId: String(e[0]).trim(), eventType: e[1] || '', team: e[2] || '', minute: toNum(e[3], 0), addedTime: toNum(e[4], 0), scoreAfterEvent: e[5] || '', player: e[6] || '' }));
  result.sort((a, b) => a.minute - b.minute || a.addedTime - b.addedTime);
  res.json(result);
}));
app.get('/api/match-odds/:matchId', asyncHandler(async (req, res) => {
  if (!ODDS_API_KEY) return res.json({ enabled: false, odds: null });
  const matchId = String(req.params.matchId || '').trim();
  const matchesData = await getSheetData('Matches', 'A:J');
  const row = matchesData.find(r => isDataRow(r, 'match_id') && String(r[0]).trim() === matchId);
  if (!row) return res.status(404).json({ error: 'Match not found' });
  if (String(row[5] || '').trim() !== 'scheduled') return res.json({ enabled: true, odds: null });
  const ko = new Date(row[4] || '').getTime();
  const homeApi = String(storedTeamToApiTeam(row[2]) || '').toLowerCase().trim();
  const awayApi = String(storedTeamToApiTeam(row[3]) || '').toLowerCase().trim();
  if (!homeApi || !awayApi) return res.json({ enabled: true, odds: null });
  const events = await fetchOddsEvents();
  let sel = null, swapped = false;
  for (const e of events) {
    const et = new Date(e.commence_time || '').getTime();
    if (Number.isFinite(ko) && Number.isFinite(et) && Math.abs(et - ko) > 4 * 3600 * 1000) continue;
    const eh = String(findOurApiTeamName(e.home_team) || '').toLowerCase().trim();
    const ea = String(findOurApiTeamName(e.away_team) || '').toLowerCase().trim();
    if (eh === homeApi && ea === awayApi) { sel = e; swapped = false; break; }
    if (eh === awayApi && ea === homeApi) { sel = e; swapped = true; break; }
  }
  if (!sel) return res.json({ enabled: true, odds: null });
  const o = getOddsFromEvent(sel);
  if (!o) return res.json({ enabled: true, odds: null });
  if (swapped) return res.json({ enabled: true, odds: { home: o.away, draw: o.draw, away: o.home, bookmakers: o.bookmakers } });
  res.json({ enabled: true, odds: o });
}));
app.get('/api/standings', asyncHandler(async (req, res) => {
  const usersData = await getSheetData('Users', 'A:P');
  const table = usersData.filter(row => isDataRow(row, 'user_id')).map(row => ({
    userId: String(row[0] || '').trim(),
    username: row[1] || '',
    displayName: row[2] || row[1] || 'User',
    registrationDate: row[3] || '',
    totalPoints: toNum(row[4], 0),
    successfulPredictions: toNum(row[6], 0),
    exactScores: toNum(row[7], 0),
    goalDifference: toNum(row[8], 0),
    draws: toNum(row[9], 0),
    outcomes: toNum(row[10], 0),
    misses: toNum(row[11], 0),
    fantikiBalance: toNum(row[12], 0),
    totalEarnedSeason: toNum(row[13], 0),
    level: toNum(row[14], 0),
    levelName: levelToName(toNum(row[14], 0)),
    historicalEarned: toNum(row[15], 0),
  })).filter(u => u.userId);
  const sortBy = String(req.query.sortBy || '').toLowerCase().trim();
  const ord = String(req.query.order || '').toLowerCase().trim();
  const fields = { points: 'totalPoints', exact: 'exactScores', difference: 'goalDifference', draws: 'draws', outcomes: 'outcomes', misses: 'misses', successful: 'successfulPredictions' };
  const hasAct = u => (u.successfulPredictions + u.exactScores + u.goalDifference + u.draws + u.outcomes + u.misses) > 0;
  if (sortBy === 'misses') {
    const sign = ord === 'desc' ? -1 : 1;
    table.sort((a, b) => {
      const aa = hasAct(a) ? 0 : 1, ba = hasAct(b) ? 0 : 1;
      if (aa !== ba) return aa - ba;
      if (a.misses !== b.misses) return (a.misses - b.misses) * sign;
      return b.totalPoints - a.totalPoints;
    });
  } else if (sortBy && fields[sortBy]) {
    const f = fields[sortBy];
    const sign = ord ? (ord === 'asc' ? 1 : -1) : -1;
    table.sort((a, b) => ((a[f] || 0) - (b[f] || 0)) * sign);
  } else {
    table.sort((a, b) => b.totalPoints - a.totalPoints || b.exactScores - a.exactScores || b.goalDifference - a.goalDifference || a.misses - b.misses);
  }
  table.forEach((r, i) => r.position = i + 1);
  res.json(table);
}));
app.post('/api/admin/sync-matches', requireAdmin, asyncHandler(async (req, res) => { try { res.json({ success: true, ...(await fetchUCLMatches()) }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } }));
app.post('/api/admin/update-results', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const updated = await updateFinishedMatches();
    const recent = await checkRecentMatchdays();
    res.json({ success: true, updated, matchdaysChecked: recent.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
}));
app.post('/api/admin/update-events', requireAdmin, asyncHandler(async (req, res) => { try { res.json({ success: true, processed: await updateMatchEventsForFinished() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } }));
app.post('/api/admin/recalculate-all', requireAdmin, asyncHandler(async (req, res) => { try { res.json({ success: true, processed: await recalculateAll() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } }));

app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: 'Internal server error' }); });

let syncInProgress = false;
async function scheduledSync() {
  if (syncInProgress || heavyJobRunning) return;
  syncInProgress = true;
  try { await fetchUCLMatches(); await updateFinishedMatches(); await updateMatchEventsForFinished(); await checkRecentMatchdays(); }
  catch (e) { console.error(e); }
  finally { syncInProgress = false; }
}
if (AUTO_SYNC && FOOTBALL_DATA_API_KEY) {
  setTimeout(() => scheduledSync().catch(console.error), 10000);
  setInterval(() => scheduledSync().catch(console.error), SYNC_INTERVAL_MS);
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (!BOT_TOKEN) return;
  if (USE_WEBHOOK) {
    if (!RENDER_HOST) { console.warn('⚠️ USE_WEBHOOK=true без RENDER_EXTERNAL_HOSTNAME'); startBotPolling().catch(console.error); return; }
    const webhookUrl = `https://${RENDER_HOST}${WEBHOOK_PATH}`;
    console.log(`Режим Telegram: WEBHOOK`);
    console.log(`URL: ${webhookUrl}`);
    try {
      await callTelegram('setWebhook', { url: webhookUrl, allowed_updates: ['message'], drop_pending_updates: true, secret_token: WEBHOOK_SECRET });
      const info = await callTelegram('getWebhookInfo', {});
      console.log(`✅ Webhook установлен. Pending: ${info.result?.pending_update_count || 0}`);
    } catch (e) { console.error('❌ Не удалось установить webhook:', e.message); startBotPolling().catch(console.error); }
  } else {
    console.log(`Режим Telegram: POLLING`);
    startBotPolling().catch(console.error);
  }
});
server.on('error', err => console.error('Server error:', err));