const { request, ensureRelay } = require('./client');

const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  let raw = args.join(',');
  if (!raw) {
    const answerFile = require('path').join(__dirname, 'answer.txt');
    if (fs.existsSync(answerFile)) {
      raw = fs.readFileSync(answerFile, 'utf8').trim();
    }
  }
  const ns = String(raw || '')
    .split(/[,\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((v) => Number.isInteger(v) && v >= 1);
  if (!ns.length) {
    console.error('Usage: node answer.js <n[,n...]> or write n to answer.txt and run: node answer.js');
    process.exit(1);
  }

  await ensureRelay();

  const health = await request('GET', '/health');
  const qid = health.body ? health.body.qid : 0;
  if (!qid) {
    console.error('No question posted yet — load a quiz question and run: node wait.js');
    process.exit(1);
  }

  const r = await request('POST', '/answer', { qid, n: ns });
  if (r.status === 200) {
    console.log(`Answer ${ns.join(',')} submitted for qid=${qid}. The extension will click and submit.`);
    return;
  }
  if (r.status === 409) {
    console.error('Question changed — run: node wait.js');
    process.exit(1);
  }
  console.error(`Relay rejected the answer (${r.status}):`, r.body ? r.body.error : 'no response');
  process.exit(1);
}

main().catch((err) => {
  console.error('answer.js failed:', err.message);
  process.exit(1);
});
