const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
const userId = tg.initDataUnsafe?.user?.id;
const initData = tg.initData;
const state = {
  standingsSort: { sortBy: '', order: '' },
  myPredictionFilter: 'all',
  pastMatchesOpen: false,
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function formatDateTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Дата не указана';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Без даты';
  return date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function getDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function typeLabel(type) {
  const labels = { exact: 'Точный счёт', difference: 'Разница', draw: 'Ничья', outcome: 'Исход', miss: 'Промах' };
  return labels[type] || '';
}
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
  overlay.addEventListener('click', event => { if (event.target === overlay) closeModal(); });
  overlay.querySelector('.modal-close').onclick = closeModal;
  overlay.querySelector('.modal-bottom-close').onclick = closeModal;
  return overlay;
}

async function auth() {
  if (!userId) { document.getElementById('app').innerHTML = '<div class="empty-state">Откройте приложение через Telegram.</div>'; return; }
  try {
    const data = await apiJson('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }) });
    if (data.userId) await loadMatches();
  } catch (error) {
    console.error(error);
    document.getElementById('app').innerHTML = `<div class="empty-state error">${escapeHtml(error.message)}</div>`;
  }
}

function buildMatchCard(match, { finished = false } = {}) {
  const card = document.createElement('div');
  card.className = `match-card${finished ? ' finished-match' : ''}`;
  const statusLabels = { scheduled: 'Предстоит', live: 'Идёт', finished: 'Завершён', postponed: 'Перенесён' };
  const predictionText = match.user_prediction ? `<div class="prediction-line">Ваш прогноз: <strong>${match.user_prediction.home} - ${match.user_prediction.away}</strong></div>` : '';
  const scoreText = match.status === 'finished' ? `<div class="score-line">Счёт: <strong>${match.home_score ?? '-'} - ${match.away_score ?? '-'}</strong></div>` : '';
  card.innerHTML = `<div class="match-card-main"><div class="match-title">${escapeHtml(match.home_team)} <span class="vs">vs</span> ${escapeHtml(match.away_team)} ${match.user_has_predicted ? '<span class="check-mark">✓</span>' : ''}</div><div class="muted">${escapeHtml(match.stage || '')}</div><div class="muted">${escapeHtml(formatDateTime(match.kickoff_utc))}</div><div class="status status-${escapeHtml(match.status)}">${escapeHtml(statusLabels[match.status] || match.status || '')}</div>${scoreText}${predictionText}</div><div class="match-actions"></div>`;
  const actions = card.querySelector('.match-actions');
  if (match.status === 'scheduled') {
    const predictButton = document.createElement('button');
    predictButton.className = 'primary-button';
    predictButton.textContent = match.user_has_predicted ? 'Изменить прогноз' : 'Сделать прогноз';
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
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Загрузка матчей…</div>';
  try {
    const matches = await apiJson(`/api/matches?userId=${encodeURIComponent(userId)}&includeFinished=true`);
    const activeMatches = matches.filter(match => match.status !== 'finished').sort((a, b) => new Date(a.kickoff_utc) - new Date(b.kickoff_utc));
    const finishedMatches = matches.filter(match => match.status === 'finished');
    app.innerHTML = `
      <div class="section-header"><h2>Матчи</h2><span class="badge">${activeMatches.length} актуальных</span></div>
      <div id="active-matches"></div>
      <button id="toggle-past-matches" class="past-toggle">${state.pastMatchesOpen ? 'Скрыть прошедшие матчи' : `Прошедшие матчи (${finishedMatches.length})`}</button>
      <div id="past-matches" class="${state.pastMatchesOpen ? '' : 'hidden'}"></div>
    `;
    const activeContainer = document.getElementById('active-matches');
    if (!activeMatches.length) activeContainer.innerHTML = '<div class="empty-state">Нет предстоящих или текущих матчей.</div>';
    else activeMatches.forEach(match => activeContainer.appendChild(buildMatchCard(match)));
    const pastContainer = document.getElementById('past-matches');
    renderFinishedMatches(pastContainer, finishedMatches);
    document.getElementById('toggle-past-matches').onclick = () => {
      state.pastMatchesOpen = !state.pastMatchesOpen;
      pastContainer.classList.toggle('hidden', !state.pastMatchesOpen);
      document.getElementById('toggle-past-matches').textContent = state.pastMatchesOpen ? 'Скрыть прошедшие матчи' : `Прошедшие матчи (${finishedMatches.length})`;
    };
  } catch (error) {
    console.error(error);
    app.innerHTML = `<div class="empty-state error">Ошибка загрузки матчей: ${escapeHtml(error.message)}</div>`;
  }
}

function showPredictionModal(match) {
  const currentHome = match.user_prediction?.home ?? 0;
  const currentAway = match.user_prediction?.away ?? 0;
  const overlay = openModal('Прогноз на матч', `<div class="modal-match-name">${escapeHtml(match.home_team)} vs ${escapeHtml(match.away_team)}</div><div class="score-inputs"><label><span>${escapeHtml(match.home_team)}</span><input type="number" id="homeGoals" min="0" max="20" value="${currentHome}"></label><span class="score-separator">:</span><label><span>${escapeHtml(match.away_team)}</span><input type="number" id="awayGoals" min="0" max="20" value="${currentAway}"></label></div><button id="save-prediction" class="primary-button full-width">Сохранить</button>`);
  overlay.querySelector('#save-prediction').onclick = () => submitPrediction(match.match_id);
}

async function submitPrediction(matchId) {
  const homeGoals = document.getElementById('homeGoals').value;
  const awayGoals = document.getElementById('awayGoals').value;
  try {
    const data = await apiJson('/api/predictions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, matchId, predictedHome: homeGoals, predictedAway: awayGoals }) });
    if (data.success) { closeModal(); tg.HapticFeedback?.notificationOccurred?.('success'); await loadMatches(); }
  } catch (error) { console.error(error); alert(error.message || 'Ошибка сохранения прогноза'); }
}

async function showAllPredictions(match) {
  try {
    const [preds, events] = await Promise.all([
      apiJson(`/api/match-predictions/${encodeURIComponent(match.match_id)}`),
      (match.status === 'finished' || match.status === 'live') ? apiJson(`/api/match-events/${encodeURIComponent(match.match_id)}`).catch(() => []) : Promise.resolve([]),
    ]);
    let predictionsHtml = '<div class="responsive-table"><table><thead><tr><th>Участник</th><th>Прогноз</th><th>Очки</th></tr></thead><tbody>';
    if (!preds.length) predictionsHtml += '<tr><td colspan="3">Прогнозов пока нет.</td></tr>';
    else preds.forEach(prediction => { predictionsHtml += `<tr><td>${escapeHtml(prediction.displayName)}</td><td>${prediction.predictedHome} - ${prediction.predictedAway}</td><td>${prediction.points ?? 0}</td></tr>`; });
    predictionsHtml += '</tbody></table></div>';
    let eventsHtml = '';
    if (events.length) {
      eventsHtml = '<div class="events-block"><h4>Голы</h4><ul>';
      events.forEach(event => {
        const minuteLabel = event.addedTime > 0 ? `${event.minute}+${event.addedTime}` : event.minute;
        eventsHtml += `<li>${escapeHtml(minuteLabel)}' — ${escapeHtml(event.team)}: ${escapeHtml(event.player || '')}${event.scoreAfterEvent ? ` (${escapeHtml(event.scoreAfterEvent)})` : ''}</li>`;
      });
      eventsHtml += '</ul></div>';
    }
    const scoreText = match.status === 'finished' ? ` · ${match.home_score ?? '-'}:${match.away_score ?? '-'}` : '';
    openModal(`${match.home_team} — ${match.away_team}${scoreText}`, predictionsHtml + eventsHtml);
  } catch (error) { console.error(error); alert(`Ошибка загрузки прогнозов: ${error.message}`); }
}

function predictionCardHtml(prediction) {
  const finished = prediction.status === 'finished';
  const type = typeLabel(prediction.prediction_type);
  return `<div class="prediction-item ${prediction.prediction_type === 'exact' ? 'prediction-exact' : ''}"><div class="prediction-item-title">${escapeHtml(prediction.home_team)} vs ${escapeHtml(prediction.away_team)}</div><div class="muted">${escapeHtml(formatDateTime(prediction.kickoff_utc))}</div><div>Прогноз: <strong>${prediction.predicted_home ?? '-'} - ${prediction.predicted_away ?? '-'}</strong></div>${finished ? `<div>Счёт: <strong>${prediction.home_score ?? '-'} - ${prediction.away_score ?? '-'}</strong></div>` : ''}${finished ? `<div class="result-line">${type ? `${escapeHtml(type)} ·` : ''}<strong>${prediction.points} очк.</strong></div>` : '<div class="muted">Матч ещё не завершён</div>'}</div>`;
}

async function loadMyPredictions(filter = state.myPredictionFilter) {
  state.myPredictionFilter = filter;
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Загрузка прогнозов…</div>';
  try {
    const params = new URLSearchParams({ userId: String(userId), sort: filter === 'exact_first' ? 'exact_first' : 'date_desc' });
    if (!['all', 'exact_first'].includes(filter)) params.set('type', filter);
    const predictions = await apiJson(`/api/my-predictions?${params.toString()}`);
    app.innerHTML = `
      <div class="section-header"><h2>Мои прогнозы</h2><span class="badge">${predictions.length}</span></div>
      <div class="filter-bar" id="my-prediction-filters">
        <button data-filter="all" class="${filter === 'all' ? 'active' : ''}">Все</button>
        <button data-filter="exact_first" class="${filter === 'exact_first' ? 'active' : ''}">ТС первыми</button>
        <button data-filter="exact" class="${filter === 'exact' ? 'active' : ''}">Только ТС</button>
        <button data-filter="successful" class="${filter === 'successful' ? 'active' : ''}">С очками</button>
        <button data-filter="miss" class="${filter === 'miss' ? 'active' : ''}">Промахи</button>
      </div>
      <div id="my-predictions-list"></div>
    `;
    document.querySelectorAll('#my-prediction-filters button').forEach(button => { button.onclick = () => loadMyPredictions(button.dataset.filter); });
    const list = document.getElementById('my-predictions-list');
    if (!predictions.length) {
      list.innerHTML = filter === 'exact' ? '<div class="empty-state">Пока нет матчей с полностью угаданным счётом.</div>' : '<div class="empty-state">По выбранному фильтру прогнозов нет.</div>';
      return;
    }
    predictions.forEach(prediction => list.insertAdjacentHTML('beforeend', predictionCardHtml(prediction)));
  } catch (error) {
    console.error(error);
    app.innerHTML = `<div class="empty-state error">Ошибка загрузки прогнозов: ${escapeHtml(error.message)}</div>`;
  }
}

function nextStandingsSort(sortBy) {
  const current = state.standingsSort;
  if (current.sortBy !== sortBy) return { sortBy, order: sortBy === 'misses' ? 'asc' : 'desc' };
  return { sortBy, order: current.order === 'asc' ? 'desc' : 'asc' };
}
function sortArrow(sortBy) {
  if (state.standingsSort.sortBy !== sortBy) return '';
  return state.standingsSort.order === 'asc' ? ' ↑' : ' ↓';
}

async function loadStandings(sortBy = state.standingsSort.sortBy, order = state.standingsSort.order) {
  state.standingsSort = { sortBy, order };
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Расчёт таблицы…</div>';
  try {
    const params = new URLSearchParams();
    if (sortBy) params.set('sortBy', sortBy);
    if (order) params.set('order', order);
    const url = params.toString() ? `/api/standings?${params.toString()}` : '/api/standings';
    const [table, historyData] = await Promise.all([
      apiJson(url),
      apiJson('/api/standings-history').catch(() => ({ previousPositions: {}, currentPositions: {} })),
    ]);
    const { previousPositions, currentPositions } = historyData;

    app.innerHTML = `
      <div class="section-header"><h2>Турнирная таблица</h2><span class="badge">${table.length} участников</span></div>
      <div class="standings-hint">Нажимай на имя — все прогнозы участника. На цифру в колонке — матчи соответствующей категории.</div>
      <div class="filter-bar standings-sort-bar">
        <button data-sort="" class="${!sortBy ? 'active' : ''}">Комплексно</button>
        <button data-sort="points" class="${sortBy === 'points' ? 'active' : ''}">Очки</button>
        <button data-sort="exact" class="${sortBy === 'exact' ? 'active' : ''}">Точные</button>
        <button data-sort="difference" class="${sortBy === 'difference' ? 'active' : ''}">Разницы</button>
        <button data-sort="draws" class="${sortBy === 'draws' ? 'active' : ''}">Ничьи</button>
        <button data-sort="outcomes" class="${sortBy === 'outcomes' ? 'active' : ''}">Исходы</button>
        <button data-sort="misses" class="${sortBy === 'misses' ? 'active' : ''}">Промахи</button>
        <button id="show-last-round" class="secondary-button" style="margin-left: auto;">🏆 Тур</button>
      </div>
      <div class="responsive-table standings-table-wrap">
        <table class="standings-table">
          <thead><tr>
            <th>#</th><th>Участник</th>
            <th><button class="table-sort" data-sort="points">Очки${sortArrow('points')}</button></th>
            <th><button class="table-sort" data-sort="successful">Угадано${sortArrow('successful')}</button></th>
            <th><button class="table-sort" data-sort="exact">Точные${sortArrow('exact')}</button></th>
            <th><button class="table-sort" data-sort="difference">Разницы${sortArrow('difference')}</button></th>
            <th><button class="table-sort" data-sort="draws">Ничьи${sortArrow('draws')}</button></th>
            <th><button class="table-sort" data-sort="outcomes">Исходы${sortArrow('outcomes')}</button></th>
            <th><button class="table-sort" data-sort="misses">Промахи${sortArrow('misses')}</button></th>
          </tr></thead>
          <tbody id="standings-body"></tbody>
        </table>
      </div>
    `;

    document.getElementById('show-last-round').onclick = showLastRoundStandings;

    const body = document.getElementById('standings-body');
    if (!table.length) body.innerHTML = '<tr><td colspan="9">Нет участников.</td></tr>';
    else {
      table.forEach(row => {
        const prevPos = previousPositions[row.userId];
        const currPos = currentPositions[row.userId] || row.position;
        let arrow = '';
        if (prevPos && currPos) {
          const diff = prevPos - currPos;
          if (diff > 0) arrow = `<span class="position-arrow up" title="Поднялся на ${diff}">▲${diff}</span>`;
          else if (diff < 0) arrow = `<span class="position-arrow down" title="Опустился на ${Math.abs(diff)}">▼${Math.abs(diff)}</span>`;
        }
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${row.position} ${arrow}</td>
          <td><button class="link-button participant-link">${escapeHtml(row.displayName)}</button></td>
          <td><button class="metric-button metric-points">${row.totalPoints}</button></td>
          <td><button class="metric-button metric-successful">${row.successfulPredictions}</button></td>
          <td><button class="metric-button metric-exact">${row.exactScores}</button></td>
          <td><button class="metric-button metric-difference">${row.goalDifference}</button></td>
          <td><button class="metric-button metric-draw">${row.draws}</button></td>
          <td><button class="metric-button metric-outcome">${row.outcomes}</button></td>
          <td><button class="metric-button metric-miss">${row.misses}</button></td>
        `;
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

    document.querySelectorAll('.table-sort').forEach(button => {
      button.onclick = () => { const next = nextStandingsSort(button.dataset.sort); loadStandings(next.sortBy, next.order); };
    });
    document.querySelectorAll('.standings-sort-bar button').forEach(button => {
      button.onclick = () => {
        const selected = button.dataset.sort;
        if (!selected) { state.standingsSort = { sortBy: '', order: '' }; loadStandings('', ''); return; }
        const next = nextStandingsSort(selected);
        loadStandings(next.sortBy, next.order);
      };
    });
  } catch (error) {
    console.error(error);
    app.innerHTML = `<div class="empty-state error">Ошибка загрузки таблицы: ${escapeHtml(error.message)}</div>`;
  }
}

async function showParticipantPredictions(targetUserId, displayName, type) {
  const titles = {
    all: `Все прогнозы — ${displayName}`,
    successful: `Матчи с очками — ${displayName}`,
    exact: `Точные счета — ${displayName}`,
    difference: `Угаданная разница — ${displayName}`,
    draw: `Угаданные ничьи — ${displayName}`,
    outcome: `Угаданные исходы — ${displayName}`,
    miss: `Промахи — ${displayName}`,
  };
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
    const modalBody = overlay.querySelector('.modal-body');
    modalBody.insertBefore(chartButton, modalBody.firstChild);
  } catch (error) { console.error(error); alert(`Ошибка загрузки прогнозов участника: ${error.message}`); }
}

async function showPointsChart(userId, displayName) {
  try {
    const history = await apiJson(`/api/user-points-history/${encodeURIComponent(userId)}`);
    if (!history.length) { alert('Нет данных для построения графика'); return; }
    const chartHtml = `<div class="chart-container"><canvas id="pointsChart"></canvas></div>`;
    const overlay = openModal(`Динамика очков — ${displayName}`, chartHtml);

    if (!window.Chart) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    const ctx = document.getElementById('pointsChart').getContext('2d');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: history.map(h => new Date(h.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })),
        datasets: [{
          label: 'Набранные очки',
          data: history.map(h => h.points),
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          tension: 0.1,
          fill: true,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true } } },
    });
  } catch (error) { console.error(error); alert(`Ошибка загрузки графика: ${error.message}`); }
}

async function showLastRoundStandings() {
  try {
    const table = await apiJson('/api/standings-last-round');
    if (!table.length) { openModal('Турнирная таблица за последний тур', '<div class="empty-state">Нет данных за последний тур.</div>'); return; }
    let html = '<div class="responsive-table"><table><thead><tr><th>#</th><th>Участник</th><th>Очки</th><th>Точные</th><th>Разница</th><th>Ничья</th><th>Исход</th><th>Промах</th></tr></thead><tbody>';
    table.forEach(row => {
      html += `<tr><td>${row.position}</td><td>${escapeHtml(row.displayName)}</td><td>${row.points}</td><td>${row.exact}</td><td>${row.difference}</td><td>${row.draw}</td><td>${row.outcome}</td><td>${row.miss}</td></tr>`;
    });
    html += '</tbody></table></div>';
    openModal('Турнирная таблица за последний тур', html);
  } catch (error) { console.error(error); alert(`Ошибка загрузки таблицы за тур: ${error.message}`); }
}

document.getElementById('nav-matches').addEventListener('click', () => loadMatches());
document.getElementById('nav-my-predictions').addEventListener('click', () => loadMyPredictions('all'));
document.getElementById('nav-standings').addEventListener('click', () => { state.standingsSort = { sortBy: '', order: '' }; loadStandings('', ''); });
auth();