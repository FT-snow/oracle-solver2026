const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 8787;

function request(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
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
  throw new Error('relay.js failed to start on 127.0.0.1:8787');
}

module.exports = { request, ensureRelay };
