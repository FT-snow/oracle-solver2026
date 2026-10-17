// env.js — dependency-free .env loader shared by all Node entrypoints.
const fs = require('fs');
const path = require('path');

let loaded = false;

function loadEnv(file) {
  if (loaded) return;
  loaded = true;
  const envFile = file || path.join(__dirname, '.env');
  try {
    if (!fs.existsSync(envFile)) return;
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const k = line.slice(0, eqIdx).trim();
      const v = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) {
    /* .env is optional */
  }
}

module.exports = { loadEnv };
