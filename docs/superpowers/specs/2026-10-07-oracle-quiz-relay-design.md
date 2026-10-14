# Oracle Quiz Relay — Design Spec

Date: 2026-10-07
Status: approved (design v2)

## Goal

Automate the answer loop for Oracle Academy quizzes (`https://academy.oracle.com/*`). The existing console script (`something.js`) already extracts the question and clicks an option via `press(n)`, but it relies on the Gemini API and must be re-pasted after every submit because the page reloads. This design replaces the AI answer source with an operator-at-the-terminal loop and removes re-pasting entirely.

Flow: a Chrome extension extracts the current question, sends it to a local relay server, the operator reads the question in the terminal, replies with an option number, and the relay hands that number back to the extension, which clicks the option and submits. The page reloads and the content script runs again for the next question. Repeat until the quiz ends.

## Constraints and assumptions

- Page reloads after each submit destroy injected page scripts; the trigger must survive navigation (Chrome extension content script, not pasted console code).
- No fixed quiz shape: question count, choice count (2–6+), and wording may vary per quiz. Nothing is hardcoded to a fixed count.
- The relay runs on the operator's machine only, bound to `127.0.0.1`.
- `something.js` is left untouched; its Gemini path is unused by this system.

## Components

### 1. `relay.js` — local relay server

Dependency-free Node HTTP server on `127.0.0.1:8787`. All responses include `Access-Control-Allow-Origin: *` and handle `OPTIONS` preflight (the extension posts JSON from an `academy.oracle.com` origin).

In-memory state (no persistence file — the system self-heals after a restart, see Edge cases):

- `current`: `{qid, question, choices[], extractionFailed}` or `null`. `qid` is a monotonically increasing integer.
- `pendingAnswer`: `{qid, n}` or `null`.
- `lastAnsweredQid`: highest `qid` that has been answered.

Endpoints:

| Endpoint | Method | Behavior |
|---|---|---|
| `/question` | POST | Body `{question, choices[], extractionFailed?}`. Replaces `current` with a new `qid`, clears `pendingAnswer`. Returns `{qid}`. |
| `/next` | GET | Held (max 60s) until `current` exists with `current.qid > lastAnsweredQid`; then returns `current`. |
| `/answer` | POST | Body `{qid, n}`. `409` if `qid !== current.qid` (stale/wrong question); `400` if `n` is outside `1..current.choices.length` (or choices are empty). Otherwise stores `pendingAnswer` and sets `lastAnsweredQid = qid`. Returns `{ok: true}`. |
| `/answer-poll?qid=N` | GET | Held (max 60s) until `pendingAnswer` with matching `qid` appears; returns `{n}` once and clears `pendingAnswer`. Timeout → `{n: null}`. If `current.qid !== qid` → `{stale: true}` (question was replaced or relay restarted). |
| `/health` | GET | `{ok: true, qid: <current qid or 0>, lastAnsweredQid}`. |

### 2. `extension/` — Chrome MV3 extension

Files: `manifest.json`, `content.js`.

- `manifest.json`: Manifest V3, one content script on `https://academy.oracle.com/*`, `run_at: document_idle`, `all_frames: true` (APEX quizzes may sit in an iframe).
- `content.js` behavior, in order:
  1. Guard: run once per document (`window.__quizRelayDone`).
  2. **Extract** with two strategies:
     - **Primary (DOM)**: find the question's radio/checkbox inputs and their labels directly — count is whatever the page renders. Capture a re-findable handle (`id`/`name`/`value`) for each choice, not a live element reference (the poll may outlast a re-render).
     - **Fallback (text)**: the existing `innerText` parsing from `something.js` ("Question X of Y" → "Choices" block), producing choice strings only.
  3. **Post**: `POST /question` with `{question, choices}` (strings, numbered `[1..n]` at display time only). If extraction failed: post raw text with `extractionFailed: true` so the operator sees the problem, click nothing, do not poll.
  4. **Poll**: long-poll `GET /answer-poll?qid=N`, looping on `{n: null}` timeouts (60s) indefinitely while the page is unchanged. On `{stale: true}`: re-post the current page's question (new `qid`) and resume polling — bounded to at most 3 re-posts, each ≥10s apart (prevents an infinite re-post ping-pong if two frames both hold the question; after the bound, log and stop).
  5. **Answer**: on `{n}` where `1 <= n <= choices.length`:
     - DOM-extracted choice: re-find the input by its handle, click it, dispatch `change`/`input` events.
     - Text-extracted choice: existing snippet-matching logic (first 25 chars, deepest matching element, click input/label).
     - 400ms later, click the "Submit Answer" button. Page reloads → content script runs again (step 1).
  6. **End-of-quiz detection**: if no question and no choice inputs found: log "quiz appears finished / completion page" and stop (no posting, no polling).
  7. **Failure handling**: extraction failure on a normal page → log a clear error, still post raw text (step 3). Three consecutive extraction failures → stop polling entirely (no spam). Invalid `n` from the relay → log, click nothing, keep polling.
  8. Every step logs to the content-script console with a `[quiz-relay]` prefix.

### 3. `wait.js` — operator CLI (read question)

- Health-check the relay (`GET /health`); if down, spawn `node relay.js` detached (`detached: true`, stdio ignored) and retry.
- Loop `GET /next` (60s hold per request) until a question with `qid > lastAnsweredQid` exists.
- Print, then exit: `qid`, the question text, and choices numbered `[1] … [n]`, or a loud `EXTRACTION FAILED — raw text below` banner when `extractionFailed` is set.

### 4. `answer.js` — operator CLI (send answer)

- `node answer.js <n>` → reads the current `qid` from `GET /health`, then `POST /answer {qid, n}` (no long-polling needed). On `409`, print a clear "question changed — run wait.js again" error and exit non-zero; on `400`, print the relay's range complaint and exit non-zero.
- Health-check/auto-start same as `wait.js`.

## End-to-end sequence

1. Quiz page loads → content script extracts question 7 (choices A–D) → `POST /question` → `qid=7`.
2. Operator runs `node wait.js` → prints question 7 with `[1]–[4]`.
3. Operator (AI agent) reads it, decides, runs `node answer.js 2`.
4. Relay stores `pendingAnswer {qid:7, n:2}`, `lastAnsweredQid=7`.
5. Extension's held poll returns `{n:2}` → clicks choice 2 → submits.
6. Page reloads with question 8 → content script runs again → step 1.
7. When the page is a completion screen → extraction finds nothing → extension logs "finished" and stops.

## Edge cases

- **Stale answer** (`qid` mismatch, e.g. user advanced manually): `409` to `answer.js`; operator re-runs `wait.js`.
- **Relay restart mid-question**: `current` and `pendingAnswer` lost. Extension's poll gets `{stale: true}` → re-posts question with a fresh `qid` → operator answers again. `lastAnsweredQid` reset to 0 only re-shows an unanswered question — harmless.
- **Poll timeout**: extension re-polls; question is only posted once per page life unless stale.
- **Extraction failure**: never blind-clicks; raw text reaches the terminal so the operator can diagnose.
- **Multiple frames**: `all_frames: true`; content script posts only from the frame that actually contains question inputs. If both frames do, the later post wins and the earlier gets `{stale:true}` and re-posts — bounded as in extension step 4 (max 3, ≥10s apart), so the worst case is a few extra terminal lines, never an infinite loop.

## Testing

1. **Endpoint smoke test (no browser)**: start `relay.js`; `curl POST /question` with a fake question; run `wait.js` → verify printout; `curl GET /answer-poll?qid=N` in background; `node answer.js 2` → verify poll returns `{n:2}`; wrong `qid` → verify `409`.
2. **Restart path**: kill relay between `/question` and `/answer-poll` → restart → verify `{stale:true}` → re-post works.
3. **Live run**: load unpacked extension, open the real quiz, verify extraction console output matches the visible question, answer one question end-to-end, confirm click + submit + reload loop.
4. **Failure paths**: open a non-quiz page on the domain → verify end-of-quiz detection stops it; force bad extraction → verify raw-text post + no click.

## Out of scope

- `something.js` Gemini flow (left as-is, unused).
- Auto-starting the relay at OS boot, persistence across relay restarts, GUI/status page.
- Any site other than `academy.oracle.com` (match rule can be widened later).
