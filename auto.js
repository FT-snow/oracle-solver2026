// auto.js — the solver loop: polls /next, answers from the database or Gemini,
// submits to the relay (which clicks happen in the extension).
//
// Efficiency rules baked in:
//   - Local answer DB first (0ms), AI second, manual/guess last.
//   - Only real, currently-available Gemini models are tried (the old list
//     contained dead model names that burned an 8s timeout per question).
//   - If AI cannot answer after several retries, an optional deterministic
//     guess keeps the quiz MOVING instead of stalling forever.

require('./env').loadEnv();
const path = require('path');
const db = require('./db');
const { request, ensureRelay, ensureAuth } = require('./client');
const readline = require('readline');

const ALLOW_FALLBACK_GUESS = (process.env.ALLOW_FALLBACK_GUESS || 'true').toLowerCase() !== 'false';

// --- Answer matching ---------------------------------------------------------

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isAnswerMatch(choice, target) {
  const a = normText(choice);
  const b = normText(target);
  if (a === b) return true;
  // Substring matching ONLY for sufficiently long sentences/descriptions (>= 25 chars)
  // to avoid short collision bugs like "0,1,2,3" vs "0,1,2,3,4" or "CREATE_WRAP" vs "CREATE_WRAPPED"
  if (a.length >= 25 && b.length >= 25) {
    if (a.includes(b) || b.includes(a)) {
      return Math.abs(a.length - b.length) < 20;
    }
  }
  return false;
}

function findChoiceIndex(choices, target) {
  const normTarget = normText(target);
  // 1. Exact match first across all choices
  for (let i = 0; i < choices.length; i++) {
    if (normText(choices[i]) === normTarget) {
      return i;
    }
  }
  // 2. Fall back to isAnswerMatch only if no exact match exists
  for (let i = 0; i < choices.length; i++) {
    if (isAnswerMatch(choices[i], target)) {
      return i;
    }
  }
  return -1;
}

// Database-first cache: returns choice indices (1-based) or null.
function checkCache(questionText, choices) {
  const rec = db.get(questionText);
  if (!rec || !rec.answerTexts || !rec.answerTexts.length) return null;
  const matched = [];
  for (const ans of rec.answerTexts) {
    const idx = findChoiceIndex(choices, ans);
    if (idx !== -1) matched.push(idx + 1);
  }
  if (matched.length === rec.answerTexts.length && matched.length > 0) {
    return [...new Set(matched)];
  }
  return null;
}

// --- Gemini ------------------------------------------------------------------

// Multi-key rotation: reads from GEMINI_API_KEYS (comma-separated) or GEMINI_API_KEY
const rawKeys = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(',')
  : (process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : []);
const GEMINI_API_KEYS = rawKeys.map((k) => k.trim()).filter(Boolean);
const keyCooldowns = {};

// Real, currently-available models only (cheap/fast lite models first).
const CANDIDATE_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.0-flash'
];

function printQuestion(q) {
  const line = '='.repeat(60);
  console.log('\n' + line);
  if (q.extractionFailed) {
    console.log('!!! EXTRACTION FAILED on the quiz page — raw text below !!!');
    console.log(line);
    console.log(q.question);
    console.log(line);
    return;
  }
  console.log(`QUESTION (qid=${q.qid})`);
  console.log('-'.repeat(60));
  console.log(q.question || '(question text not extracted)');
  console.log('-'.repeat(60));
  console.log('Choices:');
  q.choices.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
  console.log(line);
}

async function askGemini(questionText, choices) {
  if (!GEMINI_API_KEYS.length) return null;

  const chooseCountMatch = questionText.match(/choose\s+(one|two|three|four|five|\d+)/i);
  let instruction = 'Respond ONLY with the option number (e.g. 1).';
  if (chooseCountMatch) {
    instruction = `Choose ${chooseCountMatch[0]} option numbers separated by commas (e.g. 1,3).`;
  } else if (/choose\s+all/i.test(questionText)) {
    instruction = 'Choose all correct option numbers separated by commas (e.g. 1,2,4).';
  }

  const prompt = `Oracle Academy Exam Question.
Instructions: ${instruction} Do not explain. Output option numbers only.

Question:
${questionText.replace(/Question\s+\d+\s+of\s+\d+/i, '').trim()}

Choices:
${choices.map((c, i) => `[${i + 1}] ${c}`).join('\n')}

Answer:`;

  const now = Date.now();
  for (const key of GEMINI_API_KEYS) {
    for (const model of CANDIDATE_MODELS) {
      const cooldownKey = `${key.slice(0, 10)}_${model}`;
      if (keyCooldowns[cooldownKey] && keyCooldowns[cooldownKey] > now) continue;

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': key
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 200, temperature: 0.0 }
            }),
            signal: AbortSignal.timeout(8000)
          }
        );

        if (!res.ok) {
          const errText = await res.text();
          console.warn(`[Key ${key.slice(0, 14)}.. | ${model} HTTP ${res.status}]: ${errText.slice(0, 80)}`);
          if (res.status === 429) {
            keyCooldowns[cooldownKey] = Date.now() + 60000;
          }
          continue;
        }

        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        console.log(`[${model}] raw response: "${raw}"`);
        const indices = parseAnswerIndices(raw, choices.length);
        if (indices) return indices;
      } catch (err) {
        console.warn(`[Key ${key.slice(0, 14)}.. | ${model} error: ${err.message}]`);
      }
    }
  }
  return null;
}

function parseAnswerIndices(text, maxChoice) {
  const matches = text.match(/\d+/g);
  if (!matches) return null;
  const indices = [...new Set(matches.map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= maxChoice))];
  return indices.length ? indices : null;
}

function askUser(rl, promptText) {
  return new Promise((resolve) => rl.question(promptText, resolve));
}

async function main() {
  console.log('Starting Auto Runner...');
  if (GEMINI_API_KEYS.length) {
    console.log(`Loaded ${GEMINI_API_KEYS.length} Gemini API key(s) for auto-solve.`);
  } else {
    console.log('Notice: No GEMINI_API_KEY set. (Create .env or set GEMINI_API_KEY env var to enable AI auto-solve).');
  }
  await ensureRelay();
  console.log('Connected to relay on 127.0.0.1:8787.');
  await ensureAuth();

  const stats = db.stats();
  console.log(`Answer database ready: ${stats.total} questions (${Object.entries(stats.bySource).map(([k, v]) => `${k}: ${v}`).join(', ') || 'empty'}).`);
  console.log('Waiting for questions...');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let lastAnsweredQid = 0;

  for (;;) {
    try {
      const r = await request('GET', '/next');
      if (r.status === 200 && r.body && r.body.qid && r.body.qid !== lastAnsweredQid) {
        const q = r.body;
        printQuestion(q);

        let selectedIndices = null;
        let source = 'manual';

        // 1. Check the answer database for an instant 0ms response
        const cachedIndices = checkCache(q.question, q.choices);
        if (cachedIndices) {
          console.log(`\u26A1 [DB HIT - 0ms]: [${cachedIndices.join(', ')}] -> ${cachedIndices.map((i) => q.choices[i - 1]).join('; ')}`);
          selectedIndices = cachedIndices;
          source = 'cache';
        }

        // 2. Try Gemini auto-solve if not in the database
        if (!selectedIndices && GEMINI_API_KEYS.length && q.choices && q.choices.length > 0) {
          console.log('Querying AI for the answer...');
          selectedIndices = await askGemini(q.question, q.choices);
          if (selectedIndices) {
            console.log(`AI selected: [${selectedIndices.join(', ')}] -> ${selectedIndices.map((i) => q.choices[i - 1]).join('; ')}`);
            source = 'ai';
          }
        }

        // 3. Manual input (TTY) or bounded AI retries (headless)
        let retryCount = 0;
        while (!selectedIndices) {
          if (process.stdin.isTTY) {
            const input = await askUser(rl, `Enter answer (1-${q.choices.length}, comma-separated if multiple): `);
            selectedIndices = parseAnswerIndices(input, q.choices.length);
          } else {
            console.log('Retrying AI in 2 seconds...');
            await new Promise((r) => setTimeout(r, 2000));
            selectedIndices = await askGemini(q.question, q.choices);
            retryCount++;
            if (retryCount > 5) break;
          }
        }

        // 4. Deterministic fallback guess so the quiz keeps moving
        if (!selectedIndices && ALLOW_FALLBACK_GUESS && q.choices && q.choices.length > 0) {
          selectedIndices = [1];
          source = 'guess';
          console.warn(`FALLBACK GUESS: choosing [1] "${q.choices[0]}" — set ALLOW_FALLBACK_GUESS=false to disable.`);
        }

        if (!selectedIndices) {
          console.warn('Could not determine answer for qid=' + q.qid);
          continue;
        }

        // 5. Submit answer to relay (relay stores it in the answer DB + cloud)
        const ansRes = await request('POST', '/answer', { qid: q.qid, n: selectedIndices, source });
        if (ansRes.status === 200) {
          console.log(`Submitted answer [${selectedIndices.join(',')}] for qid=${q.qid} (source: ${source}).`);
          lastAnsweredQid = q.qid;
          const qNumMatch = q.question.match(/Question\s+(\d+)\s+of\s+(\d+)/i);
          const isFinalQuestion = qNumMatch && parseInt(qNumMatch[1], 10) === parseInt(qNumMatch[2], 10);
          if (isFinalQuestion) {
            console.log('\n============================================================');
            console.log(`*** FINAL QUESTION (${qNumMatch[1]} of ${qNumMatch[2]}) SUBMITTED! ***`);
            console.log('*** Extension will click "Complete Assessment" and move to the next section. ***');
            console.log('============================================================\n');
          } else {
            console.log('Extension will click and submit on page. Waiting for next question...\n');
          }
        } else if (ansRes.status === 409) {
          console.log('Question changed/stale, re-polling...');
        } else {
          console.error(`Failed to submit: ${ansRes.body ? ansRes.body.error : 'unknown error'}`);
        }
      }
    } catch (err) {
      console.error('Error during poll:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error('auto.js failed:', err.message);
  process.exit(1);
});
