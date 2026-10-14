const http = require('http');
const fs = require('fs');
const pathMod = require('path');

const HOST = '127.0.0.1';
const PORT = 8787;
const HOLD_MS = 60000;
const POLL_INTERVAL_MS = 50;

let nextQid = 1;
let lastAnsweredQid = 0;
let current = null;        // { qid, question, choices[], extractionFailed }
let pendingAnswer = null;  // { qid, ns[] }
const seenPollers = new Set();
let lastPageState = null;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

const answersCache = new Map();

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { ok: true, qid: current ? current.qid : 0, lastAnsweredQid });
      return;
    }

    if (req.method === 'POST' && path === '/page-state') {
      const body = await readBody(req);
      lastPageState = { ...body, receivedAt: new Date().toISOString() };
      const snippet = (body.text || '').replace(/\s+/g, ' ').slice(0, 100);
      console.log(`[relay] page-state: "${body.title || ''}" action=${body.action || 'none'} text="${snippet}"`);
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/page-state') {
      send(res, 200, lastPageState || { ok: false, error: 'no state yet' });
      return;
    }

    if (req.method === 'GET' && path === '/next') {
      hold(
        req,
        res,
        () => (current && current.qid > lastAnsweredQid ? { ...current } : undefined),
        { qid: 0 }
      );
      return;
    }

    if (req.method === 'GET' && path === '/answer-poll') {
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

    if (req.method === 'POST' && path === '/diag') {
      const body = await readBody(req);
      console.log('[relay] diag ' + JSON.stringify(body));
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/target-url') {
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

    if (req.method === 'POST' && path === '/question') {
      const body = await readBody(req);
      const question = typeof body.question === 'string' ? body.question : '';
      const choices = Array.isArray(body.choices)
        ? body.choices.filter((c) => typeof c === 'string')
        : [];
      current = {
        qid: nextQid++,
        question,
        choices,
        extractionFailed: !!body.extractionFailed
      };
      pendingAnswer = null;
      seenPollers.clear();
      console.log(`[relay] question qid=${current.qid} posted (${current.choices.length} choices)`);
      send(res, 200, { qid: current.qid });
      return;
    }

    if (req.method === 'POST' && path === '/answer') {
      const body = await readBody(req);
      const qid = parseInt(body.qid, 10);
      const rawNs = Array.isArray(body.n) ? body.n : [body.n];
      const ns = rawNs.map((v) => parseInt(v, 10));
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
      console.log(`[relay] answer n=${ns.join(',')} accepted for qid=${qid}`);
      send(res, 200, { ok: true });
      return;
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on http://${HOST}:${PORT}`);
});
