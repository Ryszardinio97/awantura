# Awantura o kasę – aktywność na Discordzie

Gra uruchamiana w oknie aktywności na kanale głosowym. Gracze licytują, wpisując kwotę.
Prowadzący ma własny panel: losuje kategorię, otwiera i zamyka licytację, pokazuje pytanie
i ocenia odpowiedź.

## Jak to działa

```
Discord (okno aktywności) ──► tunel Cloudflare ──► Twój komputer
                                                   ├─ strona gry (client/)
                                                   └─ serwer gry (server/) – trzyma kasę, pulę, licytację
```

Serwer jest jedynym „sędzią”: sprawdza każdą ofertę i rozsyła wszystkim aktualny stan.
Stan zapisuje się w `data/games.json`, więc restart serwera w trakcie gry nie zeruje kasy.

## Zasady (domyślne, do zmiany w `server/game.js` → `CONFIG`)

- 3 drużyny: Niebiescy, Zieloni, Żółci. Każda zaczyna z **10 000 zł**. Drużyna bez graczy nie gra.
- Na początku rundy każda drużyna płaci **200 zł wpisowego** do puli.
- Licytacja odbywa się **na czacie gry**. Gdy licytacja jest otwarta, wiadomość zawierająca
  samą kwotę (np. `500`, `1 000`, `1000 zł`) jest ofertą. Musi być wielokrotnością 100 zł
  i przebić najwyższą ofertę. `vabank` = cała kasa drużyny.
  Każda inna wiadomość to zwykły czat. Odrzucona oferta nie trafia na czat,
  a wysyłający dostaje komunikat, dlaczego.
- **10 s bez przebicia** zamyka licytację (na pierwszą ofertę jest 20 s). Prowadzący może zamknąć wcześniej.
- Wszystkie zalicytowane kwoty idą do puli, także drużyn, które przegrały licytację.
- Zwycięzca licytacji odpowiada. Prowadzący klika **Dobrze**, a drużyna zgarnia pulę,
  albo **Źle**, a pula przechodzi do następnej rundy.
- Gra kończy się, gdy zostanie mniej niż dwie drużyny stać na wpisowe, albo gdy prowadzący kliknie „Zakończ grę”.

Każdy z drużyny może licytować (umowa: licytuje lider). Na czacie widać, kto podbił.

## Uruchamianie jedną komendą

`npm run discord` odpala naraz serwer, stronę i tunel. Adres tunelu znajdziesz w linijkach
`[tunel]` (ten z `trycloudflare.com`).

## Tryby gry

Prowadzący wybiera tryb w swoim panelu (przyciski **🎙️ Głosowy** / **⌨️ Tekstowy**). Tryb da się zmienić między rundami.

**Czat ma dwie zakładki:** 💬 *Ogólny* (widzą wszyscy) i 👥 *Moja drużyna* (widzą tylko gracze tej drużyny, prowadzący też nie).
Licytuje się tylko na czacie ogólnym. Gdy zaczyna się licytacja, gra sama przełącza na *Ogólny*.
Przy nowych wiadomościach w drugiej zakładce pojawia się czerwony licznik.

### 🎙️ Tryb głosowy
- Wszyscy siedzą na ogólnym kanale głosowym i licytują na czacie gry.
- Po pokazaniu pytania prowadzący klika **🔀 Narada drużyn**, a bot przenosi każdego gracza na kanał głosowy jego drużyny.
- **↩️ Wszyscy wracają** przenosi wszystkich (także prowadzącego) z powrotem na kanał ogólny. Lider odpowiada głosem, prowadzący klika Dobrze/Źle.
- **Ważne:** aktywność odpalaj na **kanale tekstowym** (np. `#awantura`), a nie na głosowym.
  Aktywność odpalona na kanale głosowym wyrzuca gracza, gdy ten zmieni kanał.

### ⌨️ Tryb tekstowy
- Nikt nie musi być na voice.
- Po pokazaniu pytania drużyna, która wygrała licytację, sama przełącza się na zakładkę *Moja drużyna* i tam się naradza.
- Odpowiedź wpisuje się z wykrzyknikiem, np. `!Wisła`. Liczy się pierwsza taka odpowiedź. Widzą ją wszyscy, a prowadzący ma ją w panelu i klika Dobrze/Źle.

## Bot do przenoszenia drużyn (tylko tryb głosowy)

1. Na serwerze Discorda utwórz 4 kanały głosowe: ogólny i po jednym dla każdej drużyny.
2. Developer Portal → Twoja aplikacja → **Bot** → **Reset Token**. Skopiuj token do `.env` jako `DISCORD_BOT_TOKEN`.
   **Token jest tak samo tajny jak sekret, nikomu go nie pokazuj.**
3. Developer Portal → **Installation**: w *Guild Install* dodaj zakres (scope) `bot` i uprawnienie **Move Members**.
   Potem otwórz link instalacyjny i jeszcze raz dodaj aplikację na swój serwer, żeby bot dostał uprawnienie.
4. W Discordzie włącz Tryb dewelopera (Ustawienia → Zaawansowane), potem PPM → *Kopiuj ID*:
   - na ikonie serwera → `GUILD_ID`,
   - na kanałach głosowych → `VOICE_MAIN`, `VOICE_BLUE`, `VOICE_GREEN`, `VOICE_YELLOW`.
5. Zrestartuj grę. W terminalu powinno pojawić się `Bot do kanałów głosowych: gotowy.`

Bot przenosi tylko osoby, które w tej chwili są na jakimś kanale głosowym. Pozostałe wypisze na czacie.
Jeśli bot nie przenosi nikogo, sprawdź, czy rola bota ma uprawnienie *Przenoszenie członków* i dostęp do kanałów drużyn.
Discord odtwarza dźwięk przy każdym przeniesieniu. Każdy gracz może go wyłączyć u siebie w Ustawieniach → Powiadomienia → Dźwięki.

## Koło i dźwięki

- **🎲 Losuj kategorię** uruchamia u wszystkich koło, które kręci się 10 s (`CONFIG.spinSec` w `server/game.js`).
  Licytację można zacząć dopiero, gdy koło stanie.
- Dźwięki wrzuć do `client/public/sounds/` (dokładnie te nazwy):

| Plik | Kiedy gra |
|---|---|
| `LOSOWANIE.mp3` | kręcenie kołem |
| `LICYTACJAEND.mp3` | koniec licytacji (przycisk albo koniec czasu) |
| `GOOD1.mp3` / `GOOD2.mp3` | dobra odpowiedź (serwer losuje jeden, wszyscy słyszą ten sam) |
| `TIME.mp3` | pokazanie pytania, czyli czas na odpowiedź |
| `FAIL.mp3` | zła odpowiedź |

Nowy dźwięk przerywa poprzedni (np. GOOD przerywa TIME). Każdy gracz może wyciszyć dźwięki u siebie przyciskiem 🔊 w nagłówku.
Przeglądarka nie pozwala grać dźwięków, zanim ktoś kliknie w okno gry, więc pierwsze kliknięcie je „odblokowuje”.

## Mistrzowie i finał

**Etap 1:** Niebiescy, Zieloni i Żółci grają zwykłe rundy. Mistrzowie czekają.

**Finał:** prowadzący klika **🏆 Finał z Mistrzami** między rundami. Finał zaczyna się też sam, gdy już tylko jedną drużynę z etapu 1 stać na wpisowe.
- Drużyna z największą kasą zostaje pretendentem i wchodzi do finału ze swoją kasą. Mistrzowie dostają tyle samo.
- Przy remisie gra prosi o dogrywkę albo o ręczną poprawkę kwot.
- Finał trwa 7 pytań (`CONFIG.finalQuestions`). Wygrywa drużyna z większą kasą, a przy remisie Mistrzowie bronią tytułu.
- Zwycięzcy zostają nowymi Mistrzami. Gra zapamiętuje ich w `data/champions.json`, więc w następnej grze (także po restarcie) sami trafią do drużyny Mistrzów.
- Gdy w grze nie ma Mistrzów, zwycięzca etapu 1 od razu zostaje Mistrzami.

**Ustalanie Mistrzów ręcznie:** w panelu prowadzącego rozwiń **👥 Drużyny graczy** i ustaw graczom drużynę „Mistrzowie”. Gracze mogą też sami kliknąć „Mistrzowie” przed startem.

**Pola specjalne na kole (tylko w finale, każde raz):**
- **⬛ Czarna skrzynka:** drużyny licytują skrzynkę w ciemno, a prowadzący klika **📦 Otwórz skrzynkę**. Nagrodę losuje gra z listy `CONFIG.blackBox` w `server/game.js` (np. 10 000 zł, cała pula, ogórek kiszony). Listę możesz zmieniać.
- **⚔️ 1 na 1:** bez licytacji. Każda drużyna wpłaca 500 zł, a prowadzący dokłada 1000 zł (`duelFee`, `duelBonus`). Każda drużyna wybiera jednego gracza przyciskiem **Gram!**.
  - W trybie ABCD wygrywa pierwsza poprawna odpowiedź. Kto się pomyli, odpada.
  - W trybie bez odpowiedzi gracze wpisują `!odpowiedź`, a prowadzący ocenia.
  - Gdy obaj się pomylą, pula przechodzi dalej.
- Gdy zostaje tyle pytań, ile niewylosowanych pól specjalnych, koło musi w nie trafić, więc oba zawsze się pojawią.

Opcjonalnie w `.env`: `VOICE_CHAMPS` to kanał głosowy Mistrzów do narad w trybie głosowym.

---

## Krok 1: Programy

1. **Node.js** w wersji LTS (20 lub nowszej): https://nodejs.org
2. **cloudflared** (tunel): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   Na Windowsie najprościej: `winget install --id Cloudflare.cloudflared`

W folderze projektu:

```
npm install
```

## Krok 2: Test bez Discorda (najszybciej)

```
copy .env.example .env      (Windows)   |   cp .env.example .env   (Linux/Mac)
npm run dev
```

Otwórz **http://localhost:5173** w kilku kartach przeglądarki i w każdej wpisz inny nick.
W jednej kliknij „Zostań prowadzącym”, w pozostałych wybierz drużyny i graj.
Tak najwygodniej sprawdzać zmiany, bo strona przeładowuje się sama.

## Krok 3: Aplikacja w Discord Developer Portal

1. Wejdź na https://discord.com/developers/applications → **New Application**.
2. **OAuth2**:
   - skopiuj **Client ID** do `.env` jako `VITE_DISCORD_CLIENT_ID`,
   - kliknij **Reset Secret** i skopiuj sekret do `.env` jako `DISCORD_CLIENT_SECRET`,
   - w **Redirects** dodaj `https://127.0.0.1`. Discord wymaga jakiegoś adresu, ale aktywność go nie używa.
3. **Activities → Settings**: włącz aktywności (Enable Activities).
4. **Installation**: zaproś aplikację na swój serwer (link instalacyjny z tej zakładki).
5. W `.env` w `HOST_IDS` wpisz swoje ID z Discorda, żeby zawsze móc przejąć prowadzenie
   (Ustawienia → Zaawansowane → Tryb dewelopera, potem PPM na siebie → Kopiuj ID).

## Krok 4: Odpalenie w Discordzie

Terminal 1:
```
npm run dev:discord
```

Terminal 2:
```
cloudflared tunnel --url http://localhost:5173
```

cloudflared wypisze adres w stylu `https://jakies-losowe-slowa.trycloudflare.com`.
W Developer Portal → **Activities → URL Mappings** ustaw:

| PREFIX | TARGET |
|--------|--------|
| `/`    | `jakies-losowe-slowa.trycloudflare.com` (bez `https://`) |

Wejdź na kanał głosowy, kliknij ikonę aktywności (🚀) i wybierz swoją aplikację.

> Darmowy tunel dostaje **nowy adres przy każdym uruchomieniu**, więc URL Mapping trzeba wtedy
> zaktualizować. Stały adres dostaniesz przez nazwany tunel Cloudflare z własną domeną,
> a potem przez przeniesienie gry na VPS.

## Krok 5: Granie „na serio”

Do grania ze znajomymi lepiej użyć zbudowanej wersji (szybsza, bez przeładowywania na żywo):

1. W `.env` ustaw `DEV_LOGIN=0`. Inaczej każdy, kto zna adres tunelu, mógłby wejść z dowolnym nickiem.
2. Uruchom:
   ```
   npm run build
   npm start
   cloudflared tunnel --url http://localhost:3001
   ```
3. Zaktualizuj URL Mapping na nowy adres tunelu.

Na VPS robisz to samo: `npm install`, `npm run build`, `npm start` (np. przez `pm2`)
i ustawiasz URL Mapping na swoją domenę.

## Pytania

Są w `server/questions.json`: 182 pytania w 15 kategoriach. Format jednego pytania:

```json
{ "kategoria": "Geografia", "pytanie": "Jak nazywa się najdłuższa rzeka w Polsce?",
  "odpowiedz": "Wisła", "bledne": ["Odra", "Warta", "Bug"] }
```

- `bledne` to 3 złe odpowiedzi, potrzebne do trybu ABCD. Pytania bez nich pojawiają się tylko w trybie „Bez odpowiedzi”.
- Nową kategorię tworzysz, wpisując nową nazwę w `kategoria`. Na kole mieści się 8 pól (wylosowana kategoria + 7 innych).
- Po zmianach zrestartuj serwer. Pytanie nie powtórzy się w jednej grze.

## Rodzaj pytań: ABCD albo bez odpowiedzi

Prowadzący wybiera w panelu: **🅰️ ABCD** albo **✍️ Bez odpowiedzi**. Zmiana jest możliwa między rundami.

**🅰️ ABCD:** pod pytaniem są 4 odpowiedzi w losowej kolejności.
- Drużyna, która wygrała licytację, klika odpowiedź albo wpisuje na czacie `!B`. Liczy się pierwsza odpowiedź.
- **💡 Podpowiedź 50/50** usuwa dwie złe odpowiedzi. Kupuje ją drużyna (przycisk pod odpowiedziami) albo prowadzący w jej imieniu, np. gdy lider poprosi głosowo. Kosztuje `CONFIG.hintCost` (domyślnie 500 zł, ustaw 0 dla darmowej). Pieniądze trafiają do puli. Jedna podpowiedź na pytanie.
- Prowadzący widzi poprawną odpowiedź (zielona przerywana ramka) i klika Dobrze/Źle. Po ocenie wszyscy widzą dobrą odpowiedź na zielono i ewentualnie złą na czerwono.

**✍️ Bez odpowiedzi:** samo pytanie. Drużyna odpowiada głosem albo na czacie przez `!odpowiedź`, a prowadzący ocenia.

## Pliki

| Plik | Co robi |
|------|---------|
| `server/game.js` | Zasady gry, licytacja, timer, panel prowadzącego |
| `server/index.js` | Logowanie przez Discorda, WebSocket, zapis stanu |
| `server/questions.json` | Pytania |
| `client/main.js` | Logowanie w aktywności, rysowanie planszy, przyciski |
| `client/style.css` | Wygląd |
| `client/index.html` | Układ strony |

## Typowe problemy

- **Biały ekran / „Błąd logowania”**: sprawdź `VITE_DISCORD_CLIENT_ID` i `DISCORD_CLIENT_SECRET`
  w `.env` i zrestartuj `npm run dev:discord`. Klient czyta `.env` tylko przy starcie.
- **Aktywność się nie ładuje**: URL Mapping musi wskazywać aktualny adres tunelu (bez `https://`).
- **„Blocked request. This host is not allowed”**: dopisz swoją domenę do `allowedHosts` w `vite.config.js`.
- **Każde odpalenie aktywności to nowa gra**: Discord tworzy nową instancję, gdy wszyscy wyjdą
  z aktywności. Dopóki ktoś w niej jest, odświeżenie albo restart serwera nie kasuje stanu.
