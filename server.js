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
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
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

// ========== Вспомогательные функции ==========
async function getSheetData(sheetName, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!${range}`,
  });
  return response.data.values || [];
}

function filterHeader(rows, headerValue) {
  return rows.filter(row => row[0] !== headerValue);
}

async function appendRows(sheetName, rows) {
  if (rows.length === 0) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:A`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: rows },
  });
}

async function updateRow(sheetName, idColumnIndex, idValue, newValues) {
  const data = await getSheetData(sheetName, 'A:Z');
  const rowIndex = data.findIndex(row => row[idColumnIndex] === String(idValue));
  if (rowIndex === -1) return false;
  const range = `${sheetName}!A${rowIndex + 1}:Z${rowIndex + 1}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [newValues] },
  });
  return true;
}

function extractUserId(req) {
  if (req.body.initData) {
    const params = new URLSearchParams(req.body.initData);
    const user = JSON.parse(params.get('user') || '{}');
    return user.id;
  }
  return req.body.userId || req.query.userId || null;
}

// ========== Маппинг статусов ==========
function mapStatus(apiStatus) {
  if (apiStatus === 'SCHEDULED' || apiStatus === 'TIMED') return 'scheduled';
  if (apiStatus === 'LIVE' || apiStatus === 'IN_PLAY') return 'live';
  if (apiStatus === 'FINISHED') return 'finished';
  if (apiStatus === 'POSTPONED') return 'postponed';
  return apiStatus.toLowerCase();
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

// ========== Словарь синонимов ==========
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

function normalizeTeamName(name) {
  const lower = name.toLowerCase().trim();
  if (teamSynonyms[lower]) {
    return teamSynonyms[lower];
  }
  for (const [key, value] of Object.entries(teamSynonyms)) {
    if (lower.includes(key) || key.includes(lower)) {
      return value;
    }
  }
  return name;
}

// ========== Работа с Football-Data.org ==========
function mapStage(apiStage) {
  const stages = {
    'PRELIMINARY': 'Предварительный раунд',
    'FIRST_QUALIFYING_ROUND': '1-й квал. раунд',
    'SECOND_QUALIFYING_ROUND': '2-й квал. раунд',
    'THIRD_QUALIFYING_ROUND': '3-й квал. раунд',
    'PLAY_OFF_ROUND': 'Раунд плей-офф',
    'GROUP_STAGE': 'Групповой этап',
    'ROUND_OF_16': '1/8 финала',
    'QUARTER_FINALS': '1/4 финала',
    'SEMI_FINALS': 'Полуфинал',
    'FINAL': 'Финал',
  };
  return stages[apiStage] || apiStage;
}

async function fetchUCLMatches() {
  if (!FOOTBALL_DATA_API_KEY) {
    throw new Error('FOOTBALL_DATA_API_KEY не задан');
  }
  const season = '2026';
  const url = `${FOOTBALL_DATA_BASE_URL}/competitions/CL/matches?season=${season}`;
  const response = await fetch(url, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Football-Data.org API error: ${response.status} ${text}`);
  }
  const data = await response.json();
  const matches = data.matches || [];
  const existingMatches = filterHeader(await getSheetData('Matches', 'A:J'), 'match_id');
  const existingIds = new Set(existingMatches.map(row => row[0]));

  const newRows = [];

  for (const match of matches) {
    const matchId = String(match.id);
    if (existingIds.has(matchId)) continue;

    let homeTeam = match.homeTeam?.name || 'Unknown';
    let awayTeam = match.awayTeam?.name || 'Unknown';
    if (teamTranslations[homeTeam]) homeTeam = teamTranslations[homeTeam];
    if (teamTranslations[awayTeam]) awayTeam = teamTranslations[awayTeam];

    const kickoffUtc = match.utcDate || '';
    const status = mapStatus(match.status);
    const stage = mapStage(match.stage);

    let homeScore = '';
    let awayScore = '';
    let resultUpdatedAt = '';
    if (status === 'finished' && match.score && match.score.fullTime) {
      homeScore = match.score.fullTime.home;
      awayScore = match.score.fullTime.away;
      resultUpdatedAt = new Date().toISOString();
    }

    newRows.push([
      matchId,
      stage,
      homeTeam,
      awayTeam,
      kickoffUtc,
      status,
      homeScore,
      awayScore,
      resultUpdatedAt,
      'FALSE'
    ]);
    existingIds.add(matchId);
  }

  await appendRows('Matches', newRows);
  return newRows.length;
}

async function updateFinishedMatches() {
  if (!FOOTBALL_DATA_API_KEY) {
    throw new Error('FOOTBALL_DATA_API_KEY не задан');
  }
  const season = '2026';
  const url = `${FOOTBALL_DATA_BASE_URL}/competitions/CL/matches?season=${season}`;
  const response = await fetch(url, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Football-Data.org API error: ${response.status} ${text}`);
  }
  const data = await response.json();
  const apiMatches = data.matches || [];

  const sheetMatches = await getSheetData('Matches', 'A:J');
  const matchRows = filterHeader(sheetMatches, 'match_id');

  for (const apiMatch of apiMatches) {
    if (apiMatch.status !== 'FINISHED') continue;

    const matchId = String(apiMatch.id);
    const sheetIndex = matchRows.findIndex(row => row[0] === matchId);
    if (sheetIndex === -1) continue;

    const currentRow = matchRows[sheetIndex];
    const scoreLocked = currentRow[9] === 'TRUE';

    if (scoreLocked) continue;

    const homeScore = apiMatch.score?.fullTime?.home;
    const awayScore = apiMatch.score?.fullTime?.away;
    if (homeScore === undefined || awayScore === undefined) continue;

    const currentHome = currentRow[6];
    const currentAway = currentRow[7];
    if (currentHome === String(homeScore) && currentAway === String(awayScore)) {
      continue;
    }

    const updatedRow = [...currentRow];
    updatedRow[5] = 'finished';
    updatedRow[6] = homeScore;
    updatedRow[7] = awayScore;
    updatedRow[8] = new Date().toISOString();

    const actualRowIndex = sheetMatches.findIndex(row => row[0] === matchId);
    if (actualRowIndex === -1) continue;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Matches!A${actualRowIndex + 1}:J${actualRowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [updatedRow] },
    });

    await recalculatePointsForMatch(matchId, homeScore, awayScore);
  }
  return true;
}

async function fetchMatchEvents(matchId) {
  if (!FOOTBALL_DATA_API_KEY) {
    throw new Error('FOOTBALL_DATA_API_KEY не задан');
  }
  const url = `${FOOTBALL_DATA_BASE_URL}/matches/${matchId}/events`;
  const response = await fetch(url, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY },
  });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return data.events || [];
}

async function updateMatchEventsForFinished() {
  const finishedMatches = filterHeader(await getSheetData('Matches', 'A:J'), 'match_id')
    .filter(row => row[5] === 'finished');

  const existingEvents = filterHeader(await getSheetData('MatchEvents', 'A:G'), 'match_id');
  const existingMatchIds = new Set(existingEvents.map(row => row[0]));

  const matchesToProcess = finishedMatches
    .filter(match => !existingMatchIds.has(match[0]))
    .slice(0, 4);

  for (const match of matchesToProcess) {
    const matchId = match[0];
    try {
      const events = await fetchMatchEvents(matchId);
      if (events && events.length > 0) {
        const rows = [];
        for (const ev of events) {
          if (ev.type !== 'GOAL') continue;
          const team = ev.team?.name || '';
          const minute = ev.minute || 0;
          const addedTime = ev.injuryTime || 0;
          const player = ev.player?.name || '';
          rows.push([matchId, 'goal', team, minute, addedTime, '', player]);
        }
        if (rows.length > 0) {
          await appendRows('MatchEvents', rows);
        }
      }
    } catch (err) {
      console.error(`Ошибка получения событий для матча ${matchId}:`, err.message);
    }

    if (match !== matchesToProcess[matchesToProcess.length - 1]) {
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return matchesToProcess.length;
}

async function recalculatePointsForMatch(matchId, homeScore, awayScore) {
  const predictions = filterHeader(await getSheetData('Predictions', 'A:Z'), 'prediction_id');
  const matchPredictions = predictions.filter(row => row[2] === matchId);

  for (const pred of matchPredictions) {
    const predHome = Number(pred[3]);
    const predAway = Number(pred[4]);
    const { points, type } = calculatePoints(predHome, predAway, homeScore, awayScore);

    const oldPoints = Number(pred[7]);
    const oldType = pred[8] || '';

    const updatedPred = [pred[0], pred[1], pred[2], pred[3], pred[4], pred[5], pred[6], points, type];
    await updateRow('Predictions', 0, pred[0], updatedPred);

    const userId = pred[1];
    const users = filterHeader(await getSheetData('Users', 'A:Z'), 'user_id');
    const userIndex = users.findIndex(row => row[0] === String(userId));
    if (userIndex === -1) continue;
    const allUsers = await getSheetData('Users', 'A:Z');
    const user = [...allUsers[userIndex + 1]];

    user[4] = Number(user[4]) - oldPoints;
    if (oldPoints > 0) user[6] = Number(user[6]) - 1;
    if (oldType === 'exact') user[7] = Number(user[7]) - 1;
    if (oldType === 'difference') user[8] = Number(user[8]) - 1;
    if (oldType === 'draw') user[9] = Number(user[9]) - 1;
    if (oldType === 'outcome') user[10] = Number(user[10]) - 1;
    if (oldType === 'miss') user[11] = Number(user[11]) - 1;

    user[4] = Number(user[4]) + points;
    if (points > 0) user[6] = Number(user[6]) + 1;
    if (type === 'exact') user[7] = Number(user[7]) + 1;
    if (type === 'difference') user[8] = Number(user[8]) + 1;
    if (type === 'draw') user[9] = Number(user[9]) + 1;
    if (type === 'outcome') user[10] = Number(user[10]) + 1;
    if (type === 'miss') user[11] = Number(user[11]) + 1;

    await updateRow('Users', 0, userId, user);
  }
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

async function processTelegramMessage(msg) {
  const chatId = msg.chat?.id;
  const from = msg.from;
  const text = msg.text || '';

  if (!text || !from) return;

  const userId = from.id;
  const username = from.username || '';

  // Регистрируем пользователя, если его нет
  const users = filterHeader(await getSheetData('Users', 'A:Z'), 'user_id');
  const existingUser = users.find(row => row[0] === String(userId));
  if (!existingUser) {
    let displayName = from.first_name || username || 'User';
    if (from.last_name && from.first_name) {
      displayName = `${from.first_name} ${from.last_name}`;
    }
    await appendRows('Users', [[
      userId,
      username,
      displayName,
      new Date().toISOString(),
      0, 0, 0, 0, 0, 0, 0, 0
    ]]);
  }

  try {
    const parsed = parsePredictionText(text);
    if (!parsed) {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'Не удалось распознать матч и счёт. Используйте формат: "Команда1 - Команда2 Счёт" или /predict Команда1 - Команда2 Счёт.'
      });
      return;
    }

    const homeNormalized = normalizeTeamName(parsed.home);
    const awayNormalized = normalizeTeamName(parsed.away);

    const matches = filterHeader(await getSheetData('Matches', 'A:J'), 'match_id');
    const match = matches.find(m => {
      const home = (m[2] || '').toLowerCase().trim();
      const away = (m[3] || '').toLowerCase().trim();
      return home === homeNormalized.toLowerCase() &&
             away === awayNormalized.toLowerCase();
    });

    if (!match) {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: `Матч "${parsed.home} - ${parsed.away}" не найден. Проверьте названия команд.`
      });
      return;
    }

    const matchId = match[0];
    const status = match[5];
    const kickoff = new Date(match[4]);
    if (status !== 'scheduled' || Date.now() >= kickoff.getTime()) {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: `Матч уже начался или завершён, прогнозы не принимаются.`
      });
      return;
    }

    const predictions = filterHeader(await getSheetData('Predictions', 'A:Z'), 'prediction_id');
    const existingIndex = predictions.findIndex(row => row[1] === String(userId) && row[2] === matchId);
    if (existingIndex !== -1) {
      const row = predictions[existingIndex];
      const updatedRow = [row[0], userId, matchId, parsed.homeScore, parsed.awayScore, row[5], new Date().toISOString(), 0, ''];
      await updateRow('Predictions', 0, row[0], updatedRow);
    } else {
      const predictionId = `${userId}_${matchId}`;
      await appendRows('Predictions', [[
        predictionId,
        userId,
        matchId,
        parsed.homeScore,
        parsed.awayScore,
        new Date().toISOString(),
        new Date().toISOString(),
        0,
        ''
      ]]);
    }

    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: `✅ Прогноз сохранён: ${match[2]} ${parsed.homeScore}:${parsed.awayScore} ${match[3]}`
    });

  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'Произошла внутренняя ошибка. Попробуйте позже.'
    });
  }
}

function parsePredictionText(text) {
  const clean = text.replace(/^\/predict\s+/, '').trim();
  const match = clean.match(/^(.*?)\s*[-–—]\s*(.*?)\s+(\d+)\s*:\s*(\d+)$/);
  if (!match) return null;
  return {
    home: match[1].trim(),
    away: match[2].trim(),
    homeScore: Number(match[3]),
    awayScore: Number(match[4])
  };
}

async function startBotPolling() {
  console.log('Запуск Telegram polling...');
  while (true) {
    try {
      const response = await callTelegram('getUpdates', {
        offset: telegramOffset,
        timeout: 30,
        allowed_updates: ['message']
      });

      if (response.ok && response.result.length > 0) {
        for (const update of response.result) {
          telegramOffset = update.update_id + 1;
          if (update.message) {
            await processTelegramMessage(update.message);
          }
        }
      }
    } catch (err) {
      console.error('Ошибка polling:', err.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// ========== Маршруты API ==========
app.post('/api/auth', async (req, res) => {
  const initDataString = req.body.initData;
  if (!initDataString) {
    return res.status(400).json({ error: 'initData required' });
  }
  const params = new URLSearchParams(initDataString);
  const user = JSON.parse(params.get('user'));
  const userId = user.id;

  const users = filterHeader(await getSheetData('Users', 'A:Z'), 'user_id');
  const existing = users.find(row => row[0] === String(userId));
  if (!existing) {
    let displayName = user.first_name || user.username || 'User';
    if (user.last_name && user.first_name) {
      displayName = `${user.first_name} ${user.last_name}`;
    }
    await appendRows('Users', [[
      userId,
      user.username || '',
      displayName,
      new Date().toISOString(),
      0, 0, 0, 0, 0, 0, 0, 0
    ]]);
    return res.json({ userId, displayName });
  } else {
    return res.json({ userId, displayName: existing[2] });
  }
});

app.get('/api/matches', async (req, res) => {
  const userId = req.query.userId;
  const matches = filterHeader(await getSheetData('Matches', 'A:J'), 'match_id');
  let userPredictions = [];
  if (userId) {
    const predictions = filterHeader(await getSheetData('Predictions', 'A:Z'), 'prediction_id');
    userPredictions = predictions.filter(row => row[1] === String(userId));
  }

  const result = matches.map(row => {
    const matchId = row[0];
    const userPred = userPredictions.find(p => p[2] === matchId);
    return {
      match_id: matchId,
      stage: row[1],
      home_team: row[2],
      away_team: row[3],
      kickoff_utc: row[4],
      status: row[5],
      home_score: row[6],
      away_score: row[7],
      user_has_predicted: !!userPred,
      user_prediction: userPred ? { home: Number(userPred[3]), away: Number(userPred[4]) } : null,
    };
  });
  res.json(result);
});

app.post('/api/predictions', async (req, res) => {
  const userId = extractUserId(req);
  const { matchId, predictedHome, predictedAway } = req.body;
  if (!userId || !matchId || predictedHome === undefined || predictedAway === undefined) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  const matches = filterHeader(await getSheetData('Matches', 'A:J'), 'match_id');
  const match = matches.find(row => row[0] === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  const kickoff = new Date(match[4]);
  if (Date.now() >= kickoff.getTime()) {
    return res.status(400).json({ error: 'Match already started' });
  }
  const pHome = Number(predictedHome);
  const pAway = Number(predictedAway);
  if (isNaN(pHome) || isNaN(pAway) || pHome < 0 || pAway < 0 || pHome > 20 || pAway > 20) {
    return res.status(400).json({ error: 'Invalid score' });
  }
  const predictions = filterHeader(await getSheetData('Predictions', 'A:Z'), 'prediction_id');
  const existingIndex = predictions.findIndex(row => row[1] === String(userId) && row[2] === matchId);
  if (existingIndex !== -1) {
    const row = predictions[existingIndex];
    const updatedRow = [row[0], userId, matchId, pHome, pAway, row[5], new Date().toISOString(), 0, ''];
    await updateRow('Predictions', 0, row[0], updatedRow);
  } else {
    const predictionId = `${userId}_${matchId}`;
    await appendRows('Predictions', [[
      predictionId,
      userId,
      matchId,
      pHome,
      pAway,
      new Date().toISOString(),
      new Date().toISOString(),
      0,
      ''
    ]]);
  }
  res.json({ success: true });
});

app.post('/api/admin/match-result', async (req, res) => {
  const userId = extractUserId(req);
  const adminIds = process.env.ADMIN_USER_IDS.split(',').map(Number);
  if (!adminIds.includes(Number(userId))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { matchId, homeScore, awayScore } = req.body;
  if (!matchId || homeScore === undefined || awayScore === undefined) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  const hScore = Number(homeScore);
  const aScore = Number(awayScore);
  if (isNaN(hScore) || isNaN(aScore) || hScore < 0 || aScore < 0 || hScore > 20 || aScore > 20) {
    return res.status(400).json({ error: 'Invalid score' });
  }
  const matches = filterHeader(await getSheetData('Matches', 'A:J'), 'match_id');
  const matchIndex = matches.findIndex(row => row[0] === matchId);
  if (matchIndex === -1) return res.status(404).json({ error: 'Match not found' });
  const allMatches = await getSheetData('Matches', 'A:J');
  const updatedMatch = [...allMatches[matchIndex + 1]];
  updatedMatch[5] = 'finished';
  updatedMatch[6] = hScore;
  updatedMatch[7] = aScore;
  updatedMatch[8] = new Date().toISOString();
  updatedMatch[9] = 'TRUE';
  await updateRow('Matches', 0, matchId, updatedMatch);

  await recalculatePointsForMatch(matchId, hScore, aScore);
  res.json({ success: true, processed: true });
});

app.get('/api/match-predictions/:matchId', async (req, res) => {
  const { matchId } = req.params;
  const predictions = filterHeader(await getSheetData('Predictions', 'A:Z'), 'prediction_id');
  const matchPreds = predictions.filter(row => row[2] === matchId);

  const users = filterHeader(await getSheetData('Users', 'A:Z'), 'user_id');
  const userMap = new Map(users.map(u => [u[0], u[2] || u[1] || u[0]]));

  const result = matchPreds.map(p => ({
    userId: p[1],
    displayName: userMap.get(p[1]) || p[1],
    predictedHome: Number(p[3]),
    predictedAway: Number(p[4]),
    points: Number(p[7]),
    predictionType: p[8] || '',
  }));

  res.json(result);
});

app.get('/api/match-events/:matchId', async (req, res) => {
  const { matchId } = req.params;
  const events = filterHeader(await getSheetData('MatchEvents', 'A:G'), 'match_id');
  const matchEvents = events.filter(row => row[0] === matchId);
  const result = matchEvents.map(e => ({
    matchId: e[0],
    eventType: e[1],
    team: e[2],
    minute: Number(e[3]),
    addedTime: e[4] ? Number(e[4]) : 0,
    scoreAfterEvent: e[5],
    player: e[6] || '',
  }));
  res.json(result);
});

app.get('/api/standings', async (req, res) => {
  const users = filterHeader(await getSheetData('Users', 'A:Z'), 'user_id');
  const table = users.map(row => ({
    userId: row[0],
    username: row[1],
    displayName: row[2],
    registrationDate: row[3],
    totalPoints: Number(row[4]),
    successfulPredictions: Number(row[6]),
    exactScores: Number(row[7]),
    goalDifference: Number(row[8]),
    draws: Number(row[9]),
    outcomes: Number(row[10]),
    misses: Number(row[11]),
  }));
  table.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (b.successfulPredictions !== a.successfulPredictions) return b.successfulPredictions - a.successfulPredictions;
    if (b.exactScores !== a.exactScores) return b.exactScores - a.exactScores;
    if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
    if (b.draws !== a.draws) return b.draws - a.draws;
    if (b.outcomes !== a.outcomes) return b.outcomes - a.outcomes;
    return a.userId - b.userId;
  });
  table.forEach((row, index) => row.position = index + 1);
  res.json(table);
});

app.post('/api/admin/sync-matches', async (req, res) => {
  const userId = extractUserId(req);
  const adminIds = process.env.ADMIN_USER_IDS.split(',').map(Number);
  if (!adminIds.includes(Number(userId))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const count = await fetchUCLMatches();
    res.json({ success: true, fetched: count });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/update-results', async (req, res) => {
  const apiKey = req.headers['x-admin-api-key'] || req.body.apiKey;
  if (!ADMIN_API_KEY || apiKey !== ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await updateFinishedMatches();
    res.json({ success: true });
  } catch (error) {
    console.error('Update results error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/update-events', async (req, res) => {
  const apiKey = req.headers['x-admin-api-key'] || req.body.apiKey;
  if (!ADMIN_API_KEY || apiKey !== ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const processed = await updateMatchEventsForFinished();
    res.json({ success: true, processed });
  } catch (error) {
    console.error('Update events error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/recalculate-all', async (req, res) => {
  const apiKey = req.headers['x-admin-api-key'] || req.body.apiKey;
  if (!ADMIN_API_KEY || apiKey !== ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const allUsers = await getSheetData('Users', 'A:Z');
    const userRows = filterHeader(allUsers, 'user_id');
    for (let i = 0; i < userRows.length; i++) {
      const user = [...userRows[i]];
      user[4] = 0;
      user[6] = 0;
      user[7] = 0;
      user[8] = 0;
      user[9] = 0;
      user[10] = 0;
      user[11] = 0;
      await updateRow('Users', 0, user[0], user);
    }

    const allPredictions = await getSheetData('Predictions', 'A:Z');
    const predictionRows = filterHeader(allPredictions, 'prediction_id');
    for (const pred of predictionRows) {
      const updatedPred = [...pred];
      updatedPred[7] = 0;
      updatedPred[8] = '';
      await updateRow('Predictions', 0, pred[0], updatedPred);
    }

    const allMatches = filterHeader(await getSheetData('Matches', 'A:J'), 'match_id');
    const finishedMatches = allMatches.filter(row => row[5] === 'finished' && row[6] !== '' && row[7] !== '');
    for (const match of finishedMatches) {
      const matchId = match[0];
      const homeScore = Number(match[6]);
      const awayScore = Number(match[7]);
      await recalculatePointsForMatch(matchId, homeScore, awayScore);
    }

    res.json({ success: true, processed: finishedMatches.length });
  } catch (error) {
    console.error('Recalculate all error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

function calculatePoints(predHome, predAway, actHome, actAway) {
  if (predHome === actHome && predAway === actAway) return { points: 5, type: 'exact' };
  if (actHome === actAway && predHome === predAway) return { points: 3, type: 'draw' };
  if ((predHome - predAway) === (actHome - actAway)) return { points: 3, type: 'difference' };
  if ((predHome > predAway && actHome > actAway) || (predHome < predAway && actHome < actAway)) return { points: 1, type: 'outcome' };
  return { points: 0, type: 'miss' };
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
  if (BOT_TOKEN) {
    startBotPolling().catch(err => {
      console.error('Ошибка в polling цикле:', err);
    });
  }
});