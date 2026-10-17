// seed-convex.mjs — one-time import of quiz_cache.json into the shared
// Convex answer database (batches of 250).
//
//   CONVEX_URL=https://<deployment>.convex.site ADMIN_SECRET=... node scripts/seed-convex.mjs
//   (values also come from .env)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// minimal .env loader (no deps)
try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch (e) {}

const CONVEX_URL = (process.env.CONVEX_URL || '').trim().replace(/\/+$/, '');
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();

if (!CONVEX_URL || !ADMIN_SECRET) {
  console.error('Set CONVEX_URL and ADMIN_SECRET (in .env or environment) before seeding.');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'quiz_cache.json'), 'utf8'));
const items = Object.entries(raw)
  .filter(([, answers]) => Array.isArray(answers) && answers.length)
  .map(([question, answerTexts]) => ({ question, answerTexts: answerTexts.map(String) }));

console.log(`Seeding ${items.length} answers to ${CONVEX_URL} ...`);

let seeded = 0;
for (let i = 0; i < items.length; i += 250) {
  const batch = items.slice(i, i + 250);
  const res = await fetch(`${CONVEX_URL}/admin/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ items: batch }),
    signal: AbortSignal.timeout(60000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    console.error(`Batch ${i}-${i + batch.length} failed (HTTP ${res.status}):`, data.error || 'unknown');
    process.exit(1);
  }
  seeded += data.seeded || 0;
  console.log(`  batch ${Math.floor(i / 250) + 1}: +${data.seeded} (total ${seeded})`);
}

console.log(`Done. Seeded/verified ${seeded} answers in the shared database.`);
