const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
const userId = tg.initDataUnsafe?.user?.id;
const initData = tg.initData;
const state = {
  standingsSort: { sortBy: '', order: '' },
  myPredictionFilter: 'all',
  pastMatchesOpen: false,
  duelsView: 'open',
  balance: null,
};

function escapeHtml(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
function formatDateTime(v) { const d = new Date(v); if (!Number.isFinite(d.getTime())) return 'Дата не указана'; return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function formatDay(v) { const d = new Date(v); if (!Number.isFinite(d.getTime())) return 'Без даты'; return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
function getDayKey(v) { const d = new Date(v); if (!Number.isFinite(d.getTime())) return 'unknown'; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function typeLabel(t) { return { exact: 'Точный счёт', difference: 'Разница', draw: 'Ничья', outcome: 'Исход', miss: 'Промах' }[t] || ''; }

async function apiJson(url, options = {}) {
  const response = await fetch(url, options);
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new Error(data?.error || `Ошибка HTTP ${response.status}`);
  return data;
}

function closeModal() { document.querySelector('.modal-overlay')?.remove(); }
function openModal(title, bodyHtml) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-card"><div class="modal-header"><h3>${escapeHtml(title)}</h3><button class="icon-button modal-close" aria-label="Закрыть">×</button></div><div class="modal-body">${bodyHtml}</div><button class="secondary-button modal-bottom-close">Закрыть</button></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  overlay.querySelector('.modal-close').onclick = closeModal;
  overlay.querySelector('.modal-bottom-close').onclick = closeModal;
  return overlay;
}

// ===== Тосты =====
function showToast(message, type = 'info', ttl = 2500) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, ttl);
}

// ===== Баланс фантиков в хедере =====
async function refreshBalance() {
  if (!userId) return;
  try {
    const info = await apiJson(`/api/fantiki/balance/${encodeURIComponent(userId)}`);
    state.balance = info;
    const valEl = document.getElementById('balance-value');
    const lvlEl = document.getElementById('level-badge');
    if (valEl) valEl.textContent = info.balance;
    if (lvlEl) {
      if (info.level > 0) { lvlEl.textContent = info.levelName; lvlEl.style.display = ''; }
      else { lvlEl.style.display = 'none'; }
    }
  } catch { /* молча */ }
}

async function tryDailyLogin() {
  if (!userId) return;
  try {
    const r = await apiJson('/api/daily-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, userId: String(userId) }),
    });
    if (r.success) { showToast(`+${r.amount} 🪙 за вход`, 'success'); await refreshBalance(); }
  } catch { /* молча */ }
}

// ===== Навигация =====
function setActiveNav(name) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`nav-${name}`);
  if (btn) btn.classList.add('active');
}

async function auth() {
  if (!userId) { document.getElementById('app').innerHTML = '<div class="empty-state">Откройте приложение через Telegram.</div>'; return; }
  try {
    await apiJson('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, userId: String(userId) }) });
    await refreshBalance();
    tryDailyLogin().catch(() => {});
    await loadMatches();
  } catch (error) { document.getElementById('app').innerHTML = `<div class="empty-state error">${escapeHtml(error.message)}</div>`; }
}

// ===== Матчи =====
function buildMatchCard(match, { finished = false } = {}) {
  const card = document.createElement('div');
  card.className = `match-card${finished ? ' finished-match' : ''}`;
  const statusLabels = { scheduled: 'Предстоит', live: 'Идёт', finished: 'Завершён', postponed: 'Перенесён' };
  const predictionText = match.user_prediction ? `<div class="prediction-line">Ваш прогноз: <strong>${match.user_prediction.home} - ${match.user_prediction.away}</strong></div>` : '';
  const scoreText = match.status === 'finished' ? `<div class="score-line">Счёт: <strong>${match.home_score ?? '-'} - ${match.away_score ?? '-'}</strong></div>` : '';
  const oddsBlock = !finished ? `<div class="odds-line hidden" data-odds-match="${escapeHtml(match.match_id)}"></div>` : '';
  card.innerHTML = `<div class="match-card-main"><div class="match-title">${escapeHtml(match.home_team)} <span class="vs">vs</span> ${escapeHtml(match.away_team)} ${match.user_has_predicted ? '<span class="check-mark">✓</span>' : ''}</div>${oddsBlock}<div class="muted">${escapeHtml(match.stage || '')}</div><div class="muted">${escapeHtml(formatDateTime(match.kickoff_utc))}</div><div class="status status-${escapeHtml(match.status)}">${escapeHtml(statusLabels[match.status] || match.status || '')}</div>${scoreText}${predictionText}</div><div class="match-actions"></div>`;
  const actions = card.querySelector('.match-actions');
  if (match.status === 'scheduled') {
    const predictButton = document.createElement('button');
    predictButton.className = 'primary-button';
    predictButton.textContent = match.user_has_predicted ? 'Изменить' : 'Сделать прогноз';
    predictButton.onclick = () => showPredictionModal(match);
    actions.appendChild(predictButton);
  }
  const allButton = document.createElement('button');
  allButton.className = 'secondary-button';
  allButton.textContent = 'Прогнозы';
  allButton.onclick = () => showAllPredictions(match);
  actions.appendChild(allButton);
  return card;
}

async function loadOddsForMatches(matches) {
  if (!matches.length) return;
  await Promise.allSettled(matches.map(async match => {
    const container = document.querySelector(`[data-odds-match="${match.match_id}"]`);
    if (!container || !container.isConnected) return;
    try {
      const data = await apiJson(`/api/match-odds/${encodeURIComponent(match.match_id)}`);
      if (data?.enabled && data?.odds) {
        const f = v => Number(v || 0).toFixed(2);
        container.classList.remove('hidden');
        container.title = `Средние коэффициенты по ${data.odds.bookmakers} букмекерам`;
        container.innerHTML = `<span class="odds-item">1 <strong>${f(data.odds.home)}</strong></span><span class="odds-item">X <strong>${f(data.odds.draw)}</strong></span><span class="odds-item">2 <strong>${f(data.odds.away)}</strong></span>`;
      } else container.remove();
    } catch { container.remove(); }
  }));
}

function renderFinishedMatches(container, matches) {
  container.innerHTML = '';
  if (!matches.length) { container.innerHTML = '<div class="empty-state compact">Прошедших матчей пока нет.</div>'; return; }
  const grouped = new Map();
  [...matches].sort((a, b) => new Date(b.kickoff_utc) - new Date(a.kickoff_utc)).forEach(match => {
    const key = getDayKey(match.kickoff_utc);
    if (!grouped.has(key)) grouped.set(key, { label: formatDay(match.kickoff_utc), matches: [] });
    grouped.get(key).matches.push(match);
  });
  for (const group of grouped.values()) {
    const daySection = document.createElement('section');
    daySection.className = 'past-day';
    daySection.innerHTML = `<h3>${escapeHtml(group.label)}</h3>`;
    group.matches.forEach(match => daySection.appendChild(buildMatchCard(match, { finished: true })));
    container.appendChild(daySection);
  }
}

async function loadMatches() {
  setActiveNav('matches');
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Загрузка матчей…</div>';
  try {
    const matches = await apiJson(`/api/matches?userId=${encodeURIComponent(userId)}&includeFinished=true`);
    const activeMatches = matches.filter(m => m.status !== 'finished').sort((a, b) => new Date(a.kickoff_utc) - new Date(b.kickoff_utc));
    const finishedMatches = matches.filter(m => m.status === 'finished');
    app.innerHTML = `<div class="section-header"><h2>Матчи</h2><span class="badge">${activeMatches.length} актуальных</span></div><div id="active-matches"></div><button id="toggle-past-matches" class="past-toggle">${state.pastMatchesOpen ? 'Скрыть прошедшие матчи' : `Прошедшие матчи (${finishedMatches.length})`}</button><div id="past-matches" class="${state.pastMatchesOpen ? '' : 'hidden'}"></div>`;
    const activeContainer = document.getElementById('active-matches');
    if (!activeMatches.length) activeContainer.innerHTML = '<div class="empty-state">Нет предстоящих или текущих матчей.</div>';
    else { activeMatches.forEach(match => activeContainer.appendChild(buildMatchCard(match))); loadOddsForMatches(activeMatches).catch(() => {}); }
    const pastContainer = document.getElementById('past-matches');
    renderFinishedMatches(pastContainer, finishedMatches);
    document.getElementById('toggle-past-matches').onclick = () => {
      state.pastMatchesOpen = !state.pastMatchesOpen;
      pastContainer.classList.toggle('hidden', !state.pastMatchesOpen);
      document.getElementById('toggle-past-matches').textContent = state.pastMatchesOpen ? 'Скрыть прошедшие матчи' : `Прошедшие матчи (${finishedMatches.length})`;
    };
  } catch (error) { app.innerHTML = `<div class="empty-state error">Ошибка загрузки матчей: ${escapeHtml(error.message)}</div>`; }
}

function showPredictionModal(match) {
  const ch = match.user_prediction?.home ?? 0, ca = match.user_prediction?.away ?? 0;
  const overlay = openModal('Прогноз на матч', `<div class="modal-match-name">${escapeHtml(match.home_team)} vs ${escapeHtml(match.away_team)}</div><div class="score-inputs"><label><span>${escapeHtml(match.home_team)}</span><input type="number" id="homeGoals" min="0" max="20" value="${ch}"></label><span class="score-separator">:</span><label><span>${escapeHtml(match.away_team)}</span><input type="number" id="awayGoals" min="0" max="20" value="${ca}"></label></div><button id="save-prediction" class="primary-button full-width">Сохранить</button>`);
  overlay.querySelector('#save-prediction').onclick = () => submitPrediction(match.match_id);
}

async function submitPrediction(matchId) {
  const homeGoals = document.getElementById('homeGoals').value, awayGoals = document.getElementById('awayGoals').value;
  try {
    const data = await apiJson('/api/predictions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, userId: String(userId), matchId, predictedHome: homeGoals, predictedAway: awayGoals }) });
    if (data.success) { closeModal(); tg.HapticFeedback?.notificationOccurred?.('success'); showToast('Прогноз сохранён', 'success'); await loadMatches(); }
  } catch (error) { showToast(error.message || 'Ошибка сохранения', 'error'); }
}

async function showAllPredictions(match) {
  try {
    const [preds, events] = await Promise.all([
      apiJson(`/api/match-predictions/${encodeURIComponent(match.match_id)}`),
      (match.status === 'finished' || match.status === 'live') ? apiJson(`/api/match-events/${encodeURIComponent(match.match_id)}`).catch(() => []) : Promise.resolve([]),
    ]);
    let predictionsHtml = '<div class="responsive-table"><table><thead><tr><th>Участник</th><th>Прогноз</th><th>Очки</th></tr></thead><tbody>';
    if (!preds.length) predictionsHtml += '<tr><td colspan="3">Прогнозов пока нет.</td></tr>';
    else preds.forEach(p => { predictionsHtml += `<tr><td>${escapeHtml(p.displayName)}</td><td>${p.predictedHome} - ${p.predictedAway}</td><td>${p.points ?? 0}</td></tr>`; });
    predictionsHtml += '</tbody></table></div>';
    let eventsHtml = '';
    if (events.length) {
      eventsHtml = '<div class="events-block"><h4>Голы</h4><ul>';
      events.forEach(e => { const m = e.addedTime > 0 ? `${e.minute}+${e.addedTime}` : e.minute; eventsHtml += `<li>${escapeHtml(m)}' — ${escapeHtml(e.team)}: ${escapeHtml(e.player || '')}${e.scoreAfterEvent ? ` (${escapeHtml(e.scoreAfterEvent)})` : ''}</li>`; });
      eventsHtml += '</ul></div>';
    }
    const scoreText = match.status === 'finished' ? ` · ${match.home_score ?? '-'}:${match.away_score ?? '-'}` : '';
    openModal(`${match.home_team} — ${match.away_team}${scoreText}`, predictionsHtml + eventsHtml);
  } catch (error) { showToast(`Ошибка: ${error.message}`, 'error'); }
}

// ===== Мои прогнозы =====
function predictionCardHtml(p) {
  const finished = p.status === 'finished', type = typeLabel(p.prediction_type);
  return `<div class="prediction-item ${p.prediction_type === 'exact' ? 'prediction-exact' : ''}"><div class="prediction-item-title">${escapeHtml(p.home_team)} vs ${escapeHtml(p.away_team)}</div><div class="muted">${escapeHtml(formatDateTime(p.kickoff_utc))}</div><div>Прогноз: <strong>${p.predicted_home ?? '-'} - ${p.predicted_away ?? '-'}</strong></div>${finished ? `<div>Счёт: <strong>${p.home_score ?? '-'} - ${p.away_score ?? '-'}</strong></div>` : ''}${finished ? `<div class="result-line">${type ? `${escapeHtml(type)} ·` : ''}<strong>${p.points} очк.</strong>${p.fantiki_awarded ? ` · +${p.fantiki_awarded} 🪙` : ''}</div>` : '<div class="muted">Матч ещё не завершён</div>'}</div>`;
}

async function loadMyPredictions(filter = state.myPredictionFilter) {
  setActiveNav('my-predictions');
  state.myPredictionFilter = filter;
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Загрузка прогнозов…</div>';
  try {
    const params = new URLSearchParams({ userId: String(userId), sort: filter === 'exact_first' ? 'exact_first' : 'date_desc' });
    if (!['all', 'exact_first'].includes(filter)) params.set('type', filter);
    const predictions = await apiJson(`/api/my-predictions?${params.toString()}`);
    app.innerHTML = `<div class="section-header"><h2>Мои прогнозы</h2><span class="badge">${predictions.length}</span></div><div class="filter-bar" id="my-prediction-filters"><button data-filter="all" class="${filter === 'all' ? 'active' : ''}">Все</button><button data-filter="exact_first" class="${filter === 'exact_first' ? 'active' : ''}">ТС первыми</button><button data-filter="exact" class="${filter === 'exact' ? 'active' : ''}">Только ТС</button><button data-filter="successful" class="${filter === 'successful' ? 'active' : ''}">С очками</button><button data-filter="miss" class="${filter === 'miss' ? 'active' : ''}">Промахи</button></div><div id="my-predictions-list"></div>`;
    document.querySelectorAll('#my-prediction-filters button').forEach(b => { b.onclick = () => loadMyPredictions(b.dataset.filter); });
    const list = document.getElementById('my-predictions-list');
    if (!predictions.length) { list.innerHTML = filter === 'exact' ? '<div class="empty-state">Пока нет матчей с полностью угаданным счётом.</div>' : '<div class="empty-state">По выбранному фильтру прогнозов нет.</div>'; return; }
    predictions.forEach(p => list.insertAdjacentHTML('beforeend', predictionCardHtml(p)));
  } catch (error) { app.innerHTML = `<div class="empty-state error">Ошибка загрузки прогнозов: ${escapeHtml(error.message)}</div>`; }
}

// ===== Таблица =====
function nextStandingsSort(sortBy) {
  const current = state.standingsSort;
  if (current.sortBy !== sortBy) return { sortBy, order: sortBy === 'misses' ? 'asc' : 'desc' };
  return { sortBy, order: current.order === 'asc' ? 'desc' : 'asc' };
}
function sortArrow(sortBy) { if (state.standingsSort.sortBy !== sortBy) return ''; return state.standingsSort.order === 'asc' ? ' ↑' : ' ↓'; }

async function loadStandings(sortBy = state.standingsSort.sortBy, order = state.standingsSort.order) {
  setActiveNav('standings');
  state.standingsSort = { sortBy, order };
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Расчёт таблицы…</div>';
  try {
    const params = new URLSearchParams();
    if (sortBy) params.set('sortBy', sortBy);
    if (order) params.set('order', order);
    const url = params.toString() ? `/api/standings?${params.toString()}` : '/api/standings';
    const [table, historyData] = await Promise.all([apiJson(url), apiJson('/api/standings-history').catch(() => ({ previousPositions: {}, currentPositions: {} }))]);
    const { previousPositions, currentPositions } = historyData;
    app.innerHTML = `<div class="section-header"><h2>Турнирная таблица</h2><span class="badge">${table.length} участников</span></div><div class="standings-hint">Нажимай на имя — все прогнозы участника. На цифру в колонке — матчи соответствующей категории.</div><div class="filter-bar standings-sort-bar"><button data-sort="" class="${!sortBy ? 'active' : ''}">Комплексно</button><button data-sort="points" class="${sortBy === 'points' ? 'active' : ''}">Очки</button><button data-sort="exact" class="${sortBy === 'exact' ? 'active' : ''}">Точные</button><button data-sort="difference" class="${sortBy === 'difference' ? 'active' : ''}">Разницы</button><button data-sort="draws" class="${sortBy === 'draws' ? 'active' : ''}">Ничьи</button><button data-sort="outcomes" class="${sortBy === 'outcomes' ? 'active' : ''}">Исходы</button><button data-sort="misses" class="${sortBy === 'misses' ? 'active' : ''}">Промахи</button><button id="show-last-round" class="secondary-button" style="margin-left: auto;">🏆 Тур</button></div><div class="responsive-table standings-table-wrap"><table class="standings-table"><thead><tr><th>#</th><th>Участник</th><th><button class="table-sort" data-sort="points">Очки${sortArrow('points')}</button></th><th><button class="table-sort" data-sort="successful">Угадано${sortArrow('successful')}</button></th><th><button class="table-sort" data-sort="exact">Точные${sortArrow('exact')}</button></th><th><button class="table-sort" data-sort="difference">Разницы${sortArrow('difference')}</button></th><th><button class="table-sort" data-sort="draws">Ничьи${sortArrow('draws')}</button></th><th><button class="table-sort" data-sort="outcomes">Исходы${sortArrow('outcomes')}</button></th><th><button class="table-sort" data-sort="misses">Промахи${sortArrow('misses')}</button></th></tr></thead><tbody id="standings-body"></tbody></table></div>`;
    document.getElementById('show-last-round').onclick = showLastRoundStandings;
    const body = document.getElementById('standings-body');
    if (!table.length) body.innerHTML = '<tr><td colspan="9">Нет участников.</td></tr>';
    else {
      table.forEach(row => {
        const prevPos = previousPositions[row.userId], currPos = currentPositions[row.userId] || row.position;
        let arrow = '';
        if (prevPos && currPos) { const diff = prevPos - currPos; if (diff > 0) arrow = `<span class="position-arrow up" title="Поднялся на ${diff}">▲${diff}</span>`; else if (diff < 0) arrow = `<span class="position-arrow down" title="Опустился на ${Math.abs(diff)}">▼${Math.abs(diff)}</span>`; }
        const levelHtml = row.level > 0 ? `<span class="table-level">${escapeHtml(row.levelName)}</span>` : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${row.position} ${arrow}</td><td><button class="link-button participant-link">${escapeHtml(row.displayName)}${levelHtml}</button></td><td><button class="metric-button metric-points">${row.totalPoints}</button></td><td><button class="metric-button metric-successful">${row.successfulPredictions}</button></td><td><button class="metric-button metric-exact">${row.exactScores}</button></td><td><button class="metric-button metric-difference">${row.goalDifference}</button></td><td><button class="metric-button metric-draw">${row.draws}</button></td><td><button class="metric-button metric-outcome">${row.outcomes}</button></td><td><button class="metric-button metric-miss">${row.misses}</button></td>`;
        tr.querySelector('.participant-link').onclick = () => showParticipantPredictions(row.userId, row.displayName, 'all');
        tr.querySelector('.metric-points').onclick = () => showParticipantPredictions(row.userId, row.displayName, 'successful');
        tr.querySelector('.metric-successful').onclick = () => showParticipantPredictions(row.userId, row.displayName, 'successful');
        tr.querySelector('.metric-exact').onclick = () => showParticipantPredictions(row.userId, row.displayName, 'exact');
        tr.querySelector('.metric-difference').onclick = () => showParticipantPredictions(row.userId, row.displayName, 'difference');
        tr.querySelector('.metric-draw').onclick = () => showParticipantPredictions(row.userId, row.displayName, 'draw');
        tr.querySelector('.metric-outcome').onclick = () => showParticipantPredictions(row.userId, row.displayName, 'outcome');
        tr.querySelector('.metric-miss').onclick = () => showParticipantPredictions(row.userId, row.displayName, 'miss');
        body.appendChild(tr);
      });
    }
    document.querySelectorAll('.table-sort').forEach(b => { b.onclick = () => { const n = nextStandingsSort(b.dataset.sort); loadStandings(n.sortBy, n.order); }; });
    document.querySelectorAll('.standings-sort-bar button:not(#show-last-round)').forEach(b => {
      b.onclick = () => {
        const s = b.dataset.sort;
        if (!s) { state.standingsSort = { sortBy: '', order: '' }; loadStandings('', ''); return; }
        const n = nextStandingsSort(s);
        loadStandings(n.sortBy, n.order);
      };
    });
  } catch (error) { app.innerHTML = `<div class="empty-state error">Ошибка загрузки таблицы: ${escapeHtml(error.message)}</div>`; }
}

async function showParticipantPredictions(targetUserId, displayName, type) {
  const titles = { all: `Все прогнозы — ${displayName}`, successful: `Матчи с очками — ${displayName}`, exact: `Точные счета — ${displayName}`, difference: `Угаданная разница — ${displayName}`, draw: `Угаданные ничьи — ${displayName}`, outcome: `Угаданные исходы — ${displayName}`, miss: `Промахи — ${displayName}` };
  try {
    const params = new URLSearchParams({ sort: 'date_desc' });
    if (type && type !== 'all') params.set('type', type);
    const predictions = await apiJson(`/api/user-predictions/${encodeURIComponent(targetUserId)}?${params.toString()}`);
    const bodyHtml = predictions.length ? predictions.map(predictionCardHtml).join('') : '<div class="empty-state compact">Матчей по этой категории нет.</div>';
    const overlay = openModal(titles[type] || titles.all, bodyHtml);
    const chartButton = document.createElement('button');
    chartButton.className = 'primary-button';
    chartButton.textContent = '📊 Показать динамику очков';
    chartButton.style.marginTop = '1rem';
    chartButton.style.width = '100%';
    chartButton.onclick = () => showPointsChart(targetUserId, displayName);
    overlay.querySelector('.modal-body').insertBefore(chartButton, overlay.querySelector('.modal-body').firstChild);
  } catch (error) { showToast(`Ошибка: ${error.message}`, 'error'); }
}

async function showPointsChart(targetUserId, displayName) {
  try {
    const history = await apiJson(`/api/user-points-history/${encodeURIComponent(targetUserId)}`);
    if (!history.length) { showToast('Нет данных для графика', 'error'); return; }
    openModal(`Динамика очков — ${displayName}`, `<div class="chart-container"><canvas id="pointsChart"></canvas></div><div class="muted" style="margin-top: 8px; text-align: center;">Сумма очков за каждый игровой день</div>`);
    if (!window.Chart) { await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/chart.js'; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); }); }
    new Chart(document.getElementById('pointsChart').getContext('2d'), {
      type: 'bar',
      data: { labels: history.map(h => h.label), datasets: [{ label: 'Очки за день', data: history.map(h => h.points), backgroundColor: 'rgba(75, 192, 192, 0.65)', borderColor: 'rgb(75, 192, 192)', borderWidth: 1, borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
  } catch (error) { showToast(`Ошибка графика: ${error.message}`, 'error'); }
}

async function showLastRoundStandings() {
  try {
    const table = await apiJson('/api/standings-last-round');
    if (!table.length) { openModal('Турнирная таблица за последний тур', '<div class="empty-state">За последние 3 дня нет завершённых матчей.</div>'); return; }
    let html = '<div class="muted" style="margin-bottom: 10px;">Учитываются завершённые матчи максимум за последние 3 дня.</div><div class="responsive-table"><table><thead><tr><th>#</th><th>Участник</th><th>Очки</th><th>Точные</th><th>Разница</th><th>Ничьи</th><th>Исходы</th><th>Промахи</th></tr></thead><tbody>';
    table.forEach(row => { html += `<tr><td>${row.position}</td><td>${escapeHtml(row.displayName)}</td><td class="round-points">${row.points}</td><td>${row.exact}</td><td>${row.difference}</td><td>${row.draw}</td><td>${row.outcome}</td><td>${row.miss}</td></tr>`; });
    html += '</tbody></table></div>';
    openModal('Турнирная таблица за последние 3 дня', html);
  } catch (error) { showToast(`Ошибка: ${error.message}`, 'error'); }
}

// ===== Дуэли =====
function duelCardHtml(duel, { mine = false } = {}) {
  const isCreator = duel.creator_id === String(userId);
  const isParticipant = duel.participants.some(p => p.userId === String(userId));
  const statusLabels = { open: 'Открыта', full: 'Заполнена', settled: 'Завершена', cancelled: 'Отменена', refunded: 'Возврат' };
  const participantsList = duel.participants.map(p => {
    const res = p.result && p.result !== 'pending' ? ` (${p.result === 'winner' ? 'победа' : p.result === 'loser' ? 'проигрыш' : 'возврат'})` : '';
    return `${escapeHtml(p.displayName)}: ${p.predictedHome}:${p.predictedAway}${res}`;
  }).join(', ');
  const actions = [];
  if (duel.status === 'open' && !isParticipant) {
    actions.push(`<button class="primary-button duel-join-btn" data-duel="${escapeHtml(duel.duel_id)}">Вступить</button>`);
  }
  if (isCreator && duel.status === 'open' && duel.participants_count === 1) {
    actions.push(`<button class="secondary-button duel-cancel-btn" data-duel="${escapeHtml(duel.duel_id)}">Отменить</button>`);
  }
  let myBetHtml = '';
  if (mine && duel.my_bet) {
    const res = duel.my_bet.result;
    const resClass = res === 'winner' ? 'duel-result-winner' : res === 'loser' ? 'duel-result-loser' : res === 'refunded' ? 'duel-result-refunded' : '';
    const resLabel = res === 'winner' ? 'победа' : res === 'loser' ? 'проигрыш' : res === 'refunded' ? 'возврат' : '';
    myBetHtml = `<div class="duel-my-bet">Ваш прогноз: <strong>${duel.my_bet.predictedHome}:${duel.my_bet.predictedAway}</strong>${res !== 'pending' ? ` · <span class="${resClass}">${resLabel}</span>` : ''}</div>`;
  }
  const scoreHtml = duel.match_status === 'finished' && duel.home_score !== null ? `<div class="duel-meta">Счёт: <strong>${duel.home_score}:${duel.away_score}</strong></div>` : '';
  return `<div class="duel-card"><div class="duel-header"><div class="duel-teams">${escapeHtml(duel.home_team)} — ${escapeHtml(duel.away_team)}</div><span class="duel-stake">${duel.stake} 🪙</span></div><div class="duel-meta">${escapeHtml(formatDateTime(duel.kickoff_utc))} · ${escapeHtml(statusLabels[duel.status] || duel.status)}</div>${scoreHtml}<div class="duel-participants">Участников: ${duel.participants_count} · Банк: ${duel.pot} 🪙</div><div class="duel-participants">${participantsList || 'Пока никого'}</div>${myBetHtml}${actions.length ? `<div class="duel-actions">${actions.join('')}</div>` : ''}</div>`;
}

async function loadDuels(view = state.duelsView) {
  setActiveNav('duels');
  state.duelsView = view;
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Загрузка дуэлей…</div>';
  try {
    const [open, mine] = await Promise.all([
      apiJson('/api/duels/open'),
      apiJson(`/api/duels/my/${encodeURIComponent(userId)}`).catch(() => []),
    ]);
    const activeMine = mine.filter(d => ['open','full'].includes(d.status));
    const historyMine = mine.filter(d => !['open','full'].includes(d.status));
    app.innerHTML = `<div class="section-header"><h2>Дуэли</h2><button id="create-duel-btn" class="primary-button">+ Создать</button></div><div class="duel-tabs"><button class="duel-tab ${view === 'open' ? 'active' : ''}" data-view="open">Открытые (${open.length})</button><button class="duel-tab ${view === 'my' ? 'active' : ''}" data-view="my">Мои (${activeMine.length})</button></div><div id="duels-list"></div>`;
    document.getElementById('create-duel-btn').onclick = openCreateDuelModal;
    document.querySelectorAll('.duel-tab').forEach(b => b.onclick = () => loadDuels(b.dataset.view));
    const list = document.getElementById('duels-list');
    const items = view === 'open' ? open : activeMine;
    if (!items.length) {
      list.innerHTML = view === 'open'
        ? '<div class="empty-state">Нет открытых дуэлей. Создайте первую!</div>'
        : '<div class="empty-state">У вас нет активных дуэлей.</div>';
    } else {
      items.forEach(d => list.insertAdjacentHTML('beforeend', duelCardHtml(d, { mine: view === 'my' })));
      list.querySelectorAll('.duel-join-btn').forEach(b => b.onclick = () => openJoinDuelModal(items.find(x => x.duel_id === b.dataset.duel)));
      list.querySelectorAll('.duel-cancel-btn').forEach(b => b.onclick = () => cancelDuel(b.dataset.duel));
    }
    if (view === 'my' && historyMine.length) {
      list.insertAdjacentHTML('beforeend', '<div class="section-header" style="margin-top:20px"><h3 style="font-size:16px">История</h3></div>');
      historyMine.forEach(d => list.insertAdjacentHTML('beforeend', duelCardHtml(d, { mine: true })));
    }
  } catch (error) { app.innerHTML = `<div class="empty-state error">Ошибка загрузки дуэлей: ${escapeHtml(error.message)}</div>`; }
}

async function openCreateDuelModal() {
  let matches;
  try { matches = await apiJson('/api/matches?status=scheduled'); }
  catch (e) { showToast(`Ошибка: ${e.message}`, 'error'); return; }
  if (!matches.length) { showToast('Нет матчей для дуэли', 'error'); return; }
  const options = matches.map(m => `<option value="${escapeHtml(m.match_id)}">${escapeHtml(m.home_team)} — ${escapeHtml(m.away_team)} · ${escapeHtml(formatDateTime(m.kickoff_utc))}</option>`).join('');
  const overlay = openModal('Создать дуэль', `<label class="form-label">Матч</label><select id="duel-match" class="form-input">${options}</select><label class="form-label">Ваш прогноз</label><div class="score-inputs"><input type="number" id="duel-ph" min="0" max="20" value="1" class="form-input"><span class="score-separator">:</span><input type="number" id="duel-pa" min="0" max="20" value="0" class="form-input"></div><label class="form-label">Ставка (10–500, кратна 5)</label><input type="number" id="duel-stake" min="10" max="500" step="5" value="20" class="form-input"><button id="duel-submit" class="primary-button full-width">Создать дуэль</button>`);
  overlay.querySelector('#duel-submit').onclick = () => submitCreateDuel(overlay);
}

async function submitCreateDuel(overlay) {
  const matchId = overlay.querySelector('#duel-match').value;
  const ph = Number(overlay.querySelector('#duel-ph').value);
  const pa = Number(overlay.querySelector('#duel-pa').value);
  const stake = Number(overlay.querySelector('#duel-stake').value);
  if (!Number.isFinite(ph) || !Number.isFinite(pa) || ph < 0 || pa < 0 || ph > 20 || pa > 20) { showToast('Некорректный счёт', 'error'); return; }
  if (stake < 10 || stake > 500 || stake % 5 !== 0) { showToast('Ставка 10–500, кратна 5', 'error'); return; }
  const btn = overlay.querySelector('#duel-submit');
  btn.disabled = true; btn.textContent = 'Создание...';
  try {
    const r = await apiJson('/api/duels/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, userId: String(userId), matchId, predictedHome: ph, predictedAway: pa, stake }),
    });
    if (r.success) { closeModal(); tg.HapticFeedback?.notificationOccurred?.('success'); showToast(`Дуэль создана. Ставка ${stake} 🪙`, 'success'); await refreshBalance(); await loadDuels(); }
    else { showToast(r.error || 'Ошибка', 'error'); btn.disabled = false; btn.textContent = 'Создать дуэль'; }
  } catch (e) { showToast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Создать дуэль'; }
}

function openJoinDuelModal(duel) {
  if (!duel) return;
  const occupied = duel.participants.map(p => `${p.predictedHome}:${p.predictedAway}`).join(', ');
  const overlay = openModal('Вступить в дуэль', `<div class="modal-match-name">${escapeHtml(duel.home_team)} — ${escapeHtml(duel.away_team)}</div><div class="muted" style="margin: 10px 0;">Ставка: <strong>${duel.stake} 🪙</strong> · Банк: ${duel.pot} 🪙</div><div class="muted" style="margin-bottom: 10px;">Занятые счета: ${occupied}</div><label class="form-label">Ваш прогноз (не должен совпадать)</label><div class="score-inputs"><input type="number" id="duel-ph" min="0" max="20" value="1" class="form-input"><span class="score-separator">:</span><input type="number" id="duel-pa" min="0" max="20" value="0" class="form-input"></div><button id="duel-submit" class="primary-button full-width">Вступить за ${duel.stake} 🪙</button>`);
  overlay.querySelector('#duel-submit').onclick = () => submitJoinDuel(duel, overlay);
}

async function submitJoinDuel(duel, overlay) {
  const ph = Number(overlay.querySelector('#duel-ph').value);
  const pa = Number(overlay.querySelector('#duel-pa').value);
  if (!Number.isFinite(ph) || !Number.isFinite(pa) || ph < 0 || pa < 0 || ph > 20 || pa > 20) { showToast('Некорректный счёт', 'error'); return; }
  if (duel.participants.some(p => p.predictedHome === ph && p.predictedAway === pa)) { showToast('Такой счёт уже занят', 'error'); return; }
  const btn = overlay.querySelector('#duel-submit');
  btn.disabled = true; btn.textContent = 'Вступление...';
  try {
    const r = await apiJson(`/api/duels/join/${encodeURIComponent(duel.duel_id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, userId: String(userId), predictedHome: ph, predictedAway: pa }),
    });
    if (r.success) { closeModal(); tg.HapticFeedback?.notificationOccurred?.('success'); showToast(`Вы вступили. Ставка ${duel.stake} 🪙`, 'success'); await refreshBalance(); await loadDuels(); }
    else { showToast(r.error || 'Ошибка', 'error'); btn.disabled = false; btn.textContent = 'Вступить'; }
  } catch (e) { showToast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Вступить'; }
}

async function cancelDuel(duelId) {
  if (!confirm('Отменить дуэль? Ставка вернётся на баланс.')) return;
  try {
    const r = await apiJson(`/api/duels/cancel/${encodeURIComponent(duelId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, userId: String(userId) }),
    });
    if (r.success) { showToast('Дуэль отменена', 'success'); await refreshBalance(); await loadDuels(); }
    else showToast(r.error || 'Ошибка', 'error');
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== Навигация =====
document.getElementById('nav-matches').addEventListener('click', () => loadMatches());
document.getElementById('nav-my-predictions').addEventListener('click', () => loadMyPredictions('all'));
document.getElementById('nav-standings').addEventListener('click', () => { state.standingsSort = { sortBy: '', order: '' }; loadStandings('', ''); });
document.getElementById('nav-duels').addEventListener('click', () => loadDuels('open'));

auth();