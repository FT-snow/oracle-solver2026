// pdf-mode.test.js — DOM scenarios for the extension's autopilot.
// Simulates just enough DOM (compound selectors, visibility, class lists) for
// extension/content.js to run its real logic end-to-end.
//
// Usage: node tests/pdf-mode.test.js <scenario>
// Scenarios: pdf | startquiz | quiz | resolve | resolve-group | idle

const path = require('path');

const scenario = process.argv[2];
const contentPath = path.join(__dirname, '..', 'extension', 'content.js');

const posts = [];
const clicks = [];

function matchBranch(e, branch) {
  branch = branch.trim();
  if (branch === '*') return true;
  let m;
  if ((m = branch.match(/^label\[for="(.*)"\]$/))) {
    return e.tag === 'label' && e.id === m[1];
  }
  if ((m = branch.match(/^input\[type="([^"]+)"\]$/))) {
    return e.tag === 'input' && e.type === m[1];
  }
  if ((m = branch.match(/^([a-z]+)\[([a-z-]+)\]$/))) {
    return e.tag === m[1] && !!e.attrs[m[2]];
  }
  if ((m = branch.match(/^\[([a-z-]+)="([^"]+)"\]$/))) {
    return e.attrs[m[1]] === m[2];
  }
  if ((m = branch.match(/^([a-z]+)\.([\w-]+)$/))) {
    return e.tag === m[1] && e.classList.includes(m[2]);
  }
  if (branch.startsWith('.')) {
    return e.classList.includes(branch.slice(1));
  }
  return e.tag === branch;
}

function matchesSel(e, sel) {
  return sel.split(',').some((branch) => matchBranch(e, branch));
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

// Keeps session-scoped state inspectable from assertions.
const sessionStore = {};

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
    classList: opts.class ? String(opts.class).split(/\s+/).filter(Boolean) : [],
    attrs: opts.attrs || {},
    matches(sel) {
      return matchesSel(e, sel);
    },
    closest(sel) {
      let p = e.parent;
      while (p) {
        if (matchesSel(p, sel)) return p;
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
    getBoundingClientRect() {
      return { width: 40, height: 20, top: 10, left: 10 };
    },
    click() {
      clicks.push(e);
      if (tag === 'input' && (e.type === 'checkbox' || e.type === 'radio')) e.checked = !e.checked;
    },
    dispatchEvent() {
      return true;
    },
    getAttribute(name) {
      if (name === 'value') return opts.value || null;
      if (name === 'href') return opts.href || null;
      return e.attrs[name] !== undefined ? e.attrs[name] : null;
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
let radios = [];
let choicesDiv = null;

if (scenario === 'pdf') {
  body = el('body', { text: 'PDF Viewer\nSome pdf content here' });
  const navbar = append(body, el('nav', {}));
  saveBtn = append(navbar, el('button', { text: 'Save and Continue' }));
  append(body, el('input', { type: 'text' }));
} else if (scenario === 'startquiz') {
  body = el('body', { text: 'Section 1 complete\nAll PDFs done' });
  startBtn = append(body, el('a', { text: 'Take an Assessment' }));
} else if (scenario === 'quiz') {
  body = el('body', {
    text: [
      'Home',
      'My Classes',
      'Take the Assessment',
      'Exit',
      'Question 4 of 15',
      'Today, all industries have a need for database systems. True or False?',
      'Choices:',
      'A unique identifier for each record in a table',
      'A temporary storage area in memory',
      '© 2026, Oracle and/or its affiliates.',
      'Submit Answer'
    ].join('\n')
  });
  append(append(body, el('nav', {})), el('a', { text: 'Take the Assessment' }));
} else if (scenario === 'resolve') {
  body = el('body', {
    text: [
      'Question 3 of 15',
      'Pick the right one.',
      'Choices:',
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
      '© 2026, Oracle and/or its affiliates.',
      'Submit Answer'
    ].join('\n')
  });
  const group = append(body, el('div', { text: 'Alpha\nBeta\nGamma\nDelta' }));
  for (const _ of [1, 2, 3, 4]) radios.push(append(group, el('input', { type: 'radio' })));
  append(body, el('button', { text: 'Submit Answer' }));
} else if (scenario === 'resolve-group') {
  body = el('body', {
    text: [
      'Question 2 of 15',
      'Pick the right one.',
      'Choices:',
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
      '© 2026, Oracle and/or its affiliates.',
      'Submit Answer'
    ].join('\n')
  });
  choicesDiv = append(body, el('div', { text: 'Alpha\nBeta\nGamma\nDelta' }));
  append(body, el('button', { text: 'Submit Answer' }));
} else if (scenario === 'results') {
  body = el('body', {
    text: 'Your assessment is now complete!\nScore: 75%\nRetake Assessment'
  });
  const rows = append(body, el('div', {}));
  append(rows, el('div', { text: 'Question 1 of 10 - The TRUNCATE command cannot be rolled back. Correct' }));
  append(rows, el('div', { text: 'Question 3 of 10 - The default number of rollback segments is 10. Incorrect' }));
  append(body, el('button', { text: 'Retake Assessment' }));
} else if (scenario === 'idle') {
  body = el('body', { text: 'Course home\nSome navigation here' });
  append(body, el('input', { type: 'checkbox' }));
  append(body, el('button', { text: 'Continue' }));
} else {
  console.error('unknown scenario');
  process.exit(2);
}

global.window = {
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  addEventListener: () => {}
};
global.CSS = { escape: (s) => s };
global.sessionStorage = {
  _v: sessionStore,
  getItem(k) { return this._v[k] || null; },
  setItem(k, v) { this._v[k] = String(v); },
  removeItem(k) { delete this._v[k]; }
};
if (typeof global.Event === 'undefined') {
  global.Event = class Event {
    constructor(type) { this.type = type; }
  };
}
global.MouseEvent = class MouseEvent extends global.Event {
  constructor(type, opts) {
    super(type);
    Object.assign(this, opts || {});
  }
};
global.document = {
  readyState: 'complete',
  body,
  title: 'Test Page',
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
// Faithful simulation of extension/background.js: routes content-script
// RELAY_FETCH messages through the mocked global fetch.
global.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      const RELAY = 'http://127.0.0.1:8787';
      fetch(RELAY + msg.path, {
        method: msg.method || 'GET',
        headers: msg.body ? { 'Content-Type': 'application/json' } : undefined,
        body: msg.body ? JSON.stringify(msg.body) : undefined
      })
        .then(async (res) => {
          let text;
          if (typeof res.text === 'function') text = await res.text();
          else text = JSON.stringify(await res.json());
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (e) {}
          cb({ ok: true, status: res.status, body: parsed });
        })
        .catch((e) => cb({ ok: false, error: String(e) }));
    },
    onMessage: { addListener: () => {} }
  }
};
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/question')) {
    posts.push(JSON.parse(opts.body));
  }
  if (u.includes('/answer-poll')) {
    if (scenario === 'resolve' || scenario === 'resolve-group') {
      return { status: 200, json: async () => ({ ns: [3] }) };
    }
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
    ok =
      posts.length === 1 &&
      posts[0].choices.length === 2 &&
      posts[0].extractionFailed === false &&
      clicks.length === 0;
  } else if (scenario === 'resolve') {
    ok =
      posts.length === 1 &&
      posts[0].choices.length === 4 &&
      clicks.length === 2 &&
      clicks[0] === radios[2] &&
      clicks[1].innerText === 'Submit Answer';
  } else if (scenario === 'resolve-group') {
    ok =
      posts.length === 1 &&
      posts[0].choices.length === 4 &&
      clicks.length === 2 &&
      clicks[0] === choicesDiv &&
      clicks[1].innerText === 'Submit Answer';
  } else if (scenario === 'idle') {
    ok = clicks.length === 0 && posts.length === 0;
  } else if (scenario === 'results') {
    console.log(JSON.stringify({
      wrongq: JSON.parse(sessionStorage.getItem('wrongq') || '[]').length
    }));
    ok =
      clicks.length === 1 &&
      clicks[0].innerText === 'Retake Assessment' &&
      posts.length === 0 &&
      JSON.parse(sessionStorage.getItem('wrongq') || '[]').length >= 1;
  }
  console.log(JSON.stringify({
    scenario,
    clicks: clicks.map((c) => c.tag + ':' + c.innerText.slice(0, 25)),
    posts: posts.length,
    result: ok ? 'PASS' : 'FAIL'
  }));
  process.exit(ok ? 0 : 1);
}, 1400);
