require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

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
const BOT_USERNAME = process.env.BOT_USERNAME || 'ucl_predictor_bot';
const SEASON = process.env.FOOTBALL_SEASON || '2026';
const EVENTS_BATCH_SIZE = Number(process.env.EVENTS_BATCH_SIZE || 4);
const SYNC_INTERVAL_MS = (Number(process.env.SYNC_INTERVAL_MINUTES || 15) * 60 * 1000);
const AUTO_SYNC = String(process.env.AUTO_SYNC || '').toLowerCase() !== 'false';
const ALLOW_PLAIN_USER_ID = String(process.env.ALLOW_PLAIN_USER_ID || '').toLowerCase() !== 'false';

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE_URL = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
const ODDS_SPORT_KEY = process.env.ODDS_SPORT_KEY || 'soccer_uefa_champions_league';
const ODDS_CACHE_TTL_MS = 60 * 60 * 1000;
let oddsCache = { fetchedAt: 0, events: [] };

const EXPECTED_COLUMNS = {
  Users: 18, Predictions: 11, Matches: 10, MatchEvents: 7,
  FantikiTransactions: 7, Duels: 9, DuelBets: 7, QuestsProgress: 5,
  MatchdayBonuses: 7, SeasonBadges: 6,
};

let heavyJobRunning = false;

const _useWebhookEnv = String(process.env.USE_WEBHOOK || '').toLowerCase();
const RENDER_HOST = process.env.RENDER_EXTERNAL_HOSTNAME || '';
const USE_WEBHOOK = !!BOT_TOKEN && (_useWebhookEnv === 'true' || (_useWebhookEnv !== 'false' && !!RENDER_HOST));
const WEBHOOK_SECRET = crypto.createHash('sha256').update(`secret:${BOT_TOKEN || 'none'}`).digest('hex').slice(0, 32);
const WEBHOOK_PATH = `/webhook/${crypto.createHash('sha256').update(`path:${BOT_TOKEN || 'none'}`).digest('hex').slice(0, 32)}`;

const sheetCache = new Map();
const SHEET_CACHE_TTL_MS = 45 * 1000;

async function sheetsRequestWithRetry(fn, maxRetries = 5) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (error) {
      const isRL = error?.code === 429 || error?.status === 429 ||
        String(error?.message || '').includes('429') || String(error?.message || '').includes('Quota exceeded');
      if (!isRL || attempt === maxRetries) throw error;
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
  const k = `${sheet}!${range}`;
  const c = sheetCache.get(k);
  if (c && Date.now() < c.expiresAt) return c.data;
  const res = await sheetsRequestWithRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheet)}!${range}` }));
  const data = res.data.values || [];
  sheetCache.set(k, { data, expiresAt: Date.now() + SHEET_CACHE_TTL_MS });
  return data;
}
async function batchGetSheets(sheetRanges) {
  const ranges = sheetRanges.map(({ sheet, range }) => `${quoteSheetName(sheet)}!${range}`);
  const res = await sheetsRequestWithRetry(() =>
    sheets.spreadsheets.values.batchGet({ spreadsheetId: SHEET_ID, ranges }));
  const result = {};
  (res.data.valueRanges || []).forEach((vr, i) => {
    const { sheet, range } = sheetRanges[i];
    const k = `${sheet}!${range}`, data = vr.values || [];
    sheetCache.set(k, { data, expiresAt: Date.now() + SHEET_CACHE_TTL_MS });
    result[sheet] = data;
  });
  sheetRanges.forEach(({ sheet }) => { if (!(sheet in result)) result[sheet] = []; });
  return result;
}

function isNotEmpty(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
function toNum(v, f = 0) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function toScore(v) { if (v === null || v === undefined || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function quoteSheetName(n) { return `'${String(n).replace(/'/g, "''")}'`; }
function columnLetter(i) { let r = '', n = Math.max(1, Math.floor(i)); while (n > 0) { const m = (n - 1) % 26; r = String.fromCharCode(65 + m) + r; n = Math.floor((n - 1) / 26); } return r; }
function padRow(row, len) { const l = Math.max(0, Number(len) || 0); return Array.from({ length: l }, (_, i) => row?.[i] ?? ''); }
function isDataRow(row, header) { if (!Array.isArray(row) || !row.length) return false; const f = row[0]; if (!isNotEmpty(f)) return false; return header === undefined || String(f).trim() !== String(header).trim(); }
function rangeForRow(sheet, idx, cols) { return `${quoteSheetName(sheet)}!A${idx + 1}:${columnLetter(cols)}${idx + 1}`; }
function isDifferentRow(o, n, len) { for (let i = 0; i < len; i++) if (String(o?.[i] ?? '').trim() !== String(n?.[i] ?? '').trim()) return true; return false; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function calculateLevel(t) { t = toNum(t, 0); if (t >= 5000) return 5; if (t >= 2000) return 4; if (t >= 1000) return 3; if (t >= 500) return 2; if (t >= 100) return 1; return 0; }
function levelToName(l) { return ['Без уровня', 'Новичок', 'Прогнозист', 'Аналитик', 'Снайпер', 'Профи'][l] || 'Без уровня'; }
function getLevelBonus(l) { return [0, 0, 0.05, 0.10, 0.15, 0.25][l] || 0; }
function getLevelThreshold(l) { return [0, 100, 500, 1000, 2000, 5000][l] || 0; }

const LEVELS_DATA = [
  { level: 0, name: 'Без уровня', min: 0,    bonus: 0  },
  { level: 1, name: 'Новичок',    min: 100,  bonus: 0  },
  { level: 2, name: 'Прогнозист', min: 500,  bonus: 5  },
  { level: 3, name: 'Аналитик',   min: 1000, bonus: 10 },
  { level: 4, name: 'Снайпер',    min: 2000, bonus: 15 },
  { level: 5, name: 'Профи',      min: 5000, bonus: 25 },
];

function getMatchdayKey(utcDate) { const d = new Date(utcDate); if (!Number.isFinite(d.getTime())) return null; return d.toISOString().slice(0, 10); }

async function appendRows(sheet, rows) {
  if (!rows.length) return;
  const len = EXPECTED_COLUMNS[sheet] || Math.max(...rows.map(r => r.length));
  await sheetsRequestWithRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheet)}!A:A`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    resource: { values: rows.map(r => padRow(r, len)) },
  }));
  invalidateSheetCache(sheet);
}
async function batchWriteRows(sheet, updates) {
  if (!updates.length) return;
  const len = EXPECTED_COLUMNS[sheet] || 26;
  for (let i = 0; i < updates.length; i += 200) {
    const chunk = updates.slice(i, i + 200).map(u => ({ range: rangeForRow(sheet, u.rowIndex, len), values: [padRow(u.values, len)] }));
    await sheetsRequestWithRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID, requestBody: { valueInputOption: 'RAW', data: chunk },
    }));
  }
  invalidateSheetCache(sheet);
}
async function writeRow(sheet, idx, values) { await batchWriteRows(sheet, [{ rowIndex: idx, values }]); }

const sheetIdCache = {};
async function getSheetIdByName(name) {
  if (sheetIdCache[name] !== undefined) return sheetIdCache[name];
  const res = await sheetsRequestWithRetry(() => sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' }));
  const s = res.data.sheets?.find(x => x.properties?.title === name);
  if (!s) throw new Error(`Sheet not found: ${name}`);
  sheetIdCache[name] = s.properties.sheetId;
  return sheetIdCache[name];
}
async function deleteRowsByRowIndices(sheet, indexes) {
  const u = [...new Set(indexes.map(Number).filter(Number.isFinite))].sort((a, b) => b - a);
  if (!u.length) return;
  const sheetId = await getSheetIdByName(sheet);
  for (let i = 0; i < u.length; i += 200) {
    const chunk = u.slice(i, i + 200);
    await sheetsRequestWithRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: chunk.map(idx => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 } } })) },
    }));
  }
  invalidateSheetCache(sheet);
}

async function setupSheet(sheetName, headers) {
  let exists = true;
  try { await sheetsRequestWithRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheetName)}!A1:A1` })); }
  catch { exists = false; }
  if (!exists) {
    await sheetsRequestWithRetry(() => sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] } }));
    delete sheetIdCache[sheetName];
    await sheetsRequestWithRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheetName)}!A1:${columnLetter(headers.length)}1`,
      valueInputOption: 'RAW', requestBody: { values: [headers] },
    }));
    invalidateSheetCache(sheetName);
    return { created: true };
  }
  const res = await sheetsRequestWithRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheetName)}!A1:AZ1` }));
  const cur = res.data.values?.[0] || [];
  const maxLen = Math.max(cur.length, headers.length);
  const merged = [];
  for (let i = 0; i < maxLen; i++) merged.push(cur[i] ?? headers[i] ?? '');
  if (merged.length === cur.length && merged.every((h, i) => h === (cur[i] ?? ''))) return { created: false };
  await sheetsRequestWithRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${quoteSheetName(sheetName)}!A1:${columnLetter(merged.length)}1`,
    valueInputOption: 'RAW', requestBody: { values: [merged] },
  }));
  invalidateSheetCache(sheetName);
  return { created: false, updated: true };
}

async function migrateFantiki() {
  const result = { sheetsCreated: [], columnsUpdated: [], usersInitialized: 0, predictionsInitialized: 0 };
  const newSheets = [
    { name: 'FantikiTransactions', headers: ['tx_id','user_id','amount','reason','ref_id','created_at','balance_after'] },
    { name: 'Duels', headers: ['duel_id','match_id','creator_id','stake','status','created_at','settled_at','pot','winner_ids'] },
    { name: 'DuelBets', headers: ['bet_id','duel_id','user_id','predicted_home','predicted_away','joined_at','result'] },
    { name: 'QuestsProgress', headers: ['user_id','quest_id','matchday_key','completed_at','awarded'] },
    { name: 'MatchdayBonuses', headers: ['bonus_id','matchday_key','type','user_id','place','amount','awarded_at'] },
    { name: 'SeasonBadges', headers: ['badge_id','user_id','season_label','badge_key','badge_name','awarded_at'] },
  ];
  for (const s of newSheets) { const r = await setupSheet(s.name, s.headers); if (r.created) result.sheetsCreated.push(s.name); }
  const usersHeaders = ['user_id','username','display_name','registration_date','points','total_predictions','successful','exact','difference','draws','outcomes','misses','fantiki_balance','total_earned_season','level','historical_earned','referred_by','referral_awarded'];
  const predHeaders = ['prediction_id','user_id','match_id','predicted_home','predicted_away','created_at','updated_at','points','prediction_type','fantiki_awarded','is_starred'];
  if ((await setupSheet('Users', usersHeaders)).updated) result.columnsUpdated.push('Users');
  if ((await setupSheet('Predictions', predHeaders)).updated) result.columnsUpdated.push('Predictions');

  const usersData = await getSheetData('Users', 'A:R');
  const userUpdates = [];
  usersData.forEach((row, idx) => {
    if (!isDataRow(row, 'user_id')) return;
    const p = padRow(row, EXPECTED_COLUMNS.Users);
    let ch = false;
    for (const i of [12,13,14,15]) if (p[i] === '' || p[i] == null) { p[i] = 0; ch = true; }
    if (p[16] === '' || p[16] == null) { p[16] = ''; ch = true; }
    if (p[17] === '' || p[17] == null) { p[17] = 'FALSE'; ch = true; }
    if (ch) { userUpdates.push({ rowIndex: idx, values: p }); result.usersInitialized++; }
  });
  if (userUpdates.length) await batchWriteRows('Users', userUpdates);

  const predData = await getSheetData('Predictions', 'A:K');
  const predUpdates = [];
  predData.forEach((row, idx) => {
    if (!isDataRow(row, 'prediction_id')) return;
    const p = padRow(row, EXPECTED_COLUMNS.Predictions);
    let ch = false;
    if (p[9] === '' || p[9] == null) { p[9] = 0; ch = true; }
    if (p[10] === '' || p[10] == null) { p[10] = 'FALSE'; ch = true; }
    if (ch) { predUpdates.push({ rowIndex: idx, values: p }); result.predictionsInitialized++; }
  });
  if (predUpdates.length) await batchWriteRows('Predictions', predUpdates);
  return result;
}

async function awardFantiki(userId, amount, reason, refId = '', idempotencyKey = '') {
  const amt = toNum(amount, 0);
  if (!userId || !amt) return { success: false, error: 'Invalid params' };
  const uid = String(userId).trim();

  if (idempotencyKey) {
    const txData = await getSheetData('FantikiTransactions', 'A:G');
    const exists = txData.some(r => isDataRow(r, 'tx_id')
      && String(r[1] || '').trim() === uid && `${r[3]}|${r[4]}` === idempotencyKey);
    if (exists) return { success: false, error: 'Already awarded', idempotent: true };
  }

  const usersData = await getSheetData('Users', 'A:R');
  const userIndex = usersData.findIndex(r => isDataRow(r, 'user_id') && String(r[0]).trim() === uid);
  if (userIndex === -1) return { success: false, error: 'User not found' };

  const user = padRow(usersData[userIndex], EXPECTED_COLUMNS.Users);
  const oldBal = toNum(user[12], 0), oldTotal = toNum(user[13], 0);
  const newBal = Math.max(0, oldBal + amt);
  const newTotal = amt > 0 ? oldTotal + amt : oldTotal;
  user[12] = newBal; user[13] = newTotal; user[14] = calculateLevel(newTotal);
  await writeRow('Users', userIndex, user);

  const txId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await appendRows('FantikiTransactions', [[txId, uid, amt, String(reason||''), String(refId||''), new Date().toISOString(), newBal]]);
  return { success: true, txId, newBalance: newBal, newTotalEarned: newTotal, level: user[14], levelName: levelToName(user[14]) };
}

async function getBalance(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  const usersData = await getSheetData('Users', 'A:R');
  const row = usersData.find(r => isDataRow(r, 'user_id') && String(r[0]).trim() === uid);
  if (!row) return null;
  const p = padRow(row, EXPECTED_COLUMNS.Users);
  const total = toNum(p[13], 0), level = toNum(p[14], 0) || calculateLevel(total);
  return { userId: uid, balance: toNum(p[12], 0), totalEarnedSeason: total, level, levelName: levelToName(level),
    levelBonus: getLevelBonus(level), nextLevelAt: level < 5 ? getLevelThreshold(level + 1) : null, historicalEarned: toNum(p[15], 0) };
}

async function checkReferralAward(userId) {
  const uid = String(userId).trim();
  const usersData = await getSheetData('Users', 'A:R');
  const userRow = usersData.find(r => isDataRow(r, 'user_id') && String(r[0]).trim() === uid);
  if (!userRow) return;
  const p = padRow(userRow, EXPECTED_COLUMNS.Users);
  const referredBy = String(p[16] || '').trim();
  const awarded = String(p[17] || '').trim().toUpperCase() === 'TRUE';
  
  if (referredBy && !awarded && toNum(p[5], 0) >= 20) {
    const refResult = await awardFantiki(referredBy, 150, 'referral_bonus', uid, `referral|${referredBy}|${uid}`);
    if (refResult.success) {
      const idx = usersData.findIndex(r => isDataRow(r, 'user_id') && String(r[0]).trim() === uid);
      if (idx !== -1) {
        p[17] = 'TRUE';
        await writeRow('Users', idx, p);
      }
    }
  }
}

async function getTodayBalance(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;

  const matches = await getSheetData('Matches', 'A:J');
  const now = Date.now();

  const dayMatches = new Map();
  matches.forEach(r => {
    if (!isDataRow(r, 'match_id')) return;
    const k = getMatchdayKey(r[4]);
    if (!k) return;
    if (!dayMatches.has(k)) dayMatches.set(k, []);
    dayMatches.get(k).push(r);
  });

  const sortedDays = [...dayMatches.keys()].sort();
  let currentMatchday = null;

  for (let i = 0; i < sortedDays.length; i++) {
    const dayKey = sortedDays[i];
    const day = dayMatches.get(dayKey);
    const firstMatchStart = Math.min(...day.map(r => new Date(r[4] || '').getTime()));
    
    if (now >= firstMatchStart) {
      currentMatchday = dayKey;
    } else {
      break;
    }
  }

  if (!currentMatchday) return { date: null, total: 0, breakdown: {}, count: 0 };

  const dayStart = new Date(`${currentMatchday}T00:00:00Z`).getTime();
  const upperBound = now; 

  const txData = await getSheetData('FantikiTransactions', 'A:G');
  const dayTx = txData.filter(r => {
    if (!isDataRow(r, 'tx_id')) return false;
    if (String(r[1] || '').trim() !== uid) return false;
    const t = new Date(r[5] || '').getTime();
    if (!Number.isFinite(t)) return false;
    return t >= dayStart && t <= upperBound;
  });

  const breakdown = {};
  let total = 0;
  dayTx.forEach(r => {
    const reason = String(r[3] || '').trim();
    const amount = toNum(r[2], 0);
    breakdown[reason] = (breakdown[reason] || 0) + amount;
    total += amount;
  });

  return { date: currentMatchday, total, breakdown, count: dayTx.length };
}

// ========== Дивизионы ==========
const DIVISION_SIZE = Number(process.env.DIVISION_SIZE || 10);
const MIN_USERS_FOR_DIVISIONS = Number(process.env.MIN_USERS_FOR_DIVISIONS || 20);
const DIVISION_NAMES = ['💎 Платина', '🥇 Золото', '🥈 Серебро', '🥉 Бронза', 'Лига 5', 'Лига 6', 'Лига 7', 'Лига 8', 'Лига 9', 'Лига 10'];
function divisionName(idx) { return DIVISION_NAMES[idx] || `Лига ${idx + 1}`; }

async function getDivisionsData() {
  const usersData = await getSheetData('Users', 'A:R');
  const users = usersData.filter(row => isDataRow(row, 'user_id')).map(row => ({
    userId: String(row[0] || '').trim(),
    username: row[1] || '',
    displayName: row[2] || row[1] || 'User',
    totalPoints: toNum(row[4], 0),
    successfulPredictions: toNum(row[6], 0),
    exactScores: toNum(row[7], 0),
    goalDifference: toNum(row[8], 0),
    draws: toNum(row[9], 0),
    outcomes: toNum(row[10], 0),
    misses: toNum(row[11], 0),
    level: toNum(row[14], 0),
    levelName: levelToName(toNum(row[14], 0)),
  })).filter(u => u.userId && u.totalPoints > 0);

  users.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (b.exactScores !== a.exactScores) return b.exactScores - a.exactScores;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    if (b.draws !== a.draws) return b.draws - a.draws;
    if (b.outcomes !== a.outcomes) return b.outcomes - a.outcomes;
    if (a.misses !== b.misses) return a.misses - b.misses;
    return String(a.userId).localeCompare(String(b.userId), 'ru', { numeric: true });
  });

  const N = users.length;
  if (!N) return { divisions: [], divisionSize: DIVISION_SIZE, totalUsers: 0, numDivisions: 0, minUsersForDivisions: MIN_USERS_FOR_DIVISIONS, splittingNotYetActive: false };

  if (N < MIN_USERS_FOR_DIVISIONS) {
    return {
      divisions: [{
        division: 1,
        name: '🏆 Общая лига',
        size: N,
        users: users.map((u, i) => ({ ...u, position: i + 1 })),
      }],
      divisionSize: DIVISION_SIZE,
      totalUsers: N,
      numDivisions: 1,
      minUsersForDivisions: MIN_USERS_FOR_DIVISIONS,
      splittingNotYetActive: true,
      neededForSplitting: MIN_USERS_FOR_DIVISIONS - N,
    };
  }

  const numDivisions = Math.max(1, Math.ceil(N / DIVISION_SIZE));
  const baseSize = Math.floor(N / numDivisions);
  const remainder = N % numDivisions;

  const divisions = [];
  let cursor = 0;
  for (let d = 0; d < numDivisions; d++) {
    const size = baseSize + (d < remainder ? 1 : 0);
    const chunk = users.slice(cursor, cursor + size);
    cursor += size;
    divisions.push({
      division: d + 1,
      name: divisionName(d),
      size: chunk.length,
      users: chunk.map((u, i) => ({ ...u, position: i + 1 })),
    });
  }
  return { divisions, divisionSize: DIVISION_SIZE, totalUsers: N, numDivisions, minUsersForDivisions: MIN_USERS_FOR_DIVISIONS, splittingNotYetActive: false };
}

// ========== Прогнозы: логика ==========
function getLatestPredictionMap(data) {
  const latest = new Map();
  data.forEach((row, idx) => {
    if (!isDataRow(row, 'prediction_id')) return;
    const uid = String(row[1] || '').trim(), mid = String(row[2] || '').trim();
    if (!uid || !mid) return;
    const k = `${uid}|${mid}`;
    const ts = Date.parse(row[6] || '') || Date.parse(row[5] || '') || 0;
    const cur = latest.get(k);
    if (!cur || ts > cur.ts || (ts === cur.ts && idx > cur.idx)) latest.set(k, { idx, ts, userId: uid, matchId: mid });
  });
  return latest;
}
function getLatestPredictionsForUser(data, userId) {
  const map = getLatestPredictionMap(data);
  const uid = String(userId || '').trim();
  const rows = [];
  for (const it of map.values()) { const r = data[it.idx]; if (r && String(r[1] || '').trim() === uid) rows.push(r); }
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
  const byAsc = (a, b) => (new Date(a.kickoff_utc).getTime() || Infinity) - (new Date(b.kickoff_utc).getTime() || Infinity);
  const s = String(sortMode || '').toLowerCase().trim();
  if (s === 'exact_first') return [...list].sort((a, b) => (b.prediction_type === 'exact' ? 1 : 0) - (a.prediction_type === 'exact' ? 1 : 0) || byAsc(a, b));
  if (s === 'points_desc') return [...list].sort((a, b) => b.points - a.points || byAsc(a, b));
  if (s === 'date_desc') return [...list].sort((a, b) => (new Date(b.kickoff_utc).getTime() || -Infinity) - (new Date(a.kickoff_utc).getTime() || -Infinity));
  return [...list].sort(byAsc);
}

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
    const ad = Number(p.get('auth_date') || 0);
    return !(ad && Date.now()/1000 - ad > 86400);
  } catch { return false; }
}
function extractAuthenticatedUser(req) {
  const initData = req.body?.initData || req.query?.initData;
  if (initData) {
    if (BOT_TOKEN && !verifyTelegramInitData(initData)) return null;
    try {
      const p = new URLSearchParams(initData);
      const u = JSON.parse(p.get('user') || 'null');
      if (u?.id) return { ...u, id: String(u.id).trim() };
    } catch { return null; }
  }
  if (ALLOW_PLAIN_USER_ID) {
    const uid = req.body?.userId || req.query?.userId;
    if (isNotEmpty(uid)) return { id: String(uid).trim(), username: req.body?.username || '', first_name: req.body?.firstName || '', last_name: req.body?.lastName || '' };
  }
  return null;
}

function extractUserId(req) {
  const u = extractAuthenticatedUser(req);
  if (u?.id) return u.id;
  const adminKey = req.headers['x-admin-api-key'] || req.body?.apiKey;
  if (ADMIN_API_KEY && adminKey === ADMIN_API_KEY) {
    const uid = req.body?.userId || req.query?.userId;
    if (isNotEmpty(uid)) return String(uid).trim();
  }
  return null;
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-api-key'] || req.body?.apiKey;
  if (ADMIN_API_KEY && key === ADMIN_API_KEY) return next();
  const u = extractAuthenticatedUser(req);
  if (u?.id && getAdminIds().includes(String(u.id).trim())) return next();
  return res.status(403).json({ error: 'Forbidden' });
}
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const teamTranslations = { 'Real Madrid CF': 'Реал Мадрид', 'FC Barcelona': 'Барселона', 'Manchester City FC': 'Манчестер Сити', 'Liverpool FC': 'Ливерпуль', 'FC Bayern München': 'Бавария', 'Paris Saint-Germain FC': 'ПСЖ', 'Juventus FC': 'Ювентус', 'AC Milan': 'Милан', 'Chelsea FC': 'Челси', 'Arsenal FC': 'Арсенал', 'Borussia Dortmund': 'Боруссия Дортмунд', 'Club Atlético de Madrid': 'Атлетико Мадрид', 'FC Internazionale Milano': 'Интер', 'SSC Napoli': 'Наполи', 'FC Porto': 'Порту', 'SL Benfica': 'Бенфика', 'AFC Ajax': 'Аякс', 'Olympique Lyonnais': 'Лион', 'AS Monaco FC': 'Монако', 'FC Red Bull Salzburg': 'Зальцбург', 'FK Shakhtar Donetsk': 'Шахтер', 'GNK Dinamo Zagreb': 'Динамо Загреб', 'Celtic FC': 'Селтик', 'Rangers FC': 'Рейнджерс', 'Club Brugge KV': 'Брюгге', 'Galatasaray SK': 'Галатасарай', 'Fenerbahçe SK': 'Фенербахче', 'Olympiacos FC': 'Олимпиакос', 'AEK Athens FC': 'АЕК', 'Maccabi Haifa FC': 'Маккаби Хайфа', 'FC København': 'Копенгаген', 'BSC Young Boys': 'Янг Бойз', 'FK Crvena Zvezda': 'Црвена Звезда', 'Racing Club de Lens': 'Ланс', 'Real Sociedad de Fútbol': 'Реал Сосьедад', 'PSV': 'ПСВ', 'Feyenoord Rotterdam': 'Фейеноорд', 'Sporting CP': 'Спортинг', 'Sporting Clube de Portugal': 'Спортинг', 'FC Viktoria Plzeň': 'Виктория Пльзень', 'Stade Brestois 29': 'Брест', 'VfB Stuttgart': 'Штутгарт', 'Aston Villa FC': 'Астон Вилла', 'Bologna FC 1909': 'Болонья', 'Girona FC': 'Жирона', 'RC Celta de Vigo': 'Сельта', 'Real Betis Balompié': 'Бетис', 'Sevilla FC': 'Севилья', 'Valencia CF': 'Валенсия', 'Lazio Roma': 'Лацио', 'Atalanta BC': 'Аталанта', 'AS Roma': 'Рома', 'Olympique de Marseille': 'Марсель', 'Lille OSC': 'Лилль', 'OGC Nice': 'Ницца', 'Stade Rennais FC': 'Ренн', 'RC Strasbourg Alsace': 'Страсбур', 'FC Nantes': 'Нант', 'SC Braga': 'Брага', 'RSC Anderlecht': 'Андерлехт', 'KRC Genk': 'Генк', 'Ferencvárosi TC': 'Ференцварош', 'Ludogorets Razgrad': 'Лудогорец', 'Qarabağ FK': 'Карабах', 'Sparta Praha': 'Спарта Прага', 'Slavia Praha': 'Славия Прага', 'SK Slavia Praha': 'Славия Прага', 'FC Basel 1893': 'Базель', 'Grasshopper Club Zürich': 'Грассхоппер', 'Manchester United FC': 'Манчестер Юнайтед', 'Villarreal CF': 'Вильярреал', 'PAE AEK': 'АЕК', 'LASK Linz': 'ЛАСК', 'Viking FK': 'Викинг', 'ŠK Slovan Bratislava': 'Слован Братислава', 'FK Bodø/Glimt': 'Будё-Глимт', 'Como 1907': 'Комо', 'RB Leipzig': 'РБ Лейпциг', 'Sabah FK': 'Сабах' };
const teamSynonyms = { 'мс':'Манчестер Сити','ман сити':'Манчестер Сити','мю':'Манчестер Юнайтед','реал':'Реал Мадрид','реал мадрид':'Реал Мадрид','барса':'Барселона','барселона':'Барселона','бавария':'Бавария','дортмунд':'Боруссия Дортмунд','атлетико':'Атлетико Мадрид','интер':'Интер','наполи':'Наполи','псж':'ПСЖ','ливерпуль':'Ливерпуль','челси':'Челси','арсенал':'Арсенал','ювентус':'Ювентус','милан':'Милан','аякс':'Аякс','порту':'Порту','бенфика':'Бенфика','лион':'Лион','монако':'Монако','зальцбург':'Зальцбург','шахтер':'Шахтер','селтик':'Селтик','брюгге':'Брюгге','галатасарай':'Галатасарай','фенербахче':'Фенербахче','олимпиакос':'Олимпиакос','аек':'АЕК','копенгаген':'Копенгаген','янг бойз':'Янг Бойз','црвена звезда':'Црвена Звезда','ланс':'Ланс','реал сосьедад':'Реал Сосьедад','псв':'ПСВ','фейеноорд':'Фейеноорд','спортинг':'Спортинг','штутгарт':'Штутгарт','астон вилла':'Астон Вилла','болонья':'Болонья','жирона':'Жирона','сельта':'Сельта','бетис':'Бетис','севилья':'Севилья','валенсия':'Валенсия','лацио':'Лацио','аталанта':'Аталанта','рома':'Рома','марсель':'Марсель','лилль':'Лилль','ницца':'Ницца','ренн':'Ренн','нант':'Нант','брага':'Брага','андерлехт':'Андерлехт','генк':'Генк','ференцварош':'Ференцварош','лудогорец':'Лудогорец','карабах':'Карабах','базель':'Базель','вильярреал':'Вильярреал','ласк':'ЛАСК','викинг':'Викинг','слован братислава':'Слован Братислава','будё-глимт':'Будё-Глимт','комо':'Комо','рб лейпциг':'РБ Лейпциг','сабах':'Сабах' };
const teamAliases = new Map();
Object.entries(teamTranslations).forEach(([api, ru]) => { teamAliases.set(api.toLowerCase().trim(), ru); teamAliases.set(ru.toLowerCase().trim(), ru); });
Object.entries(teamSynonyms).forEach(([a, ru]) => teamAliases.set(a.toLowerCase().trim(), ru));
function translateTeam(name) { return name ? (teamTranslations[name] || name) : ''; }
function normalizeTeamName(name) {
  const l = String(name || '').toLowerCase().trim();
  if (teamAliases.has(l)) return teamAliases.get(l);
  const c = l.replace(/[«»"'()]/g, '').replace(/\s+/g, ' ').trim();
  return teamAliases.has(c) ? teamAliases.get(c) : String(name || '').trim();
}

const ruToApiTeam = new Map(), apiTeamLowerMap = new Map();
Object.entries(teamTranslations).forEach(([api, ru]) => { ruToApiTeam.set(ru.toLowerCase().trim(), api); apiTeamLowerMap.set(api.toLowerCase().trim(), api); });
const oddsTeamAliases = { 'bayern munich':'FC Bayern München','psg':'Paris Saint-Germain FC','man city':'Manchester City FC','man united':'Manchester United FC','inter':'FC Internazionale Milano','juventus':'Juventus FC','milan':'AC Milan','dortmund':'Borussia Dortmund','atletico':'Club Atlético de Madrid','napoli':'SSC Napoli','porto':'FC Porto','benfica':'SL Benfica','ajax':'AFC Ajax','lyon':'Olympique Lyonnais','monaco':'AS Monaco FC','salzburg':'FC Red Bull Salzburg','shakhtar':'FK Shakhtar Donetsk','celtic':'Celtic FC','rangers':'Rangers FC','galatasaray':'Galatasaray SK','fenerbahce':'Fenerbahçe SK','olympiacos':'Olympiacos FC','copenhagen':'FC København','young boys':'BSC Young Boys','crvena zvezda':'FK Crvena Zvezda','lens':'Racing Club de Lens','real sociedad':'Real Sociedad de Fútbol','psv':'PSV','feyenoord':'Feyenoord Rotterdam','sporting lisbon':'Sporting CP','stuttgart':'VfB Stuttgart','aston villa':'Aston Villa FC','bologna':'Bologna FC 1909','girona':'Girona FC','celta':'RC Celta de Vigo','betis':'Real Betis Balompié','sevilla':'Sevilla FC','valencia':'Valencia CF','lazio':'Lazio Roma','atalanta':'Atalanta BC','roma':'AS Roma','marseille':'Olympique de Marseille','lille':'Lille OSC','nice':'OGC Nice','rennes':'Stade Rennais FC','nantes':'FC Nantes','braga':'SC Braga','anderlecht':'RSC Anderlecht','genk':'KRC Genk','villarreal':'Villarreal CF','lask':'LASK Linz','viking':'Viking FK','leipzig':'RB Leipzig','real madrid':'Real Madrid CF','barcelona':'FC Barcelona','liverpool':'Liverpool FC','chelsea':'Chelsea FC','arsenal':'Arsenal FC' };
function storedTeamToApiTeam(s) { const l = String(s || '').toLowerCase().trim(); if (!l) return ''; return ruToApiTeam.get(l) || apiTeamLowerMap.get(l) || String(s || '').trim(); }
function findOurApiTeamName(t) { const r = String(t || '').toLowerCase().trim(); if (!r) return null; if (oddsTeamAliases[r]) return oddsTeamAliases[r]; const e = apiTeamLowerMap.get(r); if (e) return e; for (const [l, n] of apiTeamLowerMap) if (l.includes(r) || r.includes(l)) return n; return null; }
async function fetchOddsEvents() {
  if (!ODDS_API_KEY) return [];
  const now = Date.now();
  if (now - oddsCache.fetchedAt < ODDS_CACHE_TTL_MS) return oddsCache.events;
  for (const sk of [...new Set([ODDS_SPORT_KEY, 'upcoming'].filter(Boolean))]) {
    try {
      const url = `${ODDS_API_BASE_URL}/sports/${encodeURIComponent(sk)}/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`;
      const r = await fetch(url); if (!r.ok) continue;
      const d = await r.json();
      if (Array.isArray(d) && d.length > 0) { oddsCache = { fetchedAt: now, events: d }; return d; }
    } catch (e) { console.error('Odds error:', e.message); }
  }
  oddsCache = { fetchedAt: now, events: [] };
  return [];
}
function getOddsFromEvent(event) {
  const rows = [];
  (event.bookmakers || []).forEach(b => {
    const m = (b.markets || []).find(x => String(x.key || '').toLowerCase() === 'h2h');
    if (!m) return;
    const o = m.outcomes || [];
    const h = o.find(x => x.name === event.home_team), a = o.find(x => x.name === event.away_team), d = o.find(x => String(x.name || '').toLowerCase() === 'draw');
    if (h?.price && a?.price && d?.price) rows.push({ home: Number(h.price), draw: Number(d.price), away: Number(a.price) });
  });
  if (!rows.length) return null;
  const avg = k => { const v = rows.map(r => r[k]).filter(Number.isFinite); if (!v.length) return null; return Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 100) / 100; };
  const h = avg('home'), d = avg('draw'), a = avg('away');
  if (h === null || d === null || a === null) return null;
  return { home: h, draw: d, away: a, bookmakers: rows.length };
}

function mapStage(s) { const m = { PRELIMINARY:'Предварительный раунд', FIRST_QUALIFYING_ROUND:'1-й квал. раунд', SECOND_QUALIFYING_ROUND:'2-й квал. раунд', THIRD_QUALIFYING_ROUND:'3-й квал. раунд', PLAY_OFF_ROUND:'Раунд плей-офф', GROUP_STAGE:'Групповой этап', ROUND_OF_16:'1/8 финала', QUARTER_FINALS:'1/4 финала', SEMI_FINALS:'Полуфинал', FINAL:'Финал' }; return m[s] || s; }
function mapStatus(s) { if (s === 'SCHEDULED' || s === 'TIMED') return 'scheduled'; if (['LIVE','IN_PLAY','PAUSED'].includes(s)) return 'live'; if (s === 'FINISHED') return 'finished'; if (s === 'POSTPONED') return 'postponed'; if (['SUSPENDED','CANCELLED'].includes(s)) return s.toLowerCase(); return String(s || '').toLowerCase(); }
async function fetchFootball(path) {
  if (!FOOTBALL_DATA_API_KEY) throw new Error('FOOTBALL_DATA_API_KEY не задан');
  const res = await fetch(`${FOOTBALL_DATA_BASE_URL}${path}`, { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY } });
  if (!res.ok) { const t = await res.text(); const e = new Error(`Football-Data error: ${res.status} ${t}`); e.status = res.status; throw e; }
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
function addResultToDelta(d, r, s) {
  if (!d || !r) return;
  const p = toNum(r.points, 0);
  d.points += s * p;
  if (p > 0) d.successful += s;
  if (r.type === 'exact') d.exact += s;
  if (r.type === 'difference') d.difference += s;
  if (r.type === 'draw') d.draws += s;
  if (r.type === 'outcome') d.outcomes += s;
  if (r.type === 'miss') d.misses += s;
}
function calculatePredictionFantiki(type, totalGoals, lvl) {
  let base = 0;
  if (type === 'outcome') base = 10;
  else if (type === 'difference') base = 20;
  else if (type === 'exact') { base = 50; if (totalGoals >= 8) base += 50; else if (totalGoals >= 6) base += 25; }
  if (base === 0) return 0;
  return Math.round(base * (1 + getLevelBonus(lvl)));
}

async function getUserActiveDuelsCount(userId) {
  const uid = String(userId).trim();
  const { Duels: ds, DuelBets: bs } = await batchGetSheets([{ sheet: 'Duels', range: 'A:I' }, { sheet: 'DuelBets', range: 'A:G' }]);
  const activeIds = new Set();
  ds.forEach(r => { if (!isDataRow(r, 'duel_id')) return; const st = String(r[4] || '').trim(); if (st === 'open' || st === 'full') activeIds.add(String(r[0]).trim()); });
  let cnt = 0;
  for (const b of bs) { if (!isDataRow(b, 'bet_id')) continue; if (String(b[2] || '').trim() !== uid) continue; if (activeIds.has(String(b[1] || '').trim())) cnt++; }
  return cnt;
}
async function getUserMatchDuelBet(userId, matchId) {
  const uid = String(userId).trim(), mid = String(matchId).trim();
  const { Duels: ds, DuelBets: bs } = await batchGetSheets([{ sheet: 'Duels', range: 'A:I' }, { sheet: 'DuelBets', range: 'A:G' }]);
  const matchDuelIds = new Set();
  ds.forEach(r => { if (!isDataRow(r, 'duel_id')) return; if (String(r[1] || '').trim() === mid) matchDuelIds.add(String(r[0]).trim()); });
  for (const b of bs) { if (!isDataRow(b, 'bet_id')) continue; if (String(b[2] || '').trim() !== uid) continue; if (matchDuelIds.has(String(b[1] || '').trim())) return b; }
  return null;
}

async function createDuel(userId, matchId, ph, pa, stake) {
  const uid = String(userId).trim(), mid = String(matchId).trim(), s = toNum(stake, 0);
  if (s < 10 || s > 500 || s % 5 !== 0) return { success: false, error: 'Ставка 10–500, кратная 5' };
  const pH = toScore(ph), pA = toScore(pa);
  if (pH === null || pA === null || pH < 0 || pA < 0 || pH > 20 || pA > 20) return { success: false, error: 'Некорректный счёт' };
  const matchesData = await getSheetData('Matches', 'A:J');
  const match = matchesData.find(r => isDataRow(r, 'match_id') && String(r[0]).trim() === mid);
  if (!match) return { success: false, error: 'Матч не найден' };
  if (String(match[5] || '').trim() !== 'scheduled') return { success: false, error: 'Матч недоступен' };
  const ko = new Date(match[4]);
  if (!Number.isFinite(ko.getTime()) || Date.now() >= ko.getTime()) return { success: false, error: 'Матч начался' };
  const bal = await getBalance(uid);
  if (!bal) return { success: false, error: 'Пользователь не найден' };
  if (bal.balance < s) return { success: false, error: 'Недостаточно фантиков' };
  if ((await getUserActiveDuelsCount(uid)) >= 3) return { success: false, error: 'Максимум 3 активные дуэли' };
  if (await getUserMatchDuelBet(uid, mid)) return { success: false, error: 'Вы уже в дуэли на этот матч' };

  const duelId = `duel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const escrow = await awardFantiki(uid, -s, 'duel_stake', duelId, `duel_stake|${duelId}|${uid}`);
  if (!escrow.success) return { success: false, error: 'Не удалось зарезервировать: ' + (escrow.error || '') };
  await appendRows('Duels', [[duelId, mid, uid, s, 'open', now, '', s, '']]);
  const betId = `bet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await appendRows('DuelBets', [[betId, duelId, uid, pH, pA, now, 'pending']]);
  return { success: true, duelId, betId, newBalance: escrow.newBalance };
}

async function joinDuel(userId, duelId, ph, pa) {
  const uid = String(userId).trim(), did = String(duelId).trim();
  const pH = toScore(ph), pA = toScore(pa);
  if (pH === null || pA === null || pH < 0 || pA < 0 || pH > 20 || pA > 20) return { success: false, error: 'Некорректный счёт' };
  const { Duels: ds, DuelBets: bs } = await batchGetSheets([{ sheet: 'Duels', range: 'A:I' }, { sheet: 'DuelBets', range: 'A:G' }]);
  const dIdx = ds.findIndex(r => isDataRow(r, 'duel_id') && String(r[0]).trim() === did);
  if (dIdx === -1) return { success: false, error: 'Дуэль не найдена' };
  const duel = ds[dIdx];
  const mid = String(duel[1] || '').trim(), creatorId = String(duel[2] || '').trim();
  const s = toNum(duel[3], 0), st = String(duel[4] || '').trim();
  if (st !== 'open') return { success: false, error: 'Дуэль закрыта' };
  if (creatorId === uid) return { success: false, error: 'Нельзя в свою дуэль' };
  const matchesData = await getSheetData('Matches', 'A:J');
  const match = matchesData.find(r => isDataRow(r, 'match_id') && String(r[0]).trim() === mid);
  if (!match) return { success: false, error: 'Матч не найден' };
  if (String(match[5] || '').trim() !== 'scheduled') return { success: false, error: 'Матч недоступен' };
  const ko = new Date(match[4]);
  if (!Number.isFinite(ko.getTime()) || Date.now() >= ko.getTime()) return { success: false, error: 'Матч начался' };

  const duelBets = bs.filter(b => isDataRow(b, 'bet_id') && String(b[1] || '').trim() === did);
  if (duelBets.some(b => String(b[2] || '').trim() === uid)) return { success: false, error: 'Вы уже в этой дуэли' };
  if (duelBets.some(b => toNum(b[3]) === pH && toNum(b[4]) === pA)) return { success: false, error: 'Такой счёт уже занят' };
  if (duelBets.length >= 20) return { success: false, error: 'Макс 20 участников' };

  const bal = await getBalance(uid);
  if (!bal || bal.balance < s) return { success: false, error: 'Недостаточно фантиков' };
  if ((await getUserActiveDuelsCount(uid)) >= 3) return { success: false, error: 'Максимум 3 активные дуэли' };
  if (await getUserMatchDuelBet(uid, mid)) return { success: false, error: 'Вы уже в дуэли на этот матч' };

  const escrow = await awardFantiki(uid, -s, 'duel_stake', did, `duel_stake|${did}|${uid}`);
  if (!escrow.success) return { success: false, error: 'Не удалось зарезервировать' };
  const betId = `bet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await appendRows('DuelBets', [[betId, did, uid, pH, pA, new Date().toISOString(), 'pending']]);

  const newPot = toNum(duel[7], 0) + s;
  const newCnt = duelBets.length + 1;
  const newSt = newCnt >= 20 ? 'full' : 'open';
  const upd = padRow(duel, EXPECTED_COLUMNS.Duels);
  upd[7] = newPot; upd[4] = newSt;
  await writeRow('Duels', dIdx, upd);
  return { success: true, betId, newBalance: escrow.newBalance };
}

async function cancelDuel(userId, duelId) {
  const uid = String(userId).trim(), did = String(duelId).trim();
  const { Duels: ds, DuelBets: bs } = await batchGetSheets([{ sheet: 'Duels', range: 'A:I' }, { sheet: 'DuelBets', range: 'A:G' }]);
  const dIdx = ds.findIndex(r => isDataRow(r, 'duel_id') && String(r[0]).trim() === did);
  if (dIdx === -1) return { success: false, error: 'Не найдено' };
  const duel = ds[dIdx];
  if (String(duel[2] || '').trim() !== uid) return { success: false, error: 'Только создатель' };
  if (String(duel[4] || '').trim() !== 'open') return { success: false, error: 'Нельзя отменить' };
  const duelBets = bs.map((b, idx) => ({ row: b, idx })).filter(({ row }) => isDataRow(row, 'bet_id') && String(row[1] || '').trim() === did);
  if (duelBets.length > 1) return { success: false, error: 'Уже есть участники' };
  const s = toNum(duel[3], 0);
  await awardFantiki(uid, s, 'duel_refund', did, `duel_refund|${did}|${uid}`);
  for (const { row, idx } of duelBets) { const u = padRow(row, EXPECTED_COLUMNS.DuelBets); u[6] = 'refunded'; await writeRow('DuelBets', idx, u); }
  const upd = padRow(duel, EXPECTED_COLUMNS.Duels);
  upd[4] = 'cancelled'; upd[6] = new Date().toISOString();
  await writeRow('Duels', dIdx, upd);
  return { success: true };
}

async function settleDuel(duelId, hs, as) {
  const did = String(duelId).trim();
  const H = toScore(hs), A = toScore(as);
  if (H === null || A === null) return { success: false, error: 'Invalid score' };
  const { Duels: ds, DuelBets: bs } = await batchGetSheets([{ sheet: 'Duels', range: 'A:I' }, { sheet: 'DuelBets', range: 'A:G' }]);
  const dIdx = ds.findIndex(r => isDataRow(r, 'duel_id') && String(r[0] || '').trim() === did);
  if (dIdx === -1) return { success: false, error: 'Not found' };
  const duel = ds[dIdx];
  const st = String(duel[4] || '').trim();
  if (['settled','refunded','cancelled'].includes(st)) return { success: false, error: 'Finalized', status: st };
  const s = toNum(duel[3], 0), pot = toNum(duel[7], 0);
  const bets = bs.map((b, idx) => ({ row: b, idx })).filter(({ row }) => isDataRow(row, 'bet_id') && String(row[1] || '').trim() === did);

  const winners = bets.filter(({ row }) => toNum(row[3]) === H && toNum(row[4]) === A);
  const winnerIds = [];

  if (winners.length === 0) {
    for (const { row, idx } of bets) {
      const uid = String(row[2] || '').trim();
      await awardFantiki(uid, s, 'duel_refund', did, `duel_refund|${did}|${uid}`);
      const u = padRow(row, EXPECTED_COLUMNS.DuelBets); u[6] = 'refunded';
      await writeRow('DuelBets', idx, u);
    }
  } else {
    const share = Math.floor(pot / winners.length);
    const remainder = pot - share * winners.length;
    for (let i = 0; i < winners.length; i++) {
      const { row, idx } = winners[i];
      const uid = String(row[2] || '').trim();
      const amount = share + (i === 0 ? remainder : 0);
      await awardFantiki(uid, amount, 'duel_win', did, `duel_win|${did}|${uid}`);
      const u = padRow(row, EXPECTED_COLUMNS.DuelBets); u[6] = 'winner';
      await writeRow('DuelBets', idx, u);
      winnerIds.push(uid);
    }
    for (const { row, idx } of bets) {
      if (winners.some(w => w.idx === idx)) continue;
      const u = padRow(row, EXPECTED_COLUMNS.DuelBets); u[6] = 'loser';
      await writeRow('DuelBets', idx, u);
    }
  }
  const upd = padRow(duel, EXPECTED_COLUMNS.Duels);
  upd[4] = 'settled'; upd[6] = new Date().toISOString(); upd[8] = winnerIds.join(',');
  await writeRow('Duels', dIdx, upd);
  return { success: true, winners: winnerIds.length, refunded: winners.length === 0 ? bets.length : 0, winnerIds, pot };
}

async function refundDuel(duelId, reason) {
  const did = String(duelId).trim();
  const { Duels: ds, DuelBets: bs } = await batchGetSheets([{ sheet: 'Duels', range: 'A:I' }, { sheet: 'DuelBets', range: 'A:G' }]);
  const dIdx = ds.findIndex(r => isDataRow(r, 'duel_id') && String(r[0] || '').trim() === did);
  if (dIdx === -1) return { success: false };
  const duel = ds[dIdx];
  const st = String(duel[4] || '').trim();
  if (st !== 'open' && st !== 'full') return { success: false };
  const s = toNum(duel[3], 0);
  const bets = bs.map((b, idx) => ({ row: b, idx })).filter(({ row }) => isDataRow(row, 'bet_id') && String(row[1] || '').trim() === did);
  for (const { row, idx } of bets) {
    const uid = String(row[2] || '').trim();
    await awardFantiki(uid, s, 'duel_refund', did, `duel_refund|${did}|${uid}`);
    const u = padRow(row, EXPECTED_COLUMNS.DuelBets); u[6] = 'refunded';
    await writeRow('DuelBets', idx, u);
  }
  const upd = padRow(duel, EXPECTED_COLUMNS.Duels);
  upd[4] = 'refunded'; upd[6] = new Date().toISOString();
  await writeRow('Duels', dIdx, upd);
  return { success: true, refunded: bets.length, reason };
}

async function settleDuelsForMatch(matchId) {
  const mid = String(matchId).trim();
  const matchesData = await getSheetData('Matches', 'A:J');
  const match = matchesData.find(r => isDataRow(r, 'match_id') && String(r[0]).trim() === mid);
  if (!match) return { settled: 0, refunded: 0 };
  const st = String(match[5] || '').trim();
  const H = toScore(match[6]), A = toScore(match[7]);
  const ds = await getSheetData('Duels', 'A:I');
  const pending = ds.filter(r => isDataRow(r, 'duel_id') && String(r[1] || '').trim() === mid && ['open','full'].includes(String(r[4] || '').trim()));
  let settled = 0, refunded = 0;
  for (const d of pending) {
    const did = String(d[0]).trim();
    if (st === 'finished' && H !== null && A !== null) { const r = await settleDuel(did, H, A); if (r.success) settled++; }
    else if (st === 'postponed' || st === 'cancelled') { const r = await refundDuel(did, st); if (r.success) refunded++; }
  }
  return { settled, refunded };
}

async function settleAllPendingDuels() {
  const matchesData = await getSheetData('Matches', 'A:J');
  const ds = await getSheetData('Duels', 'A:I');
  const mMap = new Map();
  matchesData.forEach(r => { if (isDataRow(r, 'match_id')) mMap.set(String(r[0]).trim(), r); });
  const pending = ds.filter(r => isDataRow(r, 'duel_id') && ['open','full'].includes(String(r[4] || '').trim()));
  let settled = 0, refunded = 0;
  for (const d of pending) {
    const mid = String(d[1] || '').trim();
    const m = mMap.get(mid);
    if (!m) continue;
    const st = String(m[5] || '').trim();
    const H = toScore(m[6]), A = toScore(m[7]);
    const did = String(d[0]).trim();
    if (st === 'finished' && H !== null && A !== null) { const r = await settleDuel(did, H, A); if (r.success) settled++; }
    else if (st === 'postponed' || st === 'cancelled') { const r = await refundDuel(did, st); if (r.success) refunded++; }
  }
  return { settled, refunded };
}

async function listOpenDuels() {
  const { Duels: ds, DuelBets: bs, Matches: ms, Users: us } = await batchGetSheets([
    { sheet: 'Duels', range: 'A:I' }, { sheet: 'DuelBets', range: 'A:G' },
    { sheet: 'Matches', range: 'A:J' }, { sheet: 'Users', range: 'A:R' },
  ]);
  const mMap = new Map(), uMap = new Map();
  ms.forEach(r => { if (isDataRow(r, 'match_id')) mMap.set(String(r[0]).trim(), r); });
  us.forEach(r => { if (isDataRow(r, 'user_id')) uMap.set(String(r[0]).trim(), r[2] || r[1] || r[0]); });
  const betsByDuel = new Map();
  bs.forEach(b => { if (!isDataRow(b, 'bet_id')) return; const k = String(b[1] || '').trim(); if (!betsByDuel.has(k)) betsByDuel.set(k, []); betsByDuel.get(k).push(b); });
  const result = [];
  for (const d of ds) {
    if (!isDataRow(d, 'duel_id')) continue;
    const st = String(d[4] || '').trim();
    if (st !== 'open' && st !== 'full') continue;
    const did = String(d[0]).trim(), mid = String(d[1] || '').trim();
    const m = mMap.get(mid);
    if (!m || String(m[5] || '').trim() !== 'scheduled') continue;
    const bets = betsByDuel.get(did) || [];
    result.push({
      duel_id: did, match_id: mid,
      home_team: m[2] || '', away_team: m[3] || '', kickoff_utc: m[4] || '', stage: m[1] || '',
      creator_id: String(d[2] || '').trim(), creator_name: uMap.get(String(d[2] || '').trim()) || '',
      stake: toNum(d[3], 0), status: st, pot: toNum(d[7], 0),
      participants_count: bets.length,
      participants: bets.map(b => ({ userId: String(b[2] || '').trim(), displayName: uMap.get(String(b[2] || '').trim()) || '', predictedHome: toNum(b[3], 0), predictedAway: toNum(b[4], 0) })),
      created_at: d[5] || '',
    });
  }
  result.sort((a, b) => (new Date(a.kickoff_utc).getTime() || 0) - (new Date(b.kickoff_utc).getTime() || 0));
  return result;
}

async function listMyDuels(userId) {
  const uid = String(userId).trim();
  const { Duels: ds, DuelBets: bs, Matches: ms, Users: us } = await batchGetSheets([
    { sheet: 'Duels', range: 'A:I' }, { sheet: 'DuelBets', range: 'A:G' },
    { sheet: 'Matches', range: 'A:J' }, { sheet: 'Users', range: 'A:R' },
  ]);
  const mMap = new Map(), uMap = new Map();
  ms.forEach(r => { if (isDataRow(r, 'match_id')) mMap.set(String(r[0]).trim(), r); });
  us.forEach(r => { if (isDataRow(r, 'user_id')) uMap.set(String(r[0]).trim(), r[2] || r[1] || r[0]); });
  const myBetByDuel = new Map();
  const betsByDuel = new Map();
  bs.forEach(b => {
    if (!isDataRow(b, 'bet_id')) return;
    const did = String(b[1] || '').trim();
    if (!betsByDuel.has(did)) betsByDuel.set(did, []);
    betsByDuel.get(did).push(b);
    if (String(b[2] || '').trim() === uid) myBetByDuel.set(did, b);
  });
  const result = [];
  for (const d of ds) {
    if (!isDataRow(d, 'duel_id')) continue;
    const did = String(d[0]).trim();
    if (!myBetByDuel.has(did)) continue;
    const mid = String(d[1] || '').trim();
    const m = mMap.get(mid);
    if (!m) continue;
    const myBet = myBetByDuel.get(did);
    const bets = betsByDuel.get(did) || [];
    result.push({
      duel_id: did, match_id: mid,
      home_team: m[2] || '', away_team: m[3] || '', kickoff_utc: m[4] || '', stage: m[1] || '',
      home_score: toScore(m[6]), away_score: toScore(m[7]), match_status: m[5] || '',
      creator_id: String(d[2] || '').trim(), creator_name: uMap.get(String(d[2] || '').trim()) || '',
      stake: toNum(d[3], 0), status: String(d[4] || '').trim(), pot: toNum(d[7], 0),
      settled_at: d[6] || '', winner_ids: String(d[8] || '').split(',').filter(Boolean),
      my_bet: { predictedHome: toNum(myBet[3], 0), predictedAway: toNum(myBet[4], 0), result: myBet[6] || 'pending' },
      participants_count: bets.length,
      participants: bets.map(b => ({ userId: String(b[2] || '').trim(), displayName: uMap.get(String(b[2] || '').trim()) || '', predictedHome: toNum(b[3], 0), predictedAway: toNum(b[4], 0), result: b[6] || 'pending' })),
      created_at: d[5] || '',
    });
  }
  result.sort((a, b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0));
  return result;
}

async function checkMatchdayStreakBonus(matchdayKey) {
  const m = await getSheetData('Matches', 'A:J');
  const dm = m.filter(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === matchdayKey);
  if (!dm.length) return null;
  if (!dm.every(r => ['finished','postponed','cancelled'].includes(String(r[5] || '').trim()))) return null;
  const b = await getSheetData('MatchdayBonuses', 'A:G');
  if (b.some(r => isDataRow(r, 'bonus_id') && String(r[1] || '').trim() === matchdayKey && String(r[2] || '').trim() === 'streak')) return null;
  const { Predictions: p } = await batchGetSheets([{ sheet: 'Predictions', range: 'A:K' }]);
  const ids = new Set(dm.map(r => String(r[0]).trim()));
  const lm = getLatestPredictionMap(p);
  const cnts = new Map();
  for (const it of lm.values()) {
    const row = p[it.idx];
    if (!row) continue;
    if (!ids.has(String(row[2] || '').trim())) continue;
    if (String(row[8] || '').trim() !== 'exact') continue;
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    cnts.set(uid, (cnts.get(uid) || 0) + 1);
  }
  let total = 0, awarded = 0;
  for (const [uid, cnt] of cnts) {
    let b = 0;
    if (cnt >= 5) b = 300; else if (cnt === 4) b = 150; else if (cnt === 3) b = 75; else if (cnt === 2) b = 25;
    if (b > 0) { const r = await awardFantiki(uid, b, 'daily_streak_bonus', matchdayKey, `daily_streak|${matchdayKey}|${uid}`); if (r.success) { total += b; awarded++; } }
  }
  await appendRows('MatchdayBonuses', [[`bonus_streak_${matchdayKey}`, matchdayKey, 'streak', '', '', total, new Date().toISOString()]]);
  return { matchdayKey, awardedCount: awarded, totalBonus: total };
}

async function checkRoundPrizes(matchdayKey) {
  const m = await getSheetData('Matches', 'A:J');
  const dm = m.filter(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === matchdayKey);
  if (!dm.length) return null;
  if (!dm.every(r => ['finished','postponed','cancelled'].includes(String(r[5] || '').trim()))) return null;
  const b = await getSheetData('MatchdayBonuses', 'A:G');
  if (b.some(r => isDataRow(r, 'bonus_id') && String(r[1] || '').trim() === matchdayKey && String(r[2] || '').trim() === 'round_prize')) return null;
  const { Predictions: p } = await batchGetSheets([{ sheet: 'Predictions', range: 'A:K' }]);
  const ids = new Set(dm.map(r => String(r[0]).trim()));
  const byId = new Map(); dm.forEach(r => byId.set(String(r[0]).trim(), r));
  const lm = getLatestPredictionMap(p);
  const pts = new Map();
  for (const it of lm.values()) {
    const row = p[it.idx];
    if (!row) continue;
    const mid = String(row[2] || '').trim();
    if (!ids.has(mid)) continue;
    if (String(row[8] || '').trim() === 'duplicate') continue;
    const match = byId.get(mid);
    if (!match) continue;
    const H = toScore(match[6]), A = toScore(match[7]);
    if (H === null || A === null) continue;
    const r = calculatePoints(row[3], row[4], H, A);
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    pts.set(uid, (pts.get(uid) || 0) + r.points);
  }
  const sorted = [...pts.entries()].sort((a, b) => b[1] - a[1]);
  const rewards = { 1: 100, 2: 60, 3: 30 };
  const prizes = new Map();
  let pos = 1, i = 0;
  while (i < sorted.length && pos <= 3) {
    const val = sorted[i][1];
    const grp = [];
    while (i < sorted.length && sorted[i][1] === val) { grp.push(sorted[i][0]); i++; }
    const amt = rewards[pos] || 0;
    if (amt > 0) for (const uid of grp) prizes.set(uid, { place: pos, amount: amt });
    pos += grp.length;
  }
  let total = 0, awarded = 0;
  const rows = [];
  for (const [uid, { place, amount }] of prizes) {
    const r = await awardFantiki(uid, amount, 'round_prize', matchdayKey, `round_prize|${matchdayKey}|${uid}`);
    if (r.success) { total += amount; awarded++; rows.push([`bonus_prize_${matchdayKey}_${uid}`, matchdayKey, 'round_prize', uid, place, amount, new Date().toISOString()]); }
  }
  if (rows.length) await appendRows('MatchdayBonuses', rows);
  await appendRows('MatchdayBonuses', [[`bonus_prize_marker_${matchdayKey}`, matchdayKey, 'round_prize', '', '', total, new Date().toISOString()]]);
  return { matchdayKey, awardedCount: awarded, totalAwarded: total };
}

async function checkRecentMatchdays() {
  const m = await getSheetData('Matches', 'A:J');
  const days = new Set(), now = Date.now();
  m.forEach(r => {
    if (!isDataRow(r, 'match_id')) return;
    const d = new Date(r[4] || '');
    if (!Number.isFinite(d.getTime())) return;
    const diff = now - d.getTime();
    if (diff > 0 && diff < 7 * 24 * 60 * 60 * 1000) { const k = getMatchdayKey(r[4]); if (k) days.add(k); }
  });
  const results = [];
  for (const k of days) {
    try {
      const s = await checkMatchdayStreakBonus(k);
      const p = await checkRoundPrizes(k);
      results.push({ key: k, streak: s, prize: p });
    } catch (e) { console.error(`Matchday ${k} failed:`, e.message); }
  }
  return results;
}

async function checkQuestsProgress(userId, matchdayKey) {
  if (!matchdayKey || !userId) return;
  const { Matches: m, Predictions: p, QuestsProgress: q } = await batchGetSheets([
    { sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }, { sheet: 'QuestsProgress', range: 'A:E' },
  ]);
  const dm = m.filter(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === matchdayKey && String(r[5] || '').trim() === 'scheduled');
  const ids = new Set(dm.map(r => String(r[0]).trim()));
  if (!ids.size) return;
  const lm = getLatestPredictionMap(p);
  const up = [...lm.values()].map(it => p[it.idx]).filter(r => r && String(r[1] || '').trim() === userId && ids.has(String(r[2] || '').trim()));
  const has = qid => q.some(r => isDataRow(r, 'user_id') && String(r[0] || '').trim() === userId && String(r[1] || '').trim() === qid && String(r[2] || '').trim() === matchdayKey);
  const award = async (qid, amt) => { if (has(qid)) return; await awardFantiki(userId, amt, `quest_${qid}`, matchdayKey, `quest|${qid}|${matchdayKey}|${userId}`); await appendRows('QuestsProgress', [[userId, qid, matchdayKey, new Date().toISOString(), amt]]); };
  if (up.length >= 5) await award('predict_5', 30);
  if (dm.length > 0 && up.length >= dm.length) await award('predict_all', 50);
  if (up.some(r => String(r[8] || '').trim() === 'exact')) await award('first_exact', 20);
  const oc = up.filter(r => ['outcome','difference','exact','draw'].includes(String(r[8] || '').trim())).length;
  if (oc >= 3) await award('three_outcomes', 15);
}

async function calculateSeasonTitles() {
  const { Predictions: p, Matches: m } = await batchGetSheets([{ sheet: 'Predictions', range: 'A:K' }, { sheet: 'Matches', range: 'A:J' }]);
  const byId = new Map(); m.forEach(r => { if (isDataRow(r, 'match_id')) byId.set(String(r[0]).trim(), r); });
  const lm = getLatestPredictionMap(p);
  const stats = new Map();
  for (const it of lm.values()) {
    const row = p[it.idx];
    if (!row || String(row[8] || '').trim() === 'duplicate') continue;
    const match = byId.get(String(row[2] || '').trim());
    if (!match || String(match[5] || '').trim() !== 'finished') continue;
    const H = toScore(match[6]), A = toScore(match[7]);
    if (H === null || A === null) continue;
    const r = calculatePoints(row[3], row[4], H, A);
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    if (!stats.has(uid)) stats.set(uid, { total: 0, exact: 0, ok: 0, risky: 0, days: new Map() });
    const s = stats.get(uid);
    s.total++;
    if (r.points > 0) s.ok++;
    if (r.type === 'exact') {
      s.exact++;
      if (H + A >= 6) s.risky++;
      const d = getMatchdayKey(match[4]);
      if (d) s.days.set(d, (s.days.get(d) || 0) + 1);
    }
  }
  const t = { sniper: null, stable: null, risky: null, wild_round: [] };
  let bs = { uid: null, r: -1 }, bst = { uid: null, r: -1 }, br = { uid: null, c: -1 };
  for (const [uid, s] of stats) {
    if (s.total < 10) continue;
    if (s.exact/s.total > bs.r) bs = { uid, r: s.exact/s.total, exact: s.exact, total: s.total };
    if (s.ok/s.total > bst.r) bst = { uid, r: s.ok/s.total, ok: s.ok, total: s.total };
    if (s.risky > br.c) br = { uid, c: s.risky };
    for (const [d, c] of s.days) if (c >= 3) t.wild_round.push({ uid, day: d, count: c });
  }
  if (bs.uid) t.sniper = { userId: bs.uid, ratio: bs.r, exact: bs.exact, total: bs.total };
  if (bst.uid) t.stable = { userId: bst.uid, ratio: bst.r, successful: bst.ok, total: bst.total };
  if (br.uid) t.risky = { userId: br.uid, count: br.c };
  return t;
}

function titleName(k) { return { sniper: 'Точный снайпер', stable: 'Стабильный', risky: 'Рисковый', wild_round: 'Лютый тур' }[k] || k; }

async function getSeasonTitlesForUser(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  const [cur, saved] = await Promise.all([calculateSeasonTitles(), getSheetData('SeasonBadges', 'A:F').catch(() => [])]);
  const badges = [];
  if (cur.sniper && cur.sniper.userId === uid) badges.push({ key: 'sniper', name: titleName('sniper'), scope: 'current', detail: `${cur.sniper.exact}/${cur.sniper.total} (${Math.round(cur.sniper.ratio * 100)}%)` });
  if (cur.stable && cur.stable.userId === uid) badges.push({ key: 'stable', name: titleName('stable'), scope: 'current', detail: `${cur.stable.successful}/${cur.stable.total} (${Math.round(cur.stable.ratio * 100)}%)` });
  if (cur.risky && cur.risky.userId === uid) badges.push({ key: 'risky', name: titleName('risky'), scope: 'current', detail: `ТС с 6+ голами: ${cur.risky.count}` });
  cur.wild_round.filter(w => w.uid === uid).forEach(w => badges.push({ key: 'wild_round', name: titleName('wild_round'), scope: 'current', detail: `${w.day}: ${w.count} ТС` }));
  saved.forEach(r => { if (!isDataRow(r, 'badge_id')) return; if (String(r[1] || '').trim() !== uid) return; badges.push({ key: r[3] || '', name: r[4] || '', scope: 'historical', season: r[2] || '', awardedAt: r[5] || '' }); });
  return { userId: uid, badges, currentTitles: cur };
}

async function recalculatePointsForMatch(matchId, hs, as) {
  const H = toScore(hs), A = toScore(as);
  if (H === null || A === null) return { predictionsUpdated: 0, fantikiAwarded: 0 };
  const mid = String(matchId).trim(), tg = H + A;
  const { Predictions: p, Users: u, Matches: m } = await batchGetSheets([
    { sheet: 'Predictions', range: 'A:K' }, { sheet: 'Users', range: 'A:R' }, { sheet: 'Matches', range: 'A:J' },
  ]);
  const matchRow = m.find(r => isDataRow(r, 'match_id') && String(r[0]).trim() === mid);
  const mdk = matchRow ? getMatchdayKey(matchRow[4]) : null;
  const lm = getLatestPredictionMap(p);
  const predUpdates = [], userDeltas = new Map(), fantikiDeltas = new Map();
  p.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'prediction_id')) return;
    if (String(row[2] || '').trim() !== mid) return;
    const uid = String(row[1] || '').trim();
    if (!uid) return;
    const latest = lm.get(`${uid}|${mid}`);
    if (!latest) return;
    const oldP = toNum(row[7], 0), oldT = String(row[8] || '').trim(), oldF = toNum(row[9], 0);
    const eD = () => { if (!userDeltas.has(uid)) userDeltas.set(uid, emptyUserDelta()); return userDeltas.get(uid); };
    const eF = () => { if (!fantikiDeltas.has(uid)) fantikiDeltas.set(uid, 0); return fantikiDeltas; };
    if (rowIndex !== latest.idx) {
      if (oldP !== 0 || oldT !== 'duplicate' || oldF !== 0) {
        const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
        upd[7] = 0; upd[8] = 'duplicate'; upd[9] = 0;
        predUpdates.push({ rowIndex, values: upd });
        addResultToDelta(eD(), { points: oldP, type: oldT }, -1);
        if (oldF !== 0) eF().set(uid, fantikiDeltas.get(uid) - oldF);
      }
      return;
    }
    const nr = calculatePoints(row[3], row[4], H, A);
    const uRow = u.find(r => isDataRow(r, 'user_id') && String(r[0]).trim() === uid);
    const lvl = uRow ? toNum(padRow(uRow, EXPECTED_COLUMNS.Users)[14], 0) : 0;
    const newF = calculatePredictionFantiki(nr.type, tg, lvl);
    const pCh = oldP !== nr.points || oldT !== nr.type;
    const fCh = oldF !== newF;
    if (pCh || fCh) {
      const upd = padRow(row, EXPECTED_COLUMNS.Predictions);
      if (pCh) { upd[6] = new Date().toISOString(); upd[7] = nr.points; upd[8] = nr.type; }
      if (fCh) upd[9] = newF;
      predUpdates.push({ rowIndex, values: upd });
    }
    if (pCh) { const d = eD(); addResultToDelta(d, { points: oldP, type: oldT }, -1); addResultToDelta(d, nr, 1); }
    if (fCh) { const f = eF(); f.set(uid, (f.get(uid) || 0) + (newF - oldF)); }
  });
  await batchWriteRows('Predictions', predUpdates);
  if (userDeltas.size) {
    const uu = [];
    for (const [uid, d] of userDeltas) {
      const idx = u.findIndex(r => isDataRow(r, 'user_id') && String(r[0]).trim() === uid);
      if (idx === -1) continue;
      const ur = padRow(u[idx], EXPECTED_COLUMNS.Users);
      ur[4] = Math.max(0, toNum(ur[4], 0) + d.points);
      ur[6] = Math.max(0, toNum(ur[6], 0) + d.successful);
      ur[7] = Math.max(0, toNum(ur[7], 0) + d.exact);
      ur[8] = Math.max(0, toNum(ur[8], 0) + d.difference);
      ur[9] = Math.max(0, toNum(ur[9], 0) + d.draws);
      ur[10] = Math.max(0, toNum(ur[10], 0) + d.outcomes);
      ur[11] = Math.max(0, toNum(ur[11], 0) + d.misses);
      uu.push({ rowIndex: idx, values: ur });
    }
    await batchWriteRows('Users', uu);
  }
  let ta = 0;
  for (const [uid, amt] of fantikiDeltas) {
    if (amt === 0) continue;
    await awardFantiki(uid, amt, amt > 0 ? 'prediction_award' : 'prediction_correction', mid, '');
    ta += amt;
  }
  if (mdk) await checkMatchdayStreakBonus(mdk).catch(console.error);
  await settleDuelsForMatch(mid).catch(console.error);
  
  for (const uid of userDeltas.keys()) {
    await checkReferralAward(uid).catch(console.error);
  }

  return { predictionsUpdated: predUpdates.length, fantikiAwarded: ta };
}

async function fetchUCLMatches() {
  const data = await fetchFootball(`/competitions/CL/matches?season=${SEASON}`);
  const apiMatches = data.matches || [];
  const matchesData = await getSheetData('Matches', 'A:J');
  const byId = new Map();
  matchesData.forEach((row, idx) => { if (isDataRow(row, 'match_id')) byId.set(String(row[0]).trim(), { row, rowIndex: idx }); });
  const newRows = [], updates = [], recalc = [];
  for (const am of apiMatches) {
    const mid = String(am.id);
    const home = translateTeam(am.homeTeam?.name || 'Unknown');
    const away = translateTeam(am.awayTeam?.name || 'Unknown');
    const ko = am.utcDate || '';
    const status = mapStatus(am.status), stage = mapStage(am.stage);
    const apiH = toScore(am.score?.fullTime?.home), apiA = toScore(am.score?.fullTime?.away);
    const ex = byId.get(mid);
    if (!ex) {
      let hs = '', as = '', ru = '';
      if (status === 'finished' && apiH !== null && apiA !== null) { hs = apiH; as = apiA; ru = new Date().toISOString(); }
      newRows.push([mid, stage, home, away, ko, status, hs, as, ru, 'FALSE']);
      if (status === 'finished' && apiH !== null && apiA !== null) recalc.push({ matchId: mid, hs: apiH, as: apiA });
      continue;
    }
    const cur = padRow(ex.row, EXPECTED_COLUMNS.Matches);
    if (String(cur[9] || '').toUpperCase() === 'TRUE') continue;
    const oS = String(cur[5] || '').trim(), oH = toScore(cur[6]), oA = toScore(cur[7]);
    let hs = cur[6], as = cur[7], ru = cur[8], rl = false;
    if (status === 'finished' && apiH !== null && apiA !== null) {
      hs = apiH; as = apiA;
      if (oS !== 'finished' || oH !== apiH || oA !== apiA) { ru = new Date().toISOString(); rl = true; }
    } else if (status !== 'finished') {
      hs = ''; as = ''; ru = '';
      if (oS === 'finished') rl = true;
    }
    const upd = [mid, stage, home, away, ko, status, hs, as, ru, cur[9] || 'FALSE'];
    if (isDifferentRow(cur, upd, EXPECTED_COLUMNS.Matches)) updates.push({ rowIndex: ex.rowIndex, values: upd });
    if (rl && apiH !== null && apiA !== null) recalc.push({ matchId: mid, hs: apiH, as: apiA });
  }
  await appendRows('Matches', newRows);
  await batchWriteRows('Matches', updates);
  for (const it of recalc) await recalculatePointsForMatch(it.matchId, it.hs, it.as);
  return { added: newRows.length, updated: updates.length, recalculated: recalc.length };
}

async function updateFinishedMatches() {
  const data = await fetchFootball(`/competitions/CL/matches?season=${SEASON}`);
  const apiMatches = (data.matches || []).filter(m => m.status === 'FINISHED');
  const matchesData = await getSheetData('Matches', 'A:J');
  let cnt = 0;
  for (const am of apiMatches) {
    const mid = String(am.id);
    const idx = matchesData.findIndex(r => isDataRow(r, 'match_id') && String(r[0]).trim() === mid);
    if (idx === -1) continue;
    const cur = padRow(matchesData[idx], EXPECTED_COLUMNS.Matches);
    if (String(cur[9] || '').toUpperCase() === 'TRUE') continue;
    const H = toScore(am.score?.fullTime?.home), A = toScore(am.score?.fullTime?.away);
    if (H === null || A === null) continue;
    if (String(cur[5] || '').trim() === 'finished' && toScore(cur[6]) === H && toScore(cur[7]) === A) continue;
    const upd = [...cur];
    upd[5] = 'finished'; upd[6] = H; upd[7] = A; upd[8] = new Date().toISOString(); upd[9] = cur[9] || 'FALSE';
    await writeRow('Matches', idx, upd);
    await recalculatePointsForMatch(mid, H, A);
    cnt++;
  }
  return cnt;
}

async function fetchMatchEvents(mid) { const d = await fetchFootball(`/matches/${mid}/events`); return d.events || []; }
function buildEventRows(mid, events, home, away) {
  if (!Array.isArray(events)) return [];
  const gt = new Set(['GOAL','PENALTY','OWN_GOAL','GOAL_PENALTY','SCORE_CHANGE']);
  const sc = events.filter(e => e && gt.has(String(e.type || '').toUpperCase()))
    .sort((a, b) => toNum(a.minute, 0) - toNum(b.minute, 0) || toNum(a.injuryTime, 0) - toNum(b.injuryTime, 0));
  let h = 0, a = 0; const rows = [];
  for (const e of sc) {
    const rawT = e.team?.name || ''; const t = translateTeam(rawT); const p = e.player?.name || '';
    const m = toNum(e.minute, 0), ad = toNum(e.injuryTime, 0);
    const nt = String(t || rawT || '').toLowerCase().trim();
    const nh = String(home || '').toLowerCase().trim();
    const na = String(away || '').toLowerCase().trim();
    if (nt && nh && nt === nh) h++;
    else if (nt && na && nt === na) a++;
    rows.push([mid, 'goal', t || rawT, m, ad, `${h}:${a}`, p]);
  }
  return rows;
}
async function updateMatchEventsForFinished() {
  const { Matches: m, MatchEvents: ev } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'MatchEvents', range: 'A:G' }]);
  const fin = m.filter(r => isDataRow(r, 'match_id') && String(r[5] || '').trim() === 'finished');
  const ex = new Set(ev.filter(r => isDataRow(r, 'match_id')).map(r => String(r[0]).trim()));
  const proc = fin.filter(r => !ex.has(String(r[0]).trim())).slice(0, EVENTS_BATCH_SIZE);
  for (const r of proc) {
    const mid = String(r[0]).trim();
    try {
      const evs = await fetchMatchEvents(mid);
      const rows = buildEventRows(mid, evs, String(r[2] || '').trim(), String(r[3] || '').trim());
      if (rows.length) await appendRows('MatchEvents', rows);
      else await appendRows('MatchEvents', [[mid, 'no_events', '', 0, 0, '', '']]);
    } catch (e) {
      console.error(`Events ${mid}:`, e.message);
      if (e.status === 403 || e.status === 404) await appendRows('MatchEvents', [[mid, 'events_unavailable', '', 0, 0, '', '']]);
    }
    if (r !== proc[proc.length - 1]) await sleep(5000);
  }
  return proc.length;
}

async function recalculateAll() {
  const { Users: u, Predictions: p, Matches: m } = await batchGetSheets([{ sheet: 'Users', range: 'A:R' }, { sheet: 'Predictions', range: 'A:K' }, { sheet: 'Matches', range: 'A:J' }]);
  const fin = new Map();
  m.forEach(r => {
    if (!isDataRow(r, 'match_id')) return;
    if (String(r[5] || '').trim() !== 'finished') return;
    const H = toScore(r[6]), A = toScore(r[7]);
    if (H === null || A === null) return;
    fin.set(String(r[0]).trim(), { homeScore: H, awayScore: A });
  });
  const lm = getLatestPredictionMap(p);
  const stats = new Map(), idxById = new Map();
  u.forEach((r, i) => {
    if (!isDataRow(r, 'user_id')) return;
    const uid = String(r[0]).trim();
    if (!uid) return;
    idxById.set(uid, i);
    stats.set(uid, { tp: 0, tpr: 0, sp: 0, ex: 0, gd: 0, dr: 0, oc: 0, ms: 0 });
  });
  const pu = [];
  p.forEach((r, i) => {
    if (!isDataRow(r, 'prediction_id')) return;
    const uid = String(r[1] || '').trim(), mid = String(r[2] || '').trim();
    if (!uid || !mid) return;
    const latest = lm.get(`${uid}|${mid}`);
    const oP = toNum(r[7], 0), oT = String(r[8] || '').trim();
    if (!latest || i !== latest.idx) {
      if (oP !== 0 || oT !== 'duplicate') {
        const upd = padRow(r, EXPECTED_COLUMNS.Predictions);
        upd[7] = 0; upd[8] = 'duplicate';
        pu.push({ rowIndex: i, values: upd });
      }
      return;
    }
    const st = stats.get(uid);
    if (st) st.tpr++;
    let pts = 0, typ = '';
    const fm = fin.get(mid);
    if (fm) {
      const res = calculatePoints(r[3], r[4], fm.homeScore, fm.awayScore);
      pts = res.points; typ = res.type;
      if (st) {
        st.tp += pts;
        if (pts > 0) st.sp++;
        if (typ === 'exact') st.ex++;
        if (typ === 'difference') st.gd++;
        if (typ === 'draw') st.dr++;
        if (typ === 'outcome') st.oc++;
        if (typ === 'miss') st.ms++;
      }
    }
    if (oP !== pts || oT !== typ) {
      const upd = padRow(r, EXPECTED_COLUMNS.Predictions);
      upd[6] = new Date().toISOString(); upd[7] = pts; upd[8] = typ;
      pu.push({ rowIndex: i, values: upd });
    }
  });
  const uu = [];
  for (const [uid, s] of stats) {
    const idx = idxById.get(uid);
    if (idx === undefined) continue;
    const ur = padRow(u[idx], EXPECTED_COLUMNS.Users);
    ur[4] = s.tp; ur[5] = s.tpr; ur[6] = s.sp; ur[7] = s.ex; ur[8] = s.gd; ur[9] = s.dr; ur[10] = s.oc; ur[11] = s.ms;
    uu.push({ rowIndex: idx, values: ur });
  }
  await batchWriteRows('Predictions', pu);
  await batchWriteRows('Users', uu);
  return fin.size;
}

async function getUserPredictionsResponse(userId, query = {}) {
  const { Matches: m, Predictions: p } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }]);
  const matches = m.filter(r => isDataRow(r, 'match_id'));
  const up = getLatestPredictionsForUser(p, userId);
  let r = up.map(x => {
    const mid = String(x[2]).trim();
    const match = matches.find(mm => String(mm[0]).trim() === mid);
    if (!match) return null;
    return { match_id: mid, stage: match[1] || '', home_team: match[2] || '', away_team: match[3] || '', kickoff_utc: match[4] || '', status: match[5] || '', home_score: toScore(match[6]), away_score: toScore(match[7]), predicted_home: toScore(x[3]), predicted_away: toScore(x[4]), points: toNum(x[7], 0), prediction_type: x[8] || '', fantiki_awarded: toNum(x[9], 0) };
  }).filter(Boolean);
  r = filterPredictionResponseByType(r, query.type);
  const sf = String(query.status || '').toLowerCase().trim();
  if (sf) r = r.filter(it => it.status === sf);
  return sortPredictionsResponse(r, query.sort);
}

let telegramOffset = 0, conflictCounter = 0;
async function callTelegram(method, params) {
  const url = `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/${method}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  if (!r.ok) { const t = await r.text(); throw new Error(`Telegram error: ${r.status} ${t}`); }
  return r.json();
}
function parsePredictionText(text) {
  const c = String(text || '').replace(/^\/predict(?:@\w+)?\s+/i, '').trim();
  const m = c.match(/^(.+?)\s+[-–—]\s+(.+?)\s+(\d{1,2})\s*:\s*(\d{1,2})$/i);
  if (!m) return null;
  const h = m[1].trim(), a = m[2].trim();
  if (!h || !a) return null;
  return { home: h, away: a, homeScore: Number(m[3]), awayScore: Number(m[4]) };
}
async function processTelegramMessage(msg) {
  const chatId = msg.chat?.id, from = msg.from, text = msg.text || '';
  if (!text || !from) return;
  const uid = String(from.id), un = from.username || '';
  const usersData = await getSheetData('Users', 'A:R');
  
  const refMatch = text.match(/^\/start\s+ref_(\d+)/);
  const refId = refMatch ? refMatch[1] : '';
  
  const userIndex = usersData.findIndex(row => isDataRow(row, 'user_id') && String(row[0]).trim() === uid);
  if (userIndex === -1) {
    let dn = from.first_name || un || 'User';
    if (from.last_name && from.first_name) dn = `${from.first_name} ${from.last_name}`;
    await appendRows('Users', [[uid, un, dn, new Date().toISOString(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, refId, 'FALSE']]);
  } else if (refId && refId !== uid) {
    const p = padRow(usersData[userIndex], EXPECTED_COLUMNS.Users);
    if (!p[16]) {
      p[16] = refId;
      await writeRow('Users', userIndex, p);
    }
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length || text.startsWith('/start')) return;
  
  const matchesData = await getSheetData('Matches', 'A:J');
  const matches = matchesData.filter(r => isDataRow(r, 'match_id'));
  let pd = await getSheetData('Predictions', 'A:K');
  let saved = 0;
  const aff = new Set();
  for (const line of lines) {
    const p = parsePredictionText(line);
    if (!p) continue;
    const hn = normalizeTeamName(p.home), an = normalizeTeamName(p.away);
    const match = matches.find(it => String(it[2] || '').toLowerCase().trim() === hn.toLowerCase() && String(it[3] || '').toLowerCase().trim() === an.toLowerCase());
    if (!match) continue;
    const mid = String(match[0]).trim(), st = String(match[5] || '').trim(), ko = new Date(match[4]);
    if (st !== 'scheduled' || !Number.isFinite(ko.getTime()) || Date.now() >= ko.getTime()) continue;
    const del = [];
    pd.forEach((row, i) => { if (isDataRow(row, 'prediction_id') && String(row[1]).trim() === uid && String(row[2]).trim() === mid) del.push(i); });
    await deleteRowsByRowIndices('Predictions', del);
    pd = pd.filter((_, i) => !del.includes(i));
    await appendRows('Predictions', [[`${uid}_${mid}`, uid, mid, p.homeScore, p.awayScore, new Date().toISOString(), new Date().toISOString(), 0, '', 0, 'FALSE']]);
    saved++;
    const k = getMatchdayKey(match[4]);
    if (k) aff.add(k);
  }
  if (saved > 0) {
    for (const k of aff) { try { await checkQuestsProgress(uid, k); } catch (e) { console.error('Quest:', e.message); } }
    await checkReferralAward(uid).catch(console.error);
    await callTelegram('sendMessage', { chat_id: chatId, text: `✅ Сохранено прогнозов: ${saved}` });
  }
}
async function startBotPolling() {
  if (!BOT_TOKEN) return;
  console.log('Запуск Telegram polling...');
  try { await callTelegram('deleteWebhook', { drop_pending_updates: false }); console.log('Webhook удалён.'); }
  catch (e) { console.warn('Webhook delete failed:', e.message); }
  while (true) {
    try {
      const res = await callTelegram('getUpdates', { offset: telegramOffset, timeout: 30, allowed_updates: ['message'] });
      if (res.ok && res.result.length > 0) {
        for (const u of res.result) {
          telegramOffset = u.update_id + 1;
          if (u.message) { try { await processTelegramMessage(u.message); } catch (e) { console.error('Msg:', e.message); } }
        }
      }
      conflictCounter = 0;
    } catch (e) {
      const m = String(e?.message || '');
      if (m.includes('409') || m.includes('Conflict')) {
        conflictCounter++;
        const w = conflictCounter <= 3 ? 10000 : 30000;
        if (conflictCounter <= 3) console.warn(`⚠️ 409. Ждём ${w/1000}с (${conflictCounter})`);
        await sleep(w);
      } else { console.error('Polling:', m || e); await sleep(5000); }
    }
    await sleep(1000);
  }
}
app.post(WEBHOOK_PATH, (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.status(403).json({ error: 'Forbidden' });
  res.status(200).json({ ok: true });
  if (req.body?.message) processTelegramMessage(req.body.message).catch(e => console.error('Webhook:', e.message));
});

app.get('/api/levels', (req, res) => res.json(LEVELS_DATA));

app.get('/api/fantiki/today/:userId', asyncHandler(async (req, res) => {
  const info = await getTodayBalance(req.params.userId);
  if (!info) return res.status(400).json({ error: 'userId required' });
  res.json(info);
}));

app.get('/api/standings/divisions', asyncHandler(async (req, res) => {
  res.json(await getDivisionsData());
}));

app.get('/api/standings/user-division/:userId', asyncHandler(async (req, res) => {
  const uid = String(req.params.userId || '').trim();
  if (!uid) return res.status(400).json({ error: 'userId required' });
  const data = await getDivisionsData();
  for (const div of data.divisions) {
    const u = div.users.find(x => x.userId === uid);
    if (u) return res.json({ division: div.division, name: div.name, position: u.position, size: div.size, totalUsers: data.totalUsers });
  }
  res.status(404).json({ error: 'User not found' });
}));

app.get('/api/referral/info/:userId', asyncHandler(async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });
  
  const usersData = await getSheetData('Users', 'A:R');
  const refs = usersData.filter(r => isDataRow(r, 'user_id') && String(r[16] || '').trim() === userId);
  const total = refs.length;
  const completed = refs.filter(r => String(r[17] || '').trim().toUpperCase() === 'TRUE').length;
  
  const link = `https://t.me/${BOT_USERNAME}?start=ref_${userId}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(link)}&color=3b82f6&bgcolor=1e293b`;
  
  res.json({ link, qrUrl, total, completed });
}));

app.get('/api/referral/leaderboard', asyncHandler(async (req, res) => {
  const usersData = await getSheetData('Users', 'A:R');
  const counts = new Map();
  usersData.forEach(r => {
    if (!isDataRow(r, 'user_id')) return;
    const by = String(r[16] || '').trim();
    if (by && String(r[17] || '').trim().toUpperCase() === 'TRUE') {
      counts.set(by, (counts.get(by) || 0) + 1);
    }
  });
  const names = new Map();
  usersData.forEach(r => { if (isDataRow(r, 'user_id')) names.set(String(r[0]).trim(), r[2] || r[1] || r[0]); });
  const table = [...counts.entries()].map(([uid, cnt]) => ({ userId: uid, displayName: names.get(uid) || uid, count: cnt })).sort((a,b) => b.count - a.count).slice(0, 10);
  res.json(table);
}));

app.post('/api/duels/create', asyncHandler(async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { matchId, predictedHome, predictedAway, stake } = req.body;
  const r = await createDuel(userId, matchId, predictedHome, predictedAway, stake);
  if (!r.success) return res.status(400).json(r);
  res.json(r);
}));
app.post('/api/duels/join/:duelId', asyncHandler(async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { predictedHome, predictedAway } = req.body;
  const r = await joinDuel(userId, req.params.duelId, predictedHome, predictedAway);
  if (!r.success) return res.status(400).json(r);
  res.json(r);
}));
app.post('/api/duels/cancel/:duelId', asyncHandler(async (req, res) => {
  const userId = extractUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const r = await cancelDuel(userId, req.params.duelId);
  if (!r.success) return res.status(400).json(r);
  res.json(r);
}));
app.get('/api/duels/open', asyncHandler(async (req, res) => {
  res.json(await listOpenDuels());
}));
app.get('/api/duels/my/:userId', asyncHandler(async (req, res) => {
  const uid = String(req.params.userId || '').trim();
  if (!uid) return res.status(400).json({ error: 'userId required' });
  res.json(await listMyDuels(uid));
}));
app.get('/api/duels/:duelId', asyncHandler(async (req, res) => {
  const did = String(req.params.duelId || '').trim();
  const all = await listOpenDuels();
  const found = all.find(d => d.duel_id === did);
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.json(found);
}));
app.post('/api/admin/settle-duels', requireAdmin, asyncHandler(async (req, res) => {
  const r = await settleAllPendingDuels();
  res.json({ success: true, ...r });
}));

app.get('/api/fantiki/balance/:userId', asyncHandler(async (req, res) => {
  const info = await getBalance(req.params.userId);
  if (!info) return res.status(404).json({ error: 'User not found' });
  res.json(info);
}));
app.get('/api/fantiki/transactions/:userId', asyncHandler(async (req, res) => {
  const uid = String(req.params.userId || '').trim();
  if (!uid) return res.status(400).json({ error: 'userId required' });
  const lim = Math.min(Math.max(toNum(req.query.limit, 50), 1), 200);
  const txData = await getSheetData('FantikiTransactions', 'A:G');
  res.json(txData.filter(r => isDataRow(r, 'tx_id') && String(r[1] || '').trim() === uid).slice(-lim).reverse()
    .map(r => ({ id: r[0] || '', amount: toNum(r[2], 0), reason: r[3] || '', refId: r[4] || '', createdAt: r[5] || '', balanceAfter: toNum(r[6], 0) })));
}));
app.post('/api/daily-login', asyncHandler(async (req, res) => {
  const user = extractAuthenticatedUser(req);
  if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const uid = String(user.id).trim();
  const today = new Date().toISOString().slice(0, 10);
  const m = await getSheetData('Matches', 'A:J');
  if (!m.some(r => isDataRow(r, 'match_id') && getMatchdayKey(r[4]) === today)) return res.json({ success: false, reason: 'no_matches_today', date: today });
  const tx = await getSheetData('FantikiTransactions', 'A:G');
  if (tx.some(r => isDataRow(r, 'tx_id') && String(r[1] || '').trim() === uid && String(r[3] || '').trim() === 'daily_login' && String(r[4] || '').trim() === today))
    return res.json({ success: false, reason: 'already_claimed_today', date: today });
  const r = await awardFantiki(uid, 10, 'daily_login', today, `daily_login|${uid}|${today}`);
  res.json({ success: true, date: today, amount: 10, ...r });
}));

app.get('/api/season-titles', asyncHandler(async (req, res) => res.json(await calculateSeasonTitles())));
app.get('/api/season-titles/:userId', asyncHandler(async (req, res) => {
  const r = await getSeasonTitlesForUser(req.params.userId);
  if (!r) return res.status(400).json({ error: 'userId required' });
  res.json(r);
}));

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
  const k = String(req.params.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return res.status(400).json({ error: 'YYYY-MM-DD required' });
  const s = await checkMatchdayStreakBonus(k);
  const p = await checkRoundPrizes(k);
  const d = await settleDuelsForMatch(k);
  res.json({ success: true, matchday: k, streak: s, prize: p, duels: d });
}));
app.post('/api/admin/finalize-recent', requireAdmin, asyncHandler(async (req, res) => {
  const results = await checkRecentMatchdays();
  const duels = await settleAllPendingDuels();
  res.json({ success: true, results, duels });
}));
app.post('/api/admin/finalize-all', requireAdmin, asyncHandler(async (req, res) => {
  if (heavyJobRunning) return res.status(409).json({ error: 'Another heavy job running' });
  const daysParam = req.query.days ? Number(req.query.days) : null;
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.floor(daysParam) : null;
  res.json({ success: true, scope: days ? `last ${days} days` : 'all', message: 'Started in background.' });
  (async () => {
    heavyJobRunning = true;
    try {
      const cut = days ? Date.now() - days * 86400000 : 0;
      const lbl = days ? `за ${days} дн.` : 'за всё время';
      console.log(`🔄 [finalize-all] SCOPE: ${lbl}`);
      const md = await getSheetData('Matches', 'A:J');
      const fin = md.filter(r => {
        if (!isDataRow(r, 'match_id')) return false;
        if (String(r[5] || '').trim() !== 'finished') return false;
        if (toScore(r[6]) === null || toScore(r[7]) === null) return false;
        if (!days) return true;
        const k = new Date(r[4] || '').getTime();
        return Number.isFinite(k) && k >= cut;
      });
      console.log(`🔄 [finalize-all] ${fin.length} матчей`);
      const ds = new Set(); let p = 0, e = 0;
      for (const r of fin) {
        const mid = String(r[0]).trim();
        try {
          await recalculatePointsForMatch(mid, toScore(r[6]), toScore(r[7]));
          p++;
          const k = getMatchdayKey(r[4]);
          if (k) ds.add(k);
          if (p % 5 === 0) console.log(`[finalize-all] ${p}/${fin.length}`);
        } catch (err) { console.error(`Match ${mid}:`, err.message); e++; }
        await sleep(500);
      }
      for (const k of ds) {
        try {
          const s = await checkMatchdayStreakBonus(k);
          const pr = await checkRoundPrizes(k);
          if ((s && s.awardedCount > 0) || (pr && pr.awardedCount > 0)) console.log(`[finalize-all] ${k}: streak ${s?.awardedCount||0}, prize ${pr?.awardedCount||0}`);
        } catch (err) { console.error(`Matchday ${k}:`, err.message); }
      }
      const duels = await settleAllPendingDuels();
      console.log(`✅ [finalize-all] DONE: ${p} матчей, ${e} ошибок, duels settled ${duels.settled}, refunded ${duels.refunded}`);
    } catch (e) { console.error('❌ [finalize-all] FATAL:', e); }
    finally { heavyJobRunning = false; }
  })();
}));

app.post('/api/admin/reset-season', requireAdmin, asyncHandler(async (req, res) => {
  const lbl = String(req.body?.seasonLabel || `${SEASON}-final`).trim();
  const t = await calculateSeasonTitles();
  const rows = [], now = new Date().toISOString();
  const addB = (uid, k) => rows.push([`badge_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, uid, lbl, k, titleName(k), now]);
  if (t.sniper) addB(t.sniper.userId, 'sniper');
  if (t.stable) addB(t.stable.userId, 'stable');
  if (t.risky) addB(t.risky.userId, 'risky');
  t.wild_round.forEach(w => addB(w.uid, 'wild_round'));
  if (rows.length) await appendRows('SeasonBadges', rows);
  const u = await getSheetData('Users', 'A:R');
  const upd = [];
  u.forEach((r, i) => {
    if (!isDataRow(r, 'user_id')) return;
    const ur = padRow(r, EXPECTED_COLUMNS.Users);
    const earned = toNum(ur[13], 0);
    ur[12] = 0; ur[13] = 0; ur[14] = 0; ur[15] = toNum(ur[15], 0) + earned;
    upd.push({ rowIndex: i, values: ur });
  });
  if (upd.length) await batchWriteRows('Users', upd);
  res.json({ success: true, seasonLabel: lbl, badgesSaved: rows.length, usersReset: upd.length, titles: t });
}));

app.get('/api/standings-history', asyncHandler(async (req, res) => {
  const { Matches: m, Predictions: p } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }]);
  const fm = m.filter(r => isDataRow(r, 'match_id') && String(r[5] || '').trim() === 'finished').map(r => ({ matchId: String(r[0]).trim(), ts: new Date(r[8] || r[4] || '').getTime() || 0 })).sort((a, b) => a.ts - b.ts);
  if (!fm.length) return res.json({ previousPositions: {}, currentPositions: {} });
  const ids = fm.map(x => x.matchId), prev = ids.slice(0, -1);
  const calc = s => {
    const ss = new Set(s), up = new Map();
    p.forEach(r => {
      if (!isDataRow(r, 'prediction_id')) return;
      if (!ss.has(String(r[2] || '').trim())) return;
      const u = String(r[1] || '').trim();
      if (String(r[8] || '').trim() === 'duplicate') return;
      up.set(u, (up.get(u) || 0) + toNum(r[7], 0));
    });
    const pos = {}; [...up.entries()].sort((a, b) => b[1] - a[1]).forEach(([uid], i) => pos[uid] = i + 1);
    return pos;
  };
  res.json({ previousPositions: calc(prev), currentPositions: calc(ids) });
}));
app.get('/api/user-points-history/:userId', asyncHandler(async (req, res) => {
  const uid = String(req.params.userId || '').trim();
  if (!uid) return res.status(400).json({ error: 'userId required' });
  const { Matches: m, Predictions: p } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }]);
  const byId = new Map(); m.forEach(r => { if (isDataRow(r, 'match_id')) byId.set(String(r[0]).trim(), r); });
  const lm = getLatestPredictionMap(p);
  const daily = new Map();
  for (const it of lm.values()) {
    const row = p[it.idx];
    if (!row || String(row[1] || '').trim() !== uid) continue;
    if (String(row[8] || '').trim() === 'duplicate') continue;
    const match = byId.get(String(row[2] || '').trim());
    if (!match || String(match[5] || '').trim() !== 'finished') continue;
    const H = toScore(match[6]), A = toScore(match[7]);
    if (H === null || A === null) continue;
    const r = calculatePoints(row[3], row[4], H, A);
    const d = new Date(match[8] || match[4] || '');
    if (!Number.isFinite(d.getTime())) continue;
    const k = d.toISOString().slice(0, 10);
    daily.set(k, (daily.get(k) || 0) + r.points);
  }
  res.json([...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, pts]) => ({ date: d, label: new Date(`${d}T00:00:00Z`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }), points: pts })));
}));
app.get('/api/standings-last-round', asyncHandler(async (req, res) => {
  const { Matches: m, Predictions: p, Users: u } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }, { sheet: 'Users', range: 'A:R' }]);
  const fm = m.filter(r => isDataRow(r, 'match_id') && String(r[5] || '').trim() === 'finished').map(r => ({ matchId: String(r[0]).trim(), ts: new Date(r[8] || r[4] || '').getTime() || 0 })).filter(x => x.ts > 0).sort((a, b) => b.ts - a.ts);
  if (!fm.length) return res.json([]);
  const cut = fm[0].ts - 3 * 86400000;
  const ids = new Set(fm.filter(x => x.ts >= cut).map(x => x.matchId));
  const lm = getLatestPredictionMap(p);
  const byId = new Map(); m.forEach(r => { if (isDataRow(r, 'match_id')) byId.set(String(r[0]).trim(), r); });
  const stats = new Map();
  for (const it of lm.values()) {
    const row = p[it.idx];
    if (!row) continue;
    const mid = String(row[2] || '').trim();
    if (!ids.has(mid) || String(row[8] || '').trim() === 'duplicate') continue;
    const uid = String(row[1] || '').trim();
    if (!uid) continue;
    const match = byId.get(mid);
    if (!match) continue;
    const H = toScore(match[6]), A = toScore(match[7]);
    if (H === null || A === null) continue;
    const r = calculatePoints(row[3], row[4], H, A);
    if (!stats.has(uid)) stats.set(uid, { points: 0, exact: 0, difference: 0, draw: 0, outcome: 0, miss: 0 });
    const s = stats.get(uid);
    s.points += r.points;
    if (r.type === 'exact') s.exact++;
    else if (r.type === 'difference') s.difference++;
    else if (r.type === 'draw') s.draw++;
    else if (r.type === 'outcome') s.outcome++;
    else if (r.type === 'miss') s.miss++;
  }
  const names = new Map();
  u.forEach(r => { if (isDataRow(r, 'user_id')) names.set(String(r[0]).trim(), r[2] || r[1] || String(r[0]).trim()); });
  const table = [...stats.entries()].map(([uid, s]) => ({ userId: uid, displayName: names.get(uid) || uid, ...s })).sort((a, b) => b.points - a.points || b.exact - a.exact);
  table.forEach((r, i) => r.position = i + 1);
  res.json(table);
}));
app.post('/api/auth', asyncHandler(async (req, res) => {
  const s = req.body.initData;
  let user = null;
  if (s) {
    if (BOT_TOKEN && !verifyTelegramInitData(s)) return res.status(403).json({ error: 'Invalid initData' });
    try { user = JSON.parse(new URLSearchParams(s).get('user') || 'null'); } catch { user = null; }
  }
  if (!user?.id && ALLOW_PLAIN_USER_ID && isNotEmpty(req.body.userId)) user = { id: req.body.userId, username: req.body.username || '', first_name: req.body.firstName || '', last_name: req.body.lastName || '' };
  if (!user?.id) return res.status(400).json({ error: 'userId required' });
  const uid = String(user.id).trim();
  const u = await getSheetData('Users', 'A:R');
  const existing = u.find(r => isDataRow(r, 'user_id') && String(r[0]).trim() === uid);
  if (!existing) {
    let dn = user.first_name || user.username || 'User';
    if (user.last_name && user.first_name) dn = `${user.first_name} ${user.last_name}`;
    await appendRows('Users', [[uid, user.username || '', dn, new Date().toISOString(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, req.body.refId || '', 'FALSE']]);
    return res.json({ userId: uid, displayName: dn });
  }
  res.json({ userId: uid, displayName: existing[2] || existing[1] || 'User' });
}));
app.get('/api/matches', asyncHandler(async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId).trim() : null;
  const { Matches: m, Predictions: p } = await batchGetSheets([{ sheet: 'Matches', range: 'A:J' }, { sheet: 'Predictions', range: 'A:K' }]);
  const matches = m.filter(r => isDataRow(r, 'match_id'));
  const up = userId ? getLatestPredictionsForUser(p, userId) : [];
  let r = matches.map(row => {
    const mid = String(row[0]).trim();
    const u = up.find(x => String(x[2]).trim() === mid);
    return { match_id: mid, stage: row[1] || '', home_team: row[2] || '', away_team: row[3] || '', kickoff_utc: row[4] || '', status: row[5] || '', home_score: toScore(row[6]), away_score: toScore(row[7]), user_has_predicted: Boolean(u), user_prediction: u ? { home: toScore(u[3]), away: toScore(u[4]) } : null };
  });
  const incFin = String(req.query.includeFinished || 'true').toLowerCase() !== 'false';
  const sf = String(req.query.status || '').toLowerCase().trim();
  if (!incFin) r = r.filter(x => x.status !== 'finished');
  if (sf) r = r.filter(x => x.status === sf);
  r.sort((a, b) => (new Date(a.kickoff_utc).getTime() || Infinity) - (new Date(b.kickoff_utc).getTime() || Infinity));
  res.json(r);
}));
app.get('/api/my-predictions', asyncHandler(async (req, res) => {
  const uid = req.query.userId ? String(req.query.userId).trim() : '';
  if (!uid) return res.status(400).json({ error: 'userId required' });
  res.json(await getUserPredictionsResponse(uid, req.query));
}));
app.get('/api/user-predictions/:userId', asyncHandler(async (req, res) => {
  const uid = String(req.params.userId || '').trim();
  if (!uid) return res.status(400).json({ error: 'userId required' });
  res.json(await getUserPredictionsResponse(uid, req.query));
}));
app.post('/api/predictions', asyncHandler(async (req, res) => {
  const uid = extractUserId(req);
  const { matchId, predictedHome, predictedAway } = req.body;
  if (!uid || !matchId || predictedHome === undefined || predictedAway === undefined) return res.status(400).json({ error: 'Missing params' });
  const md = await getSheetData('Matches', 'A:J');
  const idx = md.findIndex(r => isDataRow(r, 'match_id') && String(r[0]).trim() === String(matchId).trim());
  if (idx === -1) return res.status(404).json({ error: 'Match not found' });
  const match = padRow(md[idx], EXPECTED_COLUMNS.Matches);
  if (String(match[5] || '').trim() !== 'scheduled') return res.status(400).json({ error: 'Not available' });
  const ko = new Date(match[4]);
  if (!Number.isFinite(ko.getTime()) || Date.now() >= ko.getTime()) return res.status(400).json({ error: 'Started' });
  const pH = toScore(predictedHome), pA = toScore(predictedAway);
  if (pH === null || pA === null || pH < 0 || pA < 0 || pH > 20 || pA > 20) return res.status(400).json({ error: 'Invalid score' });
  const pd = await getSheetData('Predictions', 'A:K');
  const del = [];
  pd.forEach((row, i) => { if (isDataRow(row, 'prediction_id') && String(row[1]).trim() === String(uid).trim() && String(row[2]).trim() === String(matchId).trim()) del.push(i); });
  await deleteRowsByRowIndices('Predictions', del);
  await appendRows('Predictions', [[`${uid}_${matchId}`, uid, matchId, pH, pA, new Date().toISOString(), new Date().toISOString(), 0, '', 0, 'FALSE']]);
  const k = getMatchdayKey(match[4]);
  if (k) await checkQuestsProgress(uid, k).catch(console.error);
  await checkReferralAward(uid).catch(console.error);
  res.json({ success: true });
}));
app.post('/api/admin/match-result', requireAdmin, asyncHandler(async (req, res) => {
  const { matchId, homeScore, awayScore } = req.body;
  if (!matchId || homeScore === undefined || awayScore === undefined) return res.status(400).json({ error: 'Missing params' });
  const H = toScore(homeScore), A = toScore(awayScore);
  if (H === null || A === null || H < 0 || A < 0 || H > 20 || A > 20) return res.status(400).json({ error: 'Invalid' });
  const md = await getSheetData('Matches', 'A:J');
  const idx = md.findIndex(r => isDataRow(r, 'match_id') && String(r[0]).trim() === String(matchId).trim());
  if (idx === -1) return res.status(404).json({ error: 'Match not found' });
  const um = padRow(md[idx], EXPECTED_COLUMNS.Matches);
  um[5] = 'finished'; um[6] = H; um[7] = A; um[8] = new Date().toISOString(); um[9] = 'TRUE';
  await writeRow('Matches', idx, um);
  await recalculatePointsForMatch(matchId, H, A);
  res.json({ success: true });
}));
app.get('/api/match-predictions/:matchId', asyncHandler(async (req, res) => {
  const mid = String(req.params.matchId || '').trim();
  const { Predictions: p, Users: u } = await batchGetSheets([{ sheet: 'Predictions', range: 'A:K' }, { sheet: 'Users', range: 'A:R' }]);
  const lm = getLatestPredictionMap(p);
  const mp = [...lm.values()].map(it => p[it.idx]).filter(r => r && String(r[2] || '').trim() === mid);
  const names = new Map(); u.forEach(row => { if (isDataRow(row, 'user_id')) names.set(String(row[0]).trim(), row[2] || row[1] || String(row[0]).trim()); });
  res.json(mp.map(x => ({ userId: String(x[1] || '').trim(), displayName: names.get(String(x[1] || '').trim()) || x[1], predictedHome: toScore(x[3]), predictedAway: toScore(x[4]), points: toNum(x[7], 0), predictionType: x[8] || '', fantikiAwarded: toNum(x[9], 0) })));
}));
app.get('/api/match-events/:matchId', asyncHandler(async (req, res) => {
  const mid = String(req.params.matchId || '').trim();
  const data = await getSheetData('MatchEvents', 'A:G');
  const f = data.filter(r => isDataRow(r, 'match_id') && String(r[0]).trim() === mid && !['no_events','events_unavailable'].includes(String(r[1] || '').trim()));
  const r = f.map(e => ({ matchId: String(e[0]).trim(), eventType: e[1] || '', team: e[2] || '', minute: toNum(e[3], 0), addedTime: toNum(e[4], 0), scoreAfterEvent: e[5] || '', player: e[6] || '' }));
  r.sort((a, b) => a.minute - b.minute || a.addedTime - b.addedTime);
  res.json(r);
}));
app.get('/api/match-odds/:matchId', asyncHandler(async (req, res) => {
  if (!ODDS_API_KEY) return res.json({ enabled: false, odds: null });
  const mid = String(req.params.matchId || '').trim();
  const md = await getSheetData('Matches', 'A:J');
  const row = md.find(r => isDataRow(r, 'match_id') && String(r[0]).trim() === mid);
  if (!row) return res.status(404).json({ error: 'Match not found' });
  if (String(row[5] || '').trim() !== 'scheduled') return res.json({ enabled: true, odds: null });
  const ko = new Date(row[4] || '').getTime();
  const hA = String(storedTeamToApiTeam(row[2]) || '').toLowerCase().trim();
  const aA = String(storedTeamToApiTeam(row[3]) || '').toLowerCase().trim();
  if (!hA || !aA) return res.json({ enabled: true, odds: null });
  const ev = await fetchOddsEvents();
  let sel = null, sw = false;
  for (const e of ev) {
    const et = new Date(e.commence_time || '').getTime();
    if (Number.isFinite(ko) && Number.isFinite(et) && Math.abs(et - ko) > 4 * 3600 * 1000) continue;
    const eh = String(findOurApiTeamName(e.home_team) || '').toLowerCase().trim();
    const ea = String(findOurApiTeamName(e.away_team) || '').toLowerCase().trim();
    if (eh === hA && ea === aA) { sel = e; sw = false; break; }
    if (eh === aA && ea === hA) { sel = e; sw = true; break; }
  }
  if (!sel) return res.json({ enabled: true, odds: null });
  const o = getOddsFromEvent(sel);
  if (!o) return res.json({ enabled: true, odds: null });
  if (sw) return res.json({ enabled: true, odds: { home: o.away, draw: o.draw, away: o.home, bookmakers: o.bookmakers } });
  res.json({ enabled: true, odds: o });
}));
app.get('/api/standings', asyncHandler(async (req, res) => {
  const ud = await getSheetData('Users', 'A:R');
  const table = ud.filter(row => isDataRow(row, 'user_id')).map(row => ({
    userId: String(row[0] || '').trim(), username: row[1] || '', displayName: row[2] || row[1] || 'User',
    registrationDate: row[3] || '', totalPoints: toNum(row[4], 0),
    successfulPredictions: toNum(row[6], 0), exactScores: toNum(row[7], 0),
    goalDifference: toNum(row[8], 0), draws: toNum(row[9], 0), outcomes: toNum(row[10], 0), misses: toNum(row[11], 0),
    fantikiBalance: toNum(row[12], 0), totalEarnedSeason: toNum(row[13], 0),
    level: toNum(row[14], 0), levelName: levelToName(toNum(row[14], 0)), historicalEarned: toNum(row[15], 0),
    referrals: toNum(row[17], 0) ? 1 : 0,
  })).filter(u => u.userId);
  const sb = String(req.query.sortBy || '').toLowerCase().trim();
  const ord = String(req.query.order || '').toLowerCase().trim();
  const fld = { points: 'totalPoints', exact: 'exactScores', difference: 'goalDifference', draws: 'draws', outcomes: 'outcomes', misses: 'misses', successful: 'successfulPredictions' };
  const act = u => (u.successfulPredictions + u.exactScores + u.goalDifference + u.draws + u.outcomes + u.misses) > 0;
  if (sb === 'misses') {
    const sign = ord === 'desc' ? -1 : 1;
    table.sort((a, b) => {
      const aa = act(a) ? 0 : 1, ba = act(b) ? 0 : 1;
      if (aa !== ba) return aa - ba;
      if (a.misses !== b.misses) return (a.misses - b.misses) * sign;
      return b.totalPoints - a.totalPoints;
    });
  } else if (sb && fld[sb]) {
    const f = fld[sb];
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
    const upd = await updateFinishedMatches();
    const rec = await checkRecentMatchdays();
    const duels = await settleAllPendingDuels();
    res.json({ success: true, updated: upd, matchdaysChecked: rec.length, duels });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
}));
app.post('/api/admin/update-events', requireAdmin, asyncHandler(async (req, res) => { try { res.json({ success: true, processed: await updateMatchEventsForFinished() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } }));
app.post('/api/admin/recalculate-all', requireAdmin, asyncHandler(async (req, res) => { try { res.json({ success: true, processed: await recalculateAll() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); } }));

app.use((e, req, res, next) => { console.error(e); res.status(500).json({ error: 'Internal server error' }); });

let syncInProgress = false;
async function scheduledSync() {
  if (syncInProgress || heavyJobRunning) return;
  syncInProgress = true;
  try {
    await fetchUCLMatches();
    await updateFinishedMatches();
    await updateMatchEventsForFinished();
    await checkRecentMatchdays();
    await settleAllPendingDuels();
  } catch (e) { console.error(e); }
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
    if (!RENDER_HOST) { console.warn('⚠️ no RENDER_HOST'); startBotPolling().catch(console.error); return; }
    const url = `https://${RENDER_HOST}${WEBHOOK_PATH}`;
    console.log(`Webhook: ${url}`);
    try {
      await callTelegram('setWebhook', { url, allowed_updates: ['message'], drop_pending_updates: true, secret_token: WEBHOOK_SECRET });
      const info = await callTelegram('getWebhookInfo', {});
      console.log(`✅ Webhook. Pending: ${info.result?.pending_update_count || 0}`);
    } catch (e) { console.error('❌ Webhook:', e.message); startBotPolling().catch(console.error); }
  } else {
    console.log(`Polling mode`);
    startBotPolling().catch(console.error);
  }
});
server.on('error', err => console.error('Server error:', err));