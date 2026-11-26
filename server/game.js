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
  spinSec: Number(process.env.SPIN_SEC) || 10, // jak długo kręci się koło przy losowaniu kategorii
  hintCost: 500,         // cena podpowiedzi 50/50 (trafia do puli); 0 = za darmo
  finalQuestions: 7,     // ile pytań ma finał z Mistrzami
  duelFee: 500,          // 1 na 1: tyle wpłaca każda drużyna do puli…
  duelBonus: 1000,       // …a tyle dokłada prowadzący
  // Czarna skrzynka: losowana nagroda dla drużyny, która ją wylicytuje.
  // money = dopisywana kwota, pool = drużyna zgarnia całą pulę. Dopisuj własne!
  blackBox: [
    { text: '10 000 zł!', money: 10000 },
    { text: '5 000 zł', money: 5000 },
    { text: 'Sztabka złota – 7 500 zł', money: 7500 },
    { text: '2 000 zł', money: 2000 },
    { text: 'Cała pula!', pool: true },
    { text: 'Ogórek kiszony 🥒', money: 0 },
    { text: 'Pusty karton 📦', money: 0 },
  ],
};

export const BOX = 'Czarna skrzynka';
export const DUEL = '1 na 1';

const LETTERS = ['A', 'B', 'C', 'D'];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export const TEAMS = [
  { id: 'blue', name: 'Niebiescy', color: '#3b82f6' },
  { id: 'green', name: 'Zieloni', color: '#22c55e' },
  { id: 'yellow', name: 'Żółci', color: '#eab308' },
  { id: 'champs', name: 'Mistrzowie', color: '#a855f7' },
];
const STAGE1_TEAMS = ['blue', 'green', 'yellow'];

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
    answerMode: 'abcd', // 'abcd' = pytanie z 4 odpowiedziami, 'open' = bez odpowiedzi
    options: null, // tryb ABCD: 4 odpowiedzi w wylosowanej kolejności
    correctIndex: null,
    removed: [], // odpowiedzi usunięte podpowiedzią 50/50
    hintUsed: false,
    stage: 1, // 1 = trzy drużyny, 2 = finał pretendenta z Mistrzami
    challenger: null, // drużyna, która wygrała etap 1
    finalRound: 0, // numer pytania w finale
    usedSpecials: [], // wykorzystane w finale: czarna skrzynka / 1 na 1
    special: null, // bieżąca runda: null | 'box' | 'duel'
    duel: null, // { players: { team: userId }, locked: [team], pending: { team, text, by } }
    boxPrize: null,
    message: 'Czekamy na prowadzącego.',
  };
}

export class Game {
  constructor(id, questions, { saved, hostIds = [], onChange, voice, champions } = {}) {
    this.id = id;
    this.questions = questions;
    this.hostIds = hostIds;
    this.onChange = onChange ?? (() => {});
    this.voice = voice ?? null; // bot przenoszący graczy między kanałami głosowymi
    // Mistrzowie zapamiętani między grami: { ids: [], names: [] } + zapis do pliku
    this.champions = champions ?? { get: () => ({ ids: [], names: [] }), set: () => {} };
    this.voiceBusy = false;
    this.sockets = new Set(); // każdy socket ma pole .userId
    this.timer = null;
    // Czaty: 'general' (wszyscy) i osobny dla każdej drużyny (widzą tylko jej gracze).
    // Nie zapisujemy ich do pliku.
    this.chats = { general: [], ...Object.fromEntries(TEAM_IDS.map((id) => [id, []])) };
    this.chatRate = new Map(); // userId -> czasy ostatnich wiadomości (ochrona przed spamem)
    this.state = saved ?? freshState();
    this.state.mode ??= 'voice'; // stare zapisy gry nie miały trybu
    this.state.answerMode ??= 'abcd';
    this.state.removed ??= [];
    this.state.stage ??= 1;
    this.state.usedSpecials ??= [];
    this.spinTimer = null;
    // Restart serwera w trakcie kręcenia kołem – dokończ ogłoszenie kategorii.
    if (this.state.spin && this.state.spin.endsAt > Date.now()) this.armSpin();

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
    // Mistrzowie z poprzedniej gry same trafiają do drużyny Mistrzów (przed startem gry).
    const np = this.state.players[user.id];
    if (!np.team && ['lobby', 'gameover'].includes(this.state.phase) && this.champions.get().ids.includes(user.id)) {
      np.team = 'champs';
    }
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
    if (text.startsWith('!') && s.phase === 'duel' && p?.team && !isHost) {
      return this.duelAnswer(userId, text.slice(1).trim());
    }
    if (text.startsWith('!') && (s.mode === 'text' || s.answerMode === 'abcd') && p?.team && !isHost) {
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
    if (!text) return s.answerMode === 'abcd' ? 'Wpisz literę po wykrzykniku, np. !B' : 'Wpisz odpowiedź po wykrzykniku, np. !Wisła';
    if (s.answerMode === 'abcd' && s.options) {
      // litera A–D albo dokładny tekst odpowiedzi
      const i = this.parseChoice(text);
      if (i < 0) return 'Wybierz jedną z odpowiedzi: A, B, C albo D (np. !B).';
      if (s.removed.includes(i)) return 'Ta odpowiedź została odrzucona przez podpowiedź.';
      s.officialAnswer = { text: `${LETTERS[i]}) ${s.options[i]}`, index: i, by: p.name };
    } else {
      s.officialAnswer = { text: text.slice(0, 150), by: p.name };
    }
    this.addChat({ name: p.name, team: p.team, answer: true, text: s.officialAnswer.text });
    this.changed();
    return null;
  }

  // Podpowiedź 50/50: usuwa dwie złe odpowiedzi. Kupuje ją drużyna, która odpowiada
  // (albo prowadzący w jej imieniu, np. gdy lider poprosi głosowo). Cena trafia do puli.
  useHint(userId) {
    const s = this.state;
    const isHost = userId === s.hostId;
    if (s.answerMode !== 'abcd' || !s.options) return 'Podpowiedź działa tylko przy pytaniach z odpowiedziami ABCD.';
    if (s.phase !== 'question' || !s.questionShown) return 'Teraz nie ma pytania.';
    if (!isHost && s.players[userId]?.team !== s.winnerTeam) return 'Podpowiedź może wziąć tylko drużyna, która odpowiada.';
    if (s.hintUsed) return 'Podpowiedź została już wykorzystana.';
    if (s.officialAnswer) return 'Odpowiedź już padła.';
    const team = s.teams[s.winnerTeam];
    if (team.money < CONFIG.hintCost) return `Drużyny nie stać na podpowiedź (${fmt(CONFIG.hintCost)}).`;
    team.money -= CONFIG.hintCost;
    s.pool += CONFIG.hintCost;
    const wrong = shuffle([0, 1, 2, 3].filter((i) => i !== s.correctIndex));
    s.removed = wrong.slice(0, 2);
    s.hintUsed = true;
    this.say(
      CONFIG.hintCost
        ? `💡 ${teamName(s.winnerTeam)} kupują podpowiedź za ${fmt(CONFIG.hintCost)} – odpadają ${s.removed.map((i) => LETTERS[i]).sort().join(' i ')}.`
        : `💡 Podpowiedź – odpadają ${s.removed.map((i) => LETTERS[i]).sort().join(' i ')}.`,
    );
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
        if (p.team && p.id !== s.hostId && this.voice.channels[p.team]) targets.push([p, this.voice.channels[p.team]]);
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
      answerMode: s.answerMode,
      options: s.options && (isHost || s.questionShown) ? s.options : null,
      correctIndex: isHost || s.phase === 'result' ? s.correctIndex : null,
      removed: s.removed,
      hintUsed: s.hintUsed,
      stage: s.stage,
      challenger: s.challenger,
      finalRound: s.finalRound,
      boardTeams: this.boardTeams(),
      special: s.special,
      duel: s.duel
        ? {
            players: Object.fromEntries(
              Object.entries(s.duel.players).map(([t, id]) => [t, { id, name: s.players[id]?.name ?? '?' }]),
            ),
            locked: s.duel.locked,
            pending: s.duel.pending,
          }
        : null,
      boxPrize: s.boxPrize,
      championsNames: this.champions.get().names,
      spin: s.spin ?? null,
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
      case 'pick': {
        // kliknięcie odpowiedzi A–D
        const p = s.players[userId];
        if (!p?.team || userId === s.hostId) return 'Odpowiada drużyna, nie prowadzący.';
        if (s.answerMode !== 'abcd') return 'To pytanie jest bez odpowiedzi do wyboru.';
        if (s.phase === 'duel') return this.duelAnswer(userId, LETTERS[msg.index] ?? '');
        return this.officialAnswer(userId, LETTERS[msg.index] ?? '');
      }
      case 'duel_join':
        return this.duelJoin(userId);
      case 'hint':
        return this.useHint(userId);
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
    if (['bidding', 'question', 'duel', 'box'].includes(s.phase)) return 'Drużynę można zmienić dopiero po tej rundzie.';
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
        const { hostId, players, mode, answerMode } = s;
        this.clearTimer();
        this.state = freshState();
        this.state.hostId = hostId;
        this.state.players = players;
        this.state.mode = mode;
        this.state.answerMode = answerMode;
        // Zapamiętani Mistrzowie -> drużyna Mistrzów; byli Mistrzowie bez tytułu -> bez drużyny.
        const champIds = this.champions.get().ids;
        if (champIds.length) {
          for (const p of Object.values(players)) {
            if (champIds.includes(p.id) && p.id !== hostId) p.team = 'champs';
            else if (p.team === 'champs') p.team = null;
          }
        }
        this.state.phase = 'category';
        this.state.round = 1;
        this.say('Etap 1, runda 1 – prowadzący losuje kategorię.');
        for (const ws of this.sockets) this.sendHistory(ws);
        break;
      }
      case 'draw_category': {
        const err = need('category');
        if (err) return err;
        if (this.spinning()) return 'Koło jeszcze się kręci.';
        // Poprzednio wylosowane, ale niezagrane pytanie wraca do puli.
        if (s.question) s.usedQuestions = s.usedQuestions.filter((id) => id !== s.question.id);
        // …a niezagrane pole specjalne wraca na koło.
        if (s.special) s.usedSpecials = s.usedSpecials.filter((x) => x !== (s.special === 'box' ? BOX : DUEL));
        const free = this.questions.filter(
          (q) => !s.usedQuestions.includes(q.id) && (s.answerMode !== 'abcd' || q.bledne?.length >= 3),
        );
        if (!free.length) return 'Skończyły się pytania – dopisz nowe do questions.json.';
        const cats = [...new Set(free.map((q) => q.kategoria))]; // kategorie z niewykorzystanymi pytaniami
        // Koło jak w telewizji: zawsze wszystkie kategorie, w stałej kolejności (z pliku pytań).
        const allCats = [...new Set(this.questions.map((q) => q.kategoria))];
        // W finale na kole są też pola specjalne (każde najwyżej raz na finał).
        const specials = s.stage === 2 ? [BOX, DUEL].filter((x) => !s.usedSpecials.includes(x)) : [];
        const wheel = [...allCats];
        specials.forEach((sp, i) => {
          // pola specjalne w stałych miejscach koła (ok. 1/3 i 2/3 obwodu)
          wheel.splice(Math.round((wheel.length * (i + 1)) / (specials.length + 1)), 0, sp);
        });
        // Losowanie: pole specjalne z szansą ok. 1/8 na każde (jak wcześniej), inaczej kategoria z pytaniami.
        let picked = null;
        for (const sp of shuffle(specials)) if (!picked && Math.random() < 1 / 8) picked = sp;
        // Gwarancja: pod koniec finału koło musi trafić w niewykorzystane pole specjalne.
        const left = CONFIG.finalQuestions - s.finalRound + 1;
        if (specials.length && specials.length >= left) picked = specials[Math.floor(Math.random() * specials.length)];
        if (!picked) picked = cats[Math.floor(Math.random() * cats.length)];
        const index = wheel.indexOf(picked);

        s.special = picked === BOX ? 'box' : picked === DUEL ? 'duel' : null;
        s.duel = null;
        s.boxPrize = null;
        if (s.special) s.usedSpecials.push(picked);
        if (s.special === 'box') {
          s.category = BOX;
          s.question = null; // w skrzynce nie ma pytania
          s.options = null;
          s.correctIndex = null;
        } else {
          // 1 na 1: pytanie z losowej kategorii; zwykła runda: z wylosowanej
          const cat = s.special === 'duel' ? cats[Math.floor(Math.random() * cats.length)] : picked;
          const inCat = free.filter((q) => q.kategoria === cat);
          const q = inCat[Math.floor(Math.random() * inCat.length)];
          s.usedQuestions.push(q.id);
          s.category = s.special === 'duel' ? `${DUEL} · ${cat}` : cat;
          s.question = q;
          this.prepareOptions();
        }
        s.questionShown = false;
        s.spin = {
          id: Date.now(),
          cats: wheel,
          index,
          endsAt: Date.now() + CONFIG.spinSec * 1000,
        };
        this.say('Losowanie kategorii… 🎡');
        this.armSpin();
        break;
      }
      case 'start_bidding': {
        const err = need('category');
        if (err) return err;
        if (!s.category) return 'Najpierw wylosuj kategorię.';
        if (this.spinning()) return 'Poczekaj, aż koło się zatrzyma.';
        const staffed = this.activeTeams();
        if (staffed.length < 2) return 'Do gry potrzeba co najmniej dwóch drużyn z graczami.';
        if (s.special === 'duel') return this.startDuel();
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
        this.say(
          s.special === 'box'
            ? `Licytujemy CZARNĄ SKRZYNKĘ! W środku może być fortuna… albo ogórek. Wpisowe ${fmt(CONFIG.entryFee)} poszło do puli.`
            : `Licytacja otwarta! Wpisowe ${fmt(CONFIG.entryFee)} poszło do puli. Wpiszcie kwotę na czacie.`,
        );
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
        const err = need('question', 'duel');
        if (err) return err;
        if (s.phase === 'duel' && Object.keys(s.duel.players).length < this.activeTeams().length)
          return 'Każda drużyna musi najpierw wybrać gracza do pojedynku.';
        if (s.questionShown) return 'Pytanie jest już pokazane.';
        s.questionShown = true;
        if (s.phase === 'duel') {
          s.answerEndsAt = Date.now() + CONFIG.answerTimerSec * 1000;
          this.sfx('time');
          this.say(
            s.answerMode === 'abcd'
              ? '⚔️ Pojedynek! Kto pierwszy kliknie dobrą odpowiedź, zgarnia pulę. Błąd = koniec szans.'
              : '⚔️ Pojedynek! Odpowiedź wpiszcie z wykrzyknikiem (np. !Wisła) – liczy się pierwsza dobra.',
          );
          break;
        }
        s.officialAnswer = null;
        this.sfx('time');
        s.answerEndsAt = Date.now() + CONFIG.answerTimerSec * 1000;
        const who = `Pytanie dla drużyny ${teamName(s.winnerTeam)}!`;
        if (s.answerMode === 'abcd') {
          this.say(
            s.mode === 'text'
              ? `${who} Naradźcie się na czacie drużyny i kliknijcie odpowiedź (albo wpiszcie np. !B).`
              : `${who} Lider podaje odpowiedź albo klika ją na ekranie.`,
          );
        } else {
          this.say(
            s.mode === 'text'
              ? `${who} Naradźcie się na czacie drużyny i wpiszcie odpowiedź z wykrzyknikiem, np. !Wisła`
              : who,
          );
        }
        break;
      }
      case 'good':
      case 'bad': {
        if (s.phase === 'duel') return this.judgeDuel(msg.action === 'good');
        const err = need('question');
        if (err) return err;
        if (!s.questionShown) return 'Najpierw pokaż pytanie.';
        const w = teamName(s.winnerTeam);
        if (msg.action === 'good') {
          this.sfx(Math.random() < 0.5 ? 'good1' : 'good2');
          s.teams[s.winnerTeam].money += s.pool;
          this.say(`Dobra odpowiedź! ${w} zgarniają ${fmt(s.pool)}!`);
          s.pool = 0;
          s.result = 'good';
        } else {
          this.sfx('fail');
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
        const able = this.activeTeams().filter((id) => s.teams[id].money >= CONFIG.entryFee);
        if (s.stage === 2 && s.finalRound >= CONFIG.finalQuestions) return this.finish();
        if (able.length < 2) return s.stage === 1 ? this.startFinal(true) : this.finish();
        s.round += 1;
        if (s.stage === 2) s.finalRound += 1;
        s.special = null;
        s.duel = null;
        s.boxPrize = null;
        s.phase = 'category';
        s.category = null;
        s.question = null;
        s.questionShown = false;
        s.spin = null;
        s.options = null;
        s.correctIndex = null;
        s.removed = [];
        s.hintUsed = false;
        s.bidding = null;
        s.log = [];
        s.winnerTeam = null;
        s.result = null;
        s.officialAnswer = null;
        for (const id of TEAM_IDS) s.teams[id].bid = 0;
        this.say(
          s.stage === 2
            ? `Finał – pytanie ${s.finalRound} z ${CONFIG.finalQuestions}. Prowadzący losuje kategorię.`
            : `Etap 1, runda ${s.round} – prowadzący losuje kategorię.`,
        );
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
      case 'start_final': {
        if (s.stage !== 1) return 'Finał już trwa.';
        if (!(s.phase === 'result' || (s.phase === 'category' && !s.category))) return 'Finał zaczniesz między rundami.';
        return this.startFinal(false);
      }
      case 'open_box':
        return this.openBox();
      case 'duel_reset': {
        if (s.phase !== 'duel' || s.questionShown) return 'Teraz nie można zmienić graczy pojedynku.';
        s.duel.players = {};
        this.say('Prowadzący zresetował wybór graczy do pojedynku – zgłoście się jeszcze raz.');
        break;
      }
      case 'assign': {
        // prowadzący przypisuje gracza do drużyny (np. ustala Mistrzów na starcie)
        const p = s.players[msg.userId];
        if (!p) return 'Nie ma takiego gracza.';
        if (msg.team !== null && !TEAM_IDS.includes(msg.team)) return 'Nie ma takiej drużyny.';
        if (p.id === s.hostId) return 'Prowadzący nie gra w drużynie.';
        if (['bidding', 'question', 'duel', 'box'].includes(s.phase)) return 'Drużyny zmienisz po zakończeniu rundy.';
        p.team = msg.team;
        for (const ws of this.sockets) if (ws.userId === p.id) this.sendHistory(ws);
        break;
      }
      case 'set_answer_mode': {
        if (!['abcd', 'open'].includes(msg.answerMode)) return 'Nieznany rodzaj pytań.';
        if (['bidding', 'question'].includes(s.phase)) return 'Rodzaj pytań zmienisz po zakończeniu rundy.';
        s.answerMode = msg.answerMode;
        this.prepareOptions();
        this.say(msg.answerMode === 'abcd' ? 'Pytania z odpowiedziami ABCD 🅰️' : 'Pytania bez odpowiedzi do wyboru ✍️');
        break;
      }
      case 'hint':
        return this.useHint(s.hostId);
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
    this.sfx('licytacjaend');
    // Wszystkie zalicytowane kwoty idą do puli – także drużyn, które przegrały licytację.
    for (const id of TEAM_IDS) {
      const t = s.teams[id];
      t.money -= t.bid;
      s.pool += t.bid;
    }
    s.bidding.endsAt = null;
    if (s.special === 'box' && s.bidding.highestTeam) {
      s.winnerTeam = s.bidding.highestTeam;
      s.phase = 'box';
      this.say(`Czarną skrzynkę wylicytowali ${teamName(s.winnerTeam)} za ${fmt(s.bidding.highest)}! Prowadzący otwiera skrzynkę…`);
      this.changed();
      return;
    }
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

  // Tryb ABCD: poprawna + 3 błędne odpowiedzi w losowej kolejności.
  prepareOptions() {
    const s = this.state;
    s.removed = [];
    s.hintUsed = false;
    const q = s.question;
    if (s.answerMode !== 'abcd' || !q || !(q.bledne?.length >= 3)) {
      s.options = null;
      s.correctIndex = null;
      return;
    }
    s.options = shuffle([q.odpowiedz, ...q.bledne.slice(0, 3)]);
    s.correctIndex = s.options.indexOf(q.odpowiedz);
  }

  // ---------- koło i dźwięki ----------

  spinning() {
    return !!this.state.spin && this.state.spin.endsAt > Date.now();
  }

  // Po zatrzymaniu koła ogłaszamy kategorię i odblokowujemy licytację.
  armSpin() {
    clearTimeout(this.spinTimer);
    const spin = this.state.spin;
    this.spinTimer = setTimeout(() => {
      if (this.state.spin?.id !== spin.id) return;
      const st = this.state;
      if (st.special === 'box') this.say('⬛ CZARNA SKRZYNKA! Licytujemy skrzynkę w ciemno.');
      else if (st.special === 'duel')
        this.say(`⚔️ 1 NA 1! Bez licytacji: każda drużyna daje ${fmt(CONFIG.duelFee)}, prowadzący dokłada ${fmt(CONFIG.duelBonus)}. Pytanie z kategorii: ${st.question.kategoria}.`);
      else this.say(`Kategoria: ${st.category}`);
      this.changed();
    }, Math.max(0, spin.endsAt - Date.now()));
  }

  // Dźwięk u wszystkich graczy naraz (pliki w client/public/sounds).
  sfx(name) {
    const data = JSON.stringify({ type: 'sfx', name });
    for (const ws of this.sockets) if (ws.readyState === 1) ws.send(data);
  }

  // Drużyny, do których ktoś dołączył (puste drużyny nie grają).
  staffedTeams(ids = TEAM_IDS) {
    const players = Object.values(this.state.players);
    return ids.filter((id) => players.some((p) => p.team === id));
  }

  // Drużyny grające w bieżącym etapie.
  activeTeams() {
    const s = this.state;
    if (s.stage === 2) return [s.challenger, 'champs'];
    return this.staffedTeams(STAGE1_TEAMS);
  }

  // Drużyny pokazywane na tablicy.
  boardTeams() {
    return this.state.stage === 2 ? [this.state.challenger, 'champs'] : STAGE1_TEAMS;
  }

  parseChoice(text) {
    const s = this.state;
    if (!s.options) return -1;
    const t = String(text).trim().replace(/[).:]$/, '').toUpperCase();
    const i = LETTERS.indexOf(t);
    if (i >= 0) return i;
    return s.options.findIndex((o) => o.toUpperCase() === String(text).trim().toUpperCase());
  }

  // ---------- finał z Mistrzami ----------

  startFinal(auto) {
    const s = this.state;
    this.clearTimer();
    const teams = this.staffedTeams(STAGE1_TEAMS);
    if (!teams.length) return 'Brak drużyn w etapie 1.';
    const best = Math.max(...teams.map((id) => s.teams[id].money));
    const leaders = teams.filter((id) => s.teams[id].money === best);
    if (leaders.length > 1) {
      const msg = `Remis w etapie 1 (${leaders.map(teamName).join(', ')}) – rozstrzygnijcie dogrywką albo popraw kasę i kliknij Finał jeszcze raz.`;
      if (auto) {
        s.phase = 'result';
        this.say(msg);
        this.changed();
        return null;
      }
      return msg;
    }
    const challenger = leaders[0];
    if (!this.staffedTeams(['champs']).length) {
      // Nie ma Mistrzów – zwycięzca etapu 1 od razu zostaje Mistrzami.
      this.say(`Nie ma Mistrzów w grze – ${teamName(challenger)} wygrywają etap 1 i zostają nowymi Mistrzami! 🏆`);
      return this.finish(challenger);
    }
    s.stage = 2;
    s.challenger = challenger;
    s.teams.champs.money = s.teams[challenger].money; // Mistrzowie dostają tyle samo
    for (const id of TEAM_IDS) {
      s.teams[id].bid = 0;
      s.teams[id].out = ![challenger, 'champs'].includes(id);
    }
    s.pool = 0;
    s.finalRound = 1;
    s.usedSpecials = [];
    s.round += 1;
    Object.assign(s, {
      phase: 'category', category: null, question: null, questionShown: false, spin: null,
      options: null, correctIndex: null, removed: [], hintUsed: false, bidding: null, log: [],
      winnerTeam: null, result: null, officialAnswer: null, special: null, duel: null, boxPrize: null,
    });
    this.say(
      `🏆 FINAŁ! ${teamName(challenger)} (${fmt(s.teams[challenger].money)}) kontra Mistrzowie (${fmt(s.teams.champs.money)}). ` +
        `${CONFIG.finalQuestions} pytań, na kole czekają czarna skrzynka i 1 na 1.`,
    );
    this.changed();
    return null;
  }

  openBox() {
    const s = this.state;
    if (s.phase !== 'box') return 'Teraz nie ma skrzynki do otwarcia.';
    const prize = CONFIG.blackBox[Math.floor(Math.random() * CONFIG.blackBox.length)];
    const team = s.teams[s.winnerTeam];
    let gain = 0;
    if (prize.pool) {
      gain = s.pool;
      s.pool = 0;
    } else {
      gain = prize.money ?? 0;
    }
    team.money += gain;
    s.boxPrize = prize.text;
    s.result = 'box';
    s.phase = 'result';
    this.sfx(gain > 0 ? (Math.random() < 0.5 ? 'good1' : 'good2') : 'fail');
    this.say(
      gain > 0
        ? `⬛ W skrzynce: ${prize.text} ${teamName(s.winnerTeam)} zyskują ${fmt(gain)}!`
        : `⬛ W skrzynce: ${prize.text} Pech! Pula ${fmt(s.pool)} przechodzi dalej.`,
    );
    this.changed();
    return null;
  }

  startDuel() {
    const s = this.state;
    for (const id of TEAM_IDS) {
      s.teams[id].bid = 0;
      s.teams[id].out = !this.activeTeams().includes(id);
    }
    let paid = 0;
    for (const id of this.activeTeams()) {
      const fee = Math.min(CONFIG.duelFee, s.teams[id].money);
      s.teams[id].money -= fee;
      paid += fee;
    }
    s.pool += paid + CONFIG.duelBonus;
    s.duel = { players: {}, locked: [], pending: null };
    s.phase = 'duel';
    s.questionShown = false;
    this.say(`⚔️ 1 na 1! Pula: ${fmt(s.pool)}. Każda drużyna wybiera jednego gracza – kliknijcie „Gram!”.`);
    this.changed();
    return null;
  }

  duelJoin(userId) {
    const s = this.state;
    const p = s.players[userId];
    if (s.phase !== 'duel' || s.questionShown) return 'Teraz nie można zgłosić się do pojedynku.';
    if (!p?.team || !this.activeTeams().includes(p.team) || userId === s.hostId) return 'Nie grasz w drużynie biorącej udział w pojedynku.';
    if (s.duel.players[p.team]) return 'Wasza drużyna ma już gracza w pojedynku.';
    s.duel.players[p.team] = userId;
    this.say(`${teamName(p.team)}: do pojedynku staje ${p.name}!`);
    this.changed();
    return null;
  }

  duelAnswer(userId, text) {
    const s = this.state;
    const p = s.players[userId];
    if (s.phase !== 'duel' || !s.questionShown) return 'Pytanie pojedynku jeszcze nie padło.';
    if (s.duel.players[p?.team] !== userId) return 'Odpowiadają tylko gracze wybrani do pojedynku.';
    if (s.duel.locked.includes(p.team)) return 'Twoja odpowiedź była zła – teraz kolej rywala.';
    if (s.duel.pending) return 'Prowadzący ocenia odpowiedź rywala.';
    if (!text) return s.answerMode === 'abcd' ? 'Kliknij odpowiedź albo wpisz np. !B' : 'Wpisz odpowiedź po wykrzykniku.';
    if (s.answerMode === 'abcd' && s.options) {
      const i = this.parseChoice(text);
      if (i < 0) return 'Wybierz A, B, C albo D.';
      this.addChat({ name: p.name, team: p.team, answer: true, text: `${LETTERS[i]}) ${s.options[i]}` });
      if (i === s.correctIndex) return this.duelWin(p.team);
      s.duel.locked.push(p.team);
      this.say(`Źle! ${p.name} odpada – ${LETTERS[i]} to nie ta odpowiedź.`);
      if (s.duel.locked.length >= this.activeTeams().length) return this.duelNoWin();
      this.changed();
      return null;
    }
    s.duel.pending = { team: p.team, text: text.slice(0, 150), by: p.name };
    this.addChat({ name: p.name, team: p.team, answer: true, text: s.duel.pending.text });
    this.changed();
    return null;
  }

  judgeDuel(good) {
    const s = this.state;
    if (!s.duel?.pending) return 'Nie ma odpowiedzi do oceny.';
    const team = s.duel.pending.team;
    s.duel.pending = null;
    if (good) return this.duelWin(team);
    s.duel.locked.push(team);
    this.say(`Źle! ${teamName(team)} tracą szansę w pojedynku.`);
    if (s.duel.locked.length >= this.activeTeams().length) return this.duelNoWin();
    this.changed();
    return null;
  }

  duelWin(team) {
    const s = this.state;
    s.teams[team].money += s.pool;
    this.sfx(Math.random() < 0.5 ? 'good1' : 'good2');
    this.say(`Dobrze! Pojedynek wygrywają ${teamName(team)} i zgarniają ${fmt(s.pool)}!`);
    s.pool = 0;
    s.winnerTeam = team;
    s.result = 'good';
    s.answerEndsAt = null;
    s.phase = 'result';
    this.changed();
    return null;
  }

  duelNoWin() {
    const s = this.state;
    this.sfx('fail');
    this.say(`Nikt nie trafił! Pula ${fmt(s.pool)} przechodzi dalej.`);
    s.result = 'bad';
    s.answerEndsAt = null;
    s.phase = 'result';
    this.changed();
    return null;
  }

  // forcedWinner: gdy etap 1 kończy się bez Mistrzów
  finish(forcedWinner) {
    const s = this.state;
    this.clearTimer();
    s.phase = 'gameover';
    const pool = this.activeTeams().filter(Boolean);
    let best = forcedWinner;
    if (!best) {
      const list = pool.length ? pool : TEAM_IDS;
      best = list.reduce((a, b) => (s.teams[b].money > s.teams[a].money ? b : a));
      // remis w finale: Mistrzowie bronią tytułu
      if (s.stage === 2 && s.teams.champs.money === s.teams[s.challenger].money) best = 'champs';
    }
    s.winnerTeam = best;
    // Zapamiętaj nowych Mistrzów (gracze zwycięskiej drużyny).
    const winners = Object.values(s.players).filter((p) => p.team === best);
    if (winners.length && (s.stage === 2 || forcedWinner)) {
      this.champions.set({ ids: winners.map((p) => p.id), names: winners.map((p) => p.name) });
    }
    if (s.stage === 2) {
      this.say(
        best === 'champs'
          ? `🏆 Koniec gry! Mistrzowie obronili tytuł z kwotą ${fmt(s.teams.champs.money)}!`
          : `🏆 Koniec gry! ${teamName(best)} pokonali Mistrzów (${fmt(s.teams[best].money)}) i zostają nowymi Mistrzami!`,
      );
    } else if (!forcedWinner) {
      this.say(`Koniec gry! Wygrywają ${teamName(best)} z kwotą ${fmt(s.teams[best].money)}!`);
    }
    this.changed();
    return null;
  }
}
