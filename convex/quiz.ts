import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// The solve brain: shared database first (0 ms), Gemini second, nothing third.
// Runs as a node action so it can call the Gemini API directly.

// Same matching rules as auto.js (exact, then guarded substring for long texts).
function normText(s: string): string {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isAnswerMatch(choice: string, target: string): boolean {
  const a = normText(choice);
  const b = normText(target);
  if (a === b) return true;
  if (a.length >= 25 && b.length >= 25) {
    if (a.includes(b) || b.includes(a)) {
      return Math.abs(a.length - b.length) < 20;
    }
  }
  return false;
}

export function matchAnswerIndices(choices: string[], answerTexts: string[]): number[] | null {
  const matched: number[] = [];
  for (const ans of answerTexts) {
    let idx = choices.findIndex((c) => normText(c) === normText(ans));
    if (idx === -1) {
      idx = choices.findIndex((c) => isAnswerMatch(c, ans));
    }
    if (idx === -1) return null;
    matched.push(idx + 1);
  }
  if (!matched.length) return null;
  return [...new Set(matched)];
}

const GEMINI_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash"
];

function parseAnswerIndices(text: string, maxChoice: number): number[] | null {
  const matches = String(text || "").match(/\d+/g);
  if (!matches) return null;
  const indices = [...new Set(matches.map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= maxChoice))];
  return indices.length ? indices : null;
}

async function askGemini(key: string, question: string, choices: string[]): Promise<number[] | null> {
  const chooseCountMatch = question.match(/choose\s+(one|two|three|four|five|\d+)/i);
  let instruction = "Respond ONLY with the option number (e.g. 1).";
  if (chooseCountMatch) {
    instruction = `Choose ${chooseCountMatch[0]} option numbers separated by commas (e.g. 1,3).`;
  } else if (/choose\s+all/i.test(questionText(question))) {
    instruction = "Choose all correct option numbers separated by commas (e.g. 1,2,4).";
  }

  const prompt = `Oracle Academy Exam Question.
Instructions: ${instruction} Do not explain. Output option numbers only.

Question:
${question.replace(/Question\s+\d+\s+of\s+\d+/i, "").trim()}

Choices:
${choices.map((c, i) => `[${i + 1}] ${c}`).join("\n")}

Answer:`;

  // Keep the whole solve inside a safe time budget.
  const deadline = Date.now() + 14000;

  for (const model of GEMINI_MODELS) {
    if (Date.now() > deadline) break;
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 200, temperature: 0.0 }
    });
    // Try header auth first (classic keys), fall back to URL auth (newer
    // AI Studio keys occasionally behave differently).
    const attempts = [
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`
    ];
    for (let a = 0; a < attempts.length; a++) {
      if (Date.now() > deadline) break;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (a === 0) headers["x-goog-api-key"] = key;
        const res = await fetch(attempts[a], {
          method: "POST",
          headers,
          body: payload,
          signal: AbortSignal.timeout(6500),
        });
        if (!res.ok) continue; // (rate limit / auth style / outage -> next attempt)
        const data = await res.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
        const indices = parseAnswerIndices(raw, choices.length);
        if (indices) return indices;
      } catch {
        /* network hiccup — next attempt */
      }
    }
  }
  return null;
}

function questionText(q: string): string {
  return q || "";
}

export const solveViaGemini = internalAction({
  args: {
    question: v.string(),
    choices: v.array(v.string()),
    key: v.union(v.string(), v.null()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.key || args.choices.length < 2) {
      return { ns: null as number[] | null, source: "none" as string };
    }
    const ns = await askGemini(args.key, args.question, args.choices);
    if (!ns) return { ns: null as number[] | null, source: "ai-failed" as string };

    // Remember it: everyone gets a 0 ms hit next time.
    await ctx.runMutation(internal.answers.upsert, {
      question: args.question,
      choices: args.choices,
      answerTexts: ns.map((n) => args.choices[n - 1]),
      source: "ai",
      answeredBy: args.userId,
    });
    return { ns, source: "ai" };
  },
});
