const { request, ensureRelay } = require('./client');

function printQuestion(q) {
  const line = '='.repeat(60);
  console.log(line);
  if (q.extractionFailed) {
    console.log('!!! EXTRACTION FAILED on the quiz page — raw text below !!!');
    console.log(line);
    console.log(q.question);
    console.log(line);
    console.log('The extension will NOT click anything. Inspect the raw text above.');
    return;
  }
  console.log(`QUESTION (qid=${q.qid})`);
  console.log('-'.repeat(60));
  console.log(q.question || '(question text not extracted — use the choices below)');
  console.log('-'.repeat(60));
  console.log('Choices:');
  q.choices.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
  console.log(line);
  console.log(`Reply with: node answer.js <1-${q.choices.length}>`);
  console.log(line);
}

async function main() {
  await ensureRelay();
  for (;;) {
    const r = await request('GET', '/next');
    if (r.status === 200 && r.body && r.body.qid > 0) {
      printQuestion(r.body);
      return;
    }
    // 60s hold timed out with no question — loop and wait again.
  }
}

main().catch((err) => {
  console.error('wait.js failed:', err.message);
  process.exit(1);
});
