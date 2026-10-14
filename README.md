# Oracle Quiz Relay & Autopilot

A local automation relay and Chrome extension for Oracle Academy quizzes.

## Features

- **Autonomous Auto-Pilot**: Automatically advances slides/PDFs ("Save and Continue") and transitions into quiz mode.
- **Relay Server**: Dependency-free Node.js HTTP server managing questions, choices, and answers locally (`127.0.0.1:8787`).
- **AI-Powered Solver**: Optional integration with Google Gemini Flash models for automated question answering.
- **Persistent Quiz Cache**: Caches answers to repeat questions for instant 0ms responses.
- **Manual Override**: Support for terminal-based answering via `answer.js`.

---

## Getting Started

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- Google Chrome (or Chromium-based browser)

### 2. Configure Environment (Optional for AI auto-solve)
Copy the example environment file:
```bash
cp .env.example .env
```
Open `.env` and add your Google Gemini API key:
```env
GEMINI_API_KEY=your_gemini_api_key_here
```
*(You can also provide multiple comma-separated keys under `GEMINI_API_KEYS` for rate-limit rotation).*

### 3. Load the Chrome Extension
1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top right toggle).
3. Click **Load unpacked** and select the `extension` folder in this repository.

### 4. Running the System

#### Option A: Fully Automated Runner
Start the automated runner (this also boots the relay server automatically):
```bash
node auto.js
```

#### Option B: Manual Terminal Mode
Start the relay server in one terminal:
```bash
node relay.js
```
Wait for incoming questions in another terminal:
```bash
node wait.js
```
When a question appears, answer with the choice number:
```bash
node answer.js <number>
```

---

## Repository Structure

- `auto.js` — Automated question polling, caching, and AI answering loop.
- `relay.js` — Lightweight local HTTP relay server.
- `client.js` — Client helper for communication with the relay server.
- `wait.js` — Terminal watcher that displays current question and choices.
- `answer.js` — CLI tool to submit manual answer to the relay server.
- `something.js` — Standalone browser console helper script.
- `quiz_cache.json` — Offline cached question-and-answer pairs.
- `extension/` — Chrome MV3 extension content script and manifest.
- `docs/` — Architecture specs and implementation plans.
- `tests/` — Test suites for page modes.
