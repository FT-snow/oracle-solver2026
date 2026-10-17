// db.test.js — local answer database behaviour.
process.env.ORACLE_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'osolver-db-'));

const assert = require('assert');
const db = require('../db');

// Seed import from quiz_cache.json ran on first load
const stats0 = db.stats();
assert.ok(stats0.total >= 1000, 'seed import should load >1000 answers, got ' + stats0.total);
assert.strictEqual(stats0.bySource.seed, stats0.total);

// saveAnswer upserts by normalized key
const q = '  Question 5 of 15\nWhich statement removes ALL uncommitted changes? ';
db.saveAnswer({ question: q, choices: ['COMMIT', 'ROLLBACK', 'SAVEPOINT'], answerTexts: ['ROLLBACK'], source: 'ai', answeredBy: 'tester' });
const rec = db.get(q);
assert.ok(rec, 'record should exist');
assert.strictEqual(db.cleanKey(q), rec.key);
assert.strictEqual(rec.source, 'ai');
assert.strictEqual(rec.hits, 1);

// Repeat answer -> hit counter grows, answer unchanged
db.saveAnswer({ question: q, choices: ['COMMIT', 'ROLLBACK', 'SAVEPOINT'], answerTexts: ['ROLLBACK'], source: 'cache', answeredBy: 'tester' });
assert.strictEqual(db.get(q).hits, 2);
assert.strictEqual(db.get(q).source, 'ai');

// Changed answer -> revised
db.saveAnswer({ question: 'Which statement removes ALL uncommitted changes?', choices: ['COMMIT', 'ROLLBACK'], answerTexts: ['COMMIT'], source: 'manual', answeredBy: 'tester' });
const rec2 = db.get(q);
assert.deepStrictEqual(rec2.answerTexts, ['COMMIT']);
assert.strictEqual(rec2.revised, 1);

// lookupAnswerTexts + list + stats + export
assert.deepStrictEqual(db.lookupAnswerTexts(q), ['COMMIT']);
const listed = db.list({ search: 'uncommitted changes' });
assert.ok(listed.items.some((a) => a.key === rec2.key));
const exported = db.exportCacheMap();
assert.deepStrictEqual(exported[rec2.key], ['COMMIT']);
db.flushNow();

console.log('PASS db.test.js —', stats0.total, 'seeded + upsert/hit/revise/list/stats/export verified');
