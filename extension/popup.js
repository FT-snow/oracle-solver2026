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
    $('relayVal').textContent = 'offline — run: node auto.js';
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

const toggle = $('autopilotToggle');
chrome.storage.local.get(['autopilotEnabled'], (d) => {
  toggle.checked = !d || d.autopilotEnabled !== false;
});
toggle.addEventListener('change', () => {
  chrome.storage.local.set({ autopilotEnabled: toggle.checked });
});

refresh();
setInterval(refresh, 5000);
