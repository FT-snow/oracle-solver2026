// run-all.js — runs every test: local DB, local auth, and all extension
// DOM scenarios. Exits non-zero if anything fails.

const { spawnSync } = require('child_process');
const path = require('path');

const results = [];
let failed = 0;

function run(name, args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
  const lastLine = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ name, ok, output: lastLine });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${lastLine && !lastLine.startsWith('PASS') ? '  — ' + lastLine.slice(0, 120) : ''}`);
}

// Extension DOM scenarios
for (const scenario of ['pdf', 'startquiz', 'quiz', 'resolve', 'resolve-group', 'results', 'idle']) {
  run(`extension/${scenario}`, [path.join(__dirname, 'pdf-mode.test.js'), scenario]);
}

// Node-side units
run('db', [path.join(__dirname, 'db.test.js')]);
run('auth', [path.join(__dirname, 'auth.test.js')]);
run('relay', [path.join(__dirname, 'relay.test.js')]);
run('popup-smoke', [path.join(__dirname, 'popup-smoke.test.js')]);

console.log(`\n${results.length - failed}/${results.length} tests passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
