(() => {
  // Prevent duplicate top-level injection in the same frame
  if (window.__oracleAutoPilotLoaded) return;
  window.__oracleAutoPilotLoaded = true;

  const CONFIG = {
    LOOP_INTERVAL_MS: 350,
    NAV_COOLDOWN_MS: 1500,
    MAX_STALE_REPOSTS: 3,
    REPOST_MIN_INTERVAL_MS: 5000,
    TARGET_OUTLINE_URL:
      'https://academy.oracle.com/pls/f?p=63000:14:405939804972376:::14:P14_ID,P14_COURSE_ID:60121,66&cs=3pD3KfCV_Y_o9BCNmcvKcvrNKUpknT8dmk7GpHCM8e-Tjhq6AI9fEziAq29cP12snqyABLxhS5eBIo_RCuWQw5A',
    TARGET_CLASSES: [
      'Database Foundations',
      'Database Programming with PLSQL',
      'Database Design'
    ]
  };

  let isSolvingQuiz = false;
  let lastNavActionTime = 0;
  let lastReportedState = '';
  let lastSubmittedSnippet = '';
  let lastCompleteAssessmentClickTime = 0;
  let isQuizCompletedAwaitingUser = false;   // was previously an undeclared global (latent bug)

  // Access-control state: the relay tells us via /health whether login is
  // required (cloud mode / local users). When required and not verified, the
  // autopilot stays idle instead of clicking around unauthenticated.
  const authState = { required: null, ok: false, checkedAt: 0 };

  // Kill switch controllable from the extension popup.
  let autopilotEnabled = true;

  // Course-outline helpers state
  let lastOutlineNavTime = 0;

  // Quiz watchdog state: same "Question X of Y" stuck on screen for too long
  const quizWatch = { qNum: '', firstSeen: 0, submitRetried: false, altTried: false, reloadQueued: false };

  // Force-guess counter: relay could not answer this question N times
  let unansweredAttempts = 0;
  let lastSnippetPosted = '';

  const log = (...a) => console.log('[autopilot]', ...a);
  const warn = (...a) => console.warn('[autopilot]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Never let a scroll failure abort a click flow (some embedded/boundary
  // contexts throw on scrollIntoView).
  function safeScrollIntoView(el) {
    try {
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (e) {}
  }

  // Ensure PL/SQL is not prematurely marked complete in localStorage
  try {
    const raw = localStorage.getItem('oracle_completed_classes');
    if (raw) {
      let arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr = arr.filter((c) => !c.toLowerCase().includes('plsql') && !c.toLowerCase().includes('pl/sql'));
        localStorage.setItem('oracle_completed_classes', JSON.stringify(arr));
      }
    }
  } catch (e) {}

  async function api(method, path, body) {
    return new Promise((resolve, reject) => {
      // Preferred route: background service worker (avoids mixed-content/PNA
      // issues from the https page). Fallback: direct fetch with CORS (relay
      // sends Access-Control-Allow-Origin: *) when the extension context is
      // unavailable (e.g. invalidated during reload).
      const send = () => {
        fetch('http://127.0.0.1:8787' + path, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined
        })
          .then(async (res) => {
            let parsed = null;
            try {
              parsed = await res.json();
            } catch (e) {}
            if (res.status === 401) {
              authState.required = true;
              authState.ok = false;
              authState.checkedAt = Date.now();
            }
            if (!res.ok) return reject(new Error(parsed && parsed.error ? parsed.error : 'HTTP ' + res.status));
            resolve({ status: res.status, body: parsed });
          })
          .catch((e) => reject(new Error(String(e && e.message ? e.message : e))));
      };

      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          send();
          return;
        }
        chrome.runtime.sendMessage({ type: 'RELAY_FETCH', method, path, body }, (res) => {
          if (chrome.runtime.lastError) {
            // Background unreachable — degrade to direct fetch instead of dying.
            send();
            return;
          }
          if (res && res.status === 401) {
            // Token rejected/expired — background.js clears the session; the
            // autopilot will idle until the user logs in from the popup.
            authState.required = true;
            authState.ok = false;
            authState.checkedAt = Date.now();
          }
          if (!res || !res.ok) {
            return reject(new Error(res ? res.error || 'HTTP ' + res.status : 'Network request failed'));
          }
          resolve({ status: res.status, body: res.body });
        });
      } catch (e) {
        send();
      }
    });
  }

  // Ask the relay whether access control is on and whether our token is valid.
  // Throttled internally to one probe every 4s.
  async function probeAuth(force) {
    const now = Date.now();
    if (!force && now - authState.checkedAt < 4000) return authState;
    authState.checkedAt = now;
    try {
      const h = await api('GET', '/health');
      authState.required = !!(h.body && h.body.auth && h.body.auth.required);
      if (!authState.required) {
        authState.ok = true;
        return authState;
      }
      const w = await api('GET', '/whoami');
      authState.ok = w.status === 200 && !!(w.body && w.body.userId);
    } catch (e) {
      /* relay unreachable — keep last known state */
    }
    return authState;
  }

  // Popup toggle: autopilotEnabled in chrome.storage.local (default true).
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['autopilotEnabled'], (d) => {
        if (d && d.autopilotEnabled === false) autopilotEnabled = false;
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'autopilotEnabled')) {
          autopilotEnabled = changes.autopilotEnabled.newValue !== false;
          log('Autopilot toggled ' + (autopilotEnabled ? 'ON' : 'OFF') + ' from popup');
        }
      });
    }
  } catch (e) {}

  // Background re-probes auth after login/logout.
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'SESSION_UPDATED') {
          authState.ok = false;
          authState.checkedAt = 0;
          probeAuth(true);
        }
      });
    }
  } catch (e) {}

  function reportState(state, action = '') {
    const key = `${state}|${action}`;
    if (key === lastReportedState) return;
    lastReportedState = key;
    api('POST', '/page-state', {
      title: document.title || '',
      url: typeof location !== 'undefined' ? location.href : '',
      state,
      action
    }).catch(() => {});
  }

  let _cachedText = '';
  let _cachedTextTime = 0;
  function bodyText() {
    const now = Date.now();
    if (now - _cachedTextTime < 80) return _cachedText;
    _cachedText = document.body ? document.body.innerText : '';
    _cachedTextTime = now;
    return _cachedText;
  }

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function textOk(elText, choice) {
    const a = norm(elText);
    const b = norm(choice);
    if (!a || !b) return false;
    if (a === b) return true;
    const delta = Math.abs(a.length - b.length);
    if (delta > 80) return false;
    if (a.includes(b)) return true;
    if (b.includes(a)) return a.length >= 15;
    const snip = b.slice(0, 25);
    return snip.length >= 15 && a.includes(snip);
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function canClickNav() {
    return Date.now() - lastNavActionTime > CONFIG.NAV_COOLDOWN_MS;
  }

  function triggerNavClick(el, description, ignoreCooldown = false) {
    if (!el || (!ignoreCooldown && !canClickNav()) || !isVisible(el)) return false;
    lastNavActionTime = Date.now();
    log(`[Action: ${description}] Clicking:`, el);
    reportState('Navigating', `${description}: ${norm(el.innerText || el.value || '')}`);
    safeScrollIntoView(el);

    const href = el.getAttribute ? el.getAttribute('href') : null;
    if (href && href.startsWith('javascript:')) {
      try {
        const code = href.replace(/^javascript:/i, '');
        const script = document.createElement('script');
        script.textContent = code;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
      } catch (e) {}
    }

    // Synthetic mouse events help APEX handlers notice the interaction; a
    // missing/blocked MouseEvent must never abort the real click below.
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) {}
    el.click();
    return true;
  }

  // --- Modals and Popups ---
  // Strictly disabled: user manually starts assessments and handles modals
  function handleModals() {
    return false;
  }

  // --- Quiz Question Extraction & Solving ---
  function questionFromText() {
    const t = bodyText();
    let m = t.match(/Question\s+\d+\s+of\s+\d+[\s\S]*?(?=Choices)/i);
    if (m) return m[0].trim();
    m = t.match(/Question\s+\d+\s+of\s+\d+[\s\S]*?(?=\n\s*True\s+or\s+False\s*\?\s*\n)/i);
    if (m) return m[0].trim();
    m = t.match(/Question\s*\d+[^\n]*/i);
    return m ? m[0].trim() : '';
  }

  function findClickable(choiceText, allChoices) {
    const b = norm(choiceText);
    if (!b) return null;

    const choices = Array.isArray(allChoices)
      ? allChoices.map((c) => norm(typeof c === 'string' ? c : c.text)).filter(Boolean)
      : [];
    const radioInputs = Array.from(
      document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
    );

    // Direct 1-to-1 match by index
    if (choices.length > 1 && radioInputs.length === choices.length) {
      const idx = choices.indexOf(b);
      if (idx >= 0) return radioInputs[idx];
    }

    // Oracle APEX label & container matching
    for (const inp of radioInputs) {
      if (inp.id) {
        const label = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
        if (label && textOk(label.innerText, b)) return inp;
      }
      const container = inp.closest('tr, li, div.apex-item-option, div');
      if (container && textOk(container.innerText, b)) {
        return inp;
      }
    }

    // Text fallback scanning containers
    const all = Array.from(document.querySelectorAll('label, span, td, div'));
    for (const el of all) {
      if (textOk(el.innerText, b)) {
        const parentContainer = el.closest('tr, li, div');
        const inp = parentContainer
          ? parentContainer.querySelector('input[type="radio"], input[type="checkbox"]')
          : null;
        if (inp) return inp;
        // No input inside — click the matching container itself (div/td/label
        // based quiz UIs where the whole row is the clickable target).
        return el;
      }
    }

    return null;
  }

  function extractDom() {
    const inputs = Array.from(
      document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
    ).filter(isVisible);

    if (inputs.length < 2) return null;

    const groups = new Map();
    for (const inp of inputs) {
      const container = inp.closest('.apex-item-group, .apex-item-checkbox, .apex-item-radio, fieldset, table, ul, .t-Form-inputContainer, div');
      const key = inp.name || container || 'default';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inp);
    }
    let best = null;
    for (const g of groups.values()) {
      if (g.length >= 2 && (!best || g.length > best.length)) best = g;
    }
    if (!best || best.length < 2) best = inputs;
    const choices = [];
    for (const inp of best) {
      let text = '';
      if (inp.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]');
        if (lab) text = lab.innerText.trim();
      }
      if (!text && inp.closest('label')) text = inp.closest('label').innerText.trim();
      if (!text && inp.parentElement) text = inp.parentElement.innerText.trim();
      if (!text) continue;
      let handle = null;
      if (inp.id) handle = { kind: 'id', id: inp.id };
      else if (inp.name && inp.value) handle = { kind: 'name-value', name: inp.name, value: inp.value };
      choices.push({ text, handle });
    }
    if (choices.length < 2) return null;
    return {
      kind: 'dom',
      choices,
      resolve(n) {
        const c = choices[n - 1];
        if (!c) return null;
        if (c.handle) {
          if (c.handle.kind === 'id') {
            const el = document.getElementById(c.handle.id);
            if (el) return el;
          } else {
            const el = document.querySelector(
              'input[name="' +
                CSS.escape(c.handle.name) +
                '"][value="' +
                CSS.escape(c.handle.value) +
                '"]'
            );
            if (el) return el;
          }
        }
        return findClickable(c.text, choices.map((x) => x.text));
      }
    };
  }

  function choiceButtonNodes() {
    const btns = Array.from(document.querySelectorAll('button.choice-SelectArea'));
    if (btns.length >= 2) return btns;
    const ctrs = Array.from(document.querySelectorAll('.choice-Container'));
    if (ctrs.length >= 2) return ctrs;
    return [];
  }

  function extractButtons() {
    const nodes = choiceButtonNodes();
    if (nodes.length < 2) return null;
    const choices = [];
    for (const n of nodes) {
      const t = n.querySelector('.choice-Text') || n;
      const text = norm(t.innerText);
      if (text) choices.push({ text });
    }
    if (choices.length < 2) return null;
    return {
      kind: 'buttons',
      choices,
      resolve(k) {
        const list = choiceButtonNodes();
        const el = list[k - 1];
        if (!el) return null;
        return el.matches('button') ? el : el.querySelector('button') || el;
      }
    };
  }

  function extractText() {
    const t = bodyText();
    let choiceTexts = [];
    const afterChoices = t.split(/Choices[^\n]*/i)[1];
    if (afterChoices !== undefined) {
      const block = afterChoices.split(/Submit Answer|Previous Question|Version\s+\d/i)[0] || '';
      const junk = /^(?:instructions|mark for review|save answer|clear|question\s+\d+\s+of\s+\d+|\u00a9|copyright)/i;
      const oracleBoilerplate = /oracle\s+and\/or\s+its\s+affiliates/i;
      choiceTexts = block
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !junk.test(s) && !oracleBoilerplate.test(s));
    } else if (/True\s+or\s+False\s*\?/i.test(t)) {
      const m = t.match(
        /True\s+or\s+False\s*\?([\s\S]*?)(?:Submit Answer|Previous Question|Version\s+\d)/i
      );
      const block = m ? m[1] : '';
      const seen = new Set();
      for (const line of block.split('\n')) {
        const s = line.trim();
        if (/^(?:true|false)$/i.test(s) && !seen.has(s.toLowerCase())) {
          seen.add(s.toLowerCase());
          choiceTexts.push(s);
        }
      }
      if (choiceTexts.length < 2) choiceTexts = ['True', 'False'];
    } else {
      return null;
    }
    if (choiceTexts.length < 2) return null;
    return {
      kind: 'text',
      question: questionFromText(),
      choices: choiceTexts,
      resolve(n) {
        return findClickable(choiceTexts[n - 1] || '', choiceTexts);
      }
    };
  }

  function extractQuestion() {
    const btns = extractButtons();
    if (btns) return { kind: 'buttons', question: questionFromText(), choices: btns.choices, resolve: btns.resolve };
    const dom = extractDom();
    if (dom) return { kind: 'dom', question: questionFromText(), choices: dom.choices, resolve: dom.resolve };
    return extractText();
  }

  function clickChoice(el) {
    if (!el) return;
    let inp = null;
    let label = null;

    if (el.tagName === 'INPUT') {
      inp = el;
      if (inp.id) {
        label = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
      }
      if (!label) label = inp.closest('label');
    } else if (el.tagName === 'LABEL') {
      label = el;
      if (label.htmlFor) {
        inp = document.getElementById(label.htmlFor);
      }
      if (!inp) inp = label.querySelector('input');
    } else {
      inp = el.querySelector ? el.querySelector('input') : null;
      label = el.querySelector ? el.querySelector('label') : null;
    }

    const target = label || inp || el;
    safeScrollIntoView(target);

    if (inp && (inp.type === 'radio' || inp.type === 'checkbox')) {
      if (!inp.checked) {
        if (label) {
          label.click();
        } else {
          inp.click();
        }
      }
      if (!inp.checked) {
        inp.checked = true;
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    target.click();
  }

  function checkIsLastQuestion() {
    const m = bodyText().match(/question\s+(\d+)\s+of\s+(\d+)/i);
    return m ? parseInt(m[1], 10) === parseInt(m[2], 10) : false;
  }

  function clickCompleteAssessmentButton() {
    const buttons = Array.from(
      document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')
    ).filter(isVisible);

    const btn = buttons.find((b) => {
      const txt = norm(b.innerText || b.value || '').toLowerCase();
      return txt === 'complete assessment' || txt.includes('complete assessment');
    });

    if (btn) {
      log('Clicking Complete Assessment button:', btn);
      safeScrollIntoView(btn);
      lastCompleteAssessmentClickTime = Date.now();
      btn.click();
      return true;
    }
    return false;
  }

  // Escalating fallbacks when the normal "Submit Answer" button can't be found.
  function tryAlternateSubmit() {
    const sels = [
      'button[aria-label*="submit" i]',
      'button[aria-label*="next" i]',
      'a[aria-label*="next" i]',
      '.submit-button',
      'button[type="submit"]'
    ];
    for (const sel of sels) {
      const el = Array.from(document.querySelectorAll(sel)).find(isVisible);
      if (el) {
        log('Alternate submit click:', sel);
        return triggerNavClick(el, 'Alternate submit: ' + sel, true);
      }
    }
    try {
      const form = document.querySelector('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        log('Dispatched form submit as last resort');
        return true;
      }
    } catch (e) {}
    warn('No alternate submit strategy worked.');
    return false;
  }

  function clickSubmitAnswer() {
    const isLastQuestion = checkIsLastQuestion();

    const buttons = Array.from(
      document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')
    ).filter(isVisible);

    let btn = buttons.find((b) => {
      const txt = norm(b.innerText || b.value || '').toLowerCase();
      return (
        txt.includes('submit answer') ||
        txt === 'next question' ||
        txt === 'next' ||
        txt.includes('save answer')
      );
    });

    if (btn) {
      log('Clicking Submit/Next Question button:', btn);
      safeScrollIntoView(btn);
      btn.click();
    } else {
      warn('Submit Answer button not found — trying alternates.');
      tryAlternateSubmit();
    }
  }

  let solvingQuizStartTime = 0;

  async function runQuizFlow() {
    if (isSolvingQuiz) return;
    isSolvingQuiz = true;
    solvingQuizStartTime = Date.now();
    reportState('Solving Quiz Question');

    try {
      const data = extractQuestion();
      if (!data || !data.choices || data.choices.length < 2) {
        warn('Could not extract active question/choices cleanly.');
        return;
      }

      const snippet = norm(data.question || '').slice(0, 120);
      if (snippet && snippet === lastSubmittedSnippet && Date.now() - lastNavActionTime < 10000) {
        return;
      }

      const payload = {
        question: data.question || '(question text not extracted)',
        choices: data.choices.map((c) => (typeof c === 'string' ? c : c.text)),
        extractionFailed: false
      };

      log(`Posting question: "${payload.question.slice(0, 60)}..." (${payload.choices.length} choices)`);
      lastSnippetPosted = snippet;
      const r = await api('POST', '/question', payload);
      if (r.status !== 200 || !r.body || !r.body.qid) {
        warn('POST /question failed');
        return;
      }

      const qid = r.body.qid;
      log(`Question qid=${qid} posted. Polling for answer...`);

      const pollStartTime = Date.now();
      let answered = false;
      while (Date.now() - pollStartTime < 20000) {
        let poll = null;
        try {
          poll = await api('GET', '/answer-poll?qid=' + qid);
        } catch (e) {
          await sleep(300);
          continue;
        }

        if (poll && poll.body && poll.body.stale) {
          log('Poll reported stale qid');
          break;
        }

        if (poll && poll.body && Array.isArray(poll.body.ns) && poll.body.ns.length) {
          const ns = poll.body.ns;
          log(`Received answer ns=[${ns.join(', ')}]`);
          lastSubmittedSnippet = snippet;
          unansweredAttempts = 0;
          answered = true;
          const isLast = checkIsLastQuestion();
          let clickedAny = false;
          for (const n of ns) {
            const target = data.resolve(n);
            if (target) {
              clickChoice(target);
              clickedAny = true;
              log(`Clicked choice ${n}: "${payload.choices[n - 1]}"`);
              await sleep(60);
            } else {
              warn(`Could not resolve target for choice ${n}`);
            }
          }
          if (clickedAny) {
            await sleep(100);
            clickSubmitAnswer();
            lastNavActionTime = Date.now();
          } else {
            warn('No choice could be clicked — not submitting.');
          }

          if (isLast) {
            log('Last question answered! Pausing briefly before clicking Complete Assessment...');
            await sleep(800);
            await handleTopCompleteAssessment();
          }
          break;
        }
        await sleep(100);
      }

      // The relay could not answer this question (AI down / no key / no cache).
      // After the third failed cycle, force-guess the first choice so the quiz
      // keeps moving instead of looping on the same question forever.
      if (!answered) {
        unansweredAttempts++;
        if (snippet && snippet === lastSnippetPosted && unansweredAttempts >= 3) {
          warn(`No answer after ${unansweredAttempts} attempts — force-guessing choice 1 to keep the quiz moving.`);
          const first = data.resolve(1);
          if (first) clickChoice(first);
          await sleep(120);
          clickSubmitAnswer();
          lastSubmittedSnippet = snippet;
          lastNavActionTime = Date.now();
          unansweredAttempts = 0;
        }
      }
    } catch (e) {
      warn('Quiz solver error:', e.message);
    } finally {
      await sleep(30);
      isSolvingQuiz = false;
    }
  }

  // --- End of Quiz / Submit Assessment ---
  let lastTopCompleteClickTime = 0;
  let lastModalConfirmClickTime = 0;

  function isLastQuestionAnsweredAndSelected() {
    if (!checkIsLastQuestion()) return false;
    const anyChecked = document.querySelector(
      'input[type="radio"]:checked, input[type="checkbox"]:checked, .apex-item-option input:checked'
    ) !== null;
    return anyChecked;
  }

  async function handleConfirmCompleteModal() {
    const text = bodyText();
    const isConfirmModalOpen =
      /Are you sure you want to submit your assessment\?/i.test(text) ||
      /Return to Assessment/i.test(text);

    if (!isConfirmModalOpen) return false;

    if (Date.now() - lastModalConfirmClickTime < 3000) return true;

    const allButtons = Array.from(
      document.querySelectorAll('button, a, input[type="button"], [role="button"]')
    ).filter(isVisible);

    // 1. Find the modal by finding "Return to Assessment" (which uniquely exists only on this popup)
    const returnBtn = allButtons.find((b) => {
      const txt = norm(b.innerText || b.value || '').toLowerCase();
      return txt.includes('return to assessment');
    });

    let completeBtn = null;
    if (returnBtn) {
      let cur = returnBtn.parentElement;
      while (cur && cur !== document.body && !completeBtn) {
        const cands = Array.from(cur.querySelectorAll('button, a, input[type="button"], [role="button"]')).filter(isVisible);
        completeBtn = cands.find((b) => {
          if (b === returnBtn) return false;
          const txt = norm(b.innerText || b.value || '').toLowerCase();
          return txt === 'complete assessment' || txt.includes('complete assessment');
        });
        cur = cur.parentElement;
      }
    }

    // 2. Fallback: Find any Complete Assessment button NOT located in the top header
    if (!completeBtn) {
      const candidates = allButtons.filter((b) => {
        const txt = norm(b.innerText || b.value || '').toLowerCase();
        return txt === 'complete assessment' || txt.includes('complete assessment');
      });
      completeBtn = candidates.find((b) => {
        const inHeader = b.closest('header, #t_Header, .t-Header, .t-Breadcrumb-item, .top-nav');
        const rect = b.getBoundingClientRect();
        return !inHeader && rect.top > 120;
      }) || candidates[candidates.length - 1];
    }

    if (completeBtn) {
      log('Popup Confirmation modal detected! Clicking popup Complete Assessment button:', completeBtn);
      reportState('Completing Assessment', 'Confirming Complete Assessment on modal popup');
      await sleep(700); // short pause on the modal
      lastModalConfirmClickTime = Date.now();
      triggerNavClick(completeBtn, 'Confirm Complete Assessment on Modal', true);

      // Navigate to Course Outline in the same tab as requested
      setTimeout(async () => {
        const dest = await getTargetOutlineUrl();
        log('Navigating to Course Outline link:', dest);
        navigateTop(dest);
      }, 1500);
      return true;
    }

    return false;
  }

  async function handleTopCompleteAssessment() {
    if (Date.now() - lastTopCompleteClickTime < 3000) return false;

    const buttons = Array.from(
      document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]')
    ).filter(isVisible);

    // Specifically target the top header/nav button first
    const topBtn = buttons.find((b) => {
      const txt = norm(b.innerText || b.value || '').toLowerCase();
      const isComplete = txt === 'complete assessment' || txt.includes('complete assessment');
      const inHeader = b.closest('header, #t_Header, .t-Header, .t-Breadcrumb-item, .top-nav');
      const rect = b.getBoundingClientRect();
      return isComplete && (inHeader || rect.top < 150);
    }) || buttons.find((b) => {
      const txt = norm(b.innerText || b.value || '').toLowerCase();
      return txt === 'complete assessment';
    });

    if (topBtn) {
      log('Last question answered! Pausing briefly before clicking top Complete Assessment button...');
      reportState('Completing Assessment', 'Clicking top Complete Assessment button');
      await sleep(700); // short pause before clicking
      lastTopCompleteClickTime = Date.now();
      return triggerNavClick(topBtn, 'Click top Complete Assessment button', true);
    }

    return false;
  }

  // Navigate the TOP window (same-origin) so we never strand the user inside
  // an iframe when redirecting after a quiz completes.
  function navigateTop(url) {
    try {
      if (window.self !== window.top && window.top) {
        window.top.location.href = url;
        return;
      }
    } catch (e) {
      /* cross-origin — fall through to same-frame navigation */
    }
    location.href = url;
  }

  // Remember the CURRENT session's course-outline URL whenever we see it.
  // The old hardcoded TARGET_OUTLINE_URL contained a dead APEX session id +
  // checksum, which is what sent everyone to a broken page after quizzes —
  // the root cause of "it never moves on to the next section".
  function maybeCaptureOutlineUrl() {
    try {
      const href = location.href;
      if (!/f\?p=63000:14/.test(href)) return;
      const stored = sessionStorage.getItem('oracle_outline_url');
      if (stored === href) return;
      const text = bodyText();
      if (/course\s+outline|section|module|chapter|not\s*started|in\s*progress|completed/i.test(text)) {
        sessionStorage.setItem('oracle_outline_url', href);
        log('Captured course outline URL for this session:', href.slice(0, 90));
      }
    } catch (e) {}
  }

  // Dynamically resolves where to go after a quiz: current-session outline URL
  // (captured live) -> redirect_url.txt via relay -> hardcoded last resort.
  async function getTargetOutlineUrl() {
    try {
      const stored = sessionStorage.getItem('oracle_outline_url');
      if (stored && stored.startsWith('http')) return stored.trim();
    } catch (e) {}
    try {
      const res = await api('GET', '/target-url');
      if (res && res.body && typeof res.body.url === 'string' && res.body.url.startsWith('http')) {
        return res.body.url.trim();
      }
    } catch (e) {}
    return CONFIG.TARGET_OUTLINE_URL;
  }

  // --- Score / Results Page Handlers ---
  async function handleScoreScreen() {
    const text = bodyText();
    const isScorePage =
      /percentage\s+scored/i.test(text) ||
      /note\s+your\s+score/i.test(text) ||
      /mastery\s+score/i.test(text) ||
      /assessment\s+complete/i.test(text) ||
      /congratulations/i.test(text);

    if (!isScorePage) return false;

    reportState('Navigating', 'Redirecting from Score Screen to Course Outline');
    const dest = await getTargetOutlineUrl();
    log('Score/Results page detected. Redirecting to Course Outline in the same tab:', dest);
    navigateTop(dest);
    return true;
  }

  // --- Lesson Reading / Slide Advancement ---
  let lastLessonNextClickTime = 0;
  function handleLessonNext() {
    // After "Save and Continue" the same button stays visible until the next
    // slide loads; re-clicking too fast can skip content or double-advance.
    // 3s gives the page time to transition.
    if (Date.now() - lastLessonNextClickTime < 3000) return false;

    const buttons = Array.from(
      document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]')
    ).filter(isVisible);

    // Lesson context prevents clicking generic "Next"/"Continue" buttons on
    // unrelated pages (dashboards, navs) — only advance when the page itself
    // looks like a lesson/slide flow.
    const pageText = bodyText();
    const lessonCtx = /save\s*(and|&)\s*(continue|progress|next)|next\s*(slide|lesson)|mark\s*as\s*complete|slide\s+\d+\s+of\s+\d+/i.test(pageText);

    for (const b of buttons) {
      const txt = norm(b.innerText || b.value || '').toLowerCase();
      const explicit =
        txt.includes('save and continue') ||
        txt.includes('save & continue') ||
        txt.includes('save progress') ||
        txt.includes('save & progress') ||
        txt.includes('save and next') ||
        txt.includes('save & next') ||
        txt === 'next lesson' ||
        txt === 'next slide' ||
        txt === 'mark as complete';
      const generic = txt === 'continue' || txt === 'next';
      if (explicit || (generic && lessonCtx)) {
        lastLessonNextClickTime = Date.now();
        log(`Found lesson advancement button: "${txt}". Clicking once and waiting...`);
        return triggerNavClick(b, `Advance Lesson: ${txt}`, true);
      }
    }
    return false;
  }

  // --- Start Assessment / Quiz ---
  async function handleStartAssessment() {
    const text = bodyText();

    // 1. Check if the Start Assessment Popup Modal is visible
    const isModalOpen =
      /Click\s+Start\s+to\s+begin\s+assessment/i.test(text) ||
      /first\s+of\s+unlimited\s+attempts/i.test(text) ||
      /begin\s+assessment/i.test(text);

    if (isModalOpen) {
      const buttons = Array.from(
        document.querySelectorAll('button, a, input[type="button"], [role="button"]')
      ).filter(isVisible);

      const startBtn = buttons.find((b) => {
        const txt = norm(b.innerText || b.value || '').toLowerCase();
        return txt === 'start' || txt === 'start assessment' || txt === 'begin assessment';
      });

      if (startBtn) {
        log('Found "Start" button on popup modal! Pausing briefly before clicking...');
        reportState('Starting Assessment', 'Clicking Start button on popup');
        await sleep(700); // short pause on the popup as requested
        const clicked = triggerNavClick(startBtn, 'Click Start on Popup Modal', true);
        if (clicked) {
          log('Start button clicked! Waiting 1000ms for quiz to settle...');
          await sleep(1000); // wait 1 second after pressing start
          return true;
        }
        return false;
      }
    }

    // 2. Check if the "Take an Assessment" button is present on the page
    const buttons = Array.from(
      document.querySelectorAll('button, a, input[type="button"], [role="button"]')
    ).filter(isVisible);

    const takeAssessmentBtn = buttons.find((b) => {
      const txt = norm(b.innerText || b.value || '').toLowerCase();
      return txt === 'take an assessment' || txt.includes('take an assessment');
    });

    if (takeAssessmentBtn) {
      log('Found "Take an Assessment" button. Clicking...');
      return triggerNavClick(takeAssessmentBtn, 'Click Take an Assessment');
    }

    return false;
  }

  // --- Course Outline Navigation ---
  // Automatically opens the NEXT unfinished section on the course outline page
  // (prefers "In Progress", then "Not Started"; never touches "Completed").
  function handleCourseOutline() {
    const href = (typeof location !== 'undefined' && location.href) || '';
    if (!/f\?p=63000:14/.test(href)) return false;
    if (Date.now() - lastOutlineNavTime < 4000) return false;

    const text = bodyText();
    if (!/not\s*started|in\s*progress|resume|continue|completed/i.test(text)) return false;

    const clickables = Array.from(
      document.querySelectorAll('a, button, [role="button"], tr[onclick]')
    ).filter(isVisible);

    const candidates = [];
    for (const el of clickables) {
      // Find the most specific enclosing row that carries a status string.
      let container = el.closest('tr, li, article') || el.closest('.row, div.t-Report-row') || el;
      let statusText = norm(container.innerText || '');
      if (statusText.length > 400) {
        container = el.closest('tr, li') || el;
        statusText = norm(container.innerText || '');
      }
      if (statusText.length > 400) continue;

      const s = statusText.toLowerCase();
      if (/\bcompleted\b|100\s*%|passed|score\s*report/i.test(s)) continue; // finished — skip
      let score = 0;
      if (/in\s*progress|resume|continue/i.test(s)) score += 2;
      if (/not\s*started/i.test(s)) score += 1;
      if (score === 0) continue;
      score -= Math.min(statusText.length / 200, 1); // prefer tighter rows
      candidates.push({ el, score, statusText });
    }

    if (!candidates.length) return false;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    lastOutlineNavTime = Date.now();
    log('Course outline: opening next section ->', best.statusText.slice(0, 80));
    return triggerNavClick(best.el, `Open next section: ${best.statusText.slice(0, 40)}`, true);
  }

  // --- Front Page Handlers (p=63000:1) ---
  function handleFrontPage() {
    const text = bodyText();
    if (!/my\s*student\s*benefits/i.test(text)) {
      return false;
    }
    const all = Array.from(document.querySelectorAll('a, button, h2, h3, h4, span, div')).filter(isVisible);
    for (const el of all) {
      if (norm(el.innerText) === 'My Classes') {
        const clickable = el.closest('a') || (el.tagName === 'A' ? el : el.parentElement.querySelector('a') || el);
        return triggerNavClick(clickable, 'Click My Classes from Front Page');
      }
    }
    return false;
  }

  // --- Classes Dashboard ("Take Class") ---
  function findTakeClassButtonFor(targetCls) {
    const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const targetClean = clean(targetCls);

    const allTakeButtons = Array.from(document.querySelectorAll('button, a')).filter((b) => {
      const txt = norm(b.innerText || b.value || '').toLowerCase();
      return isVisible(b) && (txt === 'take class' || txt.includes('take class'));
    });

    for (const btn of allTakeButtons) {
      let cur = btn.parentElement;
      while (cur && cur !== document.body) {
        const textClean = clean(cur.innerText || '');
        if (textClean.includes(targetClean)) {
          // Verify this container does NOT contain sibling target classes (prevent parent grid matching)
          const otherClasses = CONFIG.TARGET_CLASSES.filter((c) => clean(c) !== targetClean);
          const hasOthers = otherClasses.some((other) => textClean.includes(clean(other)));
          if (!hasOthers) {
            return btn;
          }
        }
        cur = cur.parentElement;
      }
    }
    return null;
  }

  function handleClassesDashboard() {
    const text = bodyText();
    if (!/classes/i.test(text) && !/my\s*classes/i.test(text)) return false;

    let completedCourses = ['Database Foundations'];
    try {
      const stored = JSON.parse(localStorage.getItem('oracle_completed_classes') || '[]');
      completedCourses = Array.from(new Set([...completedCourses, ...stored]));
    } catch (e) {}

    const clean = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const targetCls of CONFIG.TARGET_CLASSES) {
      if (completedCourses.some((c) => clean(c) === clean(targetCls))) {
        continue;
      }

      const takeBtn = findTakeClassButtonFor(targetCls);
      if (takeBtn) {
        log(`Found isolated Take Class button for "${targetCls}":`, takeBtn);
        return triggerNavClick(takeBtn, `Enter Next Class: ${targetCls}`);
      }
    }

    return false;
  }

  let lastSeenUrl = typeof location !== 'undefined' ? location.href : '';

  // Current "Question X of Y" identifier, e.g. "4/15" ('' when not on a quiz).
  function questionNumberOnPage() {
    const m = bodyText().match(/question\s+(\d+)\s+of\s+(\d+)/i);
    return m ? `${m[1]}/${m[2]}` : '';
  }

  // Watchdog: if the SAME question number stays on screen for 20s/45s/75s we
  // escalate — re-click submit -> alternate submit strategies -> one reload.
  // This is what un-sticks the "keeps solving the same question" failure mode.
  function quizWatchdogTick() {
    const qNum = questionNumberOnPage();
    if (!qNum) {
      quizWatch.qNum = '';
      return;
    }
    if (qNum !== quizWatch.qNum) {
      quizWatch.qNum = qNum;
      quizWatch.firstSeen = Date.now();
      quizWatch.submitRetried = false;
      quizWatch.altTried = false;
      quizWatch.reloadQueued = false;
      return;
    }
    const stuckMs = Date.now() - quizWatch.firstSeen;
    if (stuckMs < 20000 || Date.now() - lastNavActionTime < 3000) return;

    if (stuckMs > 75000 && !quizWatch.reloadQueued) {
      quizWatch.reloadQueued = true;
      const lastReload = parseInt(sessionStorage.getItem('quiz_reload_at') || '0', 10);
      if (Date.now() - lastReload > 90000) {
        sessionStorage.setItem('quiz_reload_at', String(Date.now()));
        warn('Question stuck for >75s — reloading the page once to recover.');
        location.reload();
        return;
      }
    }
    if (stuckMs > 45000 && !quizWatch.altTried) {
      quizWatch.altTried = true;
      warn('Question stuck for >45s — trying alternate submit strategies.');
      tryAlternateSubmit();
      return;
    }
    if (!quizWatch.submitRetried) {
      quizWatch.submitRetried = true;
      warn('Question stuck for >20s — re-clicking Submit Answer.');
      clickSubmitAnswer();
    }
  }

  // --- Main Autopilot Loop ---
  async function autopilotCycle() {
    const currentHref = typeof location !== 'undefined' ? location.href : '';
    if (currentHref !== lastSeenUrl) {
      lastSeenUrl = currentHref;
      lastSubmittedSnippet = '';
      unansweredAttempts = 0;
    }

    if (isSolvingQuiz) {
      if (solvingQuizStartTime && Date.now() - solvingQuizStartTime > 20000) {
        warn('runQuizFlow hung for >20s, resetting isSolvingQuiz flag');
        isSolvingQuiz = false;
      } else {
        return;
      }
    }

    // 0. Kill switch (popup toggle)
    if (!autopilotEnabled) return;

    // 0.5 Access control: idle while locked out (popup login required).
    await probeAuth();
    if (authState.required && !authState.ok) {
      reportState('Locked', 'Login required — open the extension popup and sign in');
      return;
    }

    // Remember the outline URL whenever we see it (enables clean post-quiz redirects).
    maybeCaptureOutlineUrl();

    // 1. Confirm Complete Assessment Modal (if open)
    if (await handleConfirmCompleteModal()) return;

    // 2. Active Quiz Question (Highest Priority)
    const text = bodyText();
    const hasInputs = document.querySelector('input[type="radio"], input[type="checkbox"], button.choice-SelectArea') !== null;
    const hasSubmitHint = /submit\s+answer/i.test(text);
    const hasQuestion =
      /question\s+\d+\s+of\s+\d+/i.test(text) ||
      (hasSubmitHint && (hasInputs || /choices/i.test(text)));

    if (hasQuestion && (hasInputs || hasSubmitHint)) {
      if (checkIsLastQuestion() && isLastQuestionAnsweredAndSelected()) {
        if (await handleTopCompleteAssessment()) return;
      }

      quizWatchdogTick();
      await runQuizFlow();
      return;
    }

    // 3. Score / Results Page -> Redirect to Course Outline in the same tab
    if (await handleScoreScreen()) return;

    // 4. Start Assessment ("Take an Assessment" -> short pause -> popup "Start")
    if (await handleStartAssessment()) return;

    // 5. Lesson slide "Save and Continue" / "Save Progress"
    if (handleLessonNext()) return;

    // 6. Course outline page -> open the next unfinished section automatically
    if (handleCourseOutline()) return;

    // Idle heartbeat reporting
    reportState('Monitoring Page', norm(document.title));
  }

  let autopilotInterval = null;
  function startAutopilot() {
    if (autopilotInterval) return;
    autopilotInterval = setInterval(autopilotCycle, CONFIG.LOOP_INTERVAL_MS);
    log('Autonomous Oracle Auto-Pilot initialized & running.');
  }

  function stopAutopilot() {
    if (autopilotInterval) {
      clearInterval(autopilotInterval);
      autopilotInterval = null;
      log('Autonomous Oracle Auto-Pilot stopped/paused.');
    }
  }

  // Resume automatically whenever URL changes (e.g. back to home/outline)
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('popstate', () => {
      isQuizCompletedAwaitingUser = false;
      startAutopilot();
    });
    window.addEventListener('hashchange', () => {
      isQuizCompletedAwaitingUser = false;
      startAutopilot();
    });
  }

  startAutopilot();
})();