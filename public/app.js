const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const userId = tg.initDataUnsafe?.user?.id;

async function auth() {
  if (!userId) {
    document.getElementById('app').innerHTML = '<p>Откройте приложение через Telegram.</p>';
    return;
  }
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData })
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
    const res = await fetch('/api/matches');
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
      card.innerHTML = `
        <strong>${match.home_team} vs ${match.away_team}</strong><br>
        Дата: ${kickoff}<br>
        Статус: ${statusText}
        ${match.status === 'finished' ? `<br>Счёт: ${match.home_score} - ${match.away_score}` : ''}
      `;
      if (match.status === 'scheduled') {
        const btn = document.createElement('button');
        btn.className = 'btn-predict';
        btn.textContent = 'Сделать прогноз';
        btn.onclick = () => showPredictionModal(match);
        card.appendChild(btn);
      }
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
      body: JSON.stringify({ userId, matchId, predictedHome: homeGoals, predictedAway: awayGoals })
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
document.getElementById('nav-standings').addEventListener('click', () => { loadStandings(); });

auth();