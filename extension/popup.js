// popup.js — login / session status / autopilot toggle.

const $ = (id) => document.getElementById(id);

function setDot(el, state) {
  el.className = 'dot' + (state ? ' ' + state : '');
}

function render(session, relay) {
  const required = !!(relay && relay.auth && relay.auth.required);
  const relayOk = !!relay && relay.ok;

  if (relayOk) {
    setDot($('relayDot'), 'ok');
    $('relayVal').textContent = `online · auth: ${relay.auth ? relay.auth.mode : 'open'}`;
  } else {
    setDot($('relayDot'), 'bad');
    $('relayVal').textContent = 'offline — check your internet';
  }

  if (!relayOk) {
    setDot($('authDot'), 'bad');
    $('authVal').textContent = 'relay unreachable';
  } else if (session) {
    setDot($('authDot'), 'ok');
    $('authVal').textContent = session.userId || 'signed in';
  } else if (required) {
    setDot($('authDot'), 'bad');
    $('authVal').textContent = 'login required';
  } else {
    setDot($('authDot'), 'warn');
    $('authVal').textContent = 'open mode (no users)';
  }
}

function showLoginForm(show) {
  $('loginForm').classList.toggle('hidden', !show);
  $('loggedIn').classList.toggle('hidden', show);
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SESSION' });
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
      $('keyState').innerHTML = me.body.hasKey
        ? 'configured — <span style="color:var(--accent)">your key will be used automatically</span>'
        : 'not set — the solver needs one key saved here (or in the operator .env)';
    } else {
      $('keyState').textContent = me && me.status === 401 ? 'sign in first' : 'relay offline';
    }
  } catch (e) {
    $('keyState').textContent = 'relay offline';
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
