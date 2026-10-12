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
const SEASON = process.env.FOOTBALL_SEASON || '2024';
const EVENTS_BATCH_SIZE = Number(process.env.EVENTS_BATCH_SIZE || 4);
const SYNC_INTERVAL_MS = (Number(process.env.SYNC_INTERVAL_MINUTES || 15) * 60 * 1000);
const AUTO_SYNC = String(process.env.AUTO_SYNC || '').toLowerCase() !== 'false';

const ALLOW_PLAIN_USER_ID = String(process.env.ALLOW_PLAIN_USER_ID || '').toLowerCase() !== 'false';

const EXPECTED_COLUMNS = {
  Users: 12,
  Predictions: 9,
  Matches: 10,
  MatchEvents: 7,
};

// ========== Вспомогательные функции ==========
function isNotEmpty(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toScore(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function columnLetter(index) {
  let result = '';
  let n = Math.max(1, Math.floor(index));

  while (n > 0) {
    const modulo = (n - 1) % 26;
    result = String.fromCharCode(65 + modulo) + result;
    n = Math.floor((n - 1) / 26);
  }

  return result;
}

function padRow(row, length) {
  const safeLength = Math.max(0, Number(length) || 0);
  return Array.from({ length: safeLength }, (_, index) => row?.[index] ?? '');
}

function isDataRow(row, headerValue) {
  if (!Array.isArray(row) || row.length === 0) return false;

  const first = row[0];
  if (!isNotEmpty(first)) return false;

  const firstStr = String(first).trim();

  if (headerValue !== undefined && firstStr === String(headerValue).trim()) {
    return false;
  }

  return true;
}

function rangeForRow(sheetName, rowIndex, columns) {
  return `${quoteSheetName(sheetName)}!A${rowIndex + 1}:${columnLetter(columns)}${rowIndex + 1}`;
}

function isDifferentRow(oldRow, newRow, length) {
  for (let i = 0; i < length; i++) {
    const oldValue = oldRow?.[i] ?? '';
    const newValue = newRow?.[i] ?? '';

    if (String(oldValue).trim() !== String(newValue).trim()) {
      return true;
    }
  }

  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== Google Sheets API ==========
async function getSheetData(sheetName, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${quoteSheetName(sheetName)}!${range}`,
  });

  return response.data.values || [];
}

async function appendRows(sheetName, rows) {
  if (!rows.length) return;

  const expectedLength = EXPECTED_COLUMNS[sheetName] || Math.max(...rows.map(row => row.length));
  const paddedRows = rows.map(row => padRow(row, expectedLength));

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${quoteSheetName(sheetName)}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: {
      values: paddedRows,
    },
  });
}

async function batchWriteRows(sheetName, updates) {
  if (!updates.length) return;

  const expectedLength = EXPECTED_COLUMNS[sheetName] || 26;
  const chunkSize = 200;

  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize).map(update => ({
      range: rangeForRow(sheetName, update.rowIndex, expectedLength),
      values: [padRow(update.values, expectedLength)],
    }));

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: chunk,
      },
    });
  }
}

async function writeRow(sheetName, rowIndex, values) {
  await batchWriteRows(sheetName, [{ rowIndex, values }]);
}

const sheetIdCache = {};

async function getSheetIdByName(sheetName) {
  if (sheetIdCache[sheetName] !== undefined) {
    return sheetIdCache[sheetName];
  }

  const response = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties',
  });

  const sheet = response.data.sheets?.find(item => item.properties?.title === sheetName);

  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName}`);
  }

  sheetIdCache[sheetName] = sheet.properties.sheetId;
  return sheetIdCache[sheetName];
}

async function deleteRow(sheetName, idValue) {
  const data = await getSheetData(sheetName, 'A:Z');

  const rowIndex = data.findIndex(row => {
    return isNotEmpty(row[0]) && String(row[0]).trim() === String(idValue).trim();
  });

  if (rowIndex === -1) return;

  const sheetId = await getSheetIdByName(sheetName);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        },
      ],
    },
  });
}

// ========== Дополнительные помощники для последних прогнозов ==========
function getLatestPredictionMap(predictionsData) {
  const latest = new Map();

  predictionsData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'prediction_id')) return;

    const userId = String(row[1] || '').trim();
    const matchId = String(row[2] || '').trim();

    if (!userId || !matchId) return;

    const key = `${userId}|${matchId}`;

    const createdTime = Date.parse(row[5] || '') || 0;
    const fallbackUpdatedTime = Date.parse(row[6] || '') || 0;
    const submissionTime = createdTime || fallbackUpdatedTime;

    const current = latest.get(key);

    if (
      !current ||
      submissionTime > current.submissionTime ||
      (submissionTime === current.submissionTime && rowIndex > current.rowIndex)
    ) {
      latest.set(key, {
        rowIndex,
        submissionTime,
        userId,
        matchId,
      });
    }
  });

  return latest;
}

function getLatestPredictionsForUser(predictionsData, userId) {
  const latestMap = getLatestPredictionMap(predictionsData);
  const userIdStr = String(userId || '').trim();
  const rows = [];

  for (const item of latestMap.values()) {
    const row = predictionsData[item.rowIndex];

    if (row && String(row[1] || '').trim() === userIdStr) {
      rows.push(row);
    }
  }

  return rows;
}

async function deleteRowsByRowIndices(sheetName, rowIndexes) {
  const unique = [...new Set(rowIndexes.map(Number).filter(Number.isFinite))].sort((a, b) => b - a);
  if (!unique.length) return;

  const sheetId = await getSheetIdByName(sheetName);
  const chunkSize = 200;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: chunk.map(rowIndex => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        })),
      },
    });
  }
}


async function cleanupDuplicatePredictions() {
  const predictionsData = await getSheetData('Predictions', 'A:Z');
  const latestMap = getLatestPredictionMap(predictionsData);
  const rowsToDelete = [];

  predictionsData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'prediction_id')) return;

    const userId = String(row[1] || '').trim();
    const matchId = String(row[2] || '').trim();
    if (!userId || !matchId) return;

    const latest = latestMap.get(`${userId}|${matchId}`);
    if (!latest || latest.rowIndex !== rowIndex) {
      rowsToDelete.push(rowIndex);
    }
  });

  await deleteRowsByRowIndices('Predictions', rowsToDelete);
  return rowsToDelete.length;
}

function filterPredictionResponseByType(list, typeFilter) {
  const type = String(typeFilter || '').toLowerCase().trim();

  if (!type || type === 'all') return list;

  return list.filter(item => {
    if (type === 'exact') return item.prediction_type === 'exact';
    if (type === 'difference') return item.prediction_type === 'difference';
    if (type === 'draw') return item.prediction_type === 'draw';
    if (type === 'outcome') return item.prediction_type === 'outcome';

    if (type === 'miss') {
      return item.prediction_type === 'miss' || (item.status === 'finished' && item.points === 0);
    }

    if (type === 'successful' || type === 'points') {
      return item.points > 0;
    }

    if (type === 'finished') return item.status === 'finished';
    if (type === 'scheduled') return item.status === 'scheduled';
    if (type === 'live') return item.status === 'live';

    return true;
  });
}

function sortPredictionsResponse(list, sortMode) {
  const byDateAsc = (a, b) => {
    const dateA = new Date(a.kickoff_utc).getTime() || Infinity;
    const dateB = new Date(b.kickoff_utc).getTime() || Infinity;
    return dateA - dateB;
  };

  const normalizedSort = String(sortMode || '').toLowerCase().trim();

  if (normalizedSort === 'exact_first') {
    return [...list].sort((a, b) => {
      const aExact = a.prediction_type === 'exact' ? 1 : 0;
      const bExact = b.prediction_type === 'exact' ? 1 : 0;

      return bExact - aExact || byDateAsc(a, b);
    });
  }

  if (normalizedSort === 'points_desc') {
    return [...list].sort((a, b) => b.points - a.points || byDateAsc(a, b));
  }

  if (normalizedSort === 'date_desc') {
    return [...list].sort((a, b) => {
      const dateA = new Date(a.kickoff_utc).getTime() || -Infinity;
      const dateB = new Date(b.kickoff_utc).getTime() || -Infinity;

      return dateB - dateA;
    });
  }

  return [...list].sort(byDateAsc);
}

// ========== Авторизация / безопасность ==========
function getAdminIds() {
  return String(process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function verifyTelegramInitData(initDataString) {
  try {
    if (!BOT_TOKEN || !initDataString) return false;

    const params = new URLSearchParams(initDataString);
    const hash = params.get('hash');

    if (!hash) return false;

    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const calculatedBuffer = Buffer.from(calculatedHash, 'hex');
    const hashBuffer = Buffer.from(hash, 'hex');

    if (calculatedBuffer.length === 0 || hashBuffer.length !== calculatedBuffer.length) {
      return false;
    }

    if (!crypto.timingSafeEqual(calculatedBuffer, hashBuffer)) {
      return false;
    }

    const authDate = Number(params.get('auth_date') || 0);

    if (authDate && (Date.now() / 1000 - authDate > 86400)) {
      return false;
    }

    return true;
  } catch (error) {
    return false;
  }
}

function extractAuthenticatedUser(req) {
  const initData = req.body?.initData || req.query?.initData;

  if (initData) {
    if (BOT_TOKEN && !verifyTelegramInitData(initData)) {
      return null;
    }

    try {
      const params = new URLSearchParams(initData);
      const user = JSON.parse(params.get('user') || 'null');

      if (user?.id) {
        return {
          ...user,
          id: String(user.id).trim(),
        };
      }
    } catch (error) {
      return null;
    }
  }

  if (ALLOW_PLAIN_USER_ID) {
    const userId = req.body?.userId || req.query?.userId;

    if (isNotEmpty(userId)) {
      return {
        id: String(userId).trim(),
        username: req.body?.username || '',
        first_name: req.body?.firstName || '',
        last_name: req.body?.lastName || '',
      };
    }
  }

  return null;
}

function extractUserId(req) {
  const user = extractAuthenticatedUser(req);
  return user?.id ?? null;
}

function requireAdmin(req, res, next) {
  const apiKey = req.headers['x-admin-api-key'] || req.body?.apiKey;

  if (ADMIN_API_KEY && apiKey === ADMIN_API_KEY) {
    return next();
  }

  const user = extractAuthenticatedUser(req);
  const adminIds = getAdminIds();

  if (user?.id && adminIds.includes(String(user.id).trim())) {
    return next();
  }

  return res.status(403).json({ error: 'Forbidden' });
}

const asyncHandler = fn => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// ========== Маппинг статусов ==========
function mapStatus(apiStatus) {
  if (apiStatus === 'SCHEDULED' || apiStatus === 'TIMED') return 'scheduled';
  if (apiStatus === 'LIVE' || apiStatus === 'IN_PLAY' || apiStatus === 'PAUSED') return 'live';
  if (apiStatus === 'FINISHED') return 'finished';
  if (apiStatus === 'POSTPONED') return 'postponed';
  if (apiStatus === 'SUSPENDED' || apiStatus === 'CANCELLED') return apiStatus.toLowerCase();

  return String(apiStatus || '').toLowerCase();
}

// ========== Перевод названий команд ==========
const teamTranslations = {
  'Real Madrid CF': 'Реал Мадрид',
  'FC Barcelona': 'Барселона',
  'Manchester City FC': 'Манчестер Сити',
  'Liverpool FC': 'Ливерпуль',
  'FC Bayern München': 'Бавария',
  'Paris Saint-Germain FC': 'ПСЖ',
  'Juventus FC': 'Ювентус',
  'AC Milan': 'Милан',
  'Chelsea FC': 'Челси',
  'Arsenal FC': 'Арсенал',
  'Borussia Dortmund': 'Боруссия Дортмунд',
  'Club Atlético de Madrid': 'Атлетико Мадрид',
  'FC Internazionale Milano': 'Интер',
  'SSC Napoli': 'Наполи',
  'FC Porto': 'Порту',
  'SL Benfica': 'Бенфика',
  'AFC Ajax': 'Аякс',
  'Olympique Lyonnais': 'Лион',
  'AS Monaco FC': 'Монако',
  'FC Red Bull Salzburg': 'Зальцбург',
  'FK Shakhtar Donetsk': 'Шахтер',
  'GNK Dinamo Zagreb': 'Динамо Загреб',
  'Celtic FC': 'Селтик',
  'Rangers FC': 'Рейнджерс',
  'Club Brugge KV': 'Брюгге',
  'Galatasaray SK': 'Галатасарай',
  'Fenerbahçe SK': 'Фенербахче',
  'Olympiacos FC': 'Олимпиакос',
  'AEK Athens FC': 'АЕК',
  'Maccabi Haifa FC': 'Маккаби Хайфа',
  'FC København': 'Копенгаген',
  'BSC Young Boys': 'Янг Бойз',
  'FK Crvena Zvezda': 'Црвена Звезда',
  'Racing Club de Lens': 'Ланс',
  'Real Sociedad de Fútbol': 'Реал Сосьедад',
  'PSV': 'ПСВ',
  'Feyenoord Rotterdam': 'Фейеноорд',
  'Sporting CP': 'Спортинг',
  'Sporting Clube de Portugal': 'Спортинг',
  'FC Viktoria Plzeň': 'Виктория Пльзень',
  'Stade Brestois 29': 'Брест',
  'VfB Stuttgart': 'Штутгарт',
  'Aston Villa FC': 'Астон Вилла',
  'Bologna FC 1909': 'Болонья',
  'Girona FC': 'Жирона',
  'RC Celta de Vigo': 'Сельта',
  'Real Betis Balompié': 'Бетис',
  'Sevilla FC': 'Севилья',
  'Valencia CF': 'Валенсия',
  'Lazio Roma': 'Лацио',
  'Atalanta BC': 'Аталанта',
  'AS Roma': 'Рома',
  'Olympique de Marseille': 'Марсель',
  'Lille OSC': 'Лилль',
  'OGC Nice': 'Ницца',
  'Stade Rennais FC': 'Ренн',
  'RC Strasbourg Alsace': 'Страсбур',
  'FC Nantes': 'Нант',
  'SC Braga': 'Брага',
  'RSC Anderlecht': 'Андерлехт',
  'KRC Genk': 'Генк',
  'Ferencvárosi TC': 'Ференцварош',
  'Ludogorets Razgrad': 'Лудогорец',
  'Qarabağ FK': 'Карабах',
  'Sparta Praha': 'Спарта Прага',
  'Slavia Praha': 'Славия Прага',
  'SK Slavia Praha': 'Славия Прага',
  'FC Basel 1893': 'Базель',
  'Grasshopper Club Zürich': 'Грассхоппер',
  'Manchester United FC': 'Манчестер Юнайтед',
  'Villarreal CF': 'Вильярреал',
  'PAE AEK': 'АЕК',
  'LASK Linz': 'ЛАСК',
  'Viking FK': 'Викинг',
  'ŠK Slovan Bratislava': 'Слован Братислава',
  'FK Bodø/Glimt': 'Будё-Глимт',
  'Como 1907': 'Комо',
  'RB Leipzig': 'РБ Лейпциг',
  'Sabah FK': 'Сабах',
};

const teamSynonyms = {
  'мс': 'Манчестер Сити',
  'ман сити': 'Манчестер Сити',
  'мю': 'Манчестер Юнайтед',
  'ман юнайтед': 'Манчестер Юнайтед',
  'манчестер юнайтед': 'Манчестер Юнайтед',
  'реал': 'Реал Мадрид',
  'реал мадрид': 'Реал Мадрид',
  'барса': 'Барселона',
  'барселона': 'Барселона',
  'бавария': 'Бавария',
  'бавария мюнхен': 'Бавария',
  'дортмунд': 'Боруссия Дортмунд',
  'боруссия д': 'Боруссия Дортмунд',
  'боруссия дортмунд': 'Боруссия Дортмунд',
  'атлетико': 'Атлетико Мадрид',
  'атлетико мадрид': 'Атлетико Мадрид',
  'интер': 'Интер',
  'наполи': 'Наполи',
  'псж': 'ПСЖ',
  'пари сен-жермен': 'ПСЖ',
  'париж': 'ПСЖ',
  'ливерпуль': 'Ливерпуль',
  'челси': 'Челси',
  'арсенал': 'Арсенал',
  'ювентус': 'Ювентус',
  'милан': 'Милан',
  'аякс': 'Аякс',
  'порту': 'Порту',
  'бенфика': 'Бенфика',
  'лион': 'Лион',
  'монако': 'Монако',
  'зальцбург': 'Зальцбург',
  'шахтер': 'Шахтер',
  'динамо загреб': 'Динамо Загреб',
  'селтик': 'Селтик',
  'рейнджерс': 'Рейнджерс',
  'брюгге': 'Брюгге',
  'галатасарай': 'Галатасарай',
  'фенербахче': 'Фенербахче',
  'олимпиакос': 'Олимпиакос',
  'аек': 'АЕК',
  'маккаби хайфа': 'Маккаби Хайфа',
  'копенгаген': 'Копенгаген',
  'янг бойз': 'Янг Бойз',
  'црвена звезда': 'Црвена Звезда',
  'ланс': 'Ланс',
  'реал сосьедад': 'Реал Сосьедад',
  'псв': 'ПСВ',
  'фейеноорд': 'Фейеноорд',
  'спортинг': 'Спортинг',
  'спортинг лиссабон': 'Спортинг',
  'виктория пльзень': 'Виктория Пльзень',
  'брест': 'Брест',
  'штутгарт': 'Штутгарт',
  'астон вилла': 'Астон Вилла',
  'болонья': 'Болонья',
  'жирона': 'Жирона',
  'сельта': 'Сельта',
  'бетис': 'Бетис',
  'севилья': 'Севилья',
  'валенсия': 'Валенсия',
  'лацио': 'Лацио',
  'аталанта': 'Аталанта',
  'рома': 'Рома',
  'марсель': 'Марсель',
  'лилль': 'Лилль',
  'ницца': 'Ницца',
  'ренн': 'Ренн',
  'страсбур': 'Страсбур',
  'нант': 'Нант',
  'брага': 'Брага',
  'андерлехт': 'Андерлехт',
  'генк': 'Генк',
  'ференцварош': 'Ференцварош',
  'лудогорец': 'Лудогорец',
  'карабах': 'Карабах',
  'спарта прага': 'Спарта Прага',
  'славия прага': 'Славия Прага',
  'базель': 'Базель',
  'грассхоппер': 'Грассхоппер',
  'вильярреал': 'Вильярреал',
  'ласк': 'ЛАСК',
  'викинг': 'Викинг',
  'слован братислава': 'Слован Братислава',
  'будё-глимт': 'Будё-Глимт',
  'комо': 'Комо',
  'рб лейпциг': 'РБ Лейпциг',
  'сабах': 'Сабах',
};

const teamAliases = new Map();

for (const [apiName, ruName] of Object.entries(teamTranslations)) {
  teamAliases.set(apiName.toLowerCase().trim(), ruName);
  teamAliases.set(ruName.toLowerCase().trim(), ruName);
}

for (const [alias, ruName] of Object.entries(teamSynonyms)) {
  teamAliases.set(alias.toLowerCase().trim(), ruName);
}

function translateTeam(name) {
  if (!name) return '';
  return teamTranslations[name] || name;
}

function normalizeTeamName(name) {
  const lower = String(name || '').toLowerCase().trim();

  if (teamAliases.has(lower)) {
    return teamAliases.get(lower);
  }

  const cleaned = lower
    .replace(/[«»"'()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (teamAliases.has(cleaned)) {
    return teamAliases.get(cleaned);
  }

  return String(name || '').trim();
}

// ========== Работа с Football-Data.org ==========
function mapStage(apiStage) {
  const stages = {
    PRELIMINARY: 'Предварительный раунд',
    FIRST_QUALIFYING_ROUND: '1-й квал. раунд',
    SECOND_QUALIFYING_ROUND: '2-й квал. раунд',
    THIRD_QUALIFYING_ROUND: '3-й квал. раунд',
    PLAY_OFF_ROUND: 'Раунд плей-офф',
    GROUP_STAGE: 'Групповой этап',
    ROUND_OF_16: '1/8 финала',
    QUARTER_FINALS: '1/4 финала',
    SEMI_FINALS: 'Полуфинал',
    FINAL: 'Финал',
  };

  return stages[apiStage] || apiStage;
}

async function fetchFootball(path) {
  if (!FOOTBALL_DATA_API_KEY) {
    throw new Error('FOOTBALL_DATA_API_KEY не задан');
  }

  const response = await fetch(`${FOOTBALL_DATA_BASE_URL}${path}`, {
    headers: {
      'X-Auth-Token': FOOTBALL_DATA_API_KEY,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Football-Data.org API error: ${response.status} ${text}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function calculatePoints(predHome, predAway, actHome, actAway) {
  const ph = toScore(predHome);
  const pa = toScore(predAway);
  const ah = toScore(actHome);
  const aa = toScore(actAway);

  if (ph === null || pa === null || ah === null || aa === null) {
    return { points: 0, type: 'miss' };
  }

  if (ph === ah && pa === aa) {
    return { points: 5, type: 'exact' };
  }

  if (ph === pa && ah === aa) {
    return { points: 3, type: 'draw' };
  }

  if (ph - pa === ah - aa) {
    return { points: 3, type: 'difference' };
  }

  if ((ph > pa && ah > aa) || (ph < pa && ah < aa)) {
    return { points: 1, type: 'outcome' };
  }

  return { points: 0, type: 'miss' };
}

function emptyUserDelta() {
  return {
    points: 0,
    successful: 0,
    exact: 0,
    difference: 0,
    draws: 0,
    outcomes: 0,
    misses: 0,
  };
}

function addResultToDelta(delta, result, sign) {
  if (!delta || !result) return;

  const points = toNum(result.points, 0);

  delta.points += sign * points;

  if (points > 0) {
    delta.successful += sign;
  }

  if (result.type === 'exact') delta.exact += sign;
  if (result.type === 'difference') delta.difference += sign;
  if (result.type === 'draw') delta.draws += sign;
  if (result.type === 'outcome') delta.outcomes += sign;
  if (result.type === 'miss') delta.misses += sign;
}

// Идемпотентный пересчет очков для конкретного матча
async function recalculatePointsForMatch(matchId, homeScore, awayScore) {
  const ah = toScore(homeScore);
  const aa = toScore(awayScore);

  if (ah === null || aa === null) return 0;

  const matchIdStr = String(matchId).trim();

  const predictionsData = await getSheetData('Predictions', 'A:Z');
  const latestMap = getLatestPredictionMap(predictionsData);

  const predictionUpdates = [];
  const userDeltas = new Map();

  predictionsData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'prediction_id')) return;

    const predictionMatchId = String(row[2] || '').trim();
    if (predictionMatchId !== matchIdStr) return;

    const userId = String(row[1] || '').trim();
    if (!userId) return;

    const key = `${userId}|${predictionMatchId}`;
    const latest = latestMap.get(key);

    if (!latest) return;

    const oldPoints = toNum(row[7], 0);
    const oldType = String(row[8] || '').trim();

    const ensureDelta = () => {
      if (!userDeltas.has(userId)) {
        userDeltas.set(userId, emptyUserDelta());
      }
      return userDeltas.get(userId);
    };

    if (rowIndex !== latest.rowIndex) {
      if (oldPoints !== 0 || oldType !== 'duplicate') {
        const updatedPrediction = padRow(row, EXPECTED_COLUMNS.Predictions);
        updatedPrediction[7] = 0;
        updatedPrediction[8] = 'duplicate';

        predictionUpdates.push({ rowIndex, values: updatedPrediction });
        addResultToDelta(ensureDelta(), { points: oldPoints, type: oldType }, -1);
      }
      return;
    }

    const newResult = calculatePoints(row[3], row[4], ah, aa);
    const changed = oldPoints !== newResult.points || oldType !== newResult.type;

    if (!changed) return;

    const updatedPrediction = padRow(row, EXPECTED_COLUMNS.Predictions);
    updatedPrediction[7] = newResult.points;
    updatedPrediction[8] = newResult.type;

    predictionUpdates.push({ rowIndex, values: updatedPrediction });

    const delta = ensureDelta();
    addResultToDelta(delta, { points: oldPoints, type: oldType }, -1);
    addResultToDelta(delta, newResult, 1);
  });

  await batchWriteRows('Predictions', predictionUpdates);

  if (userDeltas.size > 0) {
    const usersData = await getSheetData('Users', 'A:Z');
    const userUpdates = [];

    for (const [userId, delta] of userDeltas.entries()) {
      const rowIndex = usersData.findIndex(row => {
        return isDataRow(row, 'user_id') && String(row[0]).trim() === userId;
      });

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

  return predictionUpdates.length;
}

async function fetchUCLMatches() {
  const data = await fetchFootball(`/competitions/CL/matches?season=${SEASON}`);
  const apiMatches = data.matches || [];

  const matchesData = await getSheetData('Matches', 'A:J');

  const existingById = new Map();

  matchesData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'match_id')) return;

    existingById.set(String(row[0]).trim(), { row, rowIndex });
  });

  const newRows = [];
  const updates = [];
  const recalcList = [];

  for (const apiMatch of apiMatches) {
    const matchId = String(apiMatch.id);

    let homeTeam = translateTeam(apiMatch.homeTeam?.name || 'Unknown');
    let awayTeam = translateTeam(apiMatch.awayTeam?.name || 'Unknown');

    const kickoffUtc = apiMatch.utcDate || '';
    const status = mapStatus(apiMatch.status);
    const stage = mapStage(apiMatch.stage);

    const apiHomeScore = toScore(apiMatch.score?.fullTime?.home);
    const apiAwayScore = toScore(apiMatch.score?.fullTime?.away);

    const existing = existingById.get(matchId);

    if (!existing) {
      let homeScore = '';
      let awayScore = '';
      let resultUpdatedAt = '';

      if (status === 'finished' && apiHomeScore !== null && apiAwayScore !== null) {
        homeScore = apiHomeScore;
        awayScore = apiAwayScore;
        resultUpdatedAt = new Date().toISOString();
      }

      newRows.push([
        matchId, stage, homeTeam, awayTeam, kickoffUtc, status,
        homeScore, awayScore, resultUpdatedAt, 'FALSE',
      ]);

      if (status === 'finished' && apiHomeScore !== null && apiAwayScore !== null) {
        recalcList.push({ matchId, homeScore: apiHomeScore, awayScore: apiAwayScore });
      }
      continue;
    }

    const current = padRow(existing.row, EXPECTED_COLUMNS.Matches);
    const locked = String(current[9] || '').toUpperCase() === 'TRUE';

    if (locked) continue;

    const oldStatus = String(current[5] || '').trim();
    const oldHomeScore = toScore(current[6]);
    const oldAwayScore = toScore(current[7]);

    let homeScore = current[6];
    let awayScore = current[7];
    let resultUpdatedAt = current[8];
    let shouldRecalculate = false;

    if (status === 'finished' && apiHomeScore !== null && apiAwayScore !== null) {
      homeScore = apiHomeScore;
      awayScore = apiAwayScore;

      if (oldStatus !== 'finished' || oldHomeScore !== apiHomeScore || oldAwayScore !== apiAwayScore) {
        resultUpdatedAt = new Date().toISOString();
        shouldRecalculate = true;
      }
    } else if (status !== 'finished') {
      homeScore = '';
      awayScore = '';
      resultUpdatedAt = '';
    }

    const updated = [
      matchId, stage, homeTeam, awayTeam, kickoffUtc, status,
      homeScore, awayScore, resultUpdatedAt, current[9] || 'FALSE',
    ];

    if (isDifferentRow(current, updated, EXPECTED_COLUMNS.Matches)) {
      updates.push({ rowIndex: existing.rowIndex, values: updated });
    }

    if (shouldRecalculate) {
      recalcList.push({ matchId, homeScore: apiHomeScore, awayScore: apiAwayScore });
    }
  }

  await appendRows('Matches', newRows);
  await batchWriteRows('Matches', updates);

  for (const item of recalcList) {
    await recalculatePointsForMatch(item.matchId, item.homeScore, item.awayScore);
  }

  return { added: newRows.length, updated: updates.length, recalculated: recalcList.length };
}

async function updateFinishedMatches() {
  const data = await fetchFootball(`/competitions/CL/matches?season=${SEASON}`);
  const apiMatches = (data.matches || []).filter(match => match.status === 'FINISHED');

  const matchesData = await getSheetData('Matches', 'A:J');
  let updatedCount = 0;

  for (const apiMatch of apiMatches) {
    const matchId = String(apiMatch.id);

    const rowIndex = matchesData.findIndex(row => {
      return isDataRow(row, 'match_id') && String(row[0]).trim() === matchId;
    });

    if (rowIndex === -1) continue;

    const current = padRow(matchesData[rowIndex], EXPECTED_COLUMNS.Matches);
    const scoreLocked = String(current[9] || '').toUpperCase() === 'TRUE';

    if (scoreLocked) continue;

    const homeScore = toScore(apiMatch.score?.fullTime?.home);
    const awayScore = toScore(apiMatch.score?.fullTime?.away);

    if (homeScore === null || awayScore === null) continue;

    const currentHome = toScore(current[6]);
    const currentAway = toScore(current[7]);
    const currentStatus = String(current[5] || '').trim();

    if (currentStatus === 'finished' && currentHome === homeScore && currentAway === awayScore) {
      continue;
    }

    const updated = [...current];
    updated[5] = 'finished';
    updated[6] = homeScore;
    updated[7] = awayScore;
    updated[8] = new Date().toISOString();
    updated[9] = current[9] || 'FALSE';

    await writeRow('Matches', rowIndex, updated);
    await recalculatePointsForMatch(matchId, homeScore, awayScore);

    updatedCount++;
  }

  return updatedCount;
}

async function fetchMatchEvents(matchId) {
  const data = await fetchFootball(`/matches/${matchId}/events`);
  return data.events || [];
}

function buildEventRows(matchId, events, homeTeam, awayTeam) {
  if (!Array.isArray(events)) return [];

  const goalTypes = new Set(['GOAL', 'PENALTY', 'OWN_GOAL', 'GOAL_PENALTY', 'SCORE_CHANGE']);

  const scoringEvents = events.filter(event => {
    return event && goalTypes.has(String(event.type || '').toUpperCase());
  });

  scoringEvents.sort((a, b) => {
    return toNum(a.minute, 0) - toNum(b.minute, 0) || toNum(a.injuryTime, 0) - toNum(b.injuryTime, 0);
  });

  let homeScore = 0;
  let awayScore = 0;
  const rows = [];

  for (const event of scoringEvents) {
    const rawTeam = event.team?.name || '';
    const team = translateTeam(rawTeam);
    const player = event.player?.name || '';
    const minute = toNum(event.minute, 0);
    const addedTime = toNum(event.injuryTime, 0);

    const normalizedTeam = String(team || rawTeam || '').toLowerCase().trim();
    const normalizedHome = String(homeTeam || '').toLowerCase().trim();
    const normalizedAway = String(awayTeam || '').toLowerCase().trim();

    if (normalizedTeam && normalizedHome && normalizedTeam === normalizedHome) {
      homeScore++;
    } else if (normalizedTeam && normalizedAway && normalizedTeam === normalizedAway) {
      awayScore++;
    }

    rows.push([matchId, 'goal', team || rawTeam, minute, addedTime, `${homeScore}:${awayScore}`, player]);
  }

  return rows;
}

async function updateMatchEventsForFinished() {
  const matchesData = await getSheetData('Matches', 'A:J');

  const finishedMatches = matchesData.filter(row => {
    return isDataRow(row, 'match_id') && String(row[5] || '').trim() === 'finished';
  });

  const existingEvents = await getSheetData('MatchEvents', 'A:G');

  const existingMatchIds = new Set(
    existingEvents.filter(row => isDataRow(row, 'match_id')).map(row => String(row[0]).trim())
  );

  const matchesToProcess = finishedMatches
    .filter(row => !existingMatchIds.has(String(row[0]).trim()))
    .slice(0, EVENTS_BATCH_SIZE);

  for (const matchRow of matchesToProcess) {
    const matchId = String(matchRow[0]).trim();
    const homeTeam = String(matchRow[2] || '').trim();
    const awayTeam = String(matchRow[3] || '').trim();

    try {
      const events = await fetchMatchEvents(matchId);
      const rows = buildEventRows(matchId, events, homeTeam, awayTeam);

      if (rows.length > 0) {
        await appendRows('MatchEvents', rows);
      } else {
        await appendRows('MatchEvents', [[matchId, 'no_events', '', 0, 0, '', '']]);
      }
    } catch (error) {
      console.error(`Ошибка получения событий для матча ${matchId}:`, error.message);

      if (error.status === 403 || error.status === 404) {
        await appendRows('MatchEvents', [[matchId, 'events_unavailable', '', 0, 0, '', '']]);
      }
    }

    if (matchRow !== matchesToProcess[matchesToProcess.length - 1]) {
      await sleep(5000);
    }
  }

  return matchesToProcess.length;
}

async function recalculateAll() {
  const usersData = await getSheetData('Users', 'A:Z');
  const predictionsData = await getSheetData('Predictions', 'A:Z');
  const matchesData = await getSheetData('Matches', 'A:J');

  const finishedMatches = new Map();

  matchesData.forEach(row => {
    if (!isDataRow(row, 'match_id')) return;
    const status = String(row[5] || '').trim();
    if (status !== 'finished') return;
    const homeScore = toScore(row[6]);
    const awayScore = toScore(row[7]);
    if (homeScore === null || awayScore === null) return;
    finishedMatches.set(String(row[0]).trim(), { homeScore, awayScore });
  });

  const latestMap = getLatestPredictionMap(predictionsData);
  const userStats = new Map();
  const userRowIndexById = new Map();

  usersData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'user_id')) return;
    const userId = String(row[0]).trim();
    if (!userId) return;
    userRowIndexById.set(userId, rowIndex);
    userStats.set(userId, {
      totalPoints: 0, totalPredictions: 0, successfulPredictions: 0,
      exactScores: 0, goalDifference: 0, draws: 0, outcomes: 0, misses: 0,
    });
  });

  const predictionUpdates = [];

  predictionsData.forEach((row, rowIndex) => {
    if (!isDataRow(row, 'prediction_id')) return;
    const userId = String(row[1] || '').trim();
    const matchId = String(row[2] || '').trim();
    if (!userId || !matchId) return;

    const key = `${userId}|${matchId}`;
    const latest = latestMap.get(key);
    const oldPoints = toNum(row[7], 0);
    const oldType = String(row[8] || '').trim();

    if (!latest || rowIndex !== latest.rowIndex) {
      if (oldPoints !== 0 || oldType !== 'duplicate') {
        const updatedPrediction = padRow(row, EXPECTED_COLUMNS.Predictions);
        updatedPrediction[7] = 0;
        updatedPrediction[8] = 'duplicate';
        predictionUpdates.push({ rowIndex, values: updatedPrediction });
      }
      return;
    }

    const stats = userStats.get(userId);
    if (stats) stats.totalPredictions++;

    let points = 0;
    let type = '';
    const finishedMatch = finishedMatches.get(matchId);

    if (finishedMatch) {
      const result = calculatePoints(row[3], row[4], finishedMatch.homeScore, finishedMatch.awayScore);
      points = result.points;
      type = result.type;

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
      const updatedPrediction = padRow(row, EXPECTED_COLUMNS.Predictions);
      updatedPrediction[7] = points;
      updatedPrediction[8] = type;
      predictionUpdates.push({ rowIndex, values: updatedPrediction });
    }
  });

  const userUpdates = [];

  for (const [userId, stats] of userStats.entries()) {
    const rowIndex = userRowIndexById.get(userId);
    if (rowIndex === undefined) continue;

    const updatedUser = padRow(usersData[rowIndex], EXPECTED_COLUMNS.Users);
    updatedUser[4] = stats.totalPoints;
    updatedUser[5] = 0;
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
  const matchesData = await getSheetData('Matches', 'A:J');
  const predictionsData = await getSheetData('Predictions', 'A:Z');

  const matches = matchesData.filter(row => isDataRow(row, 'match_id'));
  const userPredictions = getLatestPredictionsForUser(predictionsData, userId);

  let result = userPredictions.map(prediction => {
    const matchId = String(prediction[2]).trim();
    const match = matches.find(item => String(item[0]).trim() === matchId);
    if (!match) return null;

    const status = String(match[5] || '').trim();
    const homeScore = toScore(match[6]);
    const awayScore = toScore(match[7]);

    let points = 0;
    let predictionType = '';

    if (status === 'finished' && homeScore !== null && awayScore !== null) {
      const calculated = calculatePoints(
        prediction[3],
        prediction[4],
        homeScore,
        awayScore,
      );
      points = calculated.points;
      predictionType = calculated.type;
    }

    return {
      match_id: matchId,
      stage: match[1] || '',
      home_team: match[2] || '',
      away_team: match[3] || '',
      kickoff_utc: match[4] || '',
      status,
      home_score: homeScore,
      away_score: awayScore,
      predicted_home: toScore(prediction[3]),
      predicted_away: toScore(prediction[4]),
      points,
      prediction_type: predictionType,
      created_at: prediction[5] || '',
      updated_at: prediction[6] || prediction[5] || '',
    };
  }).filter(Boolean);

  result = filterPredictionResponseByType(result, query.type);

  const statusFilter = String(query.status || '').toLowerCase().trim();
  if (statusFilter) {
    result = result.filter(item => item.status === statusFilter);
  }

  return sortPredictionsResponse(result, query.sort);
}

async function buildStandingsSnapshot() {
  const [usersData, predictionsData, matchesData] = await Promise.all([
    getSheetData('Users', 'A:Z'),
    getSheetData('Predictions', 'A:Z'),
    getSheetData('Matches', 'A:J'),
  ]);

  const users = usersData.filter(row => isDataRow(row, 'user_id'));
  const latestMap = getLatestPredictionMap(predictionsData);

  const finishedMatches = new Map();

  matchesData.forEach(row => {
    if (!isDataRow(row, 'match_id')) return;

    const matchId = String(row[0] || '').trim();
    const status = String(row[5] || '').trim();
    const homeScore = toScore(row[6]);
    const awayScore = toScore(row[7]);

    if (
      matchId &&
      status === 'finished' &&
      homeScore !== null &&
      awayScore !== null
    ) {
      finishedMatches.set(matchId, { homeScore, awayScore });
    }
  });

  const statsByUser = new Map();

  users.forEach(row => {
    const userId = String(row[0] || '').trim();
    if (!userId) return;

    statsByUser.set(userId, {
      userId,
      username: row[1] || '',
      displayName: row[2] || row[1] || 'User',
      registrationDate: row[3] || '',
      totalPoints: 0,
      totalPredictions: 0,
      successfulPredictions: 0,
      exactScores: 0,
      goalDifference: 0,
      draws: 0,
      outcomes: 0,
      misses: 0,
    });
  });

  for (const item of latestMap.values()) {
    const prediction = predictionsData[item.rowIndex];
    if (!prediction) continue;

    const userId = String(prediction[1] || '').trim();
    const matchId = String(prediction[2] || '').trim();
    if (!userId || !matchId) continue;

    if (!statsByUser.has(userId)) {
      statsByUser.set(userId, {
        userId,
        username: '',
        displayName: userId,
        registrationDate: '',
        totalPoints: 0,
        totalPredictions: 0,
        successfulPredictions: 0,
        exactScores: 0,
        goalDifference: 0,
        draws: 0,
        outcomes: 0,
        misses: 0,
      });
    }

    const stats = statsByUser.get(userId);
    stats.totalPredictions++;

    const finished = finishedMatches.get(matchId);
    if (!finished) continue;

    const result = calculatePoints(
      prediction[3],
      prediction[4],
      finished.homeScore,
      finished.awayScore,
    );

    stats.totalPoints += result.points;
    if (result.points > 0) stats.successfulPredictions++;
    if (result.type === 'exact') stats.exactScores++;
    if (result.type === 'difference') stats.goalDifference++;
    if (result.type === 'draw') stats.draws++;
    if (result.type === 'outcome') stats.outcomes++;
    if (result.type === 'miss') stats.misses++;
  }

  return [...statsByUser.values()];
}

// ========== Telegram Long Polling ==========
let telegramOffset = 0;

async function callTelegram(method, params) {
  const url = `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/${method}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API error: ${response.status} ${text}`);
  }

  return response.json();
}

function parsePredictionText(text) {
  const clean = String(text || '')
    .replace(/^\/predict(?:@\w+)?\s+/i, '')
    .trim();

  const match = clean.match(/^(.+?)\s*[-–—]\s*(.+?)\s+(\d{1,2})\s*:\s*(\d{1,2})$/i);

  if (!match) return null;

  return {
    home: match[1].trim(),
    away: match[2].trim(),
    homeScore: Number(match[3]),
    awayScore: Number(match[4]),
  };
}

async function processTelegramMessage(msg) {
  const chatId = msg.chat?.id;
  const from = msg.from;
  const text = msg.text || '';

  if (!text || !from) return;

  const userId = String(from.id);
  const username = from.username || '';

  const usersData = await getSheetData('Users', 'A:Z');

  const existingUserIndex = usersData.findIndex(row => {
    return isDataRow(row, 'user_id') && String(row[0]).trim() === userId;
  });

  if (existingUserIndex === -1) {
    let displayName = from.first_name || username || 'User';
    if (from.last_name && from.first_name) {
      displayName = `${from.first_name} ${from.last_name}`;
    }

    await appendRows('Users', [[
      userId, username, displayName, new Date().toISOString(),
      0, 0, 0, 0, 0, 0, 0, 0,
    ]]);
  }

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return;

  const matchesData = await getSheetData('Matches', 'A:J');
  const matches = matchesData.filter(row => isDataRow(row, 'match_id'));

  let savedCount = 0;

  for (const line of lines) {
    const parsed = parsePredictionText(line);
    if (!parsed) continue;

    const homeNormalized = normalizeTeamName(parsed.home);
    const awayNormalized = normalizeTeamName(parsed.away);

    const match = matches.find(item => {
      const home = String(item[2] || '').toLowerCase().trim();
      const away = String(item[3] || '').toLowerCase().trim();
      return home === homeNormalized.toLowerCase() && away === awayNormalized.toLowerCase();
    });

    if (!match) continue;

    const matchId = String(match[0]).trim();
    const status = String(match[5] || '').trim();
    const kickoff = new Date(match[4]);

    if (status !== 'scheduled' || !Number.isFinite(kickoff.getTime()) || Date.now() >= kickoff.getTime()) {
      continue;
    }

    const predictionsData = await getSheetData('Predictions', 'A:Z');
    const existingIndexes = [];

    predictionsData.forEach((row, rowIndex) => {
      if (
        isDataRow(row, 'prediction_id') &&
        String(row[1]).trim() === userId &&
        String(row[2]).trim() === matchId
      ) {
        existingIndexes.push(rowIndex);
      }
    });

    await deleteRowsByRowIndices('Predictions', existingIndexes);

    await appendRows('Predictions', [[
      `${userId}_${matchId}`, userId, matchId, parsed.homeScore, parsed.awayScore,
      new Date().toISOString(), new Date().toISOString(), 0, '',
    ]]);

    savedCount++;
  }

  if (savedCount > 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ Сохранено прогнозов: ${savedCount}`,
    });
  }
}

async function startBotPolling() {
  console.log('Запуск Telegram polling...');

  while (true) {
    try {
      const response = await callTelegram('getUpdates', {
        offset: telegramOffset,
        timeout: 30,
        allowed_updates: ['message'],
      });

      if (response.ok && response.result.length > 0) {
        for (const update of response.result) {
          telegramOffset = update.update_id + 1;
          if (update.message) {
            await processTelegramMessage(update.message);
          }
        }
      }
    } catch (error) {
      console.error('Ошибка polling:', error.message);
      await sleep(5000);
    }

    await sleep(1000);
  }
}

// ========== Маршруты API ==========
app.post('/api/auth', asyncHandler(async (req, res) => {
  const initDataString = req.body.initData;
  let user = null;

  if (initDataString) {
    if (BOT_TOKEN && !verifyTelegramInitData(initDataString)) {
      return res.status(403).json({ error: 'Invalid initData' });
    }

    try {
      const params = new URLSearchParams(initDataString);
      user = JSON.parse(params.get('user') || 'null');
    } catch (error) {
      user = null;
    }
  }

  if (!user?.id && ALLOW_PLAIN_USER_ID && isNotEmpty(req.body.userId)) {
    user = {
      id: req.body.userId,
      username: req.body.username || '',
      first_name: req.body.firstName || '',
      last_name: req.body.lastName || '',
    };
  }

  if (!user?.id) {
    return res.status(400).json({ error: 'userId required' });
  }

  const userId = String(user.id).trim();
  const usersData = await getSheetData('Users', 'A:Z');

  const existingUser = usersData.find(row => {
    return isDataRow(row, 'user_id') && String(row[0]).trim() === userId;
  });

  if (!existingUser) {
    let displayName = user.first_name || user.username || 'User';
    if (user.last_name && user.first_name) {
      displayName = `${user.first_name} ${user.last_name}`;
    }

    await appendRows('Users', [[
      userId, user.username || '', displayName, new Date().toISOString(),
      0, 0, 0, 0, 0, 0, 0, 0,
    ]]);

    return res.json({ userId, displayName });
  }

  return res.json({
    userId,
    displayName: existingUser[2] || existingUser[1] || 'User',
  });
}));

app.get('/api/matches', asyncHandler(async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId).trim() : null;
  const matchesData = await getSheetData('Matches', 'A:J');
  const matches = matchesData.filter(row => isDataRow(row, 'match_id'));

  let userPredictions = [];

  if (userId) {
    const predictionsData = await getSheetData('Predictions', 'A:Z');
    userPredictions = getLatestPredictionsForUser(predictionsData, userId);
  }

  let result = matches.map(row => {
    const matchId = String(row[0]).trim();
    const userPrediction = userPredictions.find(prediction => String(prediction[2]).trim() === matchId);

    return {
      match_id: matchId,
      stage: row[1] || '',
      home_team: row[2] || '',
      away_team: row[3] || '',
      kickoff_utc: row[4] || '',
      status: row[5] || '',
      home_score: toScore(row[6]),
      away_score: toScore(row[7]),
      user_has_predicted: Boolean(userPrediction),
      user_prediction: userPrediction ? {
        home: toScore(userPrediction[3]),
        away: toScore(userPrediction[4]),
      } : null,
    };
  });

  const includeFinished = String(req.query.includeFinished || 'true').toLowerCase() !== 'false';
  const statusFilter = String(req.query.status || '').toLowerCase().trim();

  if (!includeFinished) {
    result = result.filter(item => item.status !== 'finished');
  }

  if (statusFilter) {
    result = result.filter(item => item.status === statusFilter);
  }

  result.sort((a, b) => {
    const dateA = new Date(a.kickoff_utc).getTime() || Infinity;
    const dateB = new Date(b.kickoff_utc).getTime() || Infinity;
    return dateA - dateB;
  });

  res.json(result);
}));

app.get('/api/my-predictions', asyncHandler(async (req, res) => {
  const userId = req.query.userId ? String(req.query.userId).trim() : '';
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const result = await getUserPredictionsResponse(userId, req.query);
  res.json(result);
}));

app.get('/api/user-predictions/:userId', asyncHandler(async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const result = await getUserPredictionsResponse(userId, req.query);
  res.json(result);
}));

app.post('/api/predictions', asyncHandler(async (req, res) => {
  const userId = extractUserId(req);
  const { matchId, predictedHome, predictedAway } = req.body;

  if (!userId || !matchId || predictedHome === undefined || predictedAway === undefined) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const matchesData = await getSheetData('Matches', 'A:J');

  const matchRowIndex = matchesData.findIndex(row => {
    return isDataRow(row, 'match_id') && String(row[0]).trim() === String(matchId).trim();
  });

  if (matchRowIndex === -1) return res.status(404).json({ error: 'Match not found' });

  const match = padRow(matchesData[matchRowIndex], EXPECTED_COLUMNS.Matches);
  const status = String(match[5] || '').trim();
  const kickoff = new Date(match[4]);

  if (status !== 'scheduled') {
    return res.status(400).json({ error: 'Match is not available for prediction' });
  }

  if (!Number.isFinite(kickoff.getTime()) || Date.now() >= kickoff.getTime()) {
    return res.status(400).json({ error: 'Match already started' });
  }

  const pHome = toScore(predictedHome);
  const pAway = toScore(predictedAway);

  if (pHome === null || pAway === null || pHome < 0 || pAway < 0 || pHome > 20 || pAway > 20) {
    return res.status(400).json({ error: 'Invalid score' });
  }

  const predictionsData = await getSheetData('Predictions', 'A:Z');
  const existingIndexes = [];

  predictionsData.forEach((row, rowIndex) => {
    if (
      isDataRow(row, 'prediction_id') &&
      String(row[1]).trim() === String(userId).trim() &&
      String(row[2]).trim() === String(matchId).trim()
    ) {
      existingIndexes.push(rowIndex);
    }
  });

  await deleteRowsByRowIndices('Predictions', existingIndexes);

  await appendRows('Predictions', [[
    `${userId}_${matchId}`, userId, matchId, pHome, pAway,
    new Date().toISOString(), new Date().toISOString(), 0, '',
  ]]);

  res.json({ success: true });
}));

app.post('/api/admin/match-result', requireAdmin, asyncHandler(async (req, res) => {
  const { matchId, homeScore, awayScore } = req.body;

  if (!matchId || homeScore === undefined || awayScore === undefined) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const hScore = toScore(homeScore);
  const aScore = toScore(awayScore);

  if (hScore === null || aScore === null || hScore < 0 || aScore < 0 || hScore > 20 || aScore > 20) {
    return res.status(400).json({ error: 'Invalid score' });
  }

  const matchesData = await getSheetData('Matches', 'A:J');

  const rowIndex = matchesData.findIndex(row => {
    return isDataRow(row, 'match_id') && String(row[0]).trim() === String(matchId).trim();
  });

  if (rowIndex === -1) return res.status(404).json({ error: 'Match not found' });

  const updatedMatch = padRow(matchesData[rowIndex], EXPECTED_COLUMNS.Matches);
  updatedMatch[5] = 'finished';
  updatedMatch[6] = hScore;
  updatedMatch[7] = aScore;
  updatedMatch[8] = new Date().toISOString();
  updatedMatch[9] = 'TRUE';

  await writeRow('Matches', rowIndex, updatedMatch);
  await recalculatePointsForMatch(matchId, hScore, aScore);

  res.json({ success: true, processed: true });
}));

app.get('/api/match-predictions/:matchId', asyncHandler(async (req, res) => {
  const matchId = String(req.params.matchId || '').trim();

  const [predictionsData, usersData, matchesData] = await Promise.all([
    getSheetData('Predictions', 'A:Z'),
    getSheetData('Users', 'A:Z'),
    getSheetData('Matches', 'A:J'),
  ]);

  const latestMap = getLatestPredictionMap(predictionsData);

  const matchPredictions = [...latestMap.values()]
    .map(item => predictionsData[item.rowIndex])
    .filter(row => row && String(row[2] || '').trim() === matchId);

  const userMap = new Map();

  usersData.forEach(row => {
    if (!isDataRow(row, 'user_id')) return;
    const predictionUserId = String(row[0]).trim();
    const displayName = row[2] || row[1] || predictionUserId;
    userMap.set(predictionUserId, displayName);
  });

  const match = matchesData.find(row => {
    return isDataRow(row, 'match_id') && String(row[0] || '').trim() === matchId;
  });

  const status = String(match?.[5] || '').trim();
  const homeScore = toScore(match?.[6]);
  const awayScore = toScore(match?.[7]);

  const result = matchPredictions.map(prediction => {
    let points = 0;
    let predictionType = '';

    if (status === 'finished' && homeScore !== null && awayScore !== null) {
      const calculated = calculatePoints(
        prediction[3],
        prediction[4],
        homeScore,
        awayScore,
      );
      points = calculated.points;
      predictionType = calculated.type;
    }

    const predictionUserId = String(prediction[1] || '').trim();

    return {
      userId: predictionUserId,
      displayName: userMap.get(predictionUserId) || predictionUserId,
      predictedHome: toScore(prediction[3]),
      predictedAway: toScore(prediction[4]),
      points,
      predictionType,
    };
  });

  result.sort((a, b) => {
    return b.points - a.points ||
      String(a.displayName).localeCompare(String(b.displayName), 'ru', { sensitivity: 'base' });
  });

  res.json(result);
}));

app.get('/api/match-events/:matchId', asyncHandler(async (req, res) => {
  const matchId = String(req.params.matchId || '').trim();
  const eventsData = await getSheetData('MatchEvents', 'A:G');

  const matchEvents = eventsData.filter(row => {
    if (!isDataRow(row, 'match_id')) return false;
    if (String(row[0]).trim() !== matchId) return false;
    const eventType = String(row[1] || '').trim();
    return eventType !== 'no_events' && eventType !== 'events_unavailable';
  });

  const result = matchEvents.map(event => ({
    matchId: String(event[0]).trim(),
    eventType: event[1] || '',
    team: event[2] || '',
    minute: toNum(event[3], 0),
    addedTime: toNum(event[4], 0),
    scoreAfterEvent: event[5] || '',
    player: event[6] || '',
  }));

  result.sort((a, b) => a.minute - b.minute || a.addedTime - b.addedTime);

  res.json(result);
}));


app.get('/api/standings', asyncHandler(async (req, res) => {
  const table = await buildStandingsSnapshot();

  const sortBy = String(req.query.sortBy || '').toLowerCase().trim();
  const requestedOrder = String(req.query.order || '').toLowerCase().trim();

  const sortableFields = {
    points: 'totalPoints',
    totalpoints: 'totalPoints',
    exact: 'exactScores',
    exactscores: 'exactScores',
    difference: 'goalDifference',
    goaldifference: 'goalDifference',
    draws: 'draws',
    outcomes: 'outcomes',
    misses: 'misses',
    successful: 'successfulPredictions',
    successfulpredictions: 'successfulPredictions',
  };

  const defaultComparator = (a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (b.exactScores !== a.exactScores) return b.exactScores - a.exactScores;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    if (b.draws !== a.draws) return b.draws - a.draws;
    if (b.outcomes !== a.outcomes) return b.outcomes - a.outcomes;
    if (a.misses !== b.misses) return a.misses - b.misses;
    if (b.successfulPredictions !== a.successfulPredictions) {
      return b.successfulPredictions - a.successfulPredictions;
    }

    return String(a.displayName || a.userId).localeCompare(
      String(b.displayName || b.userId),
      'ru',
      { numeric: true, sensitivity: 'base' },
    );
  };

  if (sortBy && sortableFields[sortBy]) {
    const field = sortableFields[sortBy];
    const defaultOrder = sortBy === 'misses' ? 'asc' : 'desc';
    const orderName = requestedOrder === 'asc' || requestedOrder === 'desc'
      ? requestedOrder
      : defaultOrder;
    const multiplier = orderName === 'asc' ? 1 : -1;

    table.sort((a, b) => {
      const primary = (toNum(a[field], 0) - toNum(b[field], 0)) * multiplier;
      if (primary !== 0) return primary;
      return defaultComparator(a, b);
    });
  } else {
    table.sort(defaultComparator);
  }

  let previousSignature = null;
  let previousPosition = 0;

  table.forEach((row, index) => {
    const signature = [
      row.totalPoints,
      row.exactScores,
      row.goalDifference,
      row.draws,
      row.outcomes,
      row.misses,
      row.successfulPredictions,
    ].join('|');

    if (sortBy && sortableFields[sortBy]) {
      row.position = index + 1;
    } else if (signature === previousSignature) {
      row.position = previousPosition;
    } else {
      row.position = index + 1;
      previousPosition = row.position;
      previousSignature = signature;
    }
  });

  res.json(table);
}));


app.post('/api/admin/sync-matches', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const result = await fetchUCLMatches();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/admin/update-results', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const updated = await updateFinishedMatches();
    res.json({ success: true, updated });
  } catch (error) {
    console.error('Update results error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/admin/update-events', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const processed = await updateMatchEventsForFinished();
    res.json({ success: true, processed });
  } catch (error) {
    console.error('Update events error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/admin/cleanup-prediction-duplicates', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const removed = await cleanupDuplicatePredictions();
    res.json({ success: true, removed });
  } catch (error) {
    console.error('Cleanup duplicate predictions error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.post('/api/admin/recalculate-all', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const processedMatches = await recalculateAll();
    res.json({ success: true, processed: processedMatches });
  } catch (error) {
    console.error('Recalculate all error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

// ========== Автоматическая синхронизация ==========
let syncInProgress = false;

async function scheduledSync() {
  if (syncInProgress) return;
  syncInProgress = true;

  try {
    console.log('Scheduled sync started');
    await fetchUCLMatches();
    await updateFinishedMatches();
    await updateMatchEventsForFinished();
    console.log('Scheduled sync finished');
  } catch (error) {
    console.error('Scheduled sync error:', error);
  } finally {
    syncInProgress = false;
  }
}

if (AUTO_SYNC && FOOTBALL_DATA_API_KEY) {
  setTimeout(() => { scheduledSync().catch(console.error); }, 10000);
  setInterval(() => { scheduledSync().catch(console.error); }, SYNC_INTERVAL_MS);
}

// ========== Запуск сервера ==========
app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);

  if (BOT_TOKEN) {
    startBotPolling().catch(error => {
      console.error('Ошибка в polling цикле:', error);
    });
  }
});