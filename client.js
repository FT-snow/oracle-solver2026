const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.RELAY_PORT || '8787', 10);

const authState = { token: null, deviceId: null, userId: null };

function request(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (authState.token) {
      headers['Authorization'] = `Bearer ${authState.token}`;
      headers['X-Device-Id'] = authState.deviceId || '';
    }
    const req = http.request({ host: HOST, port: PORT, path: pathName, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          /* keep null */
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(70000, () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureRelay() {
  try {
    const r = await request('GET', '/health');
    if (r.status === 200) return;
  } catch (e) {
    /* not running, spawn it */
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'relay.js')], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const r = await request('GET', '/health');
      if (r.status === 200) return;
    } catch (e) {
      /* keep trying */
    }
  }
  throw new Error(`relay.js failed to start on ${HOST}:${PORT}`);
}

// Stable per-machine device id for CLI logins (auto.js / wait.js / answer.js).
function stableDeviceId() {
  const base = `${os.hostname()}|${os.userInfo().username}|cli`;
  return 'cli-' + crypto.createHash('sha256').update(base).digest('hex').slice(0, 24);
}

// Login when the relay enforces access control. No-op in open mode.
async function ensureAuth() {
  let health;
  try {
    health = await request('GET', '/health');
  } catch (e) {
    throw new Error(`relay not reachable at ${HOST}:${PORT}: ${e.message}`);
  }
  const authInfo = health.body && health.body.auth ? health.body.auth : { required: false };
  if (!authInfo.required) {
    return { ok: true, mode: authInfo.mode || 'open' };
  }
  if (authState.token) return { ok: true, mode: authInfo.mode };

  const userId = process.env.AUTH_USER;
  const password = process.env.AUTH_PASS;
  if (!userId || !password) {
    throw new Error('relay requires login — set AUTH_USER and AUTH_PASS in .env (create accounts with: node admin.js add-user)');
  }
  authState.deviceId = stableDeviceId();
  const r = await request('POST', '/auth/login', {
    userId,
    password,
    deviceId: authState.deviceId,
    deviceLabel: `CLI ${os.hostname()}`
  });
  if (r.status !== 200 || !r.body || !r.body.ok || !r.body.token) {
    const code = r.body && (r.body.code || r.body.error);
    throw new Error(`login failed (${r.status}): ${code || 'unknown error'}`);
  }
  authState.token = r.body.token;
  authState.userId = r.body.userId;
  console.log(`Logged in as ${r.body.userId} (mode: ${authInfo.mode})`);
  return { ok: true, mode: authInfo.mode, userId: r.body.userId };
}

module.exports = { request, ensureRelay, ensureAuth, authState };
