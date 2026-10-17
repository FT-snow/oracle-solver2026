// relay-auth.test.js — end-to-end relay smoke test on an isolated port:
// open mode -> local auth mode -> question dedupe -> answer -> DB write.
process.env.RELAY_PORT = '8991';
process.env.ORACLE_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'osolver-relay-'));
// Empty string overrides any .env value: env.js never touches variables that are already set.
process.env.CONVEX_URL = '';
process.env.ADMIN_SECRET = '';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

function req(method, pathName, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
    if (payload) h['Content-Type'] = 'application/json';
    const r = require('http').request(
      { host: '127.0.0.1', port: 8991, path: pathName, method, headers: h },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (e) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await req('GET', '/health');
      if (r.status === 200) return r;
    } catch (e) {}
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error('relay did not start');
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')], { stdio: 'ignore' });
  const shutdown = (code, msg) => {
    try { child.kill('SIGKILL'); } catch (e) {}
    if (msg) console.log(msg);
    process.exit(code);
  };
  try {
    // 1. Open mode (no users yet)
    const health = await waitReady();
    assert.strictEqual(health.body.auth.required, false, 'open mode with no users');
    assert.strictEqual(health.body.auth.mode, 'open');

    // 2. Create a user -> enforcement flips on (local mode)
    const auth = require('../auth');
    assert.ok(auth.addUser('tester', 'pw12345').ok);
    const health2 = await req('GET', '/health');
    assert.strictEqual(health2.body.auth.required, true, 'auth required once a user exists');
    assert.strictEqual(health2.body.auth.mode, 'local');

    // 3. Gated endpoint rejects anonymous
    const denied = await req('POST', '/question', { question: 'x', choices: ['a', 'b'] });
    assert.strictEqual(denied.status, 401, 'anonymous /question rejected');

    // 4. Login from device A
    const login = await req('POST', '/auth/login', { userId: 'tester', password: 'pw12345', deviceId: 'devA', deviceLabel: 'test laptop' });
    assert.strictEqual(login.status, 200, 'login ok');
    const token = login.body.token;
    const H = { Authorization: `Bearer ${token}`, 'X-Device-Id': 'devA' };

    // 5. Device B is refused (one-device rule)
    const loginB = await req('POST', '/auth/login', { userId: 'tester', password: 'pw12345', deviceId: 'devB' });
    assert.strictEqual(loginB.status, 403, 'second device locked out');

    // 6. Post a question, dedupe returns the same qid
    const q1 = await req('POST', '/question', { question: 'Which statement ends a transaction?', choices: ['COMMIT', 'ROLLBACK'] }, H);
    assert.ok(q1.body.qid > 0);
    const q2 = await req('POST', '/question', { question: 'Which statement ends a transaction?', choices: ['COMMIT', 'ROLLBACK'] }, H);
    assert.strictEqual(q2.body.qid, q1.body.qid, 'duplicate question deduped');
    assert.strictEqual(q2.body.deduped, true);

    // 7. Answer it -> stored in DB with source + attribution
    const ans = await req('POST', '/answer', { qid: q1.body.qid, n: [2], source: 'ai' }, H);
    assert.strictEqual(ans.status, 200);
    const db = require('../db');
    const rec = db.get('Which statement ends a transaction?');
    assert.ok(rec, 'answer stored in local DB');
    assert.deepStrictEqual(rec.answerTexts, ['ROLLBACK']);
    assert.strictEqual(rec.source, 'ai');
    assert.strictEqual(rec.answeredBy, 'tester');

    // 8. /next and /answer-poll work with the token
    const poll = await req('GET', `/answer-poll?qid=${q1.body.qid}`, null, H);
    assert.deepStrictEqual(poll.body.ns, [2], 'cached answer delivered instantly');

    // 9. /answers listing works
    const list = await req('GET', '/answers?limit=10', null, H);
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.total >= 1);

    // 10. whoami
    const me = await req('GET', '/whoami', null, H);
    assert.strictEqual(me.body.userId, 'tester');

    console.log('PASS relay.test.js — auth gate, device lock, dedupe, answer storage, endpoints verified');
    shutdown(0);
  } catch (e) {
    shutdown(1, 'FAIL relay.test.js — ' + e.message);
  }
})();
