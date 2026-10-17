// settings.js — small local settings store (data/settings.json).
// Used for local-mode fallbacks, e.g. a Gemini API key set without Convex.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ORACLE_DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function save(obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    /* best effort */
  }
}

function getGeminiKey() {
  return load().geminiKey || null;
}

function setGeminiKey(key) {
  const s = load();
  const k = String(key || '').trim();
  if (k) s.geminiKey = k;
  else delete s.geminiKey;
  save(s);
  return true;
}

module.exports = { getGeminiKey, setGeminiKey };
