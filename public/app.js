const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const userId = tg.initDataUnsafe?.user?.id;
const initData = tg.initData;

async function auth() {
  if (!userId) {
    document.getElementById('app').innerHTML = '<p>Откройте приложение через Telegram.</p>';
    return;
  }
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData })
    });
    const data = await res.json();
    if (data.userId) {
      loadMatches();
    } else {
      alert('Ошибка авторизации');
    }
  } catch (e) {
    console.error(e);
    document.getElementById('app').innerHTML = '<p>Ошибка соединения с сервером.</p>';
  }
}

async function loadMatches() {
  try {
    const res = await fetch(`/api/matches?userId=${userId}`);
    const matches = await res.json();
    const app = document.getElementById('app');
    app.innerHTML = '<h2>Матчи</h2>';
    if (matches.length === 0) {
      app.innerHTML += '<p>Нет матчей.</p>';
      return;
    }
    matches.forEach(match => {
      const card = document.createElement('div');
      card.className = 'match-card';
      const kickoff = new Date(match.kickoff_utc).toLocaleString();
      let statusText = match.status === 'scheduled' ? 'Предстоит' : match.status;
      let predIcon = '';
      if (match.user_has_predicted) {
        predIcon = ' ✅';
      }
      card.innerHTML = `
        <strong>${match.home_team} vs ${match.away_team}${predIcon}</strong><br>
        Дата: ${kickoff}<br>
        Статус: ${statusText}
        ${match.status === 'finished' ? `<br>Счёт: ${match.home_score} - ${match.away_score}` : ''}
        ${match.user_prediction ? `<br>Ваш прогноз: ${match.user_prediction.home} - ${match.user_prediction.away}` : ''}
      `;
      if (match.status === 'scheduled') {
        const btn = document.createElement('button');
        btn.className = 'btn-predict';
        btn.textContent = match.user_has_predicted ? 'Изменить прогноз' : 'Сделать прогноз';
        btn.onclick = () => showPredictionModal(match);
        card.appendChild(btn);
      }
      const allBtn = document.createElement('button');
      allBtn.className = 'btn-all-predictions';
      allBtn.textContent = 'Прогнозы';
      allBtn.onclick = () => showAllPredictions(match);
      card.appendChild(allBtn);

      app.appendChild(card);
    });
  } catch (e) {
    console.error(e);
    document.getElementById('app').innerHTML = '<p>Ошибка загрузки матчей.</p>';
  }
}

function showPredictionModal(match) {
  const existing = document.querySelector('.modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:1000;';
  overlay.innerHTML = `
    <div style="background:white; padding:20px; border-radius:12px; width:90%; max-width:350px;">
      <h3>Прогноз на матч</h3>
      <p>${match.home_team} vs ${match.away_team}</p>
      <div style="display:flex; justify-content:space-around; align-items:center;">
        <label>Голы ${match.home_team}: <input type="number" id="homeGoals" min="0" max="20" value="0"></label>
        <label>Голы ${match.away_team}: <input type="number" id="awayGoals" min="0" max="20" value="0"></label>
      </div>
      <button id="save-prediction" style="margin-top:15px; width:100%; padding:10px; background:#34c759; color:white; border:none; border-radius:8px;">Сохранить</button>
      <button id="cancel-prediction" style="margin-top:5px; width:100%; padding:10px; background:#999; color:white; border:none; border-radius:8px;">Отмена</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('save-prediction').onclick = () => submitPrediction(match.match_id, overlay);
  document.getElementById('cancel-prediction').onclick = () => overlay.remove();
}

async function submitPrediction(matchId, overlay) {
  const homeGoals = document.getElementById('homeGoals').value;
  const awayGoals = document.getElementById('awayGoals').value;
  try {
    const res = await fetch('/api/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initData,
        matchId,
        predictedHome: homeGoals,
        predictedAway: awayGoals
      })
    });
    const data = await res.json();
    if (data.success) {
      alert('Прогноз сохранён');
      overlay.remove();
      loadMatches();
    } else {
      alert(data.error || 'Ошибка');
    }
  } catch (e) {
    console.error(e);
    alert('Ошибка сети');
  }
}

async function showAllPredictions(match) {
  try {
    const res = await fetch(`/api/match-predictions/${match.match_id}`);
    const preds = await res.json();

    let events = [];
    if (match.status === 'finished' || match.status === 'live') {
      const evRes = await fetch(`/api/match-events/${match.match_id}`);
      if (evRes.ok) events = await evRes.json();
    }

    const existing = document.querySelector('.modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:1000;';

    const matchTitle = `${match.home_team} vs ${match.away_team}`;
    const scoreLine = (match.home_score !== undefined && match.away_score !== undefined) ? ` ${match.home_score} - ${match.away_score}` : '';

    let tableHtml = '<table><tr><th>Участник</th><th>Прогноз</th><th>Очки</th></tr>';
    preds.forEach(p => {
      tableHtml += `<tr><td>${p.displayName}</td><td>${p.predictedHome} - ${p.predictedAway}</td><td>${p.points}</td></tr>`;
    });
    tableHtml += '</table>';

    let eventsHtml = '';
    if (events.length > 0) {
      eventsHtml = '<div style="margin-top:15px;"><h4>Голы</h4><ul>';
      events.forEach(ev => {
        const minuteLabel = ev.addedTime > 0 ? `${ev.minute}+${ev.addedTime}` : ev.minute;
        eventsHtml += `<li>${minuteLabel}' — ${ev.team}: ${ev.player} (${ev.scoreAfterEvent})</li>`;
      });
      eventsHtml += '</ul></div>';
    }

    overlay.innerHTML = `
      <div style="background:white; padding:20px; border-radius:12px; width:90%; max-width:400px;">
        <h3>${matchTitle}${scoreLine}</h3>
        ${tableHtml}
        ${eventsHtml}
        <button id="close-all" style="margin-top:10px; width:100%; padding:10px; background:#999; color:white; border:none; border-radius:8px;">Закрыть</button>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('close-all').onclick = () => overlay.remove();
  } catch (e) {
    console.error(e);
    alert('Ошибка загрузки прогнозов');
  }
}

async function loadMyPredictions() {
  try {
    const res = await fetch(`/api/my-predictions?userId=${userId}`);
    const predictions = await res.json();
    const app = document.getElementById('app');
    app.innerHTML = '<h2>Мои прогнозы</h2>';

    if (predictions.length === 0) {
      app.innerHTML += '<p>У вас пока нет прогнозов.</p>';
      return;
    }

    const grouped = {};
    predictions.forEach(p => {
      const stage = p.stage || 'Другое';
      if (!grouped[stage]) grouped[stage] = [];
      grouped[stage].push(p);
    });

    for (const stage in grouped) {
      const stageDiv = document.createElement('div');
      stageDiv.className = 'stage-group';
      stageDiv.innerHTML = `<h3>${stage}</h3>`;
      const list = document.createElement('div');
      list.className = 'prediction-list';

      grouped[stage].forEach(p => {
        const item = document.createElement('div');
        item.className = 'prediction-item';
        const kickoff = new Date(p.kickoff_utc).toLocaleString();
        const statusText = p.status === 'finished' ? `Счёт: ${p.home_score} - ${p.away_score}` : p.status;

        let pointText = '';
        if (p.points) {
          if (p.prediction_type === 'exact') {
            pointText = `<br>У тебя ТС 👍<br>Очки: ${p.points}`;
          } else {
            pointText = `<br>Очки: ${p.points}`;
          }
        }

        item.innerHTML = `
          <strong>${p.home_team} vs ${p.away_team}</strong><br>
          Дата: ${kickoff}<br>
          Статус: ${statusText}<br>
          Ваш прогноз: ${p.predicted_home} - ${p.predicted_away}
          ${pointText}
        `;
        list.appendChild(item);
      });

      stageDiv.appendChild(list);
      app.appendChild(stageDiv);
    }
  } catch (e) {
    console.error(e);
    document.getElementById('app').innerHTML = '<p>Ошибка загрузки прогнозов.</p>';
  }
}

async function loadStandings() {
  try {
    const res = await fetch('/api/standings');
    const table = await res.json();
    const app = document.getElementById('app');
    app.innerHTML = '<h2>Турнирная таблица</h2>';
    if (table.length === 0) {
      app.innerHTML += '<p>Нет участников.</p>';
      return;
    }
    let html = '<table><tr><th>#</th><th>Имя</th><th>Очки</th><th>Точные</th><th>Разницы</th><th>Ничьи</th><th>Исходы</th><th>Промахи</th></tr>';
    table.forEach(row => {
      html += `<tr><td>${row.position}</td><td>${row.displayName}</td><td>${row.totalPoints}</td><td>${row.exactScores}</td><td>${row.goalDifference}</td><td>${row.draws}</td><td>${row.outcomes}</td><td>${row.misses}</td></tr>`;
    });
    html += '</table>';
    app.innerHTML = html;
  } catch (e) {
    console.error(e);
    document.getElementById('app').innerHTML = '<p>Ошибка загрузки таблицы.</p>';
  }
}

document.getElementById('nav-matches').addEventListener('click', () => { loadMatches(); });
document.getElementById('nav-my-predictions').addEventListener('click', () => { loadMyPredictions(); });
document.getElementById('nav-standings').addEventListener('click', () => { loadStandings(); });

auth();