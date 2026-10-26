const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
const userId = tg.initDataUnsafe?.user?.id;
const initData = tg.initData;
const state = {
  standingsSort: { sortBy: '', order: '' },
  standingsView: 'overall',
  myPredictionFilter: 'all',
  pastMatchesOpen: false,
  duelsView: 'open',
  balance: null,
  today: null,
};

const COIN_SVG = `<svg class="coin-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:16px;height:16px;display:inline-block;vertical-align:middle;"><circle cx="12" cy="12" r="10" fill="#1e293b" stroke="#f97316" stroke-width="2"/><path d="M12 2a10 10 0 0 0-7.07 17.07" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><path d="M12 22a10 10 0 0 0 7.07-17.07" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><text x="12" y="15.5" font-size="7" font-weight="bold" text-anchor="middle" fill="#f97316" font-family="sans-serif">КБП</text></svg>`;

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
  referral_bonus: '🎁 Бонус за друга',
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
        <div class="today-total">${COIN_SVG} ${fmt(today.total)} <span class="muted" style="font-size:13px;font-weight:400">за ${today.date}</span></div>
        ${items.length ? `<ul class="today-breakdown">${items.map(([r, v]) => `<li><span>${REASON_LABELS[r] || escapeHtml(r)}</span><span class="${cls(v)}">${fmt(v)}</span></li>`).join('')}</ul>` : '<div class="muted" style="padding:4px 0">Начислений ещё нет</div>'}
      </div>`;
  } else {
    todayHtml = '<div class="muted" style="padding:8px 0">Нет активного игрового дня</div>';
  }

  const levelsHtml = (levels || []).map(l => {
    const isCur = bal?.level === l.level;
    return `<div class="level-row ${isCur ? 'level-current' : ''}"><span class="level-num">${l.level}</span><span class="level-name">${escapeHtml(l.name)}</span><span class="level-req">${l.min}+ ${COIN_SVG}</span><span class="level-bonus">${l.bonus > 0 ? `+${l.bonus}%` : '—'}</span></div>`;
  }).join('');

  const txHtml = tx.length
    ? `<ul class="tx-list">${tx.map(t => `<li><span>${REASON_LABELS[t.reason] || escapeHtml(t.reason)}</span><span class="tx-amount ${cls(t.amount)}">${fmt(t.amount)}</span><span class="tx-sub">${escapeHtml(formatDateTime(t.createdAt))} · баланс ${t.balanceAfter}</span></li>`).join('')}</ul>`
    : '<div class="muted">Транзакций пока нет</div>';

  openModal('Баланс фантиков', `
    <div class="balance-total">Всего: <strong>${bal?.balance ?? '—'} ${COIN_SVG}</strong></div>
    <div class="muted" style="margin-bottom:8px">${escapeHtml(bal?.levelName || 'Без уровня')} · за сезон: ${bal?.totalEarnedSeason ?? 0} ${COIN_SVG}</div>

    <h4 class="modal-section-title">Сегодня (обнуляется при старте следующего игрового дня)</h4>
    ${todayHtml}

    <h4 class="modal-section-title">Уровни</h4>
    <div class="levels-list">${levelsHtml || '<div class="muted">Не удалось загрузить</div>'}</div>

    <h4 class="modal-section-title">Последние начисления</h4>
    ${txHtml}
  `);
}

function openRulesModal() {
  const html = `
    <div class="rules-text">
      <p><strong>${COIN_SVG} Фантики</strong> — внутренняя валюта. Их дают за активность, а тратить можно в дуэлях. В конце сезона баланс обнуляется, но уровень и бейджи остаются.</p>
      
      <h4>За прогнозы (после матча)</h4>
      <ul>
        <li>Исход угадан: <strong>+10</strong></li>
        <li>Разница угадана: <strong>+20</strong></li>
        <li>Точный счёт: <strong>+50</strong></li>
        <li>ТС в матче 6–7 голов: <strong>+75</strong> (бонус редкости)</li>
        <li>ТС в матче 8+ голов: <strong>+100</strong> (бонус редкости)</li>
      </ul>

      <h4>За серию точных счетов за день</h4>
      <ul>
        <li>2 ТС: <strong>+25</strong></li>
        <li>3 ТС: <strong>+75</strong></li>
        <li>4 ТС: <strong>+150</strong></li>
        <li>5+ ТС: <strong>+300</strong></li>
      </ul>

      <h4>За вход в день матча</h4>
      <p>Заходишь в Mini App в день с матчами → <strong>+10</strong>. Один раз в день.</p>

      <h4>Квесты на тур</h4>
      <ul>
        <li>5 прогнозов в туре: <strong>+30</strong></li>
        <li>Все прогнозы тура: <strong>+50</strong></li>
        <li>Хотя бы 1 ТС за тур: <strong>+20</strong></li>
        <li>3+ исхода за тур: <strong>+15</strong></li>
      </ul>

      <h4>Призовые места в туре</h4>
      <p>Топ-3 по очкам за день: 1-е — <strong>+100</strong>, 2-е — <strong>+60</strong>, 3-е — <strong>+30</strong>. При равенстве — все получают приз своего места.</p>

      <h4>Реферальная программа</h4>
      <p>Пригласи друга по ссылке из профиля. Когда он сделает <strong>20 прогнозов</strong>, ты получишь <strong>+150</strong>.</p>

      <h4>Уровни (награда за сезон)</h4>
      <ul>
        <li>Новичок (100+)</li>
        <li>Прогнозист (500+) — <strong>+5%</strong> к наградам</li>
        <li>Аналитик (1000+) — <strong>+10%</strong></li>
        <li>Снайпер (2000+) — <strong>+15%</strong></li>
        <li>Профи (5000+) — <strong>+25%</strong></li>
      </ul>
      <p>Бонус уровня применяется только к наградам за прогнозы.</p>

      <h4>Дуэли</h4>
      <p>Создаёшь дуэль: счёт + ставка (10–500, кратно 5). Другой игрок вступает, ставит такой же счёт (не совпадающий) и такую же ставку. 1 угадал — забирает банк. 2+ угадали — делят. 0 — возврат всем.</p>
    </div>
  `;
  openModal('Правила', html);
}

async function showParticipantProfile(targetUserId, displayName) {
  const [bal, badgesData, divInfo] = await Promise.all([
    apiJson(`/api/fantiki/balance/${encodeURIComponent(targetUserId)}`).catch(() => null),
    apiJson(`/api/season-titles/${encodeURIComponent(targetUserId)}`).catch(() => ({ badges: [] })),
    apiJson(`/api/standings/user-division/${encodeURIComponent(targetUserId)}`).catch(() => null),
  ]);
  const badges = (badgesData?.badges || []);
  const lvlBonus = bal?.levelBonus ? `+${Math.round(bal.levelBonus * 100)}%` : '—';

  const badgesHtml = badges.length
    ? `<div class="profile-badges">${badges.map(b => `<span class="profile-badge">${escapeHtml(b.name)}</span>`).join('')}</div>`
    : '<div class="muted">Бейджей пока нет</div>';

  const divBadge = divInfo ? `<div style="display:inline-block;padding:4px 12px;background:rgba(59,130,246,0.15);border-radius:20px;font-size:12px;color:var(--primary);font-weight:600;margin-bottom:12px">${escapeHtml(divInfo.name)} · #${divInfo.position} из ${divInfo.size}</div>` : '';

  const overlay = openModal(displayName, `
    ${divBadge}
    <div class="profile-section">
      <div class="profile-balance">${bal?.balance ?? '—'} ${COIN_SVG}</div>
      <div class="muted">Баланс · за сезон заработано ${bal?.totalEarnedSeason ?? 0} ${COIN_SVG}</div>
    </div>
    <div class="profile-level-click" id="profile-level-click">
      <div style="font-weight:600;margin-bottom:4px">${escapeHtml(bal?.levelName || 'Без уровня')} <span class="muted" style="font-weight:400">· ур. ${bal?.level ?? 0}</span></div>
      <div class="muted">Бонус к наградам: ${lvlBonus}</div>
      ${bal?.nextLevelAt ? `<div class="muted">До следующего уровня: ${bal.totalEarnedSeason} / ${bal.nextLevelAt} ${COIN_SVG}</div>` : '<div class="muted">Максимальный уровень</div>'}
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
    return `<div class="level-row ${isCur ? 'level-current' : ''}"><span class="level-num">${l.level}</span><span class="level-name">${escapeHtml(l.name)}</span><span class="level-req">${l.min}+ ${COIN_SVG}</span><span class="level-bonus">${l.bonus > 0 ? `+${l.bonus}%` : '—'}</span></div>`;
  }).join('');
  openModal('Уровни', `<div class="muted" style="margin-bottom:12px">Уровень повышается по мере накопления фантиков за сезон. Бонус прибавляется к наградам за прогнозы.</div><div class="levels-list">${html}</div>`);
}

async function showReferralModal() {
  try {
    const info = await apiJson(`/api/referral/info/${encodeURIComponent(userId)}`);
    const html = `
      <div class="muted" style="margin-bottom:12px;line-height:1.5">
        Пригласи друга. Когда он сделает <strong>20 прогнозов</strong>, ты получишь <strong>+150 ${COIN_SVG}</strong>.
      </div>
      <div class="muted" style="margin-bottom:8px">Твоя ссылка:</div>
      <div class="ref-link-box">
        <input type="text" class="ref-link-input" id="ref-link-input" readonly value="${escapeHtml(info.link)}">
        <button class="primary-button" id="ref-copy-btn">Копировать</button>
      </div>
      <img src="${info.qrUrl}" class="ref-qr" alt="QR-код для приглашения">
      <div class="muted" style="text-align:center;margin-bottom:12px">Наведи камеру или поделись ссылкой</div>
      <div style="display:flex;justify-content:space-between;background:rgba(255,255,255,0.04);padding:12px;border-radius:10px">
        <div><strong>${info.completed}</strong> <span class="muted">завершили</span></div>
        <div><strong>${info.total}</strong> <span class="muted">всего</span></div>
      </div>
      <button class="secondary-button full-width" style="margin-top:16px" id="ref-share-btn">Поделиться в Telegram</button>
    `;
    const overlay = openModal('Пригласить друга', html);
    
    overlay.querySelector('#ref-copy-btn').onclick = () => {
      navigator.clipboard.writeText(info.link).then(() => showToast('Ссылка скопирована', 'success'));
    };
    overlay.querySelector('#ref-share-btn').onclick = () => {
      const text = encodeURIComponent('Присоединяйся к прогнозам на ЛЧ! ');
      const url = `https://t.me/share/url?url=${encodeURIComponent(info.link)}&text=${text}`;
      tg.openTelegramLink(url);
    };
  } catch (e) { showToast('Ошибка загрузки рефералки: ' + e.message, 'error'); }
}

async function tryDailyLogin() {
  if (!userId) return;
  try {
    const r = await apiJson('/api/daily-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, userId: String(userId) }),
    });
    if (r.success) { showToast(`+${r.amount} за вход`, 'success'); await refreshHeader(); }
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

function setActiveNav(name) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`nav-${name}`);
  if (btn) btn.classList.add('active');
}

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

function predictionCardHtml(p) {
  const f = p.status === 'finished', t = typeLabel(p.prediction_type);
  return `<div class="prediction-item ${p.prediction_type === 'exact' ? 'prediction-exact' : ''}"><div><strong>${escapeHtml(p.home_team)}</strong> vs <strong>${escapeHtml(p.away_team)}</strong></div><div class="muted">${escapeHtml(formatDateTime(p.kickoff_utc))}</div><div>Прогноз: <strong>${p.predicted_home ?? '-'} - ${p.predicted_away ?? '-'}</strong></div>${f ? `<div>Счёт: <strong>${p.home_score ?? '-'} - ${p.away_score ?? '-'}</strong></div>` : ''}${f ? `<div class="result-line">${t ? `${escapeHtml(t)} ·` : ''}<strong>${p.points} очк.</strong>${p.fantiki_awarded ? ` · +${p.fantiki_awarded} ${COIN_SVG}` : ''}</div>` : '<div class="muted">Матч ещё не завершён</div>'}</div>`;
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

function nextStandingsSort(sb) { const cur = state.standingsSort; if (cur.sortBy !== sb) return { sortBy: sb, order: sb === 'misses' ? 'asc' : 'desc' }; return { sortBy: sb, order: cur.order === 'asc' ? 'desc' : 'asc' }; }
function sortArrow(sb) { if (state.standingsSort.sortBy !== sb) return ''; return state.standingsSort.order === 'asc' ? ' ↑' : ' ↓'; }

async function renderDivisionsView(app) {
  const data = await apiJson('/api/standings/divisions');
  const { divisions, divisionSize, totalUsers, splittingNotYetActive, minUsersForDivisions, neededForSplitting } = data;

  let baseHtml = `<div class="section-header"><h2>Турнирная таблица</h2><span class="badge">${totalUsers} в игре</span></div>`;
  baseHtml += `<div class="filter-bar" style="margin-bottom: 16px;">
    <button data-view="overall">Все</button>
    <button data-view="divisions" class="active">По дивизионам</button>
  </div>`;

  if (!divisions.length) {
    app.innerHTML = baseHtml + `<div class="empty-state">Пока никто не набрал очки. Дивизионы появятся, как только у участников будут результаты!</div>`;
    app.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => loadStandings('', '', b.dataset.view); });
    return;
  }

  let myDiv = null, me = null;
  for (const div of divisions) {
    const found = div.users.find(x => x.userId === String(userId));
    if (found) { myDiv = div; me = found; break; }
  }

  let html = baseHtml;

  if (splittingNotYetActive) {
    html += `<div class="standings-hint">Пока все в одной лиге (с очками: ${totalUsers}). Дивизионы появятся, когда наберётся ${minUsersForDivisions} активных участников (осталось ещё ${neededForSplitting}).</div>`;
  } else {
    html += `<div class="standings-hint">Участники разделены на ${divisions.length} ${divisions.length === 1 ? 'дивизион' : divisions.length < 5 ? 'дивизиона' : 'дивизионов'}. Чем выше очки — тем выше дивизион.</div>`;
  }

  if (myDiv && me) {
    html += `<div style="background:rgba(59,130,246,0.15);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:13px">
      Вы в <strong>${escapeHtml(myDiv.name)}</strong> · #${me.position} из ${myDiv.size}
    </div>`;
  }

  divisions.forEach(div => {
    html += `<div class="division-header">${escapeHtml(div.name)} <span class="division-badge">${div.size}</span></div>`;
    html += `<div class="responsive-table"><table><thead><tr>
      <th>#</th><th>Участник</th><th>Очки</th><th>Точные</th><th>Разница</th><th>Исходы</th><th>Промахи</th>
    </tr></thead><tbody>`;
    div.users.forEach(u => {
      const isMe = u.userId === String(userId);
      const cls = isMe ? 'division-me' : '';
      const nameHtml = isMe ? `${escapeHtml(u.displayName)}<span class="division-mine-badge">вы</span>` : escapeHtml(u.displayName);
      html += `<tr class="${cls}">
        <td>${u.position}</td>
        <td><button class="link-button participant-link" data-uid="${escapeHtml(u.userId)}" data-name="${escapeHtml(u.displayName)}">${nameHtml}</button></td>
        <td><button class="metric-button metric-points" data-uid="${escapeHtml(u.userId)}" data-name="${escapeHtml(u.displayName)}">${u.totalPoints}</button></td>
        <td><button class="metric-button metric-exact" data-uid="${escapeHtml(u.userId)}" data-name="${escapeHtml(u.displayName)}">${u.exactScores}</button></td>
        <td>${u.goalDifference}</td>
        <td>${u.outcomes}</td>
        <td>${u.misses}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
  });

  app.innerHTML = html;

  app.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => loadStandings('', '', b.dataset.view); });
  app.querySelectorAll('.participant-link').forEach(b => { b.onclick = () => showParticipantProfile(b.dataset.uid, b.dataset.name); });
  app.querySelectorAll('.metric-points').forEach(b => { b.onclick = () => showParticipantPredictions(b.dataset.uid, b.dataset.name, 'successful'); });
  app.querySelectorAll('.metric-exact').forEach(b => { b.onclick = () => showParticipantPredictions(b.dataset.uid, b.dataset.name, 'exact'); });
}

async function loadStandings(sortBy = state.standingsSort.sortBy, order = state.standingsSort.order, view) {
  setActiveNav('standings');
  if (view) state.standingsView = view;
  state.standingsSort = { sortBy, order };
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Расчёт таблицы…</div>';
  try {
    if (state.standingsView === 'divisions') {
      await renderDivisionsView(app);
      return;
    }

    const params = new URLSearchParams();
    if (sortBy) params.set('sortBy', sortBy);
    if (order) params.set('order', order);
    const url = params.toString() ? `/api/standings?${params.toString()}` : '/api/standings';
    const [table, history] = await Promise.all([apiJson(url), apiJson('/api/standings-history').catch(() => ({ previousPositions: {}, currentPositions: {} }))]);
    const { previousPositions, currentPositions } = history;
    app.innerHTML = `<div class="section-header"><h2>Турнирная таблица</h2><span class="badge">${table.length} участников</span></div><div class="standings-hint">Нажми на имя — профиль участника. На цифру — матчи категории.</div><div class="filter-bar" style="margin-bottom: 8px;"><button data-view="overall" class="active">Все</button><button data-view="divisions">По дивизионам</button></div><div class="filter-bar standings-sort-bar"><button data-sort="" class="${!sortBy ? 'active' : ''}">Комплексно</button><button data-sort="points" class="${sortBy === 'points' ? 'active' : ''}">Очки</button><button data-sort="exact" class="${sortBy === 'exact' ? 'active' : ''}">Точные</button><button data-sort="difference" class="${sortBy === 'difference' ? 'active' : ''}">Разницы</button><button data-sort="draws" class="${sortBy === 'draws' ? 'active' : ''}">Ничьи</button><button data-sort="outcomes" class="${sortBy === 'outcomes' ? 'active' : ''}">Исходы</button><button data-sort="misses" class="${sortBy === 'misses' ? 'active' : ''}">Промахи</button><button id="show-last-round" class="secondary-button" style="margin-left: auto;">🏆 Тур</button></div><div class="responsive-table"><table><thead><tr><th>#</th><th>Участник</th><th><button class="table-sort" data-sort="points">Очки${sortArrow('points')}</button></th><th><button class="table-sort" data-sort="successful">Угадано${sortArrow('successful')}</button></th><th><button class="table-sort" data-sort="exact">Точные${sortArrow('exact')}</button></th><th><button class="table-sort" data-sort="difference">Разницы${sortArrow('difference')}</button></th><th><button class="table-sort" data-sort="draws">Ничьи${sortArrow('draws')}</button></th><th><button class="table-sort" data-sort="outcomes">Исходы${sortArrow('outcomes')}</button></th><th><button class="table-sort" data-sort="misses">Промахи${sortArrow('misses')}</button></th></tr></thead><tbody id="standings-body"></tbody></table></div>`;
    document.querySelectorAll('.filter-bar [data-view]').forEach(b => { b.onclick = () => loadStandings('', '', b.dataset.view); });
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
  return `<div class="duel-card"><div class="duel-header"><div class="duel-teams">${escapeHtml(duel.home_team)} — ${escapeHtml(duel.away_team)}</div><span class="duel-stake">${duel.stake} ${COIN_SVG}</span></div><div class="duel-meta">${escapeHtml(formatDateTime(duel.kickoff_utc))} · ${escapeHtml(stLbl[duel.status] || duel.status)}</div>${score}<div class="duel-participants">Участников: ${duel.participants_count} · Банк: ${duel.pot} ${COIN_SVG}</div><div class="duel-participants">${participantsList || 'Пока никого'}</div>${myBet}${actions.length ? `<div class="duel-actions">${actions.join('')}</div>` : ''}</div>`;
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
    if (r.success) { closeModal(); tg.HapticFeedback?.notificationOccurred?.('success'); showToast(`Дуэль создана. Ставка ${stake}`, 'success'); await refreshHeader(); await loadDuels(); }
    else { showToast(r.error || 'Ошибка', 'error'); b.disabled = false; b.textContent = 'Создать дуэль'; }
  } catch (e) { showToast(e.message, 'error'); b.disabled = false; b.textContent = 'Создать дуэль'; }
}

function openJoinDuelModal(duel) {
  if (!duel) return;
  const occupied = duel.participants.map(p => `${p.predictedHome}:${p.predictedAway}`).join(', ');
  const o = openModal('Вступить', `<div>${escapeHtml(duel.home_team)} — ${escapeHtml(duel.away_team)}</div><div class="muted" style="margin:10px 0">Ставка: <strong>${duel.stake} ${COIN_SVG}</strong> · Банк: ${duel.pot} ${COIN_SVG}</div><div class="muted" style="margin-bottom:10px">Занятые: ${occupied}</div><label class="form-label">Ваш прогноз (≠ чужим)</label><div class="score-inputs"><input type="number" id="duel-ph" min="0" max="20" value="1" class="form-input"><span class="score-separator">:</span><input type="number" id="duel-pa" min="0" max="20" value="0" class="form-input"></div><button id="duel-submit" class="primary-button full-width">Вступить за ${duel.stake} ${COIN_SVG}</button>`);
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
    if (r.success) { closeModal(); tg.HapticFeedback?.notificationOccurred?.('success'); showToast(`Вступили. Ставка ${duel.stake}`, 'success'); await refreshHeader(); await loadDuels(); }
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

document.getElementById('header-clickable').addEventListener('click', openBalanceModal);
document.getElementById('rules-btn').addEventListener('click', openRulesModal);
document.getElementById('nav-matches').addEventListener('click', () => loadMatches());
document.getElementById('nav-my-predictions').addEventListener('click', () => loadMyPredictions('all'));
document.getElementById('nav-standings').addEventListener('click', () => { state.standingsSort = { sortBy: '', order: '' }; loadStandings('', ''); });
document.getElementById('nav-duels').addEventListener('click', () => loadDuels('open'));

auth();