// answers.js — browse the answer database.
//
//   node answers.js                      # latest 25 answers (local DB)
//   node answers.js "rollback"           # search questions + answers
//   node answers.js --limit 100          # more rows
//   node answers.js --source ai          # filter by source (seed/cache/ai/manual/guess)
//   node answers.js --stats              # totals by source
//   node answers.js --cloud              # read the shared Convex database instead

require('./env').loadEnv();

const CONVEX_URL = (process.env.CONVEX_URL || '').trim().replace(/\/+$/, '');
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));

const search = positional[0] || '';
const limit = (flags.find((f) => f.startsWith('--limit')) || '').split('=')[1] || undefined;
const source = (flags.find((f) => f.startsWith('--source')) || '').split('=')[1] || undefined;
const useCloud = flags.includes('--cloud');
const wantStats = flags.includes('--stats');

function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function runCloud() {
  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  if (limit) qs.set('limit', limit);
  if (source) qs.set('source', source);
  const pathName = wantStats ? '/answers/stats' : `/answers?${qs.toString()}`;
  const res = await fetch(CONVEX_URL + pathName, {
    headers: { 'x-admin-secret': ADMIN_SECRET },
    signal: AbortSignal.timeout(12000)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    console.error(`Cloud query failed (HTTP ${res.status}) — is ADMIN_SECRET set in .env?`);
    process.exit(1);
  }
  return data;
}

function printStats(s, where) {
  console.log(`Answer database ${where}: ${s.total} questions`);
  for (const [k, v] of Object.entries(s.bySource || {})) {
    console.log(`   ${k.padEnd(8)} ${v}`);
  }
}

function printRows(items) {
  for (const a of items) {
    console.log(`#${a.id} [${a.source}] hits=${a.hits || 0}`);
    console.log(`   Q: ${trunc(a.question, 100)}`);
    console.log(`   A: ${(a.answerTexts || []).join(' | ')}`);
  }
}

async function main() {
  if (useCloud) {
    if (!CONVEX_URL || !ADMIN_SECRET) {
      console.error('--cloud needs CONVEX_URL and ADMIN_SECRET in .env');
      process.exit(1);
    }
    const data = await runCloud();
    if (wantStats) return printStats(data, '(cloud)');
    console.log(`${data.total} result(s) (cloud, showing ${data.items.length})\n`);
    return printRows(data.items);
  }

  const db = require('./db');
  if (wantStats) return printStats(db.stats(), '(local)');
  const { total, items } = db.list({ search, source, limit: limit || 25 });
  console.log(`${total} result(s) (local, showing ${items.length})\n`);
  printRows(items);
}

main().catch((e) => {
  console.error('answers.js failed:', e.message);
  process.exit(1);
});
