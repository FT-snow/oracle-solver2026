// popup.js — login / session status / autopilot toggle.

const $ = (id) => document.getElementById(id);

function setDot(el, state) {
  el.className = 'dot' + (state ? ' ' + state : '');
}

// A single failed /health or /me call (slow network, cold start) used to flip
// the popup to "offline" instantly. Require 2 consecutive failures instead.
let relayFailStreak = 0;
let keyFailStreak = 0;

function render(session, relay) {
  const required = !!(relay && relay.auth && relay.auth.required);
  const relayOk = !!relay && relay.ok;

  if (relayOk) {
    relayFailStreak = 0;
    setDot($('relayDot'), 'ok');
    $('relayVal').textContent = `online · auth: ${relay.auth ? relay.auth.mode : 'open'}`;
  } else {
    relayFailStreak++;
    if (relayFailStreak < 2) {
      setDot($('relayDot'), 'warn');
      $('relayVal').textContent = 'reconnecting…';
    } else {
      setDot($('relayDot'), 'bad');
      $('relayVal').textContent = 'offline — check your internet';
    }
  }

  if (session) {
    // The stored session stays authoritative through brief network hiccups —
    // never degrade a signed-in user to "relay unreachable"/login form.
    if (relayFailStreak < 2) {
      setDot($('authDot'), 'ok');
      $('authVal').textContent = session.userId || 'signed in';
    } else {
      setDot($('authDot'), 'warn');
      $('authVal').textContent = (session.userId || 'signed in') + ' · offline';
    }
  } else if (!relayOk && relayFailStreak < 2) {
    setDot($('authDot'), 'warn');
    $('authVal').textContent = 'checking…';
  } else if (relayOk && required) {
    setDot($('authDot'), 'bad');
    $('authVal').textContent = 'login required';
  } else if (relayOk) {
    setDot($('authDot'), 'warn');
    $('authVal').textContent = 'open mode (no users)';
  } else {
    setDot($('authDot'), 'bad');
    $('authVal').textContent = 'offline';
  }
}

function showLoginForm(show) {
  $('loginForm').classList.toggle('hidden', !show);
  $('loggedIn').classList.toggle('hidden', show);
}

async function refresh() {
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: 'GET_SESSION' });
  } catch (e) {
    res = null; // background unreachable — render from nothing, retry in 5s
  }
  const session = res && res.session;
  const relay = res && res.relay;
  render(session, relay);
  if (res && res.deviceId) {
    $('deviceVal').textContent = String(res.deviceId).slice(0, 16) + '…';
  }
  showLoginForm(!session);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  const msg = $('loginMsg');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = 'Signing in…';
  const res = await chrome.runtime.sendMessage({
    type: 'LOGIN',
    userId: $('userId').value.trim(),
    password: $('password').value
  });
  btn.disabled = false;
  if (res && res.ok) {
    msg.className = 'msg ok';
    msg.textContent = `Signed in as ${res.userId}.`;
    $('password').value = '';
    setTimeout(refresh, 400);
  } else {
    msg.className = 'msg err';
    msg.textContent = (res && res.error) || 'Login failed.';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'LOGOUT' });
  refresh();
});

// ---- Start / Stop solving ---------------------------------------------------

const solveBtn = $('solveBtn');
const solveState = $('solveState');
const toggle = $('autopilotToggle');

function renderSolveState(enabled) {
  solveBtn.textContent = enabled ? '■ STOP SOLVING' : '▶ START SOLVING';
  solveBtn.style.background = enabled ? 'var(--danger)' : 'var(--text)';
  solveBtn.style.color = enabled ? 'var(--bg)' : 'var(--bg)';
  solveState.textContent = enabled
    ? 'running — open an academy.oracle.com tab'
    : 'stopped — press start on your Oracle tab';
}

function setSolve(enabled) {
  chrome.storage.local.set({ autopilotEnabled: !!enabled });
  toggle.checked = !!enabled;
  renderSolveState(enabled);
}

solveBtn.addEventListener('click', () => {
  setSolve(!toggle.checked);
});

chrome.storage.local.get(['autopilotEnabled'], (d) => {
  const enabled = !d || d.autopilotEnabled !== false;
  renderSolveState(enabled);
});
toggle.addEventListener('change', () => {
  setSolve(toggle.checked);
});

const reloadTabBtn = $('reloadTabBtn');
if (reloadTabBtn) {
  reloadTabBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        try {
          chrome.tabs.reload(tabs[0].id);
          window.close();
        } catch (e) {}
      }
    });
  });
}

// ---- Per-user Gemini API key ------------------------------------------------

function maskKey(k) {
  return k.slice(0, 6) + '•••' + k.slice(-4);
}

async function refreshKey() {
  try {
    const me = await chrome.runtime.sendMessage({ type: 'RELAY_FETCH', method: 'GET', path: '/me' });
    if (me && me.ok && me.status === 200 && me.body && me.body.ok) {
      keyFailStreak = 0;
      $('keyState').innerHTML = me.body.hasKey
        ? 'configured — <span style="color:var(--accent)">your key will be used automatically</span>'
        : 'not set — save a key here; unseen questions fall back to the operator key';
    } else if (me && me.status === 401) {
      keyFailStreak = 0;
      $('keyState').textContent = 'sign in first';
    } else {
      keyFailStreak++;
      $('keyState').textContent = keyFailStreak < 2 ? 'checking…' : 'cloud unreachable';
    }
  } catch (e) {
    keyFailStreak++;
    $('keyState').textContent = keyFailStreak < 2 ? 'checking…' : 'cloud unreachable';
  }
}

$('keyHelpToggle').addEventListener('click', () => {
  $('keyHelp').classList.toggle('hidden');
});

$('saveKey').addEventListener('click', async () => {
  const key = $('apiInput').value.trim();
  const msg = $('keyMsg');
  msg.className = 'msg';
  const looksValid =
    (key.startsWith('AIza') && key.length >= 30) ||
    (key.startsWith('AQ') && key.length >= 25);
  if (!looksValid) {
    msg.className = 'msg err';
    msg.textContent = 'That does not look like a Google AI Studio key — it should start with AIza… or AQ.…';
    return;
  }
  msg.textContent = 'Saving…';
  const res = await chrome.runtime.sendMessage({ type: 'RELAY_FETCH', method: 'POST', path: '/me/set-key', body: { geminiKey: key } });
  if (res && res.ok && res.status === 200 && res.body && res.body.ok) {
    msg.className = 'msg ok';
    msg.textContent = 'Key saved for your account. New questions outside the database will use it.';
    $('apiInput').value = '';
    refreshKey();
  } else {
    msg.className = 'msg err';
    msg.textContent = (res && res.body && res.body.error) || 'Save failed — is the relay running?';
  }
});

refresh();
setInterval(() => {
  refresh();
  refreshKey();
}, 5000);
refreshKey();
