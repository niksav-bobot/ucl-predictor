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
  today: null,
};

function escapeHtml(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
function formatDateTime(v) { const d = new Date(v); if (!Number.isFinite(d.getTime())) return '—'; return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function formatDay(v) { const d = new Date(v); if (!Number.isFinite(d.getTime())) return 'Без даты'; return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
function getDayKey(v) { const d = new Date(v); if (!Number.isFinite(d.getTime())) return 'unknown'; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function typeLabel(t) { return { exact: 'Точный счёт', difference: 'Разница', draw: 'Ничья', outcome: 'Исход', miss: 'Промах' }[t] || ''; }

const REASON_LABELS = {
  prediction_award: '🎯 За прогнозы',
  prediction_correction: '↩️ Корректировка',
  daily_streak_bonus: '🔥 Серия ТС',
  daily_login: '📅 Вход в день матча',
  round_prize: '🏆 Призовые за тур',
  quest_predict_5: '📋 Квест: 5 прогнозов',
  quest_predict_all: '📋 Квест: все прогнозы',
  quest_first_exact: '📋 Квест: 1 ТС',
  quest_three_outcomes: '📋 Квест: 3 исхода',
  duel_stake: '⚔️ Ставка в дуэли',
  duel_win: '⚔️ Выигрыш в дуэли',
  duel_refund: '↩️ Возврат из дуэли',
  admin_grant: '👑 Начисление',
};

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

function showToast(message, type = 'info', ttl = 2500) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, ttl);
}

// ===== Хедер =====
async function refreshHeader() {
  if (!userId) return;
  try {
    const [bal, today] = await Promise.all([
      apiJson(`/api/fantiki/balance/${encodeURIComponent(userId)}`).catch(() => null),
      apiJson(`/api/fantiki/today/${encodeURIComponent(userId)}`).catch(() => null),
    ]);
    state.balance = bal;
    state.today = today;

    const todayVal = document.getElementById('today-value');
    const lvlBadge = document.getElementById('level-badge');

    if (todayVal) {
      if (today?.date) {
        const sign = today.total > 0 ? '+' : '';
        todayVal.textContent = `${sign}${today.total}`;
        todayVal.className = 'today-amount ' + (today.total > 0 ? 'pos' : today.total < 0 ? 'neg' : 'zero');
      } else {
        todayVal.textContent = '—';
        todayVal.className = 'today-amount zero';
      }
    }
    if (lvlBadge) {
      if (bal && bal.level > 0) { lvlBadge.textContent = bal.levelName; lvlBadge.style.display = ''; }
      else lvlBadge.style.display = 'none';
    }
  } catch (e) { console.error('refreshHeader:', e); }
}

// ===== Модалка баланса =====
async function openBalanceModal() {
  const [bal, today, tx, levels] = await Promise.all([
    apiJson(`/api/fantiki/balance/${encodeURIComponent(userId)}`).catch(() => state.balance),
    apiJson(`/api/fantiki/today/${encodeURIComponent(userId)}`).catch(() => state.today),
    apiJson(`/api/fantiki/transactions/${encodeURIComponent(userId)}?limit=30`).catch(() => []),
    apiJson('/api/levels').catch(() => []),
  ]);

  const fmt = amt => amt > 0 ? `+${amt}` : `${amt}`;
  const cls = amt => amt > 0 ? 'duel-result-winner' : amt < 0 ? 'duel-result-loser' : '';

  let todayHtml = '';
  if (today?.date) {
    const items = Object.entries(today.breakdown || {}).filter(([, v]) => v !== 0);
    todayHtml = `
      <div class="today-summary">
        <div class="today-total">${fmt(today.total)} 🪙 <span class="muted" style="font-size:13px;font-weight:400">за ${today.date}</span></div>
        ${items.length ? `<ul class="today-breakdown">${items.map(([r, v]) => `<li><span>${REASON_LABELS[r] || escapeHtml(r)}</span><span class="${cls(v)}">${fmt(v)}</span></li>`).join('')}</ul>` : '<div class="muted" style="padding:4px 0">Начислений ещё нет</div>'}
      </div>`;
  } else {
    todayHtml = '<div class="muted" style="padding:8px 0">Нет активного игрового дня</div>';
  }

  const levelsHtml = (levels || []).map(l => {
    const isCur = bal?.level === l.level;
    return `<div class="level-row ${isCur ? 'level-current' : ''}"><span class="level-num">${l.level}</span><span class="level-name">${escapeHtml(l.name)}</span><span class="level-req">${l.min}+ 🪙</span><span class="level-bonus">${l.bonus > 0 ? `+${l.bonus}%` : '—'}</span></div>`;
  }).join('');

  const txHtml = tx.length
    ? `<ul class="tx-list">${tx.map(t => `<li><span>${REASON_LABELS[t.reason] || escapeHtml(t.reason)}</span><span class="tx-amount ${cls(t.amount)}">${fmt(t.amount)}</span><span class="tx-sub">${escapeHtml(formatDateTime(t.createdAt))} · баланс ${t.balanceAfter}</span></li>`).join('')}</ul>`
    : '<div class="muted">Транзакций пока нет</div>';

  openModal('Баланс фантиков', `
    <div class="balance-total">Всего: <strong>${bal?.balance ?? '—'} 🪙</strong></div>
    <div class="muted" style="margin-bottom:8px">${escapeHtml(bal?.levelName || 'Без уровня')} · за сезон: ${bal?.totalEarnedSeason ?? 0} 🪙</div>

    <h4 class="modal-section-title">Сегодня (сбрасывается через 4 ч после последнего матча)</h4>
    ${todayHtml}

    <h4 class="modal-section-title">Уровни</h4>
    <div class="levels-list">${levelsHtml || '<div class="muted">Не удалось загрузить</div>'}</div>

    <h4 class="modal-section-title">Последние начисления</h4>
    ${txHtml}
  `);
}

// ===== Профиль участника =====
async function showParticipantProfile(targetUserId, displayName) {
  const [bal, badgesData] = await Promise.all([
    apiJson(`/api/fantiki/balance/${encodeURIComponent(targetUserId)}`).catch(() => null),
    apiJson(`/api/season-titles/${encodeURIComponent(targetUserId)}`).catch(() => ({ badges: [] })),
  ]);
  const badges = (badgesData?.badges || []);
  const lvlBonus = bal?.levelBonus ? `+${Math.round(bal.levelBonus * 100)}%` : '—';

  const badgesHtml = badges.length
    ? `<div class="profile-badges">${badges.map(b => `<span class="profile-badge">${escapeHtml(b.name)}</span>`).join('')}</div>`
    : '<div class="muted">Бейджей пока нет</div>';

  const overlay = openModal(displayName, `
    <div class="profile-section">
      <div class="profile-balance">${bal?.balance ?? '—'} 🪙</div>
      <div class="muted">Баланс · за сезон заработано ${bal?.totalEarnedSeason ?? 0} 🪙</div>
    </div>
    <div class="profile-level-click" id="profile-level-click">
      <div style="font-weight:600;margin-bottom:4px">${escapeHtml(bal?.levelName || 'Без уровня')} <span class="muted" style="font-weight:400">· ур. ${bal?.level ?? 0}</span></div>
      <div class="muted">Бонус к наградам: ${lvlBonus}</div>
      ${bal?.nextLevelAt ? `<div class="muted">До следующего уровня: ${bal.totalEarnedSeason} / ${bal.nextLevelAt} 🪙</div>` : '<div class="muted">Максимальный уровень</div>'}
      <div class="muted" style="margin-top:6px;font-size:11px">Нажмите, чтобы увидеть все уровни</div>
    </div>
    <div class="profile-section">
      <h4 class="modal-section-title" style="margin-top:0">Бейджи</h4>
      ${badgesHtml}
    </div>
    <button id="profile-all-preds" class="primary-button full-width">Все прогнозы</button>
    <button id="profile-chart" class="secondary-button full-width" style="margin-top:8px">📊 Динамика очков</button>
  `);

  overlay.querySelector('#profile-level-click').onclick = showLevelsModal;
  overlay.querySelector('#profile-all-preds').onclick = () => { closeModal(); showParticipantPredictions(targetUserId, displayName, 'all'); };
  overlay.querySelector('#profile-chart').onclick = () => { closeModal(); showPointsChart(targetUserId, displayName); };
}

async function showLevelsModal() {
  const levels = await apiJson('/api/levels').catch(() => []);
  const cur = state.balance?.level ?? 0;
  const html = (levels || []).map(l => {
    const isCur = cur === l.level;
    return `<div class="level-row ${isCur ? 'level-current' : ''}"><span class="level-num">${l.level}</span><span class="level-name">${escapeHtml(l.name)}</span><span class="level-req">${l.min}+ 🪙</span><span class="level-bonus">${l.bonus > 0 ? `+${l.bonus}%` : '—'}</span></div>`;
  }).join('');
  openModal('Уровни', `<div class="muted" style="margin-bottom:12px">Уровень повышается по мере накопления фантиков за сезон. Бонус прибавляется к наградам за прогнозы.</div><div class="levels-list">${html}</div>`);
}

// ===== Auth / daily login =====
async function tryDailyLogin() {
  if (!userId) return;
  try {
    const r = await apiJson('/api/daily-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, userId: String(userId) }),
    });
    if (r.success) { showToast(`+${r.amount} 🪙 за вход`, 'success'); await refreshHeader(); }
  } catch { /* молча */ }
}

async function auth() {
  if (!userId) { document.getElementById('app').innerHTML = '<div class="empty-state">Откройте приложение через Telegram.</div>'; return; }
  try {
    await apiJson('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, userId: String(userId) }) });
    await refreshHeader();
    tryDailyLogin().catch(() => {});
    await loadMatches();
  } catch (error) { document.getElementById('app').innerHTML = `<div class="empty-state error">${escapeHtml(error.message)}</div>`; }
}

// ===== Навигация =====
function setActiveNav(name) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`nav-${name}`);
  if (btn) btn.classList.add('active');
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
    const b = document.createElement('button');
    b.className = 'primary-button'; b.textContent = match.user_has_predicted ? 'Изменить' : 'Сделать прогноз';
    b.onclick = () => showPredictionModal(match);
    actions.appendChild(b);
  }
  const ab = document.createElement('button');
  ab.className = 'secondary-button'; ab.textContent = 'Прогнозы';
  ab.onclick = () => showAllPredictions(match);
  actions.appendChild(ab);
  return card;
}

async function loadOddsForMatches(matches) {
  if (!matches.length) return;
  await Promise.allSettled(matches.map(async match => {
    const c = document.querySelector(`[data-odds-match="${match.match_id}"]`);
    if (!c || !c.isConnected) return;
    try {
      const data = await apiJson(`/api/match-odds/${encodeURIComponent(match.match_id)}`);
      if (data?.enabled && data?.odds) {
        const f = v => Number(v || 0).toFixed(2);
        c.classList.remove('hidden');
        c.innerHTML = `<span class="odds-item">1 <strong>${f(data.odds.home)}</strong></span><span class="odds-item">X <strong>${f(data.odds.draw)}</strong></span><span class="odds-item">2 <strong>${f(data.odds.away)}</strong></span>`;
      } else c.remove();
    } catch { c.remove(); }
  }));
}

function renderFinishedMatches(container, matches) {
  container.innerHTML = '';
  if (!matches.length) { container.innerHTML = '<div class="empty-state compact">Прошедших матчей пока нет.</div>'; return; }
  const g = new Map();
  [...matches].sort((a, b) => new Date(b.kickoff_utc) - new Date(a.kickoff_utc)).forEach(m => {
    const k = getDayKey(m.kickoff_utc);
    if (!g.has(k)) g.set(k, { label: formatDay(m.kickoff_utc), matches: [] });
    g.get(k).matches.push(m);
  });
  for (const grp of g.values()) {
    const s = document.createElement('section');
    s.className = 'past-day';
    s.innerHTML = `<h3>${escapeHtml(grp.label)}</h3>`;
    grp.matches.forEach(m => s.appendChild(buildMatchCard(m, { finished: true })));
    container.appendChild(s);
  }
}

async function loadMatches() {
  setActiveNav('matches');
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Загрузка матчей…</div>';
  try {
    const matches = await apiJson(`/api/matches?userId=${encodeURIComponent(userId)}&includeFinished=true`);
    const active = matches.filter(m => m.status !== 'finished').sort((a, b) => new Date(a.kickoff_utc) - new Date(b.kickoff_utc));
    const finished = matches.filter(m => m.status === 'finished');
    app.innerHTML = `<div class="section-header"><h2>Матчи</h2><span class="badge">${active.length} актуальных</span></div><div id="active-matches"></div><button id="toggle-past-matches" class="past-toggle">${state.pastMatchesOpen ? 'Скрыть прошедшие матчи' : `Прошедшие матчи (${finished.length})`}</button><div id="past-matches" class="${state.pastMatchesOpen ? '' : 'hidden'}"></div>`;
    const ac = document.getElementById('active-matches');
    if (!active.length) ac.innerHTML = '<div class="empty-state">Нет предстоящих или текущих матчей.</div>';
    else { active.forEach(m => ac.appendChild(buildMatchCard(m))); loadOddsForMatches(active).catch(() => {}); }
    const pc = document.getElementById('past-matches');
    renderFinishedMatches(pc, finished);
    document.getElementById('toggle-past-matches').onclick = () => {
      state.pastMatchesOpen = !state.pastMatchesOpen;
      pc.classList.toggle('hidden', !state.pastMatchesOpen);
      document.getElementById('toggle-past-matches').textContent = state.pastMatchesOpen ? 'Скрыть прошедшие матчи' : `Прошедшие матчи (${finished.length})`;
    };
  } catch (e) { app.innerHTML = `<div class="empty-state error">Ошибка загрузки матчей: ${escapeHtml(e.message)}</div>`; }
}

function showPredictionModal(match) {
  const ch = match.user_prediction?.home ?? 0, ca = match.user_prediction?.away ?? 0;
  const o = openModal('Прогноз на матч', `<div>${escapeHtml(match.home_team)} vs ${escapeHtml(match.away_team)}</div><div class="score-inputs"><label><span>${escapeHtml(match.home_team)}</span><input type="number" id="homeGoals" min="0" max="20" value="${ch}"></label><span class="score-separator">:</span><label><span>${escapeHtml(match.away_team)}</span><input type="number" id="awayGoals" min="0" max="20" value="${ca}"></label></div><button id="save-prediction" class="primary-button full-width">Сохранить</button>`);
  o.querySelector('#save-prediction').onclick = () => submitPrediction(match.match_id);
}

async function submitPrediction(matchId) {
  const hg = document.getElementById('homeGoals').value, ag = document.getElementById('awayGoals').value;
  try {
    const d = await apiJson('/api/predictions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, userId: String(userId), matchId, predictedHome: hg, predictedAway: ag }) });
    if (d.success) { closeModal(); tg.HapticFeedback?.notificationOccurred?.('success'); showToast('Прогноз сохранён', 'success'); await loadMatches(); await refreshHeader(); }
  } catch (e) { showToast(e.message || 'Ошибка', 'error'); }
}

async function showAllPredictions(match) {
  try {
    const [preds, events] = await Promise.all([
      apiJson(`/api/match-predictions/${encodeURIComponent(match.match_id)}`),
      ['finished', 'live'].includes(match.status) ? apiJson(`/api/match-events/${encodeURIComponent(match.match_id)}`).catch(() => []) : Promise.resolve([]),
    ]);
    let ph = '<div class="responsive-table"><table><thead><tr><th>Участник</th><th>Прогноз</th><th>Очки</th></tr></thead><tbody>';
    if (!preds.length) ph += '<tr><td colspan="3">Прогнозов пока нет.</td></tr>';
    else preds.forEach(p => { ph += `<tr><td>${escapeHtml(p.displayName)}</td><td>${p.predictedHome} - ${p.predictedAway}</td><td>${p.points ?? 0}</td></tr>`; });
    ph += '</tbody></table></div>';
    let eh = '';
    if (events.length) {
      eh = '<div style="margin-top:16px"><h4 style="margin-bottom:8px">Голы</h4><ul style="list-style:none;font-size:13px">';
      events.forEach(e => { const m = e.addedTime > 0 ? `${e.minute}+${e.addedTime}` : e.minute; eh += `<li style="padding:4px 0">${escapeHtml(m)}' — ${escapeHtml(e.team)}: ${escapeHtml(e.player || '')}${e.scoreAfterEvent ? ` (${escapeHtml(e.scoreAfterEvent)})` : ''}</li>`; });
      eh += '</ul></div>';
    }
    const st = match.status === 'finished' ? ` · ${match.home_score ?? '-'}:${match.away_score ?? '-'}` : '';
    openModal(`${match.home_team} — ${match.away_team}${st}`, ph + eh);
  } catch (e) { showToast(`Ошибка: ${e.message}`, 'error'); }
}

// ===== Мои прогнозы =====
function predictionCardHtml(p) {
  const f = p.status === 'finished', t = typeLabel(p.prediction_type);
  return `<div class="prediction-item ${p.prediction_type === 'exact' ? 'prediction-exact' : ''}"><div><strong>${escapeHtml(p.home_team)}</strong> vs <strong>${escapeHtml(p.away_team)}</strong></div><div class="muted">${escapeHtml(formatDateTime(p.kickoff_utc))}</div><div>Прогноз: <strong>${p.predicted_home ?? '-'} - ${p.predicted_away ?? '-'}</strong></div>${f ? `<div>Счёт: <strong>${p.home_score ?? '-'} - ${p.away_score ?? '-'}</strong></div>` : ''}${f ? `<div class="result-line">${t ? `${escapeHtml(t)} ·` : ''}<strong>${p.points} очк.</strong>${p.fantiki_awarded ? ` · +${p.fantiki_awarded} 🪙` : ''}</div>` : '<div class="muted">Матч ещё не завершён</div>'}</div>`;
}

async function loadMyPredictions(filter = state.myPredictionFilter) {
  setActiveNav('my-predictions');
  state.myPredictionFilter = filter;
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Загрузка прогнозов…</div>';
  try {
    const params = new URLSearchParams({ userId: String(userId), sort: filter === 'exact_first' ? 'exact_first' : 'date_desc' });
    if (!['all', 'exact_first'].includes(filter)) params.set('type', filter);
    const preds = await apiJson(`/api/my-predictions?${params.toString()}`);
    app.innerHTML = `<div class="section-header"><h2>Мои прогнозы</h2><span class="badge">${preds.length}</span></div><div class="filter-bar" id="my-prediction-filters"><button data-filter="all" class="${filter === 'all' ? 'active' : ''}">Все</button><button data-filter="exact_first" class="${filter === 'exact_first' ? 'active' : ''}">ТС первыми</button><button data-filter="exact" class="${filter === 'exact' ? 'active' : ''}">Только ТС</button><button data-filter="successful" class="${filter === 'successful' ? 'active' : ''}">С очками</button><button data-filter="miss" class="${filter === 'miss' ? 'active' : ''}">Промахи</button></div><div id="my-predictions-list"></div>`;
    document.querySelectorAll('#my-prediction-filters button').forEach(b => { b.onclick = () => loadMyPredictions(b.dataset.filter); });
    const list = document.getElementById('my-predictions-list');
    if (!preds.length) { list.innerHTML = '<div class="empty-state">По фильтру прогнозов нет.</div>'; return; }
    preds.forEach(p => list.insertAdjacentHTML('beforeend', predictionCardHtml(p)));
  } catch (e) { app.innerHTML = `<div class="empty-state error">${escapeHtml(e.message)}</div>`; }
}

// ===== Таблица =====
function nextStandingsSort(sb) { const cur = state.standingsSort; if (cur.sortBy !== sb) return { sortBy: sb, order: sb === 'misses' ? 'asc' : 'desc' }; return { sortBy: sb, order: cur.order === 'asc' ? 'desc' : 'asc' }; }
function sortArrow(sb) { if (state.standingsSort.sortBy !== sb) return ''; return state.standingsSort.order === 'asc' ? ' ↑' : ' ↓'; }

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
    const [table, history] = await Promise.all([apiJson(url), apiJson('/api/standings-history').catch(() => ({ previousPositions: {}, currentPositions: {} }))]);
    const { previousPositions, currentPositions } = history;
    app.innerHTML = `<div class="section-header"><h2>Турнирная таблица</h2><span class="badge">${table.length} участников</span></div><div class="standings-hint">Нажми на имя — профиль участника. На цифру — матчи категории.</div><div class="filter-bar standings-sort-bar"><button data-sort="" class="${!sortBy ? 'active' : ''}">Комплексно</button><button data-sort="points" class="${sortBy === 'points' ? 'active' : ''}">Очки</button><button data-sort="exact" class="${sortBy === 'exact' ? 'active' : ''}">Точные</button><button data-sort="difference" class="${sortBy === 'difference' ? 'active' : ''}">Разницы</button><button data-sort="draws" class="${sortBy === 'draws' ? 'active' : ''}">Ничьи</button><button data-sort="outcomes" class="${sortBy === 'outcomes' ? 'active' : ''}">Исходы</button><button data-sort="misses" class="${sortBy === 'misses' ? 'active' : ''}">Промахи</button><button id="show-last-round" class="secondary-button" style="margin-left: auto;">🏆 Тур</button></div><div class="responsive-table"><table><thead><tr><th>#</th><th>Участник</th><th><button class="table-sort" data-sort="points">Очки${sortArrow('points')}</button></th><th><button class="table-sort" data-sort="successful">Угадано${sortArrow('successful')}</button></th><th><button class="table-sort" data-sort="exact">Точные${sortArrow('exact')}</button></th><th><button class="table-sort" data-sort="difference">Разницы${sortArrow('difference')}</button></th><th><button class="table-sort" data-sort="draws">Ничьи${sortArrow('draws')}</button></th><th><button class="table-sort" data-sort="outcomes">Исходы${sortArrow('outcomes')}</button></th><th><button class="table-sort" data-sort="misses">Промахи${sortArrow('misses')}</button></th></tr></thead><tbody id="standings-body"></tbody></table></div>`;
    document.getElementById('show-last-round').onclick = showLastRoundStandings;
    const body = document.getElementById('standings-body');
    if (!table.length) body.innerHTML = '<tr><td colspan="9">Нет участников.</td></tr>';
    else {
      table.forEach(row => {
        const prevPos = previousPositions[row.userId], currPos = currentPositions[row.userId] || row.position;
        let arrow = '';
        if (prevPos && currPos) { const diff = prevPos - currPos; if (diff > 0) arrow = `<span class="position-arrow up">▲${diff}</span>`; else if (diff < 0) arrow = `<span class="position-arrow down">▼${Math.abs(diff)}</span>`; }
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${row.position} ${arrow}</td><td><button class="link-button participant-link">${escapeHtml(row.displayName)}</button></td><td><button class="metric-button metric-points">${row.totalPoints}</button></td><td><button class="metric-button metric-successful">${row.successfulPredictions}</button></td><td><button class="metric-button metric-exact">${row.exactScores}</button></td><td><button class="metric-button metric-difference">${row.goalDifference}</button></td><td><button class="metric-button metric-draw">${row.draws}</button></td><td><button class="metric-button metric-outcome">${row.outcomes}</button></td><td><button class="metric-button metric-miss">${row.misses}</button></td>`;
        tr.querySelector('.participant-link').onclick = () => showParticipantProfile(row.userId, row.displayName);
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
  } catch (e) { app.innerHTML = `<div class="empty-state error">${escapeHtml(e.message)}</div>`; }
}

async function showParticipantPredictions(targetUserId, displayName, type) {
  const titles = { all: `Все прогнозы — ${displayName}`, successful: `Матчи с очками — ${displayName}`, exact: `Точные счета — ${displayName}`, difference: `Угаданная разница — ${displayName}`, draw: `Угаданные ничьи — ${displayName}`, outcome: `Угаданные исходы — ${displayName}`, miss: `Промахи — ${displayName}` };
  try {
    const params = new URLSearchParams({ sort: 'date_desc' });
    if (type && type !== 'all') params.set('type', type);
    const preds = await apiJson(`/api/user-predictions/${encodeURIComponent(targetUserId)}?${params.toString()}`);
    const bodyHtml = preds.length ? preds.map(predictionCardHtml).join('') : '<div class="empty-state compact">Матчей нет.</div>';
    openModal(titles[type] || titles.all, bodyHtml);
  } catch (e) { showToast(`Ошибка: ${e.message}`, 'error'); }
}

async function showPointsChart(targetUserId, displayName) {
  try {
    const history = await apiJson(`/api/user-points-history/${encodeURIComponent(targetUserId)}`);
    if (!history.length) { showToast('Нет данных', 'error'); return; }
    openModal(`Динамика — ${displayName}`, `<div class="chart-container"><canvas id="pointsChart"></canvas></div>`);
    if (!window.Chart) { await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/chart.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
    new Chart(document.getElementById('pointsChart').getContext('2d'), {
      type: 'bar',
      data: { labels: history.map(h => h.label), datasets: [{ label: 'Очки за день', data: history.map(h => h.points), backgroundColor: 'rgba(75,192,192,0.65)', borderColor: 'rgb(75,192,192)', borderWidth: 1, borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
  } catch (e) { showToast(`Ошибка: ${e.message}`, 'error'); }
}

async function showLastRoundStandings() {
  try {
    const table = await apiJson('/api/standings-last-round');
    if (!table.length) { openModal('Тур', '<div class="empty-state">Нет завершённых матчей за 3 дня.</div>'); return; }
    let h = '<div class="responsive-table"><table><thead><tr><th>#</th><th>Участник</th><th>Очки</th><th>Точные</th><th>Разница</th><th>Ничьи</th><th>Исходы</th><th>Промахи</th></tr></thead><tbody>';
    table.forEach(r => { h += `<tr><td>${r.position}</td><td>${escapeHtml(r.displayName)}</td><td class="round-points">${r.points}</td><td>${r.exact}</td><td>${r.difference}</td><td>${r.draw}</td><td>${r.outcome}</td><td>${r.miss}</td></tr>`; });
    h += '</tbody></table></div>';
    openModal('Турнирная таблица за 3 дня', h);
  } catch (e) { showToast(`Ошибка: ${e.message}`, 'error'); }
}

// ===== Дуэли =====
function duelCardHtml(duel, { mine = false } = {}) {
  const isCreator = duel.creator_id === String(userId);
  const isParticipant = duel.participants.some(p => p.userId === String(userId));
  const stLbl = { open: 'Открыта', full: 'Заполнена', settled: 'Завершена', cancelled: 'Отменена', refunded: 'Возврат' };
  const participantsList = duel.participants.map(p => {
    const res = p.result && p.result !== 'pending' ? ` (${p.result === 'winner' ? 'победа' : p.result === 'loser' ? 'проигрыш' : 'возврат'})` : '';
    return `${escapeHtml(p.displayName)}: ${p.predictedHome}:${p.predictedAway}${res}`;
  }).join(', ');
  const actions = [];
  if (duel.status === 'open' && !isParticipant) actions.push(`<button class="primary-button duel-join-btn" data-duel="${escapeHtml(duel.duel_id)}">Вступить</button>`);
  if (isCreator && duel.status === 'open' && duel.participants_count === 1) actions.push(`<button class="secondary-button duel-cancel-btn" data-duel="${escapeHtml(duel.duel_id)}">Отменить</button>`);
  let myBet = '';
  if (mine && duel.my_bet) {
    const res = duel.my_bet.result;
    const cls = res === 'winner' ? 'duel-result-winner' : res === 'loser' ? 'duel-result-loser' : res === 'refunded' ? 'duel-result-refunded' : '';
    const lbl = res === 'winner' ? 'победа' : res === 'loser' ? 'проигрыш' : res === 'refunded' ? 'возврат' : '';
    myBet = `<div class="duel-my-bet">Ваш прогноз: <strong>${duel.my_bet.predictedHome}:${duel.my_bet.predictedAway}</strong>${res !== 'pending' ? ` · <span class="${cls}">${lbl}</span>` : ''}</div>`;
  }
  const score = duel.match_status === 'finished' && duel.home_score !== null ? `<div class="duel-meta">Счёт: <strong>${duel.home_score}:${duel.away_score}</strong></div>` : '';
  return `<div class="duel-card"><div class="duel-header"><div class="duel-teams">${escapeHtml(duel.home_team)} — ${escapeHtml(duel.away_team)}</div><span class="duel-stake">${duel.stake} 🪙</span></div><div class="duel-meta">${escapeHtml(formatDateTime(duel.kickoff_utc))} · ${escapeHtml(stLbl[duel.status] || duel.status)}</div>${score}<div class="duel-participants">Участников: ${duel.participants_count} · Банк: ${duel.pot} 🪙</div><div class="duel-participants">${participantsList || 'Пока никого'}</div>${myBet}${actions.length ? `<div class="duel-actions">${actions.join('')}</div>` : ''}</div>`;
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
    const activeMine = mine.filter(d => ['open', 'full'].includes(d.status));
    const historyMine = mine.filter(d => !['open', 'full'].includes(d.status));
    app.innerHTML = `<div class="section-header"><h2>Дуэли</h2><button id="create-duel-btn" class="primary-button">+ Создать</button></div><div class="duel-tabs"><button class="duel-tab ${view === 'open' ? 'active' : ''}" data-view="open">Открытые (${open.length})</button><button class="duel-tab ${view === 'my' ? 'active' : ''}" data-view="my">Мои (${activeMine.length})</button></div><div id="duels-list"></div>`;
    document.getElementById('create-duel-btn').onclick = openCreateDuelModal;
    document.querySelectorAll('.duel-tab').forEach(b => b.onclick = () => loadDuels(b.dataset.view));
    const list = document.getElementById('duels-list');
    const items = view === 'open' ? open : activeMine;
    if (!items.length) list.innerHTML = view === 'open' ? '<div class="empty-state">Нет открытых дуэлей.</div>' : '<div class="empty-state">У вас нет активных дуэлей.</div>';
    else {
      items.forEach(d => list.insertAdjacentHTML('beforeend', duelCardHtml(d, { mine: view === 'my' })));
      list.querySelectorAll('.duel-join-btn').forEach(b => b.onclick = () => openJoinDuelModal(items.find(x => x.duel_id === b.dataset.duel)));
      list.querySelectorAll('.duel-cancel-btn').forEach(b => b.onclick = () => cancelDuel(b.dataset.duel));
    }
    if (view === 'my' && historyMine.length) {
      list.insertAdjacentHTML('beforeend', '<div style="margin:20px 0 8px;font-size:16px;font-weight:600">История</div>');
      historyMine.forEach(d => list.insertAdjacentHTML('beforeend', duelCardHtml(d, { mine: true })));
    }
  } catch (e) { app.innerHTML = `<div class="empty-state error">${escapeHtml(e.message)}</div>`; }
}

async function openCreateDuelModal() {
  let matches;
  try { matches = await apiJson('/api/matches?status=scheduled'); }
  catch (e) { showToast(`Ошибка: ${e.message}`, 'error'); return; }
  if (!matches.length) { showToast('Нет матчей для дуэли', 'error'); return; }
  const options = matches.map(m => `<option value="${escapeHtml(m.match_id)}">${escapeHtml(m.home_team)} — ${escapeHtml(m.away_team)} · ${escapeHtml(formatDateTime(m.kickoff_utc))}</option>`).join('');
  const o = openModal('Создать дуэль', `<label class="form-label">Матч</label><select id="duel-match" class="form-input">${options}</select><label class="form-label">Ваш прогноз</label><div class="score-inputs"><input type="number" id="duel-ph" min="0" max="20" value="1" class="form-input"><span class="score-separator">:</span><input type="number" id="duel-pa" min="0" max="20" value="0" class="form-input"></div><label class="form-label">Ставка (10–500, кратна 5)</label><input type="number" id="duel-stake" min="10" max="500" step="5" value="20" class="form-input"><button id="duel-submit" class="primary-button full-width">Создать дуэль</button>`);
  o.querySelector('#duel-submit').onclick = () => submitCreateDuel(o);
}

async function submitCreateDuel(o) {
  const matchId = o.querySelector('#duel-match').value;
  const ph = Number(o.querySelector('#duel-ph').value);
  const pa = Number(o.querySelector('#duel-pa').value);
  const stake = Number(o.querySelector('#duel-stake').value);
  if (!Number.isFinite(ph) || !Number.isFinite(pa) || ph < 0 || pa < 0 || ph > 20 || pa > 20) { showToast('Некорректный счёт', 'error'); return; }
  if (stake < 10 || stake > 500 || stake % 5 !== 0) { showToast('Ставка 10–500, кратна 5', 'error'); return; }
  const b = o.querySelector('#duel-submit'); b.disabled = true; b.textContent = 'Создание...';
  try {
    const r = await apiJson('/api/duels/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, userId: String(userId), matchId, predictedHome: ph, predictedAway: pa, stake }) });
    if (r.success) { closeModal(); tg.HapticFeedback?.notificationOccurred?.('success'); showToast(`Дуэль создана. Ставка ${stake} 🪙`, 'success'); await refreshHeader(); await loadDuels(); }
    else { showToast(r.error || 'Ошибка', 'error'); b.disabled = false; b.textContent = 'Создать дуэль'; }
  } catch (e) { showToast(e.message, 'error'); b.disabled = false; b.textContent = 'Создать дуэль'; }
}

function openJoinDuelModal(duel) {
  if (!duel) return;
  const occupied = duel.participants.map(p => `${p.predictedHome}:${p.predictedAway}`).join(', ');
  const o = openModal('Вступить', `<div>${escapeHtml(duel.home_team)} — ${escapeHtml(duel.away_team)}</div><div class="muted" style="margin:10px 0">Ставка: <strong>${duel.stake} 🪙</strong> · Банк: ${duel.pot} 🪙</div><div class="muted" style="margin-bottom:10px">Занятые: ${occupied}</div><label class="form-label">Ваш прогноз (≠ чужим)</label><div class="score-inputs"><input type="number" id="duel-ph" min="0" max="20" value="1" class="form-input"><span class="score-separator">:</span><input type="number" id="duel-pa" min="0" max="20" value="0" class="form-input"></div><button id="duel-submit" class="primary-button full-width">Вступить за ${duel.stake} 🪙</button>`);
  o.querySelector('#duel-submit').onclick = () => submitJoinDuel(duel, o);
}

async function submitJoinDuel(duel, o) {
  const ph = Number(o.querySelector('#duel-ph').value);
  const pa = Number(o.querySelector('#duel-pa').value);
  if (!Number.isFinite(ph) || !Number.isFinite(pa) || ph < 0 || pa < 0 || ph > 20 || pa > 20) { showToast('Некорректный счёт', 'error'); return; }
  if (duel.participants.some(p => p.predictedHome === ph && p.predictedAway === pa)) { showToast('Такой счёт уже занят', 'error'); return; }
  const b = o.querySelector('#duel-submit'); b.disabled = true; b.textContent = 'Вступление...';
  try {
    const r = await apiJson(`/api/duels/join/${encodeURIComponent(duel.duel_id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, userId: String(userId), predictedHome: ph, predictedAway: pa }) });
    if (r.success) { closeModal(); tg.HapticFeedback?.notificationOccurred?.('success'); showToast(`Вступили. Ставка ${duel.stake} 🪙`, 'success'); await refreshHeader(); await loadDuels(); }
    else { showToast(r.error || 'Ошибка', 'error'); b.disabled = false; b.textContent = 'Вступить'; }
  } catch (e) { showToast(e.message, 'error'); b.disabled = false; b.textContent = 'Вступить'; }
}

async function cancelDuel(duelId) {
  if (!confirm('Отменить дуэль? Ставка вернётся.')) return;
  try {
    const r = await apiJson(`/api/duels/cancel/${encodeURIComponent(duelId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData, userId: String(userId) }) });
    if (r.success) { showToast('Дуэль отменена', 'success'); await refreshHeader(); await loadDuels(); }
    else showToast(r.error || 'Ошибка', 'error');
  } catch (e) { showToast(e.message, 'error'); }
}

// ===== Навигация =====
document.getElementById('header-clickable').addEventListener('click', openBalanceModal);
document.getElementById('nav-matches').addEventListener('click', () => loadMatches());
document.getElementById('nav-my-predictions').addEventListener('click', () => loadMyPredictions('all'));
document.getElementById('nav-standings').addEventListener('click', () => { state.standingsSort = { sortBy: '', order: '' }; loadStandings('', ''); });
document.getElementById('nav-duels').addEventListener('click', () => loadDuels('open'));

auth();