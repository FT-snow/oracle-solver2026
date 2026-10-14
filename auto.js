const fs = require('fs');
const path = require('path');
const { request, ensureRelay } = require('./client');
const readline = require('readline');

// Persistent Cache: instant 0ms responses for repeated questions
const CACHE_FILE = path.join(__dirname, 'quiz_cache.json');
let quizCache = {};
try {
  if (fs.existsSync(CACHE_FILE)) {
    quizCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    console.log(`Loaded ${Object.keys(quizCache).length} cached questions from quiz_cache.json.`);
  }
} catch (e) {}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(quizCache, null, 2));
  } catch (e) {}
}

function cleanQuestionKey(q) {
  return String(q || '')
    .replace(/Question\s+\d+\s+of\s+\d+/i, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

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
  // 1. Try exact match first across all choices
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

function checkCache(questionText, choices) {
  const cleanQ = cleanQuestionKey(questionText);
  if (!cleanQ || !quizCache[cleanQ]) return null;
  const cachedAnswers = quizCache[cleanQ];
  const matched = [];
  for (const ans of cachedAnswers) {
    const idx = findChoiceIndex(choices, ans);
    if (idx !== -1) {
      matched.push(idx + 1);
    }
  }
  if (matched.length === cachedAnswers.length && matched.length > 0) {
    return [...new Set(matched)];
  }
  return null;
}

// Load local .env file if present (dependency-free)
const ENV_FILE = path.join(__dirname, '.env');
try {
  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const k = line.slice(0, eqIdx).trim();
        const v = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  }
} catch (e) {}

// Multi-key rotation: reads from GEMINI_API_KEYS (comma-separated) or GEMINI_API_KEY
const rawKeys = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(',')
  : (process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : []);
const GEMINI_API_KEYS = rawKeys.map((k) => k.trim()).filter(Boolean);
const keyCooldowns = {};

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

  const candidateModels = [
    { name: 'gemini-flash-lite-latest', disableThinking: false },
    { name: 'gemini-3.1-flash-lite', disableThinking: false },
    { name: 'gemini-3.5-flash-lite', disableThinking: false },
    { name: 'gemini-flash-latest', disableThinking: false }
  ];

  const now = Date.now();
  for (const key of GEMINI_API_KEYS) {
    for (const m of candidateModels) {
      const cooldownKey = `${key.slice(0, 10)}_${m.name}`;
      if (keyCooldowns[cooldownKey] && keyCooldowns[cooldownKey] > now) continue;

      try {
        const genConfig = {
          maxOutputTokens: 200,
          temperature: 0.0
        };
        if (m.disableThinking) {
          genConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m.name}:generateContent?key=${key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: genConfig
            }),
            signal: AbortSignal.timeout(8000)
          }
        );

        if (!res.ok) {
          const errText = await res.text();
          console.warn(`[Key ${key.slice(0, 14)}.. | ${m.name} HTTP ${res.status}]: ${errText.slice(0, 80)}`);
          if (res.status === 429) {
            keyCooldowns[cooldownKey] = Date.now() + 60000;
          }
          continue;
        }

        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        console.log(`[${m.name}] raw response: "${raw}"`);
        const indices = parseAnswerIndices(raw, choices.length);
        if (indices) return indices;
      } catch (err) {
        console.warn(`[Key ${key.slice(0, 14)}.. | ${m.name} error: ${err.message}]`);
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
  console.log('Connected to Relay on 127.0.0.1:8787. Waiting for questions...');

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

        // 1. Check persistent cache for instant 0ms response
        const cachedIndices = checkCache(q.question, q.choices);
        if (cachedIndices) {
          console.log(`⚡ [CACHE HIT - 0ms]: [${cachedIndices.join(', ')}] -> ${cachedIndices.map(i => q.choices[i-1]).join('; ')}`);
          selectedIndices = cachedIndices;
        }

        // 2. Try Gemini Auto-Solve if not in cache
        if (!selectedIndices && GEMINI_API_KEYS.length && q.choices && q.choices.length > 0) {
          console.log('Querying AI for the answer...');
          selectedIndices = await askGemini(q.question, q.choices);
          if (selectedIndices) {
            console.log(`AI selected: [${selectedIndices.join(', ')}] -> ${selectedIndices.map(i => q.choices[i-1]).join('; ')}`);
            // Cache the result for future instant hits
            const cleanQ = cleanQuestionKey(q.question);
            if (cleanQ) {
              quizCache[cleanQ] = selectedIndices.map(i => q.choices[i-1]);
              saveCache();
            }
          }
        }

        // 2. If AI didn't provide answer
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

        if (!selectedIndices) {
          console.warn('Could not determine answer for qid=' + q.qid);
          continue;
        }

        // 3. Submit answer to relay
        const ansRes = await request('POST', '/answer', { qid: q.qid, n: selectedIndices });
        if (ansRes.status === 200) {
          console.log(`Successfully submitted answer [${selectedIndices.join(',')}] for qid=${q.qid}!`);
          lastAnsweredQid = q.qid;
          const qNumMatch = q.question.match(/Question\s+(\d+)\s+of\s+(\d+)/i);
          const isFinalQuestion = qNumMatch && parseInt(qNumMatch[1], 10) === parseInt(qNumMatch[2], 10);
          if (isFinalQuestion) {
            console.log('\n============================================================');
            console.log(`*** FINAL QUESTION (${qNumMatch[1]} of ${qNumMatch[2]}) SUBMITTED! ***`);
            console.log('*** Please review and click "Complete Assessment" in your browser! ***');
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

main().catch(console.error);
