// Serwer: logowanie przez Discorda (/api/token), WebSocket z grą (/ws)
// i – po zbudowaniu klienta – serwowanie samej strony aktywności.
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3001);
const CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DEV_LOGIN = process.env.DEV_LOGIN === '1';
const HOST_IDS = (process.env.HOST_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- bot do przenoszenia graczy między kanałami głosowymi ----------
// Potrzebny tylko w trybie głosowym. Wystarczy token bota i ID kanałów w .env.
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const voiceChannels = {
  main: process.env.VOICE_MAIN,
  blue: process.env.VOICE_BLUE,
  green: process.env.VOICE_GREEN,
  yellow: process.env.VOICE_YELLOW,
  champs: process.env.VOICE_CHAMPS, // opcjonalny kanał Mistrzów
};
const voice = {
  ready: !!(BOT_TOKEN && GUILD_ID && ['main', 'blue', 'green', 'yellow'].every((k) => voiceChannels[k])),
  channels: voiceChannels,
  // Zwraca 'ok', 'not_in_voice' albo 'error'.
  async move(userId, channelId, retry = true) {
    const r = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId }),
    }).catch(() => null);
    if (!r) return 'error';
    if (r.ok) return 'ok';
    const data = await r.json().catch(() => ({}));
    if (r.status === 429 && retry) {
      // Discord każe chwilę poczekać – czekamy i próbujemy jeszcze raz
      await new Promise((res) => setTimeout(res, (data.retry_after ?? 1) * 1000 + 50));
      return voice.move(userId, channelId, false);
    }
    if (data.code === 40032) return 'not_in_voice'; // gracz nie jest na żadnym kanale głosowym
    console.error(`Nie przeniesiono ${userId}:`, r.status, data.message ?? data);
    return 'error';
  },
};

// ---------- pytania ----------
const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')).map(
  (q, i) => ({ id: i, ...q }),
);
console.log(`Wczytano ${questions.length} pytań.`);

// ---------- zapis stanu gier (żeby restart serwera nie zerował kasy) ----------
const DATA_DIR = path.join(ROOT, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'games.json');
let saved = {};
try {
  saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
} catch {
  /* brak zapisu – zaczynamy od zera */
}

// ---------- Mistrzowie zapamiętani między grami ----------
const CHAMPS_FILE = path.join(DATA_DIR, 'champions.json');
let championsData = { ids: [], names: [] };
try {
  championsData = JSON.parse(fs.readFileSync(CHAMPS_FILE, 'utf8'));
} catch {
  /* brak Mistrzów */
}
const champions = {
  get: () => championsData,
  set(data) {
    championsData = data;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CHAMPS_FILE, JSON.stringify(data));
    console.log('Nowi Mistrzowie:', data.names.join(', '));
  },
};

const games = new Map();
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const [id, g] of games) out[id] = g.state;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(out));
  }, 300);
}

function getGame(instanceId) {
  if (!games.has(instanceId)) {
    games.set(
      instanceId,
      new Game(instanceId, questions, {
        saved: saved[instanceId],
        hostIds: HOST_IDS,
        onChange: scheduleSave,
        voice,
        champions,
      }),
    );
  }
  return games.get(instanceId);
}

// ---------- HTTP ----------
const app = express();
app.use(express.json());

// Wymiana jednorazowego kodu z Discorda na access_token (sekret zostaje na serwerze).
async function tokenHandler(req, res) {
  try {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(req.body?.code || ''),
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Błąd wymiany tokenu:', data);
      return res.status(400).json({ error: 'token_exchange_failed' });
    }
    res.json({ access_token: data.access_token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
}
app.post('/api/token', tokenHandler);
app.post('/.proxy/api/token', tokenHandler);

// Awatary graczy. Pobieramy je z serwera Discorda i podajemy z naszego adresu,
// bo okno aktywności nie zawsze może ładować obrazki z obcych domen.
// Tylko dla graczy, którzy się zalogowali – żeby nie robić z tego publicznego proxy.
const avatars = new Map(); // userId -> hash awatara (albo null = domyślny)
const avatarCache = new Map(); // `${id}:${hash}` -> { buf, type }
app.get(['/api/avatar/:id', '/.proxy/api/avatar/:id'], async (req, res) => {
  const id = req.params.id;
  if (!/^\d{5,25}$/.test(id) || !avatars.has(id)) return res.sendStatus(404);
  const hash = avatars.get(id);
  const key = `${id}:${hash}`;
  try {
    if (!avatarCache.has(key)) {
      const url = hash
        ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=128`
        : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
      const r = await fetch(url);
      if (!r.ok) return res.sendStatus(404);
      avatarCache.set(key, {
        buf: Buffer.from(await r.arrayBuffer()),
        type: r.headers.get('content-type') || 'image/png',
      });
    }
    const { buf, type } = avatarCache.get(key);
    res.set('Content-Type', type).set('Cache-Control', 'public, max-age=3600').send(buf);
  } catch {
    res.sendStatus(404);
  }
});

const DIST = path.join(ROOT, 'dist');
if (fs.existsSync(DIST)) app.use(express.static(DIST));

const server = http.createServer(app);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws' || pathname === '/.proxy/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// Kim jest gracz? W Discordzie pytamy API o właściciela tokenu,
// w trybie testowym (DEV_LOGIN=1) wystarczy wpisany nick.
async function identify(msg) {
  if (msg.access_token) {
    const r = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${msg.access_token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    avatars.set(u.id, u.avatar || null);
    return { id: u.id, name: u.global_name || u.username, discord: true };
  }
  if (DEV_LOGIN && msg.devName) {
    const name = String(msg.devName).trim().slice(0, 24);
    if (!name) return null;
    return { id: `dev-${name.toLowerCase()}`, name };
  }
  return null;
}

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  let session = null;
  let pending = false;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!session) {
      if (msg.type !== 'hello' || pending) return;
      pending = true;
      const user = await identify(msg).catch(() => null);
      if (!user) {
        send(ws, { type: 'fatal', message: 'Nie udało się zalogować.' });
        return ws.close();
      }
      const instanceId = String(msg.instanceId || 'local').slice(0, 200);
      const game = getGame(instanceId);
      session = { game, userId: user.id };
      game.connect(user, ws);
      return;
    }

    const err = session.game.handle(session.userId, msg);
    if (err) send(ws, { type: 'error', message: err });
  });

  ws.on('close', () => session?.game.disconnect(ws));
});

// Wykrywanie zerwanych połączeń.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Serwer działa: http://localhost:${PORT}`);
  if (DEV_LOGIN) console.log('Tryb testowy włączony (DEV_LOGIN=1) – można wejść w przeglądarce bez Discorda.');
  console.log(voice.ready
    ? 'Bot do kanałów głosowych: gotowy.'
    : 'Bot do kanałów głosowych: wyłączony (brak danych w .env) – przenoszenie drużyn nie zadziała.');
  if (!CLIENT_ID || !CLIENT_SECRET) console.log('UWAGA: brak VITE_DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET w .env – logowanie przez Discorda nie zadziała.');
});
