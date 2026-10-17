// relay.js — local HTTP bridge (127.0.0.1:8787) between the Chrome extension,
// the solver (auto.js) and the Convex cloud.
//
// Responsibilities:
//   1. Quiz flow: hold /next for the solver, hold /answer-poll for the extension.
//   2. Dedupe repeated posts of the SAME question (page didn't advance) so the
//      same qid + cached answer is returned instantly instead of re-solving.
//   3. Access control: when CONVEX_URL is set (or local users exist) the quiz
//      endpoints require a bearer token; every login/device rule lives in Convex.
//   4. Answer storage: every answered question is written to the local DB
//      (data/answers.json) and pushed to the shared Convex database.

require('./env').loadEnv();
const http = require('http');
const fs = require('fs');
const pathMod = require('path');
const crypto = require('crypto');
const db = require('./db');
const localAuth = require('./auth');

const answersCache = new Map();

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.RELAY_PORT || '8787', 10);
const HOLD_MS = 60000;
const POLL_INTERVAL_MS = 50;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

const CONVEX_URL = (process.env.CONVEX_URL || '').trim().replace(/\/+$/, '');

// Auth mode is evaluated per request so that creating the first user (or
// setting CONVEX_URL + restart) flips enforcement on without a stale cache.
function currentAuthMode() {
  if (CONVEX_URL) return 'cloud';
  try {
    if (localAuth.countUsers() > 0) return 'local';
  } catch (e) {}
  return 'open';
}

let nextQid = 1;
let lastAnsweredQid = 0;
let current = null;        // { qid, question, choices[], extractionFailed, sig, postedAt }
let pendingAnswer = null;  // { qid, ns[] }
const seenPollers = new Set();
let lastPageState = null;
let lastSig = '';
let lastSigAt = 0;

// token -> { until, result } cache for cloud verification (avoids per-request latency)
const verifyCache = new Map();
const VERIFY_OK_TTL = 60000;
const VERIFY_FAIL_TTL = 8000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id, X-Admin-Secret');
}

function send(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authHeadersOf(req) {
  const h = {};
  const auth = req.headers['authorization'];
  if (auth) h['Authorization'] = auth;
  if (req.headers['x-device-id']) h['X-Device-Id'] = req.headers['x-device-id'];
  if (req.headers['x-admin-secret']) h['X-Admin-Secret'] = req.headers['x-admin-secret'];
  return h;
}

function bearerOf(req) {
  const auth = req.headers['authorization'] || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

async function verifyWithCloud(token, deviceId) {
  const cacheKey = `${token.slice(0, 16)}|${deviceId}`;
  const cached = verifyCache.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.result;
  let result = { ok: false };
  try {
    const res = await fetch(`${CONVEX_URL}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, deviceId }),
      signal: AbortSignal.timeout(6000)
    });
    const body = await res.json().catch(() => ({}));
    result = res.ok && body && body.ok ? { ok: true, userId: body.userId } : { ok: false };
  } catch (e) {
    result = { ok: false, cloudDown: true };
  }
  verifyCache.set(cacheKey, {
    until: Date.now() + (result.ok ? VERIFY_OK_TTL : VERIFY_FAIL_TTL),
    result
  });
  return result;
}

async function verifyAuth(req) {
  const AUTH_MODE = currentAuthMode();
  if (AUTH_MODE === 'open') return { ok: true };
  const token = bearerOf(req);
  const deviceId = req.headers['x-device-id'] || '';
  if (!token) return { ok: false, status: 401, body: { error: 'auth required — log in via the extension popup' } };
  if (AUTH_MODE === 'cloud') {
    const r = await verifyWithCloud(token, deviceId);
    return r.ok ? { ok: true, userId: r.userId } : { ok: false, status: 401, body: { error: 'invalid or expired token — log in again' } };
  }
  const r = localAuth.verifyToken(token, deviceId);
  return r.ok ? { ok: true, userId: r.userId } : { ok: false, status: 401, body: { error: 'invalid or expired token — log in again' } };
}

// Push an answered question to the shared Convex database (fire and forget).
function pushAnswerToCloud(payload, authHeaders) {
  if (!CONVEX_URL) return;
  fetch(`${CONVEX_URL}/answers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authHeaders || {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  }).catch(() => {});
}

// Holds the response until condition() returns a truthy value (the result to
// send) or maxHoldMs elapses, in which case timeoutResult is sent instead.
function hold(req, res, condition, timeoutResult, maxHoldMs = HOLD_MS) {
  const start = Date.now();
  const timer = setInterval(() => {
    const result = condition();
    if (result !== undefined) {
      clearInterval(timer);
      send(res, 200, result);
    } else if (Date.now() - start > maxHoldMs) {
      clearInterval(timer);
      send(res, 200, timeoutResult);
    }
  }, POLL_INTERVAL_MS);
  req.on('close', () => clearInterval(timer));
}

function questionSig(question, choices) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto
    .createHash('sha1')
    .update(norm(question) + '|' + (choices || []).map(norm).join('\u00a7'))
    .digest('hex');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathName = url.pathname;

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && pathName === '/health') {
      send(res, 200, {
        ok: true,
        qid: current ? current.qid : 0,
        lastAnsweredQid,
        auth: { required: currentAuthMode() !== 'open', mode: currentAuthMode() }
      });
      return;
    }

    // ---- Auth (proxied to Convex in cloud mode) ----------------------------
    if (req.method === 'POST' && (pathName === '/auth/login' || pathName === '/auth/verify' || pathName === '/auth/logout')) {
      const body = await readBody(req);
      const AUTH_MODE = currentAuthMode();
      if (AUTH_MODE === 'cloud') {
        const r = await fetch(`${CONVEX_URL}${pathName}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000)
        });
        const data = await r.text();
        cors(res);
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(data);
        return;
      }
      if (pathName === '/auth/login') {
        const r = localAuth.login({
          userId: body.userId,
          password: body.password,
          deviceId: body.deviceId,
          deviceLabel: body.deviceLabel
        });
        send(res, r.ok ? 200 : r.code === 'device_mismatch' ? 403 : 401, r.ok ? r : { ok: false, code: r.code, error: r.code === 'device_mismatch' ? `Account is locked to another device (${r.boundTo}). Ask the admin to reset the device binding.` : 'Invalid user ID or password.' });
        return;
      }
      if (pathName === '/auth/verify') {
        const r = localAuth.verifyToken(body.token, body.deviceId);
        send(res, r.ok ? 200 : 401, r.ok ? r : { ok: false, code: r.code });
        return;
      }
      send(res, 200, localAuth.logout(body.token));
      return;
    }

    if (req.method === 'GET' && pathName === '/whoami') {
      const auth = await verifyAuth(req);
      if (!auth.ok) return send(res, auth.status, auth.body);
      send(res, 200, { ok: true, userId: auth.userId, mode: currentAuthMode() });
      return;
    }

    // ---- Page state telemetry (open: harmless) -----------------------------
    if (req.method === 'POST' && pathName === '/page-state') {
      const body = await readBody(req);
      lastPageState = { ...body, receivedAt: new Date().toISOString() };
      const snippet = (body.text || '').replace(/\s+/g, ' ').slice(0, 100);
      console.log(`[relay] page-state: "${body.title || ''}" action=${body.action || 'none'} text="${snippet}"`);
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathName === '/page-state') {
      send(res, 200, lastPageState || { ok: false, error: 'no state yet' });
      return;
    }

    // ---- Answer database browsing ------------------------------------------
    if (pathName === '/answers' || pathName === '/answers/stats') {
      const auth = await verifyAuth(req);
      if (!auth.ok) return send(res, auth.status, auth.body);
      const AUTH_MODE = currentAuthMode();
      if (AUTH_MODE === 'cloud') {
        const qs = url.search;
        const r = await fetch(`${CONVEX_URL}${pathName}${qs}`, { headers: authHeadersOf(req), signal: AbortSignal.timeout(8000) });
        const data = await r.text();
        cors(res);
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(data);
        return;
      }
      if (pathName === '/answers/stats') return send(res, 200, db.stats());
      const result = db.list({
        search: url.searchParams.get('search') || undefined,
        source: url.searchParams.get('source') || undefined,
        limit: url.searchParams.get('limit') || undefined,
        offset: url.searchParams.get('offset') || undefined
      });
      return send(res, 200, result);
    }

    // ---- Gated quiz endpoints ----------------------------------------------
    if (
      (req.method === 'GET' && pathName === '/next') ||
      (req.method === 'GET' && pathName === '/answer-poll') ||
      (req.method === 'POST' && pathName === '/question') ||
      (req.method === 'POST' && pathName === '/answer')
    ) {
      const auth = await verifyAuth(req);
      if (!auth.ok) return send(res, auth.status, auth.body);
      req.__userId = auth.userId || 'local';
    }

    if (req.method === 'GET' && pathName === '/next') {
      hold(
        req,
        res,
        () => (current && current.qid > lastAnsweredQid ? { ...current } : undefined),
        { qid: 0 }
      );
      return;
    }

    if (req.method === 'GET' && pathName === '/answer-poll') {
      const qid = parseInt(url.searchParams.get('qid'), 10);
      if (!current || current.qid !== qid) {
        send(res, 200, { stale: true });
        return;
      }
      if (answersCache.has(qid)) {
        const ns = answersCache.get(qid);
        console.log(`[relay] instant answer ns=${ns.join(',')} delivered to poller for qid=${qid}`);
        send(res, 200, { ns });
        return;
      }
      if (!seenPollers.has(qid)) {
        seenPollers.add(qid);
        console.log(`[relay] extension polling for qid=${qid}`);
      }
      hold(
        req,
        res,
        () => {
          if (!current || current.qid !== qid) return { stale: true };
          if (answersCache.has(qid)) {
            const ns = answersCache.get(qid);
            console.log(`[relay] answer ns=${ns.join(',')} delivered to poller for qid=${qid}`);
            return { ns };
          }
          return undefined;
        },
        { ns: null },
        1500
      );
      return;
    }

    if (req.method === 'POST' && pathName === '/diag') {
      const body = await readBody(req);
      console.log('[relay] diag ' + JSON.stringify(body));
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathName === '/target-url') {
      let targetUrl = '';
      try {
        const file = pathMod.join(__dirname, 'redirect_url.txt');
        if (fs.existsSync(file)) {
          targetUrl = fs.readFileSync(file, 'utf8').trim();
        }
      } catch (e) {}
      send(res, 200, { url: targetUrl });
      return;
    }

    if (req.method === 'POST' && pathName === '/question') {
      const body = await readBody(req);
      const question = typeof body.question === 'string' ? body.question : '';
      const choices = Array.isArray(body.choices) ? body.choices.filter((c) => typeof c === 'string') : [];
      const sig = questionSig(question, choices);

      // Dedupe: same question re-posted (page didn't advance / re-extraction)
      // keeps the same qid so the cached answer is delivered instantly.
      if (current && sig === lastSig && current.sig === sig && Date.now() - lastSigAt < DEDUPE_WINDOW_MS) {
        console.log(`[relay] duplicate question post — returning existing qid=${current.qid}`);
        send(res, 200, { qid: current.qid, deduped: true });
        return;
      }

      current = {
        qid: nextQid++,
        question,
        choices,
        extractionFailed: !!body.extractionFailed,
        sig,
        postedAt: Date.now()
      };
      lastSig = sig;
      lastSigAt = Date.now();
      pendingAnswer = null;
      seenPollers.clear();
      console.log(`[relay] question qid=${current.qid} posted (${current.choices.length} choices)`);
      send(res, 200, { qid: current.qid });
      return;
    }

    if (req.method === 'POST' && pathName === '/answer') {
      const body = await readBody(req);
      const qid = parseInt(body.qid, 10);
      const rawNs = Array.isArray(body.n) ? body.n : [body.n];
      const ns = [...new Set(rawNs.map((v) => parseInt(v, 10)))];
      if (!current || qid !== current.qid) {
        send(res, 409, { error: 'question changed — run wait.js again' });
        return;
      }
      if (!ns.length || ns.some((v) => !Number.isInteger(v) || v < 1 || v > current.choices.length)) {
        send(res, 400, { error: `n must be ${ns.length > 1 ? 'integers' : 'an integer'} in 1..${current.choices.length}` });
        return;
      }
      pendingAnswer = { qid, ns };
      answersCache.set(qid, ns);
      lastAnsweredQid = qid;

      // Persist to the answer database (local now, shared cloud async).
      const answerTexts = ns.map((n) => current.choices[n - 1]).filter(Boolean);
      const rec = db.saveAnswer({
        question: current.question,
        choices: current.choices,
        answerTexts,
        source: typeof body.source === 'string' ? body.source : 'manual',
        answeredBy: auth_userIdOf(req),
        qid
      });
      // Answers are small and infrequent — flush synchronously so a crash
      // never loses a solved question.
      db.flushNow();
      pushAnswerToCloud(
        {
          question: current.question,
          choices: current.choices,
          answerTexts,
          source: typeof body.source === 'string' ? body.source : 'manual'
        },
        authHeadersOf(req)
      );
      console.log(`[relay] answer n=${ns.join(',')} accepted for qid=${qid}${rec ? ` (db id=${rec.id})` : ''}`);
      send(res, 200, { ok: true });
      return;
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

function auth_userIdOf(req) {
  // Attribution: resolved by verifyAuth in the gate block before dispatch.
  return (req && req.__userId) || 'local';
}

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on http://${HOST}:${PORT}`);
  const mode = currentAuthMode();
  console.log(`[relay] auth: ${mode === 'cloud' ? `cloud (${CONVEX_URL})` : mode === 'local' ? 'local users (data/users.json)' : 'open — no users configured, anyone on this machine can use it'}`);
  const s = db.stats();
  console.log(`[relay] answer database: ${s.total} questions at ${db.path}`);
});
