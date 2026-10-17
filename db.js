// db.js — tiny dependency-free JSON database for the local answer store.
//
// The shared/cloud answer database lives in Convex (see convex/). This module is
// the LOCAL fast layer: it seeds itself from quiz_cache.json on first run, stores
// every answered question, and keeps working offline when Convex is unreachable.
//
// Storage: data/answers.json (atomic writes: tmp file + rename, debounced).

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ORACLE_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'answers.json');
const SEED_FILE = path.join(__dirname, 'quiz_cache.json');
const FLUSH_DELAY_MS = 300;

let db = null;
let flushTimer = null;

function cleanKey(q) {
  return String(q || '')
    .replace(/Question\s+\d+\s+of\s+\d+/gi, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
}

function load() {
  if (db) return db;
  ensureDir();
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[db] could not read answers.json, starting fresh:', e.message);
    db = null;
  }
  if (!db || !Array.isArray(db.answers)) {
    db = { version: 1, createdAt: new Date().toISOString(), answers: [] };
  }
  if (!db.answers.length) {
    importSeed();
    flushNow();
  }
  return db;
}

// One-time import of the legacy quiz_cache.json (1721 answers) so the DB
// becomes the single source of truth.
function importSeed() {
  try {
    if (!fs.existsSync(SEED_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    let n = 0;
    for (const [question, answerTexts] of Object.entries(raw)) {
      if (!Array.isArray(answerTexts) || !answerTexts.length) continue;
      db.answers.push({
        id: db.answers.length + 1,
        key: cleanKey(question),
        question: String(question).slice(0, 2000),
        choices: [],
        answerTexts: answerTexts.map(String),
        source: 'seed',
        answeredBy: 'seed',
        hits: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      n++;
    }
    if (n) console.log(`[db] imported ${n} seed answers from quiz_cache.json`);
    return n > 0;
  } catch (e) {
    console.warn('[db] seed import failed:', e.message);
    return false;
  }
}

function nextId() {
  return db.answers.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_DELAY_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function flushNow() {
  if (!db) return;
  try {
    ensureDir();
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    /* best effort */
  }
}

// Upsert an answered question. Returns the record.
function saveAnswer({ question, choices, answerTexts, source, answeredBy, qid }) {
  load();
  const key = cleanKey(question);
  const answers = (answerTexts || []).map(String).filter(Boolean);
  if (!key || !answers.length) return null;

  const existing = db.answers.find((a) => a.key === key);
  if (existing) {
    existing.hits = (existing.hits || 0) + 1;
    existing.lastSeenAt = Date.now();
    if (answers.join('\u00a7') !== existing.answerTexts.join('\u00a7')) {
      existing.answerTexts = answers;
      if (Array.isArray(choices) && choices.length) existing.choices = choices;
      if (source) existing.source = source;
      existing.revised = (existing.revised || 0) + 1;
      existing.updatedAt = Date.now();
    }
    if ((!existing.choices || !existing.choices.length) && Array.isArray(choices) && choices.length) {
      existing.choices = choices;
    }
    scheduleFlush();
    return existing;
  }

  const rec = {
    id: nextId(),
    key,
    question: String(question).slice(0, 2000),
    choices: Array.isArray(choices) ? choices : [],
    answerTexts: answers,
    source: source || 'ai',
    answeredBy: answeredBy || 'local',
    qid: qid || null,
    hits: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  db.answers.push(rec);
  scheduleFlush();
  return rec;
}

function get(questionText) {
  load();
  const key = cleanKey(questionText);
  return db.answers.find((a) => a.key === key) || null;
}

// Exact lookup usable as an answer cache (mirrors the old quizCache behaviour).
function lookupAnswerTexts(questionText) {
  const rec = get(questionText);
  return rec ? rec.answerTexts : null;
}

function list({ search, source, limit, offset } = {}) {
  load();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  let items = db.answers;
  if (source) items = items.filter((a) => a.source === source);
  if (search) {
    const s = cleanKey(search);
    items = items.filter((a) => a.key.includes(s) || (a.answerTexts || []).some((t) => cleanKey(t).includes(s)));
  }
  items = items.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { total: items.length, items: items.slice(off, off + lim) };
}

function stats() {
  load();
  const bySource = {};
  let lastUpdated = 0;
  for (const a of db.answers) {
    bySource[a.source] = (bySource[a.source] || 0) + 1;
    if ((a.updatedAt || 0) > lastUpdated) lastUpdated = a.updatedAt;
  }
  return { total: db.answers.length, bySource, lastUpdated };
}

// Rebuild a quiz_cache.json-style map (question key -> answer texts).
function exportCacheMap() {
  load();
  const map = {};
  for (const a of db.answers) {
    if (a.answerTexts && a.answerTexts.length) map[a.key] = a.answerTexts;
  }
  return map;
}

process.on('exit', flushNow);

module.exports = {
  cleanKey,
  saveAnswer,
  get,
  lookupAnswerTexts,
  list,
  stats,
  exportCacheMap,
  flushNow,
  path: DB_FILE
};
