import { DiscordSDK } from '@discord/embedded-app-sdk';

// ---------- pomocnicze ----------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => `${Number(n).toLocaleString('pl-PL')} zł`;
const show = (el, on) => el.classList.toggle('hidden', !on);
// Kwota z osobnym "zł" – w stylu TV waluta jest ukryta, jak na telewizyjnej tablicy.
const money = (n) => `<span class="num">${Number(n).toLocaleString('pl-PL')}</span><span class="cur"> zł</span>`;

// ---------- wybór stylu: "nowy" (domyślny) albo "tv" – każdy gracz wybiera dla siebie ----------
function getTheme() {
  try { return localStorage.getItem('theme') === 'tv' ? 'tv' : 'new'; } catch { return 'new'; }
}
function applyTheme(theme) {
  document.body.classList.toggle('theme-tv', theme === 'tv');
  $('theme-toggle').textContent = theme === 'tv' ? '🎨 Styl: TV' : '🎨 Styl: nowy';
  try { localStorage.setItem('theme', theme); } catch { /* ignoruj */ }
}
applyTheme(getTheme());
$('theme-toggle').addEventListener('click', () => applyTheme(getTheme() === 'tv' ? 'new' : 'tv'));

let toastTimer;
function toast(text, kind = 'error') {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ---------- logowanie ----------
// Discord otwiera aktywność z parametrem frame_id w adresie. Bez niego jesteśmy
// w zwykłej przeglądarce – wtedy włącza się tryb testowy z wpisywaniem nicku.
const inDiscord = new URLSearchParams(location.search).has('frame_id');
let hello = null; // wiadomość logująca, wysyłana po każdym (ponownym) połączeniu

async function loginDiscord() {
  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error('Nie udało się pobrać tokenu');
  const { access_token } = await res.json();
  await sdk.commands.authenticate({ access_token });
  // instanceId = ta konkretna gra na tym kanale głosowym
  return { type: 'hello', access_token, instanceId: sdk.instanceId };
}

function loginDev() {
  return new Promise((resolve) => {
    show($('loading'), false);
    show($('dev-login'), true);
    const saved = sessionStorageGet('devName');
    if (saved) $('dev-name').value = saved;
    $('dev-name').focus();
    $('dev-login').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('dev-name').value.trim();
      if (!name) return;
      sessionStorageSet('devName', name);
      show($('dev-login'), false);
      show($('loading'), true);
      resolve({ type: 'hello', devName: name, instanceId: 'local' });
    });
  });
}

function sessionStorageGet(k) {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function sessionStorageSet(k, v) {
  try { sessionStorage.setItem(k, v); } catch { /* ignoruj */ }
}

// ---------- połączenie z serwerem ----------
let ws;
let state = null;
let clockOffset = 0; // różnica między zegarem serwera a naszym
let fatal = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify(hello));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') {
      state = msg.state;
      clockOffset = state.serverNow - Date.now();
      render();
    } else if (msg.type === 'chat') {
      addChatLine(msg.entry, msg.channel);
    } else if (msg.type === 'chat_history') {
      $('chat-log').innerHTML = '';
      $('team-log').innerHTML = '';
      msg.general.forEach((e) => addChatLine(e, 'general', true));
      msg.team.forEach((e) => addChatLine(e, 'team', true));
    } else if (msg.type === 'error') {
      toast(msg.message);
    } else if (msg.type === 'fatal') {
      fatal = true;
      $('loading-text').textContent = msg.message;
      show($('game'), false);
      show($('loading'), true);
    }
  };
  ws.onclose = () => {
    if (fatal) return; // np. złe logowanie – nie ma sensu łączyć w kółko
    toast('Utracono połączenie – łączę ponownie…', 'info');
    setTimeout(connect, 1500);
  };
}

const sendMsg = (obj) => ws?.readyState === 1 && ws.send(JSON.stringify(obj));
const hostAction = (action, extra = {}) => sendMsg({ type: 'host', action, ...extra });

// ---------- rysowanie ----------
const PHASES = {
  lobby: 'Poczekalnia',
  category: 'Losowanie kategorii',
  bidding: 'LICYTACJA',
  question: 'Pytanie',
  result: 'Wynik rundy',
  gameover: 'Koniec gry',
};

const me = () => state.players.find((p) => p.id === state.you);

function render() {
  show($('loading'), false);
  show($('game'), true);
  const s = state;
  const my = me();

  $('round').textContent = s.round ? `Runda ${s.round}` : 'Przed grą';
  $('phase').textContent = PHASES[s.phase];
  $('phase').classList.toggle('live', s.phase === 'bidding');

  // Pula: w trakcie licytacji pokazujemy też to, co już zalicytowano.
  const bidsSum = Object.values(s.teams).reduce((a, t) => a + (s.phase === 'bidding' ? t.bid : 0), 0);
  $('pool').innerHTML = money(s.pool + bidsSum);
  $('game').classList.toggle('is-host', s.isHost);

  const qVisible = s.question && (s.questionShown || s.phase === 'result') && s.question.text;
  show($('question'), !!qVisible);
  if (qVisible) {
    $('question').innerHTML =
      `<div class="q-cat">${esc(s.category)}</div>` +
      `<div>${esc(s.question.text)}</div>` +
      (s.question.answer && s.phase === 'result' ? `<div class="answer">Odpowiedź: <b>${esc(s.question.answer)}</b></div>` : '');
  }

  // Tryb gry i oficjalna odpowiedź drużyny (tryb tekstowy)
  $('mode-pill').textContent = s.mode === 'text' ? '⌨️ Tekstowy' : '🎙️ Głosowy';
  const off = s.officialAnswer && ['question', 'result'].includes(s.phase);
  show($('official'), !!off);
  if (off) {
    const m = s.teamsMeta.find((t) => t.id === s.winnerTeam);
    $('official').style.setProperty('--c', m.color);
    $('official').innerHTML = `<span class="muted">Odpowiedź drużyny ${esc(m.name)}:</span> <b>${esc(s.officialAnswer.text)}</b>`;
  }

  autoSwitchTab(my);
  prevPhase = s.phase;
  prevShown = s.questionShown;
  renderBoard(my);
  renderChatInput(my);
  renderLobby(my);
  renderHostPanel();
  tick();
}

// Tablica: górny rząd = licytacja, dolny = stan konta. Bez nazw – drużyny rozpoznaje się po kolorze.
function renderBoard(my) {
  const s = state;
  const showBids = ['bidding', 'question', 'result'].includes(s.phase);
  $('bids').innerHTML = s.teamsMeta
    .map((m) => {
      const t = s.teams[m.id];
      const leading = s.bidding?.highestTeam === m.id && ['bidding', 'question'].includes(s.phase);
      return `<div class="tile team-${m.id} ${leading ? 'leading' : ''} ${t.out ? 'out' : ''}" style="--c:${m.color}">
        <div class="tile-value">${money(showBids ? t.bid : 0)}</div></div>`;
    })
    .join('');
  // Dymek z awatarami (jeśli był otwarty) przenosimy do nowo narysowanego pola.
  const openPopup = document.querySelector('.avatars-popup');
  $('money').innerHTML = s.teamsMeta
    .map((m) => {
      const t = s.teams[m.id];
      const winner = s.winnerTeam === m.id && ['result', 'gameover'].includes(s.phase);
      const mine = my?.team === m.id;
      return `<div class="tile money team-${m.id} ${winner ? 'winner' : ''} ${t.out ? 'out' : ''} ${mine ? 'mine' : ''}" data-team="${m.id}" style="--c:${m.color}" title="Kliknij, aby zobaczyć graczy">
        <div class="tile-label">STAN KONTA</div>
        <div class="tile-value">${money(t.money)}</div></div>`;
    })
    .join('');
  if (openPopup) $('money').querySelector(`[data-team="${openPopup.dataset.team}"]`)?.append(openPopup);
}

// ---------- awatary drużyny (po kliknięciu w stan konta, na 3 s) ----------
let popupTimer;
function avatarHtml(p, color) {
  const initials = esc(p.name.trim().slice(0, 2).toUpperCase());
  const fallback = `<span class="initials" style="background:${color}">${initials}</span>`;
  // Gracze z Discorda mają prawdziwy awatar; gdy się nie wczyta, zostają inicjały.
  return `<div class="avatar" title="${esc(p.name)}">${fallback}${
    p.discord ? `<img src="/api/avatar/${esc(p.id)}" alt="" onerror="this.remove()" />` : ''
  }</div>`;
}

function showAvatars(teamId) {
  document.querySelector('.avatars-popup')?.remove();
  clearTimeout(popupTimer);
  const meta = state.teamsMeta.find((t) => t.id === teamId);
  const players = state.players.filter((p) => p.team === teamId);
  // Kwadrat podzielony na 4 części: do 4 awatarów, przy większej drużynie ostatnie pole to "+N".
  const shown = players.length > 4 ? players.slice(0, 3) : players;
  let cells = shown.map((p) => avatarHtml(p, meta.color));
  if (players.length > 4) cells.push(`<div class="avatar more">+${players.length - 3}</div>`);
  while (cells.length < 4) cells.push('<div class="avatar empty"></div>');

  const popup = document.createElement('div');
  popup.className = 'avatars-popup';
  popup.dataset.team = teamId;
  popup.style.setProperty('--c', meta.color);
  popup.innerHTML = cells.join('');
  $('money').querySelector(`[data-team="${teamId}"]`).append(popup);
  popupTimer = setTimeout(() => popup.remove(), 3000);
}

// ---------- zakładki czatu: Ogólny / Moja drużyna ----------
let activeTab = 'general';
let prevPhase = null;
let prevShown = false;
const unread = { general: 0, team: 0 };

function setTab(tab) {
  activeTab = tab;
  unread[tab] = 0;
  for (const b of document.querySelectorAll('#chat-tabs .tab')) b.classList.toggle('active', b.dataset.tab === tab);
  show($('chat-log'), tab === 'general');
  show($('team-log'), tab === 'team');
  const log = tab === 'team' ? $('team-log') : $('chat-log');
  log.scrollTop = log.scrollHeight;
  renderBadges();
  if (state) renderChatInput(me());
  $('chat-input').focus();
}

function renderBadges() {
  for (const k of ['general', 'team']) {
    const b = document.querySelector(`[data-badge="${k}"]`);
    b.textContent = unread[k] > 9 ? '9+' : unread[k];
    show(b, unread[k] > 0 && activeTab !== k);
  }
}

// Same przełączamy w ważnych momentach: licytacja -> Ogólny,
// tryb tekstowy i pytanie dla mojej drużyny -> Moja drużyna (żeby się naradzić).
function autoSwitchTab(my) {
  const s = state;
  const hasTeamTab = !!my?.team && !s.isHost;
  show($('team-tab'), hasTeamTab);
  $('chat-tabs').classList.toggle('single', !hasTeamTab);
  if (!hasTeamTab && activeTab === 'team') return setTab('general');
  if (s.phase === 'bidding' && prevPhase !== 'bidding' && activeTab !== 'general') return setTab('general');
  if (hasTeamTab && s.mode === 'text' && s.phase === 'question' && s.questionShown && !prevShown
      && s.winnerTeam === my.team && activeTab !== 'team') setTab('team');
}

function renderChatInput(my) {
  const s = state;
  const canBid = s.phase === 'bidding' && my?.team && !s.isHost && !s.teams[my.team].out;
  const canAnswer = s.mode === 'text' && s.phase === 'question' && s.questionShown && my?.team === s.winnerTeam && !s.officialAnswer;
  const input = $('chat-input');
  if (activeTab === 'team') {
    input.placeholder = canAnswer ? 'Naradźcie się… odpowiedź wpisz z ! (np. !Wisła)' : 'Wiadomość do drużyny (widzi tylko wasza drużyna)…';
    input.inputMode = 'text';
  } else {
    input.placeholder = canBid ? 'Wpisz kwotę, aby licytować…' : canAnswer ? 'Odpowiedź wpisz z ! (np. !Wisła)' : 'Napisz wiadomość…';
    input.inputMode = canBid ? 'numeric' : 'text';
  }
  const color = my?.team ? s.teamsMeta.find((t) => t.id === my.team).color : 'var(--line)';
  $('chat-form').style.setProperty('--mine', color);
}

function addChatLine(e, channel = 'general', history = false) {
  const log = channel === 'team' ? $('team-log') : $('chat-log');
  if (!history && channel !== activeTab) {
    unread[channel]++;
    renderBadges();
  }
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const div = document.createElement('div');
  div.className = 'msg';
  const name = (cls = '') => `<b class="${cls}" style="color:${e.color || 'var(--gold)'}">${esc(e.name)}${e.host ? ' ★' : ''}:</b>`;
  if (e.sys) {
    div.classList.add('sys');
    div.textContent = e.text;
  } else if (e.bid) {
    div.classList.add('bid');
    div.innerHTML = `${name()} <span class="amount">${e.vabank ? 'VA BANQUE ' : ''}${fmt(e.amount)}</span>`;
  } else if (e.answer) {
    div.classList.add('official-msg');
    div.innerHTML = `${name()} <span class="amount">ODPOWIEDŹ: ${esc(e.text)}</span>`;
  } else {
    div.innerHTML = `${name()} ${esc(e.text)}`;
  }
  log.append(div);
  while (log.children.length > 100) log.firstChild.remove();
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function renderLobby(my) {
  const s = state;
  // Drużynę wybiera się przed grą albo gdy ktoś jeszcze nie ma drużyny (i nie trwa runda).
  const chooseTeam =
    !s.isHost && !['bidding', 'question'].includes(s.phase) && (!my?.team || ['lobby', 'gameover'].includes(s.phase));
  const claim = !s.isHost && (!s.hostName || !s.hostOnline);

  $('team-buttons').innerHTML = chooseTeam
    ? s.teamsMeta
        .map((t) => `<button class="btn team-btn ${my?.team === t.id ? 'active' : ''}" data-team="${t.id}" style="--c:${t.color}">${esc(t.name)}</button>`)
        .join('')
    : '';
  show($('claim-host'), claim);
  show($('lobby'), chooseTeam || claim);
}

const ENABLED = {
  draw_category: (s) => s.phase === 'category',
  start_bidding: (s) => s.phase === 'category' && !!s.category,
  end_bidding: (s) => s.phase === 'bidding',
  show_question: (s) => s.phase === 'question' && !s.questionShown,
  good: (s) => s.phase === 'question' && s.questionShown,
  bad: (s) => s.phase === 'question' && s.questionShown,
  next_round: (s) => s.phase === 'result',
  start_game: () => true,
  end_game: (s) => !['lobby', 'gameover'].includes(s.phase),
  release_host: () => true,
  voice_split: (s) => s.mode === 'voice' && s.voiceReady && !s.voiceBusy,
  voice_join: (s) => s.mode === 'voice' && s.voiceReady && !s.voiceBusy,
};

function renderHostPanel() {
  const s = state;
  show($('host-panel'), s.isHost);
  if (!s.isHost) return;
  for (const btn of $('host-panel').querySelectorAll('[data-action]')) {
    btn.disabled = !ENABLED[btn.dataset.action](s);
    // Nowa gra w lobby/po grze nie potrzebuje potwierdzenia
    if (btn.dataset.action === 'start_game' && !btn.dataset.armed) btn.textContent = ['lobby', 'gameover'].includes(s.phase) ? '🚀 Start gry' : '🔄 Nowa gra';
  }
  for (const b of document.querySelectorAll('.mode-btn')) {
    b.classList.toggle('active', b.dataset.mode === s.mode);
    b.disabled = ['bidding', 'question'].includes(s.phase);
  }
  show($('voice-row'), s.mode === 'voice');
  show($('voice-warn'), s.mode === 'voice' && !s.voiceReady);
  const off = s.mode === 'text' && s.phase === 'question' && s.questionShown;
  show($('host-official'), off);
  if (off) {
    $('host-official').innerHTML = s.officialAnswer
      ? `Odpowiedź drużyny: <b>${esc(s.officialAnswer.text)}</b> <span class="muted">(${esc(s.officialAnswer.by)})</span>`
      : '<span class="muted">Czekam na odpowiedź drużyny (wpisaną z !)…</span>';
  }

  const q = s.question;
  $('host-answer').innerHTML = q
    ? `<div class="muted">Kategoria: ${esc(s.category)} · pytanie widzisz tylko ty, dopóki go nie pokażesz:</div><div>${esc(q.text)}</div><div>Odpowiedź: <b>${esc(q.answer)}</b></div>`
    : '<div class="muted">Brak wylosowanego pytania.</div>';

  const sel = $('adjust-target');
  if (!sel.options.length) {
    sel.innerHTML =
      s.teamsMeta.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('') + '<option value="pool">Pula</option>';
  }
  $('host-info').textContent = `Pozostało pytań: ${s.questionsLeft}`;
}

// Odliczanie – liczone lokalnie z czasu końca podanego przez serwer.
function tick() {
  if (!state) return;
  const now = Date.now() + clockOffset;
  let end = null;
  if (state.phase === 'bidding') end = state.bidding?.endsAt;
  else if (state.phase === 'question' && state.questionShown) end = state.answerEndsAt;
  const el = $('timer');
  if (!end) {
    el.textContent = '';
    el.className = 'timer';
    return;
  }
  const sec = Math.max(0, Math.ceil((end - now) / 1000));
  el.textContent = sec > 0 ? `⏱ ${sec}s` : 'Czas!';
  el.className = `timer ${sec <= 3 ? 'urgent' : ''}`;
}
setInterval(tick, 200);

// ---------- obsługa kliknięć ----------
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  sendMsg({ type: 'chat', text, channel: activeTab });
  $('chat-input').value = '';
});

$('chat-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) setTab(b.dataset.tab);
});

document.querySelector('.mode-switch').addEventListener('click', (e) => {
  const b = e.target.closest('.mode-btn');
  if (b && !b.disabled) hostAction('set_mode', { mode: b.dataset.mode });
});

$('money').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile.money');
  if (tile && state) showAvatars(tile.dataset.team);
});

$('team-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-team]');
  if (btn) sendMsg({ type: 'join_team', team: btn.dataset.team });
});

$('claim-host').addEventListener('click', () => sendMsg({ type: 'claim_host' }));

// Przyciski z data-confirm trzeba kliknąć dwa razy (w Discordzie nie ma okienek confirm()).
$('host-panel').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const needsConfirm = btn.dataset.confirm && !(btn.dataset.action === 'start_game' && ['lobby', 'gameover'].includes(state.phase));
  if (needsConfirm && !btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.dataset.label = btn.textContent;
    btn.textContent = 'Na pewno? Kliknij ponownie';
    setTimeout(() => {
      delete btn.dataset.armed;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }, 3000);
    return;
  }
  delete btn.dataset.armed;
  if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
    delete btn.dataset.label;
  }
  hostAction(btn.dataset.action);
});

$('adjust-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const delta = $('adjust-delta').value.replace(/\s/g, '');
  hostAction('adjust', { target: $('adjust-target').value, delta });
  $('adjust-delta').value = '';
});

// ---------- start ----------
(async () => {
  try {
    hello = inDiscord ? await loginDiscord() : await loginDev();
    connect();
  } catch (err) {
    console.error(err);
    $('loading-text').textContent = 'Błąd logowania: ' + err.message;
  }
})();
