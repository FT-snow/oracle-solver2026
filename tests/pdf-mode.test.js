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
} else if (scenario === 'idle') {
  body = el('body', { text: 'Course home\nSome navigation here' });
  append(body, el('input', { type: 'checkbox' }));
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
  }
  console.log(JSON.stringify({
    scenario,
    clicks: clicks.map((c) => c.tag + ':' + c.innerText.slice(0, 25)),
    posts: posts.length,
    result: ok ? 'PASS' : 'FAIL'
  }));
  process.exit(ok ? 0 : 1);
}, 1400);
