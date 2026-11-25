// Logika gry "Awantura o kasę" – jedna instancja = jedna gra na jednym kanale Discorda.
// Serwer jest jedynym źródłem prawdy: klienci tylko wysyłają akcje, a serwer
// sprawdza zasady i rozsyła wszystkim aktualny stan.

export const CONFIG = {
  startMoney: 10000,     // kasa na start każdej drużyny
  entryFee: 200,         // wpisowe na początku każdej rundy (idzie do puli)
  bidStep: 100,          // licytujemy wielokrotnościami tej kwoty
  firstBidTimerSec: 20,  // ile czasu na pierwszą ofertę po otwarciu licytacji
  bidTimerSec: 10,       // ile sekund bez przebicia zamyka licytację
  answerTimerSec: 60,    // czas na odpowiedź (tylko odliczanie, decyduje prowadzący)
};

export const TEAMS = [
  { id: 'blue', name: 'Niebiescy', color: '#3b82f6' },
  { id: 'green', name: 'Zieloni', color: '#22c55e' },
  { id: 'yellow', name: 'Żółci', color: '#eab308' },
];

const TEAM_IDS = TEAMS.map((t) => t.id);
const teamName = (id) => TEAMS.find((t) => t.id === id)?.name ?? id;
export const fmt = (n) => `${Number(n).toLocaleString('pl-PL')} zł`;

const VABANK_WORDS = ['vabank', 'vabanque', 'va-banque', 'vb'];
const normalizeBid = (text) => String(text ?? '').toLowerCase().replace(/\s|zł|zl|\./g, '');
// Czy wiadomość wygląda jak oferta: sama liczba (np. "500", "1 000 zł") albo "vabank".
const isBidText = (text) => {
  const t = normalizeBid(text);
  return /^\d+$/.test(t) || VABANK_WORDS.includes(t);
};

function freshState() {
  return {
    phase: 'lobby', // lobby | category | bidding | question | result | gameover
    round: 0,
    pool: 0,
    hostId: null,
    teams: Object.fromEntries(
      TEAMS.map((t) => [t.id, { money: CONFIG.startMoney, bid: 0, out: false }]),
    ),
    players: {}, // userId -> { id, name, team }
    category: null,
    question: null, // { id, kategoria, pytanie, odpowiedz }
    questionShown: false,
    usedQuestions: [],
    bidding: null, // { highest, highestTeam, endsAt }
    log: [], // historia ofert w bieżącej rundzie
    winnerTeam: null,
    result: null, // 'good' | 'bad' | 'nobid'
    answerEndsAt: null,
    officialAnswer: null, // tryb tekstowy: { text, by } – odpowiedź drużyny wpisana z "!"
    mode: 'voice', // 'voice' = gracze na głosowym, 'text' = wszystko na czacie
    message: 'Czekamy na prowadzącego.',
  };
}

export class Game {
  constructor(id, questions, { saved, hostIds = [], onChange, voice } = {}) {
    this.id = id;
    this.questions = questions;
    this.hostIds = hostIds;
    this.onChange = onChange ?? (() => {});
    this.voice = voice ?? null; // bot przenoszący graczy między kanałami głosowymi
    this.voiceBusy = false;
    this.sockets = new Set(); // każdy socket ma pole .userId
    this.timer = null;
    // Czaty: 'general' (wszyscy) i osobny dla każdej drużyny (widzą tylko jej gracze).
    // Nie zapisujemy ich do pliku.
    this.chats = { general: [], ...Object.fromEntries(TEAM_IDS.map((id) => [id, []])) };
    this.chatRate = new Map(); // userId -> czasy ostatnich wiadomości (ochrona przed spamem)
    this.state = saved ?? freshState();
    this.state.mode ??= 'voice'; // stare zapisy gry nie miały trybu

    // Po restarcie serwera w trakcie licytacji dajemy graczom świeży czas.
    if (this.state.phase === 'bidding') {
      this.state.bidding.endsAt = Date.now() + CONFIG.bidTimerSec * 1000;
      this.armBidTimer();
    }
  }

  // ---------- połączenia ----------

  connect(user, ws) {
    ws.userId = user.id;
    this.sockets.add(ws);
    const old = this.state.players[user.id];
    this.state.players[user.id] = {
      id: user.id,
      name: user.name,
      team: old?.team ?? null,
      discord: !!user.discord, // true = gracz z Discorda (ma awatar)
    };
    if (!this.state.hostId && this.hostIds.includes(user.id)) this.state.hostId = user.id;
    this.changed();
    this.sendHistory(ws);
  }

  // Historia obu zakładek czatu dla jednego połączenia.
  sendHistory(ws) {
    const team = this.state.players[ws.userId]?.team;
    if (ws.readyState !== 1) return;
    ws.send(
      JSON.stringify({
        type: 'chat_history',
        general: this.chats.general,
        team: team && ws.userId !== this.state.hostId ? this.chats[team] : [],
      }),
    );
  }

  // ---------- czat ----------

  // channel: 'general' albo id drużyny (czat drużynowy).
  addChat(entry, channel = 'general') {
    const full = { ...entry, at: Date.now() };
    if (entry.team) full.color = TEAMS.find((t) => t.id === entry.team)?.color;
    const list = this.chats[channel];
    list.push(full);
    if (list.length > 100) list.shift();
    const data = JSON.stringify({ type: 'chat', channel: channel === 'general' ? 'general' : 'team', entry: full });
    for (const ws of this.sockets) {
      if (ws.readyState !== 1) continue;
      if (channel !== 'general') {
        // czat drużyny widzą tylko jej gracze (prowadzący też nie)
        const p = this.state.players[ws.userId];
        if (p?.team !== channel || ws.userId === this.state.hostId) continue;
      }
      ws.send(data);
    }
  }

  // Komunikat gry – trafia na czat jako wiadomość systemowa.
  say(text) {
    this.state.message = text;
    this.addChat({ sys: true, text });
  }

  chatMessage(userId, raw, channel = 'general') {
    const s = this.state;
    const text = String(raw ?? '').trim().slice(0, 200);
    if (!text) return null;

    const now = Date.now();
    const times = (this.chatRate.get(userId) ?? []).filter((t) => now - t < 4000);
    if (times.length >= 6) return 'Zwolnij trochę 🙂';
    times.push(now);
    this.chatRate.set(userId, times);

    const p = s.players[userId];
    const isHost = userId === s.hostId;

    // Tryb tekstowy: "!odpowiedź" od drużyny, która wygrała licytację = oficjalna odpowiedź.
    if (text.startsWith('!') && s.mode === 'text' && p?.team && !isHost) {
      return this.officialAnswer(userId, text.slice(1).trim());
    }

    if (channel === 'team') {
      if (isHost || !p?.team) return 'Czat drużyny jest tylko dla graczy w drużynie.';
      this.addChat({ name: p.name, team: p.team, text }, p.team);
      return null;
    }

    // W trakcie licytacji sama kwota (albo "vabank") od gracza z drużyny = oferta.
    if (s.phase === 'bidding' && p?.team && !isHost && isBidText(text)) {
      return this.bid(userId, text);
    }
    this.addChat({ name: p?.name ?? '?', team: p?.team ?? null, host: isHost, text });
    return null;
  }

  officialAnswer(userId, text) {
    const s = this.state;
    const p = s.players[userId];
    if (s.phase !== 'question' || !s.questionShown) return 'Teraz nie ma pytania do odpowiedzi.';
    if (p.team !== s.winnerTeam) return `Odpowiada drużyna ${teamName(s.winnerTeam)}.`;
    if (s.officialAnswer) return 'Wasza drużyna już podała odpowiedź.';
    if (!text) return 'Wpisz odpowiedź po wykrzykniku, np. !Wisła';
    s.officialAnswer = { text: text.slice(0, 150), by: p.name };
    this.addChat({ name: p.name, team: p.team, answer: true, text: s.officialAnswer.text });
    this.changed();
    return null;
  }

  // ---------- kanały głosowe (tryb głosowy) ----------
  // split: każdy gracz na kanał swojej drużyny; join: wszyscy na kanał ogólny.
  async moveVoice(kind) {
    const s = this.state;
    if (!this.voice?.ready) return 'Bot nie jest skonfigurowany – uzupełnij dane bota w .env.';
    if (this.voiceBusy) return 'Przenoszę graczy, chwila…';
    const targets = [];
    for (const p of Object.values(s.players)) {
      if (!p.discord) continue; // gracze z trybu testowego nie są na Discordzie
      if (kind === 'split') {
        if (p.team && p.id !== s.hostId) targets.push([p, this.voice.channels[p.team]]);
      } else {
        targets.push([p, this.voice.channels.main]);
      }
    }
    if (!targets.length) return 'Nie ma kogo przenieść.';
    this.voiceBusy = true;
    this.say(kind === 'split' ? 'Narada! Drużyny przechodzą na swoje kanały głosowe…' : 'Wszyscy wracają na kanał ogólny…');
    let moved = 0;
    const notInVoice = [];
    try {
      for (const [p, channelId] of targets) {
        const r = await this.voice.move(p.id, channelId);
        if (r === 'ok') moved++;
        else if (r === 'not_in_voice') notInVoice.push(p.name);
      }
    } finally {
      this.voiceBusy = false;
    }
    let text = `Przeniesiono graczy: ${moved}.`;
    if (notInVoice.length) text += ` Nie są na kanale głosowym: ${notInVoice.join(', ')}.`;
    if (moved + notInVoice.length < targets.length) text += ' Części nie udało się przenieść – sprawdź uprawnienia bota.';
    this.say(text);
    this.changed();
    return null;
  }

  disconnect(ws) {
    this.sockets.delete(ws);
    this.changed(false);
  }

  isOnline(userId) {
    for (const ws of this.sockets) if (ws.userId === userId) return true;
    return false;
  }

  changed(save = true) {
    for (const ws of this.sockets) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'state', state: this.viewFor(ws.userId) }));
      }
    }
    if (save) this.onChange(this);
  }

  // Każdy gracz dostaje swój widok: odpowiedź widzi tylko prowadzący
  // (a wszyscy dopiero po ocenie), pytanie dopiero po odsłonięciu.
  viewFor(userId) {
    const s = this.state;
    const isHost = userId === s.hostId;
    const players = Object.values(s.players).map((p) => ({ ...p, online: this.isOnline(p.id) }));
    const q = s.question;
    return {
      you: userId,
      isHost,
      hostOnline: s.hostId ? this.isOnline(s.hostId) : false,
      hostName: s.hostId ? s.players[s.hostId]?.name ?? '?' : null,
      phase: s.phase,
      round: s.round,
      pool: s.pool,
      teams: s.teams,
      teamsMeta: TEAMS,
      players,
      category: s.category,
      question: q
        ? {
            text: isHost || s.questionShown ? q.pytanie : null,
            answer: isHost || s.phase === 'result' ? q.odpowiedz : null,
          }
        : null,
      questionShown: s.questionShown,
      bidding: s.bidding,
      log: s.log,
      winnerTeam: s.winnerTeam,
      result: s.result,
      answerEndsAt: s.answerEndsAt,
      message: s.message,
      mode: s.mode,
      officialAnswer: s.officialAnswer,
      voiceReady: !!this.voice?.ready,
      voiceBusy: this.voiceBusy,
      questionsLeft: this.questions.length - s.usedQuestions.length,
      config: CONFIG,
      serverNow: Date.now(),
    };
  }

  // ---------- obsługa wiadomości od klienta ----------
  // Zwraca tekst błędu albo null, gdy wszystko poszło dobrze.

  handle(userId, msg) {
    const s = this.state;
    switch (msg.type) {
      case 'join_team':
        return this.joinTeam(userId, msg.team);
      case 'claim_host':
        return this.claimHost(userId);
      case 'chat':
        return this.chatMessage(userId, msg.text, msg.channel === 'team' ? 'team' : 'general');
      case 'bid':
        return this.bid(userId, msg.text);
      case 'host':
        if (userId !== s.hostId) return 'Tylko prowadzący może to zrobić.';
        return this.hostAction(msg);
      default:
        return 'Nieznana akcja.';
    }
  }

  joinTeam(userId, team) {
    const s = this.state;
    if (team !== null && !TEAM_IDS.includes(team)) return 'Nie ma takiej drużyny.';
    if (userId === s.hostId) return 'Prowadzący nie gra w drużynie.';
    if (['bidding', 'question'].includes(s.phase)) return 'Drużynę można zmienić dopiero po tej rundzie.';
    s.players[userId].team = team;
    this.changed();
    // nowa drużyna = inna historia czatu drużynowego
    for (const ws of this.sockets) if (ws.userId === userId) this.sendHistory(ws);
    return null;
  }

  claimHost(userId) {
    const s = this.state;
    const canTake =
      !s.hostId || !this.isOnline(s.hostId) || this.hostIds.includes(userId);
    if (!canTake) return 'Gra ma już prowadzącego.';
    s.hostId = userId;
    s.players[userId].team = null;
    this.changed();
    for (const ws of this.sockets) if (ws.userId === userId) this.sendHistory(ws);
    return null;
  }

  bid(userId, text) {
    const s = this.state;
    if (s.phase !== 'bidding') return 'Licytacja jest zamknięta.';
    if (userId === s.hostId) return 'Prowadzący nie licytuje.';
    const p = s.players[userId];
    if (!p?.team) return 'Najpierw dołącz do drużyny.';
    const team = s.teams[p.team];
    if (team.out) return 'Twoja drużyna nie bierze udziału w tej rundzie.';
    if (s.bidding.highestTeam === p.team) return 'Wasza oferta już jest najwyższa.';

    const t = normalizeBid(text);
    let amount;
    let vabank = false;
    if (VABANK_WORDS.includes(t)) {
      amount = team.money;
      vabank = true;
    } else if (/^\d+$/.test(t)) {
      amount = parseInt(t, 10);
    } else {
      return 'Wpisz samą kwotę, np. 500, albo "vabank".';
    }

    if (amount > team.money) return `Macie tylko ${fmt(team.money)}.`;
    if (amount <= s.bidding.highest) return `Trzeba przebić ${fmt(s.bidding.highest)}.`;
    if (!vabank && amount % CONFIG.bidStep !== 0)
      return `Kwota musi być wielokrotnością ${CONFIG.bidStep} zł.`;
    if (amount === team.money) vabank = true;

    team.bid = amount;
    s.bidding.highest = amount;
    s.bidding.highestTeam = p.team;
    s.bidding.endsAt = Date.now() + CONFIG.bidTimerSec * 1000;
    s.log.unshift({ team: p.team, amount, by: p.name, vabank, at: Date.now() });
    s.log = s.log.slice(0, 30);
    this.addChat({ name: p.name, team: p.team, bid: true, amount, vabank });
    if (vabank) this.say(`VA BANQUE! ${teamName(p.team)} stawiają wszystko!`);
    this.armBidTimer();
    this.changed();
    return null;
  }

  // ---------- panel prowadzącego ----------

  hostAction(msg) {
    const s = this.state;
    const need = (...phases) =>
      phases.includes(s.phase) ? null : 'Tej akcji nie można teraz wykonać.';

    switch (msg.action) {
      case 'start_game': {
        const { hostId, players, mode } = s;
        this.clearTimer();
        this.state = freshState();
        this.state.hostId = hostId;
        this.state.players = players;
        this.state.mode = mode;
        this.state.phase = 'category';
        this.state.round = 1;
        this.say('Runda 1 – prowadzący losuje kategorię.');
        break;
      }
      case 'draw_category': {
        const err = need('category');
        if (err) return err;
        // Poprzednio wylosowane, ale niezagrane pytanie wraca do puli.
        if (s.question) s.usedQuestions = s.usedQuestions.filter((id) => id !== s.question.id);
        const free = this.questions.filter((q) => !s.usedQuestions.includes(q.id));
        if (!free.length) return 'Skończyły się pytania – dopisz nowe do questions.json.';
        const cats = [...new Set(free.map((q) => q.kategoria))];
        const cat = cats[Math.floor(Math.random() * cats.length)];
        const inCat = free.filter((q) => q.kategoria === cat);
        const q = inCat[Math.floor(Math.random() * inCat.length)];
        s.usedQuestions.push(q.id);
        s.category = cat;
        s.question = q;
        s.questionShown = false;
        this.say(`Kategoria: ${cat}`);
        break;
      }
      case 'start_bidding': {
        const err = need('category');
        if (err) return err;
        if (!s.category) return 'Najpierw wylosuj kategorię.';
        const staffed = this.staffedTeams();
        if (staffed.length < 2) return 'Do gry potrzeba co najmniej dwóch drużyn z graczami.';
        for (const id of TEAM_IDS) {
          const t = s.teams[id];
          t.bid = 0;
          if (!staffed.includes(id) || t.money < CONFIG.entryFee) {
            t.out = true;
          } else {
            t.out = false;
            t.money -= CONFIG.entryFee;
            s.pool += CONFIG.entryFee;
          }
        }
        s.bidding = {
          highest: 0,
          highestTeam: null,
          endsAt: Date.now() + CONFIG.firstBidTimerSec * 1000,
        };
        s.log = [];
        s.phase = 'bidding';
        this.say(`Licytacja otwarta! Wpisowe ${fmt(CONFIG.entryFee)} poszło do puli. Wpiszcie kwotę na czacie.`);
        this.armBidTimer();
        break;
      }
      case 'end_bidding': {
        const err = need('bidding');
        if (err) return err;
        this.closeBidding();
        return null; // closeBidding samo rozsyła stan
      }
      case 'show_question': {
        const err = need('question');
        if (err) return err;
        s.questionShown = true;
        s.officialAnswer = null;
        s.answerEndsAt = Date.now() + CONFIG.answerTimerSec * 1000;
        this.say(
          s.mode === 'text'
            ? `Pytanie dla drużyny ${teamName(s.winnerTeam)}! Naradźcie się na czacie drużyny i wpiszcie odpowiedź z wykrzyknikiem, np. !Wisła`
            : `Pytanie dla drużyny ${teamName(s.winnerTeam)}!`,
        );
        break;
      }
      case 'good':
      case 'bad': {
        const err = need('question');
        if (err) return err;
        if (!s.questionShown) return 'Najpierw pokaż pytanie.';
        const w = teamName(s.winnerTeam);
        if (msg.action === 'good') {
          s.teams[s.winnerTeam].money += s.pool;
          this.say(`Dobra odpowiedź! ${w} zgarniają ${fmt(s.pool)}!`);
          s.pool = 0;
          s.result = 'good';
        } else {
          this.say(`Zła odpowiedź! Pula ${fmt(s.pool)} przechodzi do następnej rundy.`);
          s.result = 'bad';
        }
        s.answerEndsAt = null;
        s.phase = 'result';
        break;
      }
      case 'next_round': {
        const err = need('result');
        if (err) return err;
        const able = this.staffedTeams().filter((id) => s.teams[id].money >= CONFIG.entryFee);
        if (able.length < 2) return this.finish();
        s.round += 1;
        s.phase = 'category';
        s.category = null;
        s.question = null;
        s.questionShown = false;
        s.bidding = null;
        s.log = [];
        s.winnerTeam = null;
        s.result = null;
        s.officialAnswer = null;
        for (const id of TEAM_IDS) s.teams[id].bid = 0;
        this.say(`Runda ${s.round} – prowadzący losuje kategorię.`);
        break;
      }
      case 'end_game': {
        if (s.phase === 'lobby' || s.phase === 'gameover') return 'Gra nie trwa.';
        return this.finish();
      }
      case 'adjust': {
        const delta = parseInt(msg.delta, 10);
        if (!Number.isFinite(delta) || delta === 0) return 'Podaj kwotę, np. 500 albo -500.';
        if (msg.target === 'pool') {
          s.pool = Math.max(0, s.pool + delta);
          this.say(`Prowadzący zmienił pulę o ${fmt(delta)}.`);
        } else if (TEAM_IDS.includes(msg.target)) {
          const t = s.teams[msg.target];
          t.money = Math.max(0, t.money + delta);
          if (t.money > 0) t.out = false;
          this.say(`Prowadzący zmienił kasę drużyny ${teamName(msg.target)} o ${fmt(delta)}.`);
        } else return 'Nieprawidłowy cel.';
        break;
      }
      case 'set_mode': {
        if (!['voice', 'text'].includes(msg.mode)) return 'Nieznany tryb.';
        if (['bidding', 'question'].includes(s.phase)) return 'Tryb zmienisz po zakończeniu rundy.';
        s.mode = msg.mode;
        this.say(msg.mode === 'voice' ? 'Tryb gry: głosowy 🎙️' : 'Tryb gry: tekstowy ⌨️');
        break;
      }
      case 'voice_split':
      case 'voice_join': {
        if (s.mode !== 'voice') return 'Przenoszenie działa tylko w trybie głosowym.';
        this.moveVoice(msg.action === 'voice_split' ? 'split' : 'join').then((err) => {
          if (err) for (const ws of this.sockets)
            if (ws.userId === s.hostId && ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: err }));
        });
        return null;
      }
      case 'release_host':
        s.hostId = null;
        this.say('Gra nie ma prowadzącego.');
        break;
      default:
        return 'Nieznana akcja prowadzącego.';
    }
    this.changed();
    return null;
  }

  // ---------- licytacja i timer ----------

  armBidTimer() {
    this.clearTimer();
    const ms = Math.max(0, this.state.bidding.endsAt - Date.now());
    this.timer = setTimeout(() => this.closeBidding(), ms);
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  closeBidding() {
    const s = this.state;
    this.clearTimer();
    if (s.phase !== 'bidding') return;
    // Wszystkie zalicytowane kwoty idą do puli – także drużyn, które przegrały licytację.
    for (const id of TEAM_IDS) {
      const t = s.teams[id];
      t.money -= t.bid;
      s.pool += t.bid;
    }
    s.bidding.endsAt = null;
    if (!s.bidding.highestTeam) {
      s.phase = 'result';
      s.result = 'nobid';
      this.say('Nikt nie licytował – pula przechodzi do następnej rundy.');
    } else {
      s.winnerTeam = s.bidding.highestTeam;
      s.phase = 'question';
      s.questionShown = false;
      this.say(`Licytację wygrywają ${teamName(s.winnerTeam)} za ${fmt(s.bidding.highest)}! Pula: ${fmt(s.pool)}.`);
    }
    this.changed();
  }

  // Drużyny, do których ktoś dołączył (puste drużyny nie grają).
  staffedTeams() {
    const players = Object.values(this.state.players);
    return TEAM_IDS.filter((id) => players.some((p) => p.team === id));
  }

  finish() {
    const s = this.state;
    this.clearTimer();
    s.phase = 'gameover';
    const pool = this.staffedTeams();
    const best = (pool.length ? pool : TEAM_IDS).reduce((a, b) => (s.teams[b].money > s.teams[a].money ? b : a));
    s.winnerTeam = best;
    this.say(`Koniec gry! Wygrywają ${teamName(best)} z kwotą ${fmt(s.teams[best].money)}!`);
    this.changed();
    return null;
  }
}
