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

// ========== Вспомогательные функции для Google Sheets ==========
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
  const existingMatches = filterHeader(await getSheetData('Matches', 'A:Z'), 'match_id');
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
    ]);
    existingIds.add(matchId);
  }

  await appendRows('Matches', newRows);
  return newRows.length;
}

// Функция для обновления результатов завершённых матчей
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

  // Получаем текущие матчи из листа, включая заголовок
  const sheetMatches = await getSheetData('Matches', 'A:Z');
  const matchRows = filterHeader(sheetMatches, 'match_id');

  for (const apiMatch of apiMatches) {
    if (apiMatch.status !== 'FINISHED') continue; // только завершённые

    const matchId = String(apiMatch.id);
    const sheetIndex = matchRows.findIndex(row => row[0] === matchId);
    if (sheetIndex === -1) continue; // нет в листе

    const currentRow = matchRows[sheetIndex];
    const currentStatus = currentRow[5];
    const currentHome = currentRow[6];
    const currentAway = currentRow[7];

    // Если уже finished и счёт заполнен, пропускаем
    if (currentStatus === 'finished' && currentHome !== '' && currentAway !== '') {
      continue;
    }

    // Получаем счёт из API
    const homeScore = apiMatch.score?.fullTime?.home;
    const awayScore = apiMatch.score?.fullTime?.away;
    if (homeScore === undefined || awayScore === undefined) continue;

    // Обновляем строку матча в листе
    const updatedRow = [...currentRow];
    updatedRow[5] = 'finished';
    updatedRow[6] = homeScore;
    updatedRow[7] = awayScore;
    updatedRow[8] = new Date().toISOString();

    // Находим фактический индекс в sheetMatches (с учётом заголовка)
    const actualRowIndex = sheetMatches.findIndex(row => row[0] === matchId);
    if (actualRowIndex === -1) continue;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Matches!A${actualRowIndex + 1}:Z${actualRowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [updatedRow] },
    });

    // Пересчитываем очки для прогнозов этого матча
    await recalculatePointsForMatch(matchId, homeScore, awayScore);
  }
  return true;
}

// Функция пересчёта очков для конкретного матча
async function recalculatePointsForMatch(matchId, homeScore, awayScore) {
  const predictions = filterHeader(await getSheetData('Predictions', 'A:Z'), 'prediction_id');
  const matchPredictions = predictions.filter(row => row[2] === matchId);

  for (const pred of matchPredictions) {
    const predHome = Number(pred[3]);
    const predAway = Number(pred[4]);
    const { points, type } = calculatePoints(predHome, predAway, homeScore, awayScore);

    // Обновляем прогноз
    const updatedPred = [pred[0], pred[1], pred[2], pred[3], pred[4], pred[5], pred[6], points, type];
    await updateRow('Predictions', 0, pred[0], updatedPred);

    // Обновляем статистику пользователя
    const userId = pred[1];
    const users = filterHeader(await getSheetData('Users', 'A:Z'), 'user_id');
    const userIndex = users.findIndex(row => row[0] === String(userId));
    if (userIndex === -1) continue;
    const allUsers = await getSheetData('Users', 'A:Z');
    const user = [...allUsers[userIndex + 1]]; // +1 из-за заголовка
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

// ========== Маршруты API ==========

// Авторизация / регистрация
app.post('/api/auth', async (req, res) => {
  const initDataString = req.body.initData;
  if (!initDataString) {
    return res.status(400).json({ error: 'initData required' });
  }
  // Проверка подписи временно отключена
  // if (!verifyTelegramWebAppData(initDataString)) {
  //   return res.status(401).json({ error: 'Invalid signature' });
  // }
  const params = new URLSearchParams(initDataString);
  const user = JSON.parse(params.get('user'));
  const userId = user.id;

  const users = filterHeader(await getSheetData('Users', 'A:Z'), 'user_id');
  const existing = users.find(row => row[0] === String(userId));
  if (!existing) {
    const displayName = user.first_name || user.username || 'User';
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

// Получение матчей (с информацией о прогнозах пользователя)
app.get('/api/matches', async (req, res) => {
  const userId = req.query.userId;
  const matches = filterHeader(await getSheetData('Matches', 'A:Z'), 'match_id');
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

// Создание/обновление прогноза
app.post('/api/predictions', async (req, res) => {
  const userId = extractUserId(req);
  const { matchId, predictedHome, predictedAway } = req.body;
  if (!userId || !matchId || predictedHome === undefined || predictedAway === undefined) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  const matches = filterHeader(await getSheetData('Matches', 'A:Z'), 'match_id');
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

// Ручной ввод результата (админ) - оставлен для совместимости
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
  const matches = filterHeader(await getSheetData('Matches', 'A:Z'), 'match_id');
  const matchIndex = matches.findIndex(row => row[0] === matchId);
  if (matchIndex === -1) return res.status(404).json({ error: 'Match not found' });
  const allMatches = await getSheetData('Matches', 'A:Z');
  const updatedMatch = [...allMatches[matchIndex + 1]];
  updatedMatch[5] = 'finished';
  updatedMatch[6] = hScore;
  updatedMatch[7] = aScore;
  updatedMatch[8] = new Date().toISOString();
  await updateRow('Matches', 0, matchId, updatedMatch);

  await recalculatePointsForMatch(matchId, hScore, aScore);
  res.json({ success: true, processed: true });
});

// Получение прогнозов всех пользователей на конкретный матч
app.get('/api/match-predictions/:matchId', async (req, res) => {
  const { matchId } = req.params;
  const predictions = filterHeader(await getSheetData('Predictions', 'A:Z'), 'prediction_id');
  const matchPreds = predictions.filter(row => row[2] === matchId);

  const users = filterHeader(await getSheetData('Users', 'A:Z'), 'user_id');
  const userMap = new Map(users.map(u => [u[0], u[2] || u[1] || u[0]])); // displayName

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

// Турнирная таблица
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

// Синхронизация матчей из Football-Data.org (админ)
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

// Автоматическое обновление результатов (защищено API-ключом)
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

// ========== Расчёт очков ==========
function calculatePoints(predHome, predAway, actHome, actAway) {
  if (predHome === actHome && predAway === actAway) return { points: 5, type: 'exact' };
  if (actHome === actAway && predHome === predAway) return { points: 3, type: 'draw' };
  if ((predHome - predAway) === (actHome - actAway)) return { points: 3, type: 'difference' };
  if ((predHome > predAway && actHome > actAway) || (predHome < predAway && actHome < actAway)) return { points: 1, type: 'outcome' };
  return { points: 0, type: 'miss' };
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});