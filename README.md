# Oracle Solver 2026

An autonomous Oracle Academy autopilot: a Chrome extension + a local relay + a
Gemini-powered solver that answers quiz questions, completes assessments, and
moves on to the next section by itself — with every answer remembered in a
shared database, and access locked to issued credentials (one device each).

**v2.7.0 — what's new**

- **Operator key fallback.** Accounts without their own Gemini key now fall
  back to the operator key pool (`GEMINI_API_KEYS` / `GEMINI_API_KEY` in the
  Convex deployment env) for unseen questions — a missing key no longer
  stalls the run on guesses.
- **"Offline" flicker fixed.** The popup required only ONE slow `/health`
  call to show "offline — check your internet". Now: 4.5s timeout + one
  retry in the background, and the popup only reports offline after two
  consecutive failures ("reconnecting…" in between). A signed-in session is
  never downgraded to the login form during a brief hiccup.
- **Degraded path fixed.** When the extension context is invalidated and the
  content script falls back to direct fetches, it used to hit a hardcoded
  dead local relay (`127.0.0.1:8787`) with no auth. Now it hits the same
  server as the background worker — with the session token and device id.
- **Transient 5xx can't lock the autopilot.** Only a real 401/403 from the
  identity probe pauses it; a passing server hiccup keeps the run moving.
- **Wider retake detection** on the results screen ("assessment again",
  "take assessment", "start over", …).

**v2.0.0 — what's new**

- **Section-switching fixed.** The old build got trapped on the same quiz: it
  redirected to a hardcoded outline URL containing a dead session id, and course
  outline navigation was disabled. Now the outline URL is captured live per
  session, the next unfinished section is opened automatically, and a watchdog
  (20s re-click → 45s alternate buttons → 75s reload-once) un-sticks any quiz.
- **Real answer database.** Every answered question is stored locally
  (`data/answers.json`, seeded with 1,721 questions) and pushed to the shared
  Convex cloud database. Browse with `node answers.js`.
- **Access control.** User IDs + passwords issued by the owner, scrypt-hashed in
  Convex. Each account binds to exactly one device on first login — sharing
  credentials fails closed. Reset bindings with `node admin.js reset-device`.
- **Better AI solving.** Only live Gemini model names are tried (dead names used
  to burn 8s per question), multi-key rotation with cooldowns, and an optional
  deterministic fallback guess so the run never stalls.
- **Login popup + kill switch.** The extension popup shows relay health, session
  state, and device ID, and can pause the autopilot.

---

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────────┐
│  Next.js site (Vercel)  │        │  Convex cloud                │
│  landing + download zip │        │  users · device locks ·      │
└─────────────────────────┘        │  shared answer database      │
                                   └──────────▲───────────────────┘
┌─────────────────────────┐                   │ HTTPS
│  Chrome extension (MV3) │◀──▶│ local relay :8787 │──▶ Gemini AI
│  popup login, autopilot │    │ auth proxy · quiz flow │
└─────────────────────────┘    └────────────────────────┘
```

| File | Role |
|---|---|
| `extension/` | MV3 extension: content autopilot, popup login, background relay-proxy |
| `relay.js` | local HTTP bridge (127.0.0.1:8787): quiz flow, dedupe, auth proxy |
| `auto.js` | solver loop: DB-first → Gemini → manual/guess |
| `convex/` | cloud functions: users, device locks, shared answers |
| `admin.js` | issue credentials, reset device locks (cloud or local) |
| `answers.js` | browse/search the answer database |
| `web/` | Next.js download site (deploy root = `web`) |
| `db.js` / `auth.js` | local fallback DB + auth when Convex isn't configured |
| `tests/` | 8 automated tests (extension DOM scenarios + DB + auth) |

---

## Setup (owner — one time)

> **Status: DEPLOYED — this section is informational only.** The Convex backend
> is already live at `https://sleek-oyster-317.convex.site` with the shared
> answer database seeded (1,721 questions). The local `.env` holds
> `ADMIN_SECRET` and the accounts (`owner` = admin, `owner-cli` = for auto.js).
> To add a friend: `node admin.js add-user <name>`. To redeploy later, follow
> `convex/README.md`.

### 1. Configure

```bash
cp .env.example .env
```

Fill in:

- `GEMINI_API_KEY` — your key(s); comma-separate `GEMINI_API_KEYS` for rotation
- `CONVEX_URL` — your Convex HTTP actions URL (already filled: `https://sleek-oyster-317.convex.site`)
- `ADMIN_SECRET` — the deployment admin secret (already filled)
- `AUTH_USER` / `AUTH_PASS` — the **dedicated CLI account** auto.js logs in with
  (device binding means it must not be the same account you use in the browser)

### 2. Deploy the cloud backend (reference — already done)

```bash
npm install
CONVEX_DEPLOYMENT=dev:sleek-lemur-918 npx convex deploy --yes
CONVEX_DEPLOYMENT=dev:sleek-lemur-918 npx convex env set ADMIN_SECRET <value>          # dev
CONVEX_DEPLOYMENT=dev:sleek-lemur-918 npx convex env set ADMIN_SECRET <value> --prod   # prod
npm run seed:convex   # imports the 1,721 cached answers into the cloud DB
```

### 3. Issue credentials

```bash
node admin.js add-user rahul.k          # prints a generated password
node admin.js add-user priya.s s3cret   # or set your own
node admin.js list
```

The first device each user signs in from becomes the only device that account
accepts. `node admin.js reset-device rahul.k` lets them move.

## Setup (users — three minutes, no installs)

1. Download the extension zip from the site, unzip it.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the unzipped folder.
3. Click the extension icon, sign in with the issued user ID + password (locks to that one browser).
4. Click **"How do I get a free key?"** → follow the Google AI Studio steps → paste your `AIza…` key → Save.

That's it — no Node, no terminal. The extension talks straight to the cloud:
shared database answers (0 ms, 1,721+ questions) first, your Gemini key only
for unseen questions, and every AI answer flows back into the shared database.

Owner-only optional CLI mode (fully autonomous on your own machine):
`node relay.js` + `node auto.js` — the extension can also point at a local
relay via `chrome.storage.local.set({ serverUrl: 'http://127.0.0.1:8787' })`.

Manual mode (owner, no AI): `node relay.js` in one terminal, `node wait.js` to
see the current question, `node answer.js 2` to answer.

---

## The answer database

```bash
node answers.js                     # latest 25
node answers.js "rollback"          # search
node answers.js --stats             # totals by source
node answers.js --cloud --limit 50  # browse the shared cloud DB
```

Every solved question is written locally on submit and pushed to Convex
asynchronously. Local hits answer in 0 ms; cloud answers sync to all users.

## Tests

```bash
npm test        # 8 tests: 6 extension DOM scenarios + DB + auth
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup flickers "offline" for a second | Normal under slow networks — it now needs 2 consecutive failures; if it stays red, check internet / Convex dashboard |
| Solver answers but quiz score stays low | The account has no Gemini key and the question isn't in the shared DB — save a key in the popup, or set the operator key pool (`npx convex env set GEMINI_API_KEYS <keys>`) |
| Popup says "relay offline" / "cloud unreachable" | No internet, or Convex is paused — check dashboard |
| "login required" and nothing happens | Sign in from the extension popup |
| `device_mismatch` at login | The account is bound elsewhere — owner runs `node admin.js reset-device <userId>` |
| `login failed` in auto.js | Set `AUTH_USER`/`AUTH_PASS` in `.env` (dedicated CLI account) |
| Quiz stuck on one question | Watchdog handles it; check the console log for `[autopilot]` warnings |
| 429 from Gemini | Add more keys to `GEMINI_API_KEYS` — rotation + 60s cooldowns are automatic |
