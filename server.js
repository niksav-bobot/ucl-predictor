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

// ========== Odds API ==========
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE_URL = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
const ODDS_SPORT_KEY = process.env.ODDS_SPORT_KEY || 'soccer_uefa_champions_league';
const ODDS_CACHE_TTL_MS = 10 * 60 * 1000;
let oddsCache = { fetchedAt: 0, events: [] };

const EXPECTED_COLUMNS = {
  Users: 16,
  Predictions: 11,
  Matches: 10,
  MatchEvents: 7,
  FantikiTransactions: 7,
  Duels: 9,
  DuelBets: 7,
  QuestsProgress: 5,
  MatchdayBonuses: 7,
};

// ========== Telegram: режим webhook / polling ==========
const _useWebhookEnv = String(process.env.USE_WEBHOOK || '').toLowerCase();
const RENDER_HOST = process.env.RENDER_EXTERNAL_HOSTNAME || '';
const USE_WEBHOOK = !!BOT_TOKEN && (_useWebhookEnv === 'true' || (_useWebhookEnv !== 'false' && !!RENDER_HOST));
const WEBHOOK_SECRET = crypto.createHash('sha256').update(`secret:${BOT_TOKEN || 'none'}`).digest('hex').slice(0, 32);
const WEBHOOK_PATH = `/webhook/${crypto.createHash('sha256').update(`path:${BOT_TOKEN || 'none'}`).digest('hex').slice(0, 32)}`;

// ========== Кэш Google Sheets + retry на 429 ==========
const sheetCache = new Map();
const SHEET_CACHE_TTL_MS = 45 * 1000;

async function sheetsRequestWithRetry(fn, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit =
        error?.code === 429 ||
        error?.status === 429 ||
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
  for (const key of [...sheetCache.keys()]) {
    if (key.startsWith(`${sheet}!`)) sheetCache.delete(key);
  }
}

async function getSheetData(sheet, range) {
  const cacheKey = `${sheet}!${range}`;
  const cached = sheetCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const res = await sheetsRequestWithRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${quoteSheetName(sheet)}!${range}`,
    })
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
function calculateLevel(totalEarned) {
  const t = toNum(totalEarned, 0);
  if (t >= 5000) return 5; // Профи
  if (t >= 2000) return 4; // Снайпер
  if (t >= 1000) return 3; // Аналитик
  if (t >= 500)  return 2; // Прогнозист
  if (t >= 100)  return 1; // Новичок
  return 0;
}
function levelToName(level) {
  return ['Без уровня', 'Новичок', 'Прогнозист', 'Аналитик', 'Снайпер', 'Профи'][level] || 'Без уровня';
}
function getLevelBonus(level) {
  return [0, 0, 0.05, 0.10, 0.15, 0.25][level] || 0;
}
function getLevelThreshold(level) {
  return [0, 100, 500, 1000, 2000, 5000][level] || 0;
}

// ========== Matchday helpers ==========
function getMatchdayKey(utcDate) {
  const d = new Date(utcDate);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
function todayUtcKey() {
  return new Date().toISOString().slice(0, 10);
}

// ========== Google Sheets: запись ==========
async function appendRows(sheet, rows) {
  if (!rows.length) return;
  const len = EXPECTED_COLUMNS[sheet] || Math.max(...rows.map(r => r.length));
  await sheetsRequestWithRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${quoteSheetName(sheet)}!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
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
        requestBody: {
          requests: chunk.map(idx => ({
            deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 } },
          })),
        },
      })
    );
  }
  invalidateSheetCache(sheet);
}

// ========== Начисление фантиков ==========
async function awardFantiki(userId, amount, reason, refId = '', idempotencyKey = '') {
  const amt = toNum(amount, 0);
  if (!userId || !amt) return { success: false, error: 'Invalid params' };
  const uid = String(userId).trim();

  // Idempotency: если передан ключ вида "reason|ref_id" — проверяем, была ли уже такая транзакция
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
  const newLevel = calculateLevel(newTotalEarned);

  user[12] = newBalance;
  user[13] = newTotalEarned;
  user[14] = newLevel;
  await writeRow('Users', userIndex, user);

  const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await appendRows('FantikiTransactions', [[
    txId, uid, amt, String(reason || ''), String(refId || ''), new Date().toISOString(), newBalance,
  ]]);

  return { success: true, txId, newBalance, newTotalEarned, level: newLevel, levelName: levelToName(newLevel) };
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
    userId: uid,
    balance: toNum(p[12], 0),
    totalEarnedSeason: total,
    level,
    levelName: levelToName(level),
    levelBonus: getLevelBonus(level),
    nextLevelAt: level < 5 ? getLevelThreshold(level + 1) : null,
    historicalEarned: toNum(p[15], 0),
  };
}

// ========== Логика последних прогнозов ==========
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
const teamSynonyms = { 'мс': 'Манчестер Сити', 'ман сити': 'Манчестер Сити', 'мю': 'Манчестер Юнайтед', 'ман юнайтед': 'Манчестер Юнайтед', 'манчестер юнайтед': 'Манчестер Юнайтед', 'реал': 'Реал Мадрид', 'реал мадрид': 'Реал Мадрид', 'барса': 'Барселона', 'барселона': 'Барселона', 'бавария': 'Бавария', 'бавария мюнхен': 'Бавария', 'дортмунд': 'Боруссия Дортмунд', 'боруссия д': 'Боруссия Дортмунд', 'боруссия дортмунд': 'Боруссия Дортмунд', 'атлетико': 'Атлетико Мадрид', 'атлетико мадрид': 'Атлетико Мадрид', 'интер': 'Интер', 'наполи': 'Наполи', 'псж': 'ПСЖ', 'пари сен-жермен': 'ПСЖ', 'париж': 'ПСЖ', 'ливерпуль': 'Ливерпуль', 'челси': 'Челси', 'арсенал': 'Арсенал', 'ювентус': 'Ювентус', 'милан': 'Милан', 'аякс': 'Аякс', 'порту': 'Порту', 'бенфика': 'Бенфика', 'лион': 'Лион', 'монако': 'Монако', 'зальцбург': 'Зальцбург', 'шахтер': 'Шахтер', 'динамо загреб': 'Динамо Загреб', 'селтик': 'Селтик', 'рейнджерс': 'Рейнджерс', 'брюгге': 'Брюгге', 'галатасарай': 'Галатасарай', 'фенербахче': 'Фенербахче', 'олимпиакос': 'Олимпиакос', 'аек': 'АЕК', 'маккаби хайфа': 'Маккаби Хайфа', 'копенгаген': 'Копенгаген', 'янг бойз': 'Янг Бойз', 'црвена звезда': 'Црвена Звезда', 'ланс': 'Ланс', 'реал сосьедад': 'Реал Сосьедад', 'псв': 'ПСВ', 'фейеноорд': 'Фейеноорд', 'спортинг': 'Спортинг', 'спортинг лиссабон': 'Спортинг', 'виктория пльзень': 'Виктория Пльзень', 'брест': 'Брест', 'штутгарт': 'Штутгарт', 'астон вилла': 'Астон Вилла', 'болонья': 'Болонья', 'жирона': 'Жирона', 'сельта': 'Сельта', 'бетис': 'Бетис', 'севилья': 'Севилья', 'валенсия': 'Валенсия', 'лацио': 'Лацио', 'аталанта': 'Аталанта', 'рома': 'Рома', 'марсель': 'Марсель', 'лилль': 'Лилль', 'ницца': 'Ницца', 'ренн': 'Ренн', 'страсбур': 'Страсбур', 'нант': 'Нант', 'брага': 'Брага', 'андерлехт': 'Андерлехт', 'генк': 'Генк', 'ференцварош': 'Ференцварош', 'лудогорец': 'Лудогорец', 'карабах': 'Карабах', 'спарта прага': 'Спарта Прага', 'славия прага': 'Славия Прага', 'базель': 'Базель', 'грассхоппер': 'Грассхоппер', 'вильярреал': 'Вильярреал', 'ласк': 'ЛАСК', 'викинг': 'Викинг', 'слован братислава': 'Слован Братислава', 'будё-глимт': 'Будё-Глимт', 'комо': 'Комо', 'рб лейпциг': 'РБ Лейпциг', 'сабах': 'Сабах' };
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

// ========== Odds API helpers ==========
const ruToApiTeam = new Map();
const apiTeamLowerMap = new Map();
Object.entries(teamTranslations).forEach(([api, ru]) => { ruToApiTeam.set(ru.toLowerCase().trim(), api); apiTeamLowerMap.set(api.toLowerCase().trim(), api); });
const oddsTeamAliases = { 'bayern munich': 'FC Bayern München', 'bayern': 'FC Bayern München', 'psg': 'Paris Saint-Germain FC', 'paris saint germain': 'Paris Saint-Germain FC', 'paris sg': 'Paris Saint-Germain FC', 'man city': 'Manchester City FC', 'manchester city': 'Manchester City FC', 'man united': 'Manchester United FC', 'manchester united': 'Manchester United FC', 'inter': 'FC Internazionale Milano', 'inter milan': 'FC Internazionale Milano', 'juventus': 'Juventus FC', 'milan': 'AC Milan', 'borussia dortmund': 'Borussia Dortmund', 'dortmund': 'Borussia Dortmund', 'atletico madrid': 'Club Atlético de Madrid', 'atletico': 'Club Atlético de Madrid', 'napoli': 'SSC Napoli', 'porto': 'FC Porto', 'benfica': 'SL Benfica', 'ajax': 'AFC Ajax', 'lyon': 'Olympique Lyonnais', 'monaco': 'AS Monaco FC', 'salzburg': 'FC Red Bull Salzburg', 'rb salzburg': 'FC Red Bull Salzburg', 'shakhtar': 'FK Shakhtar Donetsk', 'shakhtar donetsk': 'FK Shakhtar Donetsk', 'dinamo zagreb': 'GNK Dinamo Zagreb', 'celtic': 'Celtic FC', 'rangers': 'Rangers FC', 'club brugge': 'Club Brugge KV', 'brugge': 'Club Brugge KV', 'galatasaray': 'Galatasaray SK', 'fenerbahce': 'Fenerbahçe SK', 'olympiacos': 'Olympiacos FC', 'aek athens': 'AEK Athens FC', 'maccabi haifa': 'Maccabi Haifa FC', 'copenhagen': 'FC København', 'young boys': 'BSC Young Boys', 'crvena zvezda': 'FK Crvena Zvezda', 'red star belgrade': 'FK Crvena Zvezda', 'lens': 'Racing Club de Lens', 'real sociedad': 'Real Sociedad de Fútbol', 'psv eindhoven': 'PSV', 'feyenoord': 'Feyenoord Rotterdam', 'sporting lisbon': 'Sporting CP', 'viktoria plzen': 'FC Viktoria Plzeň', 'brest': 'Stade Brestois 29', 'stuttgart': 'VfB Stuttgart', 'aston villa': 'Aston Villa FC', 'bologna': 'Bologna FC 1909', 'girona': 'Girona FC', 'celta': 'RC Celta de Vigo', 'celta vigo': 'RC Celta de Vigo', 'real betis': 'Real Betis Balompié', 'betis': 'Real Betis Balompié', 'sevilla': 'Sevilla FC', 'valencia': 'Valencia CF', 'lazio': 'Lazio Roma', 'atalanta': 'Atalanta BC', 'roma': 'AS Roma', 'marseille': 'Olympique de Marseille', 'lille': 'Lille OSC', 'nice': 'OGC Nice', 'rennes': 'Stade Rennais FC', 'strasbourg': 'RC Strasbourg Alsace', 'nantes': 'FC Nantes', 'braga': 'SC Braga', 'anderlecht': 'RSC Anderlecht', 'genk': 'KRC Genk', 'ferencvaros': 'Ferencvárosi TC', 'ludogorets': 'Ludogorets Razgrad', 'qarabag': 'Qarabağ FK', 'sparta prague': 'Sparta Praha', 'slavia prague': 'Slavia Praha', 'basel': 'FC Basel 1893', 'grasshoppers': 'Grasshopper Club Zürich', 'villarreal': 'Villarreal CF', 'aek': 'PAE AEK', 'lask': 'LASK Linz', 'viking': 'Viking FK', 'slovan bratislava': 'ŠK Slovan Bratislava', 'bodo/glimt': 'FK Bodø/Glimt', 'bodoe/glimt': 'FK Bodø/Glimt', 'como': 'Como 1907', 'rb leipzig': 'RB Leipzig', 'leipzig': 'RB Leipzig', 'sabah': 'Sabah FK', 'real madrid': 'Real Madrid CF', 'barcelona': 'FC Barcelona', 'liverpool': 'Liverpool FC', 'chelsea': 'Chelsea FC', 'arsenal': 'Arsenal FC' };
function storedTeamToApiTeam(storedTeam) { const lower = String(storedTeam || '').toLowerCase().trim(); if (!lower) return ''; return ruToApiTeam.get(lower) || apiTeamLowerMap.get(lower) || String(storedTeam || '').trim(); }
function findOurApiTeamName(oddsTeam) { const raw = String(oddsTeam || '').toLowerCase().trim(); if (!raw) return null; if (oddsTeamAliases[raw]) return oddsTeamAliases[raw]; const exact = apiTeamLowerMap.get(raw); if (exact) return exact; for (const [lower, apiName] of apiTeamLowerMap.entries()) { if (lower.includes(raw) || raw.includes(lower)) return apiName; } return null; }
async function fetchOddsEvents() {
  if (!ODDS_API_KEY) return [];
  const now = Date.now();
  if (now - oddsCache.fetchedAt < ODDS_CACHE_TTL_MS) return oddsCache.events;
  const sportKeys = [...new Set([ODDS_SPORT_KEY, 'upcoming'].filter(Boolean))];
  for (const sportKey of sportKeys) {
    try {
      const url = `${ODDS_API_BASE_URL}/sports/${encodeURIComponent(sportKey)}/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) { oddsCache = { fetchedAt: now, events: data }; return data; }
    } catch (error) { console.error('Ошибка загрузки коэффициентов:', error.message); }
  }
  oddsCache = { fetchedAt: now, events: [] };
  return [];
}
function getOddsFromEvent(event) {
  const rows = [];
  (event.bookmakers || []).forEach(bookmaker => {
    const market = (bookmaker.markets || []).find(item => String(item.key || '').toLowerCase() === 'h2h');
    if (!market) return;
    const outcomes = market.outcomes || [];
    const home = outcomes.find(outcome => outcome.name === event.home_team);
    const away = outcomes.find(outcome => outcome.name === event.away_team);
    const draw = outcomes.find(outcome => String(outcome.name || '').toLowerCase() === 'draw');
    if (home?.price && away?.price && draw?.price) rows.push({ home: Number(home.price), draw: Number(draw.price), away: Number(away.price) });
  });
  if (!rows.length) return null;
  const average = key => { const values = rows.map(row => row[key]).filter(Number.isFinite); if (!values.length) return null; return Math.round((values.reduce((a, v) => a + v, 0) / values.length) * 100) / 100; };
  const home = average('home'), draw = average('draw'), away = average('away');
  if (home === null || draw === null || away === null) return null;
  return { home, draw, away, bookmakers: rows.length };
}

// ========== Football-Data.org ==========
function mapStage(apiStage) { const stages = { PRELIMINARY: 'Предварительный раунд', FIRST_QUALIFYING_ROUND: '1-й квал. раунд', SECOND_QUALIFYING_ROUND: '2-й квал. раунд', THIRD_QUALIFYING_ROUND: '3-й квал. раунд', PLAY_OFF_ROUND: 'Раунд плей-офф', GROUP_STAGE: 'Групповой этап', ROUND_OF_16: '1/8 финала', QUARTER_FINALS: '1/4 финала', SEMI_FINALS: 'Полуфинал', FINAL: 'Финал' }; return stages[apiStage] || apiStage; }
function mapStatus(apiStatus) { if (apiStatus === 'SCHEDULED' || apiStatus === 'TIMED') return 'scheduled'; if (apiStatus === 'LIVE' || apiStatus === 'IN_PLAY' || apiStatus === 'PAUSED') return 'live'; if (apiStatus === 'FINISHED') return 'finished'; if (apiStatus === 'POSTPONED') return 'postponed'; if (apiStatus === 'SUSPENDED' || apiStatus === 'CANCELLED') return apiStatus.toLowerCase(); return String(apiStatus || '').toLowerCase(); }
async function fetchFootball(path) {
  if (!FOOTBALL_DATA_API_KEY) throw new Error('FOOTBALL_DATA_API_KEY не задан');
  const res = await fetch(`${FOOTBALL_DATA_BASE_URL}${path}`, { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY } });
  if (!res.ok) { const text = await res.text(); const err = new Error(`Football-Data.org API error: ${res.status} ${text}`); err.status = res.status; throw err; }
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
function addResultToDelta(delta, result, sign) {
  if (!delta || !result) return;
  const pts = toNum(result.points, 0);
  delta.points += sign * pts;
  if (pts > 0) delta.successful += sign;
  if (result.type === 'exact') delta.exact += sign;
  if (result.type === 'difference') delta.difference += sign;
  if (result.type === 'draw') delta.draws += sign;
  if (result.type === 'outcome') delta.outcomes += sign;
  if (result.type === 'miss') delta.misses += sign;
}

// ========== Фантики за прогноз ==========
function calculatePredictionFantiki(predType, totalGoals, userLevel) {
  let base = 0;
  if (predType === 'outcome') base = 10;
  else if (predType === 'difference') base = 20;
  else if (predType === 'exact') {
    base = 50;
    if (totalGoals >= 8) base += 50;
    else if (totalGoals >= 6) base += 25;
  }
  if (base === 0) return 0;
  const mult = 1 + getLevelBonus(userLevel);
  return Math.round(base * mult);
}

// ========== Начисление очков и фантиков ==========
async function recalculatePointsForMatch(matchId, homeScore, awayScore) {
  const ah = toScore(homeScore), aa = toScore(awayScore);
  if (ah === null || aa === null) return { predictionsUpdated: 0, fantikiAwarded: 0 };
  const matchIdStr = String(matchId).trim();
  const totalGoals = ah + aa;

  const { Predictions: predictionsData, Users: usersData, Matches: matchesData } = await batchGetSheets([
    { sheet: 'Predictions', range: 'A:K' },
    { sheet: 'Users', range: 'A:P' },
    { sheet: 'Matches', range: 'A:J' },
  ]);

  const matchRow = matchesData.find(r => isDataRow(r, 'match_id') && String(r[0]).trim() === matchIdStr);
  const matchdayKey = matchRow ? getMatchdayKey(matchRow[4]) : null;

  const latestMap = getLatestPredictionMap(predictionsData);
  const predictionUpdates = [];
  const userDeltas = new Map();
  const fantikiDeltas = new Map();

  predictionsData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'prediction_id')) return;
    const pMatchId = String(row[2] || '').trim();
    if (pMatchId !== matchIdStr) return;
    const userId = String(row[1] || '').trim();
    if (!userId) return;
    const key = `${userId}|${pMatchId}`;
    const latest = latestMap.get(key);
    if (!latest) return;
    const oldPoints = toNum(row[7], 0), oldType = String(row[8] || '').trim();
    const oldFantiki = toNum(row[9], 0);
    const ensureDelta = () => { if (!userDeltas.has(userId)) userDeltas.set(userId, emptyUserDelta()); return userDeltas.get(userId); };
    const ensureFantikiDelta = () => { if (!fantikiDeltas.has(userId)) fantikiDeltas.set(userId, 0); return fantikiDeltas; };

    if (rowIndex !== latest.idx) {
      if (oldPoints !== 0 || oldType !== 'duplicate' || oldFantiki !== 0) {
        const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
        upd[7] = 0; upd[8] = 'duplicate'; upd[9] = 0;
        predictionUpdates.push({ rowIndex, values: upd });
        addResultToDelta(ensureDelta(), { points: oldPoints, type: oldType }, -1);
        if (oldFantiki !== 0) ensureFantikiDelta().set(userId, fantikiDeltas.get(userId) - oldFantiki);
      }
      return;
    }

    const newResult = calculatePoints(row[3], row[4], ah, aa);

    const userRow = usersData.find(r => isDataRow(r, 'user_id') && String(r[0]).trim() === userId);
    const userPad = userRow ? padRow(userRow, EXPECTED_COLUMNS.Users) : null;
    const userLevel = userPad ? toNum(userPad[14], 0) : 0;

    const newFantiki = calculatePredictionFantiki(newResult.type, totalGoals, userLevel);

    const pointsChanged = oldPoints !== newResult.points || oldType !== newResult.type;
    const fantikiChanged = oldFantiki !== newFantiki;

    if (pointsChanged || fantikiChanged) {
      const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
      if (pointsChanged) {
        upd[6] = new Date().toISOString();
        upd[7] = newResult.points;
        upd[8] = newResult.type;
      }
      if (fantikiChanged) upd[9] = newFantiki;
      predictionUpdates.push({ rowIndex, values: upd });
    }

    if (pointsChanged) {
      const delta = ensureDelta();
      addResultToDelta(delta, { points: oldPoints, type: oldType }, -1);
      addResultToDelta(delta, newResult, 1);
    }
    if (fantikiChanged) {
      const fDelta = ensureFantikiDelta();
      fDelta.set(userId, (fDelta.get(userId) || 0) + (newFantiki - oldFantiki));
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
    const reason = amount > 0 ? 'prediction_award' : 'prediction_correction';
    await awardFantiki(userId, amount, reason, matchIdStr, '');
    totalAwarded += amount;
  }

  if (matchdayKey) {
    await checkMatchdayStreakBonus(matchdayKey).catch(console.error);
  }

  return { predictionsUpdated: predictionUpdates.length, fantikiAwarded: totalAwarded };
}

// ========== Серия ТС за день ==========
async function checkMatchdayStreakBonus(matchdayKey) {
  const matchesData = await getSheetData('Matches', 'A:J');
  const dayMatches = matchesData.filter(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === matchdayKey);
  if (dayMatches.length === 0) return;

  // Все матчи дня должны быть finished/postponed/cancelled
  const allDone = dayMatches.every(r => {
    const status = String(r[5] || '').trim();
    return status === 'finished' || status === 'postponed' || status === 'cancelled';
  });
  if (!allDone) return;

  // Проверка: уже начислено?
  const bonusesData = await getSheetData('MatchdayBonuses', 'A:G');
  const alreadyDone = bonusesData.some(r => isDataRow(r, 'bonus_id')
    && String(r[1] || '').trim() === matchdayKey
    && String(r[2] || '').trim() === 'streak');
  if (alreadyDone) return;

  // Считаем ТС по пользователям
  const { Predictions: predictionsData } = await batchGetSheets([
    { sheet: 'Predictions', range: 'A:K' },
  ]);
  const dayMatchIds = new Set(dayMatches.map(r => String(r[0]).trim()));
  const latestMap = getLatestPredictionMap(predictionsData);
  const exactCountByUser = new Map();
  for (const item of latestMap.values()) {
    const row = predictionsData[item.idx];
    if (!row) continue;
    const matchId = String(row[2] || '').trim();
    if (!dayMatchIds.has(matchId)) continue;
    if (String(row[8] || '').trim() !== 'exact') continue;
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    exactCountByUser.set(uid, (exactCountByUser.get(uid) || 0) + 1);
  }

  let totalBonus = 0;
  let awardedCount = 0;
  for (const [userId, count] of exactCountByUser.entries()) {
    let bonus = 0;
    if (count >= 5) bonus = 300;
    else if (count === 4) bonus = 150;
    else if (count === 3) bonus = 75;
    else if (count === 2) bonus = 25;
    if (bonus > 0) {
      const r = await awardFantiki(userId, bonus, 'daily_streak_bonus', matchdayKey, `daily_streak|${matchdayKey}|${userId}`);
      if (r.success) { totalBonus += bonus; awardedCount++; }
    }
  }

  // Маркер, что день обработан
  const bonusId = `bonus_streak_${matchdayKey}`;
  await appendRows('MatchdayBonuses', [[
    bonusId, matchdayKey, 'streak', '', '', totalBonus, new Date().toISOString(),
  ]]);

  return { matchdayKey, awardedCount, totalBonus };
}

// ========== Проверка всех недавних matchday ==========
async function checkRecentMatchdays() {
  const matchesData = await getSheetData('Matches', 'A:J');
  const daySet = new Set();
  const now = Date.now();
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
    try { results.push(await checkMatchdayStreakBonus(key)); }
    catch (e) { console.error(`Streak check failed for ${key}:`, e.message); }
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
  if (dayMatchIds.size === 0) return;

  const latestMap = getLatestPredictionMap(predictionsData);
  const userPreds = [...latestMap.values()]
    .map(item => predictionsData[item.idx])
    .filter(r => r && String(r[1] || '').trim() === userId && dayMatchIds.has(String(r[2] || '').trim()));

  const hasQuest = (qid) => questsData.some(r => isDataRow(r, 'user_id')
    && String(r[0] || '').trim() === userId
    && String(r[1] || '').trim() === qid
    && String(r[2] || '').trim() === matchdayKey);

  const tryAward = async (questId, amount) => {
    if (hasQuest(questId)) return;
    await awardFantiki(userId, amount, `quest_${questId}`, matchdayKey, `quest|${questId}|${matchdayKey}|${userId}`);
    await appendRows('QuestsProgress', [[userId, questId, matchdayKey, new Date().toISOString(), amount]]);
  };

  if (userPreds.length >= 5) await tryAward('predict_5', 30);
  if (dayMatches.length > 0 && userPreds.length >= dayMatches.length) await tryAward('predict_all', 50);
  if (userPreds.some(r => String(r[8] || '').trim() === 'exact')) await tryAward('first_exact', 20);

  const outcomesCount = userPreds.filter(r => {
    const t = String(r[8] || '').trim();
    return t === 'outcome' || t === 'difference' || t === 'exact' || t === 'draw';
  }).length;
  if (outcomesCount >= 3) await tryAward('three_outcomes', 15);
}

// ========== Football-Data sync ==========
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
  for (const item of recalcList) await recalculatePointsForMatch(item.matchId, item.homeScore, item.awayScore);
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
    const currentHome = toScore(current[6]), currentAway = toScore(current[7]), currentStatus = String(current[5] || '').trim();
    if (currentStatus === 'finished' && currentHome === homeScore && currentAway === awayScore) continue;
    const updated = [...current];
    updated[5] = 'finished'; updated[6] = homeScore; updated[7] = awayScore; updated[8] = new Date().toISOString(); updated[9] = current[9] || 'FALSE';
    await writeRow('Matches', rowIndex, updated);
    await recalculatePointsForMatch(matchId, homeScore, awayScore);
    updatedCount++;
  }
  return updatedCount;
}

async function fetchMatchEvents(matchId) { const data = await fetchFootball(`/matches/${matchId}/events`); return data.events || []; }
function buildEventRows(matchId, events, homeTeam, awayTeam) {
  if (!Array.isArray(events)) return [];
  const goalTypes = new Set(['GOAL', 'PENALTY', 'OWN_GOAL', 'GOAL_PENALTY', 'SCORE_CHANGE']);
  const scoringEvents = events.filter(e => e && goalTypes.has(String(e.type || '').toUpperCase())).sort((a, b) => toNum(a.minute, 0) - toNum(b.minute, 0) || toNum(a.injuryTime, 0) - toNum(b.injuryTime, 0));
  let hs = 0, as = 0;
  const rows = [];
  for (const event of scoringEvents) {
    const rawTeam = event.team?.name || '';
    const team = translateTeam(rawTeam);
    const player = event.player?.name || '';
    const minute = toNum(event.minute, 0), addedTime = toNum(event.injuryTime, 0);
    const nt = String(team || rawTeam || '').toLowerCase().trim();
    const nh = String(homeTeam || '').toLowerCase().trim();
    const na = String(awayTeam || '').toLowerCase().trim();
    if (nt && nh && nt === nh) hs++;
    else if (nt && na && nt === na) as++;
    rows.push([matchId, 'goal', team || rawTeam, minute, addedTime, `${hs}:${as}`, player]);
  }
  return rows;
}
async function updateMatchEventsForFinished() {
  const { Matches: matchesData, MatchEvents: existingEvents } = await batchGetSheets([
    { sheet: 'Matches', range: 'A:J' },
    { sheet: 'MatchEvents', range: 'A:G' },
  ]);
  const finishedMatches = matchesData.filter(r => isDataRow(r, 'match_id') && String(r[5] || '').trim() === 'finished');
  const existingMatchIds = new Set(existingEvents.filter(r => isDataRow(r, 'match_id')).map(r => String(r[0]).trim()));
  const matchesToProcess = finishedMatches.filter(r => !existingMatchIds.has(String(r[0]).trim())).slice(0, EVENTS_BATCH_SIZE);
  for (const matchRow of matchesToProcess) {
    const matchId = String(matchRow[0]).trim();
    const homeTeam = String(matchRow[2] || '').trim();
    const awayTeam = String(matchRow[3] || '').trim();
    try {
      const events = await fetchMatchEvents(matchId);
      const rows = buildEventRows(matchId, events, homeTeam, awayTeam);
      if (rows.length > 0) await appendRows('MatchEvents', rows);
      else await appendRows('MatchEvents', [[matchId, 'no_events', '', 0, 0, '', '']]);
    } catch (error) {
      console.error(`Ошибка получения событий для матча ${matchId}:`, error.message);
      if (error.status === 403 || error.status === 404) await appendRows('MatchEvents', [[matchId, 'events_unavailable', '', 0, 0, '', '']]);
    }
    if (matchRow !== matchesToProcess[matchesToProcess.length - 1]) await sleep(5000);
  }
  return matchesToProcess.length;
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
    const status = String(row[5] || '').trim();
    if (status !== 'finished') return;
    const hs = toScore(row[6]), as = toScore(row[7]);
    if (hs === null || as === null) return;
    finishedMatches.set(String(row[0]).trim(), { homeScore: hs, awayScore: as });
  });
  const latestMap = getLatestPredictionMap(predictionsData);
  const userStats = new Map(), userRowIndexById = new Map();
  usersData.forEach((row, idx) => {
    if (!isDataRow(row, 'user_id')) return;
    const userId = String(row[0]).trim();
    if (!userId) return;
    userRowIndexById.set(userId, idx);
    userStats.set(userId, { totalPoints: 0, totalPredictions: 0, successfulPredictions: 0, exactScores: 0, goalDifference: 0, draws: 0, outcomes: 0, misses: 0 });
  });
  const predictionUpdates = [];
  predictionsData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'prediction_id')) return;
    const userId = String(row[1] || '').trim(), matchId = String(row[2] || '').trim();
    if (!userId || !matchId) return;
    const key = `${userId}|${matchId}`;
    const latest = latestMap.get(key);
    const oldPoints = toNum(row[7], 0), oldType = String(row[8] || '').trim();
    if (!latest || rowIndex !== latest.idx) {
      if (oldPoints !== 0 || oldType !== 'duplicate') {
        const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
        upd[7] = 0; upd[8] = 'duplicate';
        predictionUpdates.push({ rowIndex, values: upd });
      }
      return;
    }
    const stats = userStats.get(userId);
    if (stats) stats.totalPredictions++;
    let points = 0, type = '';
    const finishedMatch = finishedMatches.get(matchId);
    if (finishedMatch) {
      const result = calculatePoints(row[3], row[4], finishedMatch.homeScore, finishedMatch.awayScore);
      points = result.points; type = result.type;
      if (stats) {
        stats.totalPoints += points;
        if (points > 0) stats.successfulPredictions++;
        if (type === 'exact') stats.exactScores++;
        if (type === 'difference') stats.goalDifference++;
        if (type === 'draw') stats.draws++;
        if (type === 'outcome') stats.outcomes++;
        if (type === 'miss') stats.misses++;
      }
    }
    if (oldPoints !== points || oldType !== type) {
      const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
      upd[6] = new Date().toISOString(); upd[7] = points; upd[8] = type;
      predictionUpdates.push({ rowIndex, values: upd });
    }
  });
  const userUpdates = [];
  for (const [userId, stats] of userStats.entries()) {
    const rowIndex = userRowIndexById.get(userId);
    if (rowIndex === undefined) continue;
    const updatedUser = padRow(usersData[rowIndex], EXPECTED_COLUMNS.Users);
    updatedUser[4] = stats.totalPoints;
    updatedUser[5] = stats.totalPredictions;
    updatedUser[6] = stats.successfulPredictions;
    updatedUser[7] = stats.exactScores;
    updatedUser[8] = stats.goalDifference;
    updatedUser[9] = stats.draws;
    updatedUser[10] = stats.outcomes;
    updatedUser[11] = stats.misses;
    userUpdates.push({ rowIndex, values: updatedUser });
  }
  await batchWriteRows('Predictions', predictionUpdates);
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
  let result = userPredictions.map(prediction => {
    const matchId = String(prediction[2]).trim();
    const match = matches.find(m => String(m[0]).trim() === matchId);
    if (!match) return null;
    return { match_id: matchId, stage: match[1] || '', home_team: match[2] || '', away_team: match[3] || '', kickoff_utc: match[4] || '', status: match[5] || '', home_score: toScore(match[6]), away_score: toScore(match[7]), predicted_home: toScore(prediction[3]), predicted_away: toScore(prediction[4]), points: toNum(prediction[7], 0), prediction_type: prediction[8] || '', fantiki_awarded: toNum(prediction[9], 0) };
  }).filter(Boolean);
  result = filterPredictionResponseByType(result, query.type);
  const statusFilter = String(query.status || '').toLowerCase().trim();
  if (statusFilter) result = result.filter(item => item.status === statusFilter);
  return sortPredictionsResponse(result, query.sort);
}

// ========== Telegram ==========
let telegramOffset = 0;
let conflictCounter = 0;
async function callTelegram(method, params) {
  const url = `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/${method}`;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  if (!response.ok) { const text = await response.text(); throw new Error(`Telegram API error: ${response.status} ${text}`); }
  return response.json();
}

function parsePredictionText(text) {
  const clean = String(text || '').replace(/^\/predict(?:@\w+)?\s+/i, '').trim();
  const match = clean.match(/^(.+?)\s+[-–—]\s+(.+?)\s+(\d{1,2})\s*:\s*(\d{1,2})$/i);
  if (!match) return null;
  const home = match[1].trim(), away = match[2].trim();
  if (!home || !away) return null;
  return { home, away, homeScore: Number(match[3]), awayScore: Number(match[4]) };
}

async function processTelegramMessage(msg) {
  const chatId = msg.chat?.id, from = msg.from, text = msg.text || '';
  if (!text || !from) return;
  const userId = String(from.id), username = from.username || '';
  const usersData = await getSheetData('Users', 'A:P');
  const existingUserIndex = usersData.findIndex(row => isDataRow(row, 'user_id') && String(row[0]).trim() === userId);
  if (existingUserIndex === -1) {
    let displayName = from.first_name || username || 'User';
    if (from.last_name && from.first_name) displayName = `${from.first_name} ${from.last_name}`;
    await appendRows('Users', [[userId, username, displayName, new Date().toISOString(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  const matchesData = await getSheetData('Matches', 'A:J');
  const matches = matchesData.filter(row => isDataRow(row, 'match_id'));
  let predictionsData = await getSheetData('Predictions', 'A:K');
  let savedCount = 0;
  const affectedMatchdays = new Set();
  for (const line of lines) {
    const parsed = parsePredictionText(line);
    if (!parsed) continue;
    const homeNormalized = normalizeTeamName(parsed.home), awayNormalized = normalizeTeamName(parsed.away);
    const match = matches.find(item => String(item[2] || '').toLowerCase().trim() === homeNormalized.toLowerCase() && String(item[3] || '').toLowerCase().trim() === awayNormalized.toLowerCase());
    if (!match) continue;
    const matchId = String(match[0]).trim(), status = String(match[5] || '').trim(), kickoff = new Date(match[4]);
    if (status !== 'scheduled' || !Number.isFinite(kickoff.getTime()) || Date.now() >= kickoff.getTime()) continue;
    const existingIndexes = [];
    predictionsData.forEach((row, idx) => { if (isDataRow(row, 'prediction_id') && String(row[1]).trim() === userId && String(row[2]).trim() === matchId) existingIndexes.push(idx); });
    await deleteRowsByRowIndices('Predictions', existingIndexes);
    predictionsData = predictionsData.filter((_, i) => !existingIndexes.includes(i));
    await appendRows('Predictions', [[`${userId}_${matchId}`, userId, matchId, parsed.homeScore, parsed.awayScore, new Date().toISOString(), new Date().toISOString(), 0, '', 0, 'FALSE']]);
    savedCount++;
    const k = getMatchdayKey(match[4]);
    if (k) affectedMatchdays.add(k);
  }
  if (savedCount > 0) {
    for (const k of affectedMatchdays) {
      try { await checkQuestsProgress(userId, k); }
      catch (e) { console.error('Quest check failed:', e.message); }
    }
    await callTelegram('sendMessage', { chat_id: chatId, text: `✅ Сохранено прогнозов: ${savedCount}` });
  }
}

async function startBotPolling() {
  if (!BOT_TOKEN) return;
  console.log('Запуск Telegram polling...');
  try {
    await callTelegram('deleteWebhook', { drop_pending_updates: false });
    console.log('Webhook удалён, начинаем polling.');
  } catch (e) {
    console.warn('Не удалось удалить webhook:', e.message);
  }
  while (true) {
    try {
      const response = await callTelegram('getUpdates', { offset: telegramOffset, timeout: 30, allowed_updates: ['message'] });
      if (response.ok && response.result.length > 0) {
        for (const update of response.result) {
          telegramOffset = update.update_id + 1;
          if (update.message) {
            try { await processTelegramMessage(update.message); }
            catch (e) { console.error('Ошибка обработки сообщения:', e.message); }
          }
        }
      }
      conflictCounter = 0;
    } catch (error) {
      const msg = String(error?.message || '');
      const isConflict = msg.includes('409') || msg.includes('Conflict');
      if (isConflict) {
        conflictCounter++;
        const waitMs = conflictCounter <= 3 ? 10000 : 30000;
        if (conflictCounter <= 3) console.warn(`⚠️ Конфликт polling (409). Ждём ${waitMs / 1000}с... (попытка ${conflictCounter})`);
        await sleep(waitMs);
      } else {
        console.error('Ошибка polling:', msg || error);
        await sleep(5000);
      }
    }
    await sleep(1000);
  }
}

app.post(WEBHOOK_PATH, (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.status(200).json({ ok: true });
  const update = req.body;
  if (update?.message) {
    processTelegramMessage(update.message).catch(e =>
      console.error('Ошибка обработки webhook-сообщения:', e.message)
    );
  }
});

// ========== API ==========

// ---- Fantiki ----
app.get('/api/fantiki/balance/:userId', asyncHandler(async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const info = await getBalance(userId);
  if (!info) return res.status(404).json({ error: 'User not found' });
  res.json(info);
}));

app.get('/api/fantiki/transactions/:userId', asyncHandler(async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const limit = Math.min(Math.max(toNum(req.query.limit, 50), 1), 200);
  const txData = await getSheetData('FantikiTransactions', 'A:G');
  const userTx = txData
    .filter(r => isDataRow(r, 'tx_id') && String(r[1] || '').trim() === userId)
    .slice(-limit)
    .reverse();
  res.json(userTx.map(r => ({
    id: r[0] || '', amount: toNum(r[2], 0), reason: r[3] || '', refId: r[4] || '', createdAt: r[5] || '', balanceAfter: toNum(r[6], 0),
  })));
}));

app.post('/api/daily-login', asyncHandler(async (req, res) => {
  const user = extractAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const userId = String(user.id).trim();

  const todayKey = todayUtcKey();
  const matchesData = await getSheetData('Matches', 'A:J');
  const todayHasMatches = matchesData.some(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === todayKey);
  if (!todayHasMatches) return res.json({ success: false, reason: 'no_matches_today', date: todayKey });

  const txData = await getSheetData('FantikiTransactions', 'A:G');
  const alreadyClaimed = txData.some(r => isDataRow(r, 'tx_id')
    && String(r[1] || '').trim() === userId
    && String(r[3] || '').trim() === 'daily_login'
    && String(r[4] || '').trim() === todayKey);
  if (alreadyClaimed) return res.json({ success: false, reason: 'already_claimed_today', date: todayKey });

  const result = await awardFantiki(userId, 10, 'daily_login', todayKey, `daily_login|${userId}|${todayKey}`);
  res.json({ success: true, date: todayKey, amount: 10, ...result });
}));

// ---- Admin ----
app.post('/api/admin/migrate-fantiki', requireAdmin, asyncHandler(async (req, res) => {
  try { res.json({ success: true, ...(await migrateFantiki()) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
}));

app.post('/api/admin/grant-fantiki', requireAdmin, asyncHandler(async (req, res) => {
  const { userId, amount, reason } = req.body;
  if (!userId || amount == null) return res.status(400).json({ error: 'userId and amount required' });
  const result = await awardFantiki(userId, Number(amount), reason || 'admin_grant', '');
  res.json(result);
}));

app.post('/api/admin/finalize-matchday/:date', requireAdmin, asyncHandler(async (req, res) => {
  const key = String(req.params.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const result = await checkMatchdayStreakBonus(key);
  res.json({ success: true, matchday: key, result });
}));

app.post('/api/admin/finalize-recent', requireAdmin, asyncHandler(async (req, res) => {
  const results = await checkRecentMatchdays();
  res.json({ success: true, results });
}));

// ---- Existing endpoints ----
app.get('/api/standings-history', asyncHandler(async (req, res) => {
  const { Matches: matchesData, Predictions: predictionsData } = await batchGetSheets([
    { sheet: 'Matches', range: 'A:J' },
    { sheet: 'Predictions', range: 'A:K' },
  ]);
  const finishedMatches = matchesData.filter(row => isDataRow(row, 'match_id') && String(row[5] || '').trim() === 'finished').map(row => ({ matchId: String(row[0]).trim(), timestamp: new Date(row[8] || row[4] || '').getTime() || 0 })).sort((a, b) => a.timestamp - b.timestamp);
  if (!finishedMatches.length) return res.json({ previousPositions: {}, currentPositions: {} });
  const allIds = finishedMatches.map(m => m.matchId);
  const previousIds = allIds.slice(0, -1);
  const calc = (ids) => {
    const set = new Set(ids);
    const userPoints = new Map();
    predictionsData.forEach(row => {
      if (!isDataRow(row, 'prediction_id')) return;
      const matchId = String(row[2] || '').trim();
      if (!set.has(matchId)) return;
      const userId = String(row[1] || '').trim();
      if (String(row[8] || '').trim() === 'duplicate') return;
      userPoints.set(userId, (userPoints.get(userId) || 0) + toNum(row[7], 0));
    });
    const pos = {};
    [...userPoints.entries()].sort((a, b) => b[1] - a[1]).forEach(([uid], i) => pos[uid] = i + 1);
    return pos;
  };
  res.json({ previousPositions: calc(previousIds), currentPositions: calc(allIds) });
}));

app.get('/api/user-points-history/:userId', asyncHandler(async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const { Matches: matchesData, Predictions: predictionsData } = await batchGetSheets([
    { sheet: 'Matches', range: 'A:J' },
    { sheet: 'Predictions', range: 'A:K' },
  ]);
  const matchById = new Map();
  matchesData.forEach(row => { if (isDataRow(row, 'match_id')) matchById.set(String(row[0]).trim(), row); });
  const latestMap = getLatestPredictionMap(predictionsData);
  const dailyMap = new Map();
  for (const item of latestMap.values()) {
    const row = predictionsData[item.idx];
    if (!row || String(row[1] || '').trim() !== userId) continue;
    if (String(row[8] || '').trim() === 'duplicate') continue;
    const match = matchById.get(String(row[2] || '').trim());
    if (!match || String(match[5] || '').trim() !== 'finished') continue;
    const hs = toScore(match[6]), as = toScore(match[7]);
    if (hs === null || as === null) continue;
    const result = calculatePoints(row[3], row[4], hs, as);
    const date = new Date(match[8] || match[4] || '');
    if (!Number.isFinite(date.getTime())) continue;
    const dayKey = date.toISOString().slice(0, 10);
    dailyMap.set(dayKey, (dailyMap.get(dayKey) || 0) + result.points);
  }
  const history = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, points]) => ({ date, label: new Date(`${date}T00:00:00Z`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }), points }));
  res.json(history);
}));

app.get('/api/standings-last-round', asyncHandler(async (req, res) => {
  const { Matches: matchesData, Predictions: predictionsData, Users: usersData } = await batchGetSheets([
    { sheet: 'Matches', range: 'A:J' },
    { sheet: 'Predictions', range: 'A:K' },
    { sheet: 'Users', range: 'A:P' },
  ]);
  const finishedMatches = matchesData.filter(row => isDataRow(row, 'match_id') && String(row[5] || '').trim() === 'finished').map(row => ({ matchId: String(row[0]).trim(), timestamp: new Date(row[8] || row[4] || '').getTime() || 0 })).filter(m => m.timestamp > 0).sort((a, b) => b.timestamp - a.timestamp);
  if (!finishedMatches.length) return res.json([]);
  const cutoff = finishedMatches[0].timestamp - (3 * 24 * 60 * 60 * 1000);
  const roundMatchIds = new Set(finishedMatches.filter(m => m.timestamp >= cutoff).map(m => m.matchId));
  const latestMap = getLatestPredictionMap(predictionsData);
  const matchById = new Map();
  matchesData.forEach(r => { if (isDataRow(r, 'match_id')) matchById.set(String(r[0]).trim(), r); });
  const perUser = new Map();
  for (const item of latestMap.values()) {
    const row = predictionsData[item.idx];
    if (!row) continue;
    const matchId = String(row[2] || '').trim();
    if (!roundMatchIds.has(matchId) || String(row[8] || '').trim() === 'duplicate') continue;
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    const match = matchById.get(matchId);
    if (!match) continue;
    const hs = toScore(match[6]), as = toScore(match[7]);
    if (hs === null || as === null) continue;
    const result = calculatePoints(row[3], row[4], hs, as);
    if (!perUser.has(uid)) perUser.set(uid, { points: 0, exact: 0, difference: 0, draw: 0, outcome: 0, miss: 0 });
    const stats = perUser.get(uid);
    stats.points += result.points;
    if (result.type === 'exact') stats.exact++;
    else if (result.type === 'difference') stats.difference++;
    else if (result.type === 'draw') stats.draw++;
    else if (result.type === 'outcome') stats.outcome++;
    else if (result.type === 'miss') stats.miss++;
  }
  const userMap = new Map();
  usersData.forEach(row => { if (isDataRow(row, 'user_id')) userMap.set(String(row[0]).trim(), row[2] || row[1] || String(row[0]).trim()); });
  const table = [...perUser.entries()].map(([uid, stats]) => ({ userId: uid, displayName: userMap.get(uid) || uid, ...stats })).sort((a, b) => b.points - a.points || b.exact - a.exact);
  table.forEach((row, i) => row.position = i + 1);
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
  const existingUser = usersData.find(row => isDataRow(row, 'user_id') && String(row[0]).trim() === userId);
  if (!existingUser) {
    let displayName = user.first_name || user.username || 'User';
    if (user.last_name && user.first_name) displayName = `${user.first_name} ${user.last_name}`;
    await appendRows('Users', [[userId, user.username || '', displayName, new Date().toISOString(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
    return res.json({ userId, displayName });
  }
  return res.json({ userId, displayName: existingUser[2] || existingUser[1] || 'User' });
}));

app.get('/api/matches', asyncHandler(async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId).trim() : null;
  const { Matches: matchesData, Predictions: predictionsData } = await batchGetSheets([
    { sheet: 'Matches', range: 'A:J' },
    { sheet: 'Predictions', range: 'A:K' },
  ]);
  const matches = matchesData.filter(row => isDataRow(row, 'match_id'));
  const userPredictions = userId ? getLatestPredictionsForUser(predictionsData, userId) : [];
  let result = matches.map(row => {
    const matchId = String(row[0]).trim();
    const userPrediction = userPredictions.find(p => String(p[2]).trim() === matchId);
    return { match_id: matchId, stage: row[1] || '', home_team: row[2] || '', away_team: row[3] || '', kickoff_utc: row[4] || '', status: row[5] || '', home_score: toScore(row[6]), away_score: toScore(row[7]), user_has_predicted: Boolean(userPrediction), user_prediction: userPrediction ? { home: toScore(userPrediction[3]), away: toScore(userPrediction[4]) } : null };
  });
  const includeFinished = String(req.query.includeFinished || 'true').toLowerCase() !== 'false';
  const statusFilter = String(req.query.status || '').toLowerCase().trim();
  if (!includeFinished) result = result.filter(item => item.status !== 'finished');
  if (statusFilter) result = result.filter(item => item.status === statusFilter);
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
  const matchRowIndex = matchesData.findIndex(row => isDataRow(row, 'match_id') && String(row[0]).trim() === String(matchId).trim());
  if (matchRowIndex === -1) return res.status(404).json({ error: 'Match not found' });
  const match = padRow(matchesData[matchRowIndex], EXPECTED_COLUMNS.Matches);
  const status = String(match[5] || '').trim(), kickoff = new Date(match[4]);
  if (status !== 'scheduled') return res.status(400).json({ error: 'Match is not available for prediction' });
  if (!Number.isFinite(kickoff.getTime()) || Date.now() >= kickoff.getTime()) return res.status(400).json({ error: 'Match already started' });
  const pHome = toScore(predictedHome), pAway = toScore(predictedAway);
  if (pHome === null || pAway === null || pHome < 0 || pAway < 0 || pHome > 20 || pAway > 20) return res.status(400).json({ error: 'Invalid score' });
  const predictionsData = await getSheetData('Predictions', 'A:K');
  const existingIndexes = [];
  predictionsData.forEach((row, rowIndex) => { if (isDataRow(row, 'prediction_id') && String(row[1]).trim() === String(userId).trim() && String(row[2]).trim() === String(matchId).trim()) existingIndexes.push(rowIndex); });
  await deleteRowsByRowIndices('Predictions', existingIndexes);
  await appendRows('Predictions', [[`${userId}_${matchId}`, userId, matchId, pHome, pAway, new Date().toISOString(), new Date().toISOString(), 0, '', 0, 'FALSE']]);
  const matchdayKey = getMatchdayKey(match[4]);
  if (matchdayKey) await checkQuestsProgress(userId, matchdayKey).catch(console.error);
  res.json({ success: true });
}));

app.post('/api/admin/match-result', requireAdmin, asyncHandler(async (req, res) => {
  const { matchId, homeScore, awayScore } = req.body;
  if (!matchId || homeScore === undefined || awayScore === undefined) return res.status(400).json({ error: 'Missing parameters' });
  const hScore = toScore(homeScore), aScore = toScore(awayScore);
  if (hScore === null || aScore === null || hScore < 0 || aScore < 0 || hScore > 20 || aScore > 20) return res.status(400).json({ error: 'Invalid score' });
  const matchesData = await getSheetData('Matches', 'A:J');
  const rowIndex = matchesData.findIndex(row => isDataRow(row, 'match_id') && String(row[0]).trim() === String(matchId).trim());
  if (rowIndex === -1) return res.status(404).json({ error: 'Match not found' });
  const updatedMatch = padRow(matchesData[rowIndex], EXPECTED_COLUMNS.Matches);
  updatedMatch[5] = 'finished'; updatedMatch[6] = hScore; updatedMatch[7] = aScore; updatedMatch[8] = new Date().toISOString(); updatedMatch[9] = 'TRUE';
  await writeRow('Matches', rowIndex, updatedMatch);
  await recalculatePointsForMatch(matchId, hScore, aScore);
  res.json({ success: true, processed: true });
}));

app.get('/api/match-predictions/:matchId', asyncHandler(async (req, res) => {
  const matchId = String(req.params.matchId || '').trim();
  const { Predictions: predictionsData, Users: usersData } = await batchGetSheets([
    { sheet: 'Predictions', range: 'A:K' },
    { sheet: 'Users', range: 'A:P' },
  ]);
  const latestMap = getLatestPredictionMap(predictionsData);
  const matchPredictions = [...latestMap.values()].map(item => predictionsData[item.idx]).filter(row => row && String(row[2] || '').trim() === matchId);
  const userMap = new Map();
  usersData.forEach(row => { if (isDataRow(row, 'user_id')) userMap.set(String(row[0]).trim(), row[2] || row[1] || String(row[0]).trim()); });
  res.json(matchPredictions.map(prediction => ({ userId: String(prediction[1] || '').trim(), displayName: userMap.get(String(prediction[1] || '').trim()) || prediction[1], predictedHome: toScore(prediction[3]), predictedAway: toScore(prediction[4]), points: toNum(prediction[7], 0), predictionType: prediction[8] || '', fantikiAwarded: toNum(prediction[9], 0) })));
}));

app.get('/api/match-events/:matchId', asyncHandler(async (req, res) => {
  const matchId = String(req.params.matchId || '').trim();
  const eventsData = await getSheetData('MatchEvents', 'A:G');
  const matchEvents = eventsData.filter(row => isDataRow(row, 'match_id') && String(row[0]).trim() === matchId && String(row[1] || '').trim() !== 'no_events' && String(row[1] || '').trim() !== 'events_unavailable');
  const result = matchEvents.map(event => ({ matchId: String(event[0]).trim(), eventType: event[1] || '', team: event[2] || '', minute: toNum(event[3], 0), addedTime: toNum(event[4], 0), scoreAfterEvent: event[5] || '', player: event[6] || '' }));
  result.sort((a, b) => a.minute - b.minute || a.addedTime - b.addedTime);
  res.json(result);
}));

app.get('/api/match-odds/:matchId', asyncHandler(async (req, res) => {
  if (!ODDS_API_KEY) return res.json({ enabled: false, odds: null });
  const matchId = String(req.params.matchId || '').trim();
  const matchesData = await getSheetData('Matches', 'A:J');
  const matchRow = matchesData.find(row => isDataRow(row, 'match_id') && String(row[0]).trim() === matchId);
  if (!matchRow) return res.status(404).json({ error: 'Match not found' });
  if (String(matchRow[5] || '').trim() !== 'scheduled') return res.json({ enabled: true, odds: null });
  const kickoffTime = new Date(matchRow[4] || '').getTime();
  const homeApi = String(storedTeamToApiTeam(matchRow[2]) || '').toLowerCase().trim();
  const awayApi = String(storedTeamToApiTeam(matchRow[3]) || '').toLowerCase().trim();
  if (!homeApi || !awayApi) return res.json({ enabled: true, odds: null });
  const events = await fetchOddsEvents();
  let selectedEvent = null, swapped = false;
  for (const event of events) {
    const eventTime = new Date(event.commence_time || '').getTime();
    if (Number.isFinite(kickoffTime) && Number.isFinite(eventTime) && Math.abs(eventTime - kickoffTime) > 4 * 60 * 60 * 1000) continue;
    const eventHome = String(findOurApiTeamName(event.home_team) || '').toLowerCase().trim();
    const eventAway = String(findOurApiTeamName(event.away_team) || '').toLowerCase().trim();
    if (eventHome === homeApi && eventAway === awayApi) { selectedEvent = event; swapped = false; break; }
    if (eventHome === awayApi && eventAway === homeApi) { selectedEvent = event; swapped = true; break; }
  }
  if (!selectedEvent) return res.json({ enabled: true, odds: null });
  const odds = getOddsFromEvent(selectedEvent);
  if (!odds) return res.json({ enabled: true, odds: null });
  if (swapped) return res.json({ enabled: true, odds: { home: odds.away, draw: odds.draw, away: odds.home, bookmakers: odds.bookmakers } });
  return res.json({ enabled: true, odds });
}));

app.get('/api/standings', asyncHandler(async (req, res) => {
  const usersData = await getSheetData('Users', 'A:P');
  const users = usersData.filter(row => isDataRow(row, 'user_id'));
  const table = users.map(row => ({ userId: String(row[0] || '').trim(), username: row[1] || '', displayName: row[2] || row[1] || 'User', registrationDate: row[3] || '', totalPoints: toNum(row[4], 0), successfulPredictions: toNum(row[6], 0), exactScores: toNum(row[7], 0), goalDifference: toNum(row[8], 0), draws: toNum(row[9], 0), outcomes: toNum(row[10], 0), misses: toNum(row[11], 0), fantikiBalance: toNum(row[12], 0), totalEarnedSeason: toNum(row[13], 0), level: toNum(row[14], 0), levelName: levelToName(toNum(row[14], 0)) })).filter(user => user.userId);
  const sortBy = String(req.query.sortBy || '').toLowerCase().trim();
  const requestedOrder = String(req.query.order || '').toLowerCase().trim();
  const sortableFields = { points: 'totalPoints', totalpoints: 'totalPoints', exact: 'exactScores', exactscores: 'exactScores', difference: 'goalDifference', goaldifference: 'goalDifference', draws: 'draws', outcomes: 'outcomes', misses: 'misses', successful: 'successfulPredictions', successfulpredictions: 'successfulPredictions' };
  const hasActivity = user => (toNum(user.successfulPredictions, 0) + toNum(user.exactScores, 0) + toNum(user.goalDifference, 0) + toNum(user.draws, 0) + toNum(user.outcomes, 0) + toNum(user.misses, 0)) > 0;
  if (sortBy === 'misses') {
    const order = requestedOrder === 'desc' ? -1 : 1;
    table.sort((a, b) => {
      const aActive = hasActivity(a) ? 0 : 1;
      const bActive = hasActivity(b) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      if (a.misses !== b.misses) return (a.misses - b.misses) * order;
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      return String(a.userId).localeCompare(String(b.userId), 'ru', { numeric: true });
    });
  } else if (sortBy && sortableFields[sortBy]) {
    const field = sortableFields[sortBy];
    const order = requestedOrder ? (requestedOrder === 'asc' ? 1 : -1) : -1;
    table.sort((a, b) => ((a[field] || 0) - (b[field] || 0)) * order || String(a.userId).localeCompare(String(b.userId), 'ru', { numeric: true }));
  } else {
    table.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if (b.exactScores !== a.exactScores) return b.exactScores - a.exactScores;
      if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
      if (b.draws !== a.draws) return b.draws - a.draws;
      if (b.outcomes !== a.outcomes) return b.outcomes - a.outcomes;
      if (a.misses !== b.misses) return a.misses - b.misses;
      if (b.successfulPredictions !== a.successfulPredictions) return b.successfulPredictions - a.successfulPredictions;
      return String(a.userId).localeCompare(String(b.userId), 'ru', { numeric: true });
    });
  }
  table.forEach((row, index) => { row.position = index + 1; });
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
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    await fetchUCLMatches();
    await updateFinishedMatches();
    await updateMatchEventsForFinished();
    await checkRecentMatchdays();
  } catch (e) { console.error(e); }
  finally { syncInProgress = false; }
}
if (AUTO_SYNC && FOOTBALL_DATA_API_KEY) {
  setTimeout(() => scheduledSync().catch(console.error), 10000);
  setInterval(() => scheduledSync().catch(console.error), SYNC_INTERVAL_MS);
}

// ========== Запуск ==========
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  if (!BOT_TOKEN) return;
  if (USE_WEBHOOK) {
    if (!RENDER_HOST) {
      console.warn('⚠️ USE_WEBHOOK=true, но RENDER_EXTERNAL_HOSTNAME не задан. Переключаюсь на polling.');
      startBotPolling().catch(console.error);
      return;
    }
    const webhookUrl = `https://${RENDER_HOST}${WEBHOOK_PATH}`;
    console.log(`Режим Telegram: WEBHOOK`);
    console.log(`URL: ${webhookUrl}`);
    try {
      await callTelegram('setWebhook', {
        url: webhookUrl, allowed_updates: ['message'], drop_pending_updates: true, secret_token: WEBHOOK_SECRET,
      });
      const info = await callTelegram('getWebhookInfo', {});
      console.log(`✅ Webhook установлен. Pending updates: ${info.result?.pending_update_count || 0}`);
    } catch (e) {
      console.error('❌ Не удалось установить webhook:', e.message);
      console.warn('Переключаюсь на polling как резерв...');
      startBotPolling().catch(console.error);
    }
  } else {
    console.log(`Режим Telegram: POLLING${RENDER_HOST ? ' (принудительно через USE_WEBHOOK=false)' : ' (локальная разработка)'}`);
    startBotPolling().catch(console.error);
  }
});
server.on('error', err => console.error('Server error:', err));