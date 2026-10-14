# PDF Auto-Complete + Quiz Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-click "Save and Continue" on every PDF page and "Start Quiz" at section end, then hand off seamlessly to the existing quiz-answering flow.

**Architecture:** A mode dispatcher at the top of `main()` in the existing content script checks, in order: PDF save button → start-quiz button → question marker → idle. PDF/start clicks are browser-side only; the quiz path is untouched. Tests are plain-Node fake-DOM harnesses (existing project pattern, no test framework).

**Tech Stack:** Vanilla Node.js (no dependencies), Chrome MV3 content script, existing local relay (`relay.js`).

## Global Constraints

- Not a git repository: **no commit steps** — verification is harness output + `node --check`.
- Exactly one production file changes: `extension/content.js`. `relay.js`, `wait.js`, `answer.js` are untouched.
- No new npm dependencies; test harness must run with bare `node <file>`.
- After implementation, the user must reload the extension at `chrome://extensions` and refresh the page (content scripts only load on page load).
- Button text matching is case-insensitive on whitespace-normalized visible text; match only interactive elements (`button, a, input[type="button"], input[type="submit"]`), never whole-page prose.
- Constants: `PDF_CLICK_DELAY_MS = 500`, ready-state wait cap `5000` ms.

---

### Task 1: Page-mode dispatcher (PDF / Start-Quiz / Idle)

**Files:**
- Create: `tests/pdf-mode.test.js`
- Modify: `extension/content.js` — inside the `main()` function (currently starts around line 235) and a small helper block inserted just before it (after `submit()`).

**Interfaces:**
- Consumes: existing `norm()` (defined earlier in the file), `bodyText()`, `extract()`, `failCount()`/`setFailCount()`, `api()`, `log()`/`warn()`, `sleep()`.
- Produces:
  - `findButton(re: RegExp) -> Element | null`
  - `clickAfterLoad(flag: string, el: Element, label: string) -> Promise<void>`
  - `PDF_CLICK_DELAY_MS: number` (500)
  - `window.__pdfRelaySaveClicked`, `window.__pdfRelayStartQuizClicked` once-guards
- Test consumes: the content script is loaded via `require()` with stubbed `window/document/fetch/sessionStorage`; it asserts on a shared `clicks` array and a `posts` array.

- [ ] **Step 1: Write the failing test harness**

Create `tests/pdf-mode.test.js` with this exact content:

```js
const path = require('path');

const scenario = process.argv[2];
const contentPath = path.join(__dirname, '..', 'extension', 'content.js');

const posts = [];
const clicks = [];

function matchesSel(e, sel) {
  if (sel === '*') return true;
  if (sel === 'input') return e.tag === 'input';
  if (sel === 'label') return e.tag === 'label';
  if (sel === 'button' || sel === 'a') return e.tag === sel;
  if (sel === 'input[type="radio"], input[type="checkbox"]')
    return e.tag === 'input' && (e.type === 'radio' || e.type === 'checkbox');
  if (sel === 'button, a, input[type="button"], input[type="submit"]')
    return e.tag === 'button' || e.tag === 'a' || (e.tag === 'input' && (e.type === 'button' || e.type === 'submit'));
  const m = sel.match(/^label\[for="(.*)"\]$/);
  if (m) return e.tag === 'label' && e.id === m[1];
  return false;
}

function queryAll(root, sel) {
  const out = [];
  const walk = (e) => {
    if (e !== root && matchesSel(e, sel)) out.push(e);
    for (const c of e.children) walk(c);
  };
  for (const c of root.children) walk(c);
  return out;
}

function el(tag, opts = {}) {
  const e = {
    tag,
    id: opts.id || '',
    type: opts.type || '',
    value: opts.value || '',
    innerText: opts.text || '',
    children: [],
    parent: null,
    checked: false,
    matches(sel) {
      if (sel === 'input') return tag === 'input';
      if (sel === 'label') return tag === 'label';
      return false;
    },
    closest(sel) {
      let p = e.parent;
      while (p) {
        if (p.tag === sel) return p;
        p = p.parent;
      }
      return null;
    },
    querySelector(sel) {
      return queryAll(e, sel)[0] || null;
    },
    querySelectorAll(sel) {
      return queryAll(e, sel);
    },
    click() {
      clicks.push(e);
      if (tag === 'input' && (e.type === 'checkbox' || e.type === 'radio')) e.checked = !e.checked;
    },
    dispatchEvent() {
      return true;
    },
    getAttribute(name) {
      return name === 'value' ? opts.value : null;
    }
  };
  return e;
}

function append(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

let body;
let saveBtn = null;
let startBtn = null;

if (scenario === 'pdf') {
  body = el('body', { text: 'PDF Viewer\nSome pdf content here' });
  const navbar = append(body, el('nav', {}));
  saveBtn = append(navbar, el('button', { text: 'Save and Continue' }));
  append(body, el('input', { type: 'text' }));
} else if (scenario === 'startquiz') {
  body = el('body', { text: 'Section 1 complete\nAll PDFs done' });
  startBtn = append(body, el('a', { text: 'Start the Quiz' }));
} else if (scenario === 'quiz') {
  body = el('body', {
    text: [
      'Question 4 of 15',
      'Today, all industries have a need for database systems. True or False?',
      'Choices:',
      'A unique identifier for each record in a table',
      'A temporary storage area in memory',
      '© 2026, Oracle and/or its affiliates.',
      'Submit Answer'
    ].join('\n')
  });
} else if (scenario === 'idle') {
  body = el('body', { text: 'Course home\nSome navigation here' });
  append(body, el('input', { type: 'text' }));
  append(body, el('button', { text: 'Continue' }));
} else {
  console.error('unknown scenario');
  process.exit(2);
}

global.window = {};
global.CSS = { escape: (s) => s };
global.sessionStorage = {
  _v: {},
  getItem(k) { return this._v[k] || null; },
  setItem(k, v) { this._v[k] = v; }
};
if (typeof global.Event === 'undefined') {
  global.Event = class Event {
    constructor(type) { this.type = type; }
  };
}
global.document = {
  readyState: 'complete',
  body,
  querySelectorAll(sel) {
    if (sel === '*') {
      const all = [];
      const walk = (e) => { all.push(e); e.children.forEach(walk); };
      walk(body);
      return all;
    }
    return queryAll(body, sel);
  },
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  },
  getElementById(id) {
    return this.querySelectorAll('*').find((e) => e.id === id) || null;
  }
};
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/question')) {
    posts.push(JSON.parse(opts.body));
  }
  if (u.includes('/answer-poll')) {
    await new Promise((r) => setTimeout(r, 50));
    return { status: 200, json: async () => ({ ns: null }) };
  }
  return { status: 200, json: async () => ({ qid: 1 }) };
};

require(contentPath);

setTimeout(() => {
  let ok = false;
  if (scenario === 'pdf') {
    ok = clicks.length === 1 && clicks[0] === saveBtn && posts.length === 0;
  } else if (scenario === 'startquiz') {
    ok = clicks.length === 1 && clicks[0] === startBtn && posts.length === 0;
  } else if (scenario === 'quiz') {
    ok = posts.length === 1 && posts[0].choices.length === 2 && posts[0].extractionFailed === false;
  } else if (scenario === 'idle') {
    ok = clicks.length === 0 && posts.length === 0;
  }
  console.log(JSON.stringify({
    scenario,
    clicks: clicks.map((c) => c.tag + ':' + c.innerText.slice(0, 25)),
    posts: posts.length,
    result: ok ? 'PASS' : 'FAIL'
  }));
  process.exit(ok ? 0 : 1);
}, 1400);
```

- [ ] **Step 2: Run all four scenarios to confirm expected failures**

Run:

```powershell
node tests\pdf-mode.test.js pdf; node tests\pdf-mode.test.js startquiz; node tests\pdf-mode.test.js quiz; node tests\pdf-mode.test.js idle
```

Expected:
- `pdf` → FAIL (`clicks: []` — old code never clicks Save)
- `startquiz` → FAIL (`clicks: []`)
- `quiz` → PASS (existing extraction already posts this page — regression guard)
- `idle` → FAIL (`posts: 1` — old code posts extraction-failure raw text from pages with inputs)

If `quiz` FAILs, stop and debug before implementing — the baseline is broken.

- [ ] **Step 3: Add the helpers to `extension/content.js`**

Insert immediately after the closing brace of `submit()` (before `async function main()`):

```js
  const PDF_CLICK_DELAY_MS = 500;

  function findButton(re) {
    const els = Array.from(
      document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')
    );
    return els.find((el) => re.test(norm(el.innerText || el.value || ''))) || null;
  }

  async function clickAfterLoad(flag, el, label) {
    const deadline = Date.now() + 5000;
    while (document.readyState !== 'complete' && Date.now() < deadline) {
      await sleep(100);
    }
    await sleep(PDF_CLICK_DELAY_MS);
    if (window[flag]) return;
    window[flag] = true;
    log(label, '- clicking:', norm(el.innerText || el.value || ''));
    el.click();
  }
```

- [ ] **Step 4: Replace the entry logic of `main()` with the dispatcher**

Replace everything from `async function main() {` down to (but not including) the line `setFailCount(0);` with:

```js
  async function main() {
    log('running');

    const saveBtn = findButton(/save\s*(and|&)\s*(continue|next)/i);
    if (saveBtn) {
      await clickAfterLoad('__pdfRelaySaveClicked', saveBtn, 'PDF page');
      return;
    }

    const startBtn = findButton(/start\s*(the\s*)?quiz/i);
    if (startBtn) {
      await clickAfterLoad('__pdfRelayStartQuizClicked', startBtn, 'Start quiz');
      return;
    }

    const text = bodyText();
    const hasQuestionMarker = /question\s*\d/i.test(text);
    if (!hasQuestionMarker) {
      log('no quiz question, save button, or start-quiz link - idling');
      return;
    }

    let data = null;
    try {
      data = extract();
    } catch (e) {
      warn('extractor threw:', e);
    }

    if (!data) {
      const c = failCount() + 1;
      setFailCount(c);
      warn(`Extraction failed (${c}/3). Posting raw text for diagnosis, clicking nothing.`);
      if (c >= 3) warn('Three consecutive extraction failures - stopping until a page loads cleanly.');
      try {
        await api('POST', '/question', {
          question: '(EXTRACTION FAILED - raw page text)\n' + text.slice(0, 3000),
          choices: [],
          extractionFailed: true
        });
      } catch (e) {
        warn('relay unreachable:', e.message);
      }
      return;
    }
```

Everything after `setFailCount(0);` (the payload construction, question POST, and answer-poll loop) stays byte-for-byte identical. Remove now-unused locals `hasQuestionMarker`/`hasInputs` from the old body if the old code's `const text` / `const hasQuestionMarker` / `const hasInputs` lines remain duplicated — the replacement block above declares `text` and `hasQuestionMarker` itself, so delete the old declarations.

- [ ] **Step 5: Syntax check**

Run: `node --check extension\content.js`
Expected: no output (exit 0).

- [ ] **Step 6: Run all four scenarios and verify PASS**

Run:

```powershell
node tests\pdf-mode.test.js pdf; node tests\pdf-mode.test.js startquiz; node tests\pdf-mode.test.js quiz; node tests\pdf-mode.test.js idle
```

Expected: all four print `"result":"PASS"` and exit 0.

- [ ] **Step 7: Manual gate — reload the extension**

Tell the user: reload the extension at `chrome://extensions` (⟳ Quiz Relay), then refresh the quiz/course tab. Verify with them that opening a PDF page advances through PDFs automatically and the quiz question posts to the relay as before.

---

## Self-Review

1. **Spec coverage:** PDF mode (Task 1 Step 3-4) ✓; start-quiz mode ✓; quiz mode unchanged (Step 4 keeps post-`setFailCount(0)` body intact, `quiz` regression scenario guards it) ✓; idle mode replaces input-driven extraction-failure posting (Step 4 gate on `hasQuestionMarker`) ✓; error handling — 5s ready-state cap in `clickAfterLoad`, extraction-failure path preserved ✓; testing — all four spec cases are scenarios in the harness ✓; no relay/wait/answer changes ✓.
2. **Placeholders:** none — every step carries full code.
3. **Type consistency:** `findButton(re)`/`clickAfterLoad(flag, el, label)` signatures match between Step 3 (definition) and Step 4 (call sites); once-guard flag names match between implementation and docs; `norm`/`sleep`/`log` are pre-existing functions in the same file.
