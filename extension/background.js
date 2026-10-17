// background.js — MV3 service worker: proxies relay requests for content
// scripts (avoids mixed-content issues), owns the login session and the
// per-browser device id used for one-device-per-user locking.

const RELAY = 'http://127.0.0.1:8787';

// ---- Device identity --------------------------------------------------------

async function getStore(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (d) => resolve(d || {}));
    } catch (e) {
      resolve({});
    }
  });
}

async function ensureDeviceId() {
  const d = await getStore(['deviceId']);
  if (d.deviceId) return d.deviceId;
  const id =
    'dev-' +
    (crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36));
  try {
    chrome.storage.local.set({ deviceId: id });
  } catch (e) {}
  return id;
}

function deviceLabel() {
  const ua = (self.navigator && navigator.userAgent) || 'unknown';
  const platform = (self.navigator && navigator.platform) || '';
  return `Chrome ${platform} — ${ua.split(') ')[0].slice(-40)}`.slice(0, 118);
}

// ---- Session ----------------------------------------------------------------

async function getSession() {
  const d = await getStore(['session']);
  return d.session || null;
}

async function setSession(session) {
  try {
    if (session) chrome.storage.local.set({ session });
    else chrome.storage.local.remove('session');
  } catch (e) {}
  notifyTabs();
}

async function clearSessionIfInvalid(status) {
  if (status === 401) {
    await setSession(null);
  }
}

function notifyTabs() {
  try {
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs || []) {
        try {
          chrome.tabs.sendMessage(t.id, { type: 'SESSION_UPDATED' }, () => void chrome.runtime.lastError);
        } catch (e) {}
      }
    });
  } catch (e) {}
}

// ---- Message handling -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'RELAY_FETCH') {
    (async () => {
      try {
        const session = await getSession();
        const deviceId = await ensureDeviceId();
        const headers = {};
        if (msg.body) headers['Content-Type'] = 'application/json';
        if (session && session.token) headers['Authorization'] = `Bearer ${session.token}`;
        if (deviceId) headers['X-Device-Id'] = deviceId;
        const res = await fetch(RELAY + msg.path, {
          method: msg.method || 'GET',
          headers,
          body: msg.body ? JSON.stringify(msg.body) : undefined
        });
        if (res.status === 401) await clearSessionIfInvalid(401);
        const text = await res.text();
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          /* non-JSON response */
        }
        sendResponse({ ok: true, status: res.status, body: parsed });
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_SESSION') {
    (async () => {
      const session = await getSession();
      const deviceId = await ensureDeviceId();
      let relay = null;
      try {
        const res = await fetch(RELAY + '/health', { signal: AbortSignal.timeout(2500) });
        relay = await res.json();
      } catch (e) {
        relay = null;
      }
      let who = null;
      if (session && session.token && relay && relay.auth && relay.auth.required) {
        try {
          const res = await fetch(RELAY + '/whoami', {
            headers: { Authorization: `Bearer ${session.token}`, 'X-Device-Id': deviceId },
            signal: AbortSignal.timeout(4000)
          });
          who = res.ok ? await res.json() : null;
        } catch (e) {
          who = null;
        }
      }
      sendResponse({
        session: session && who ? { ...session, userId: who.userId } : null,
        deviceId,
        relay
      });
    })();
    return true;
  }

  if (msg.type === 'LOGIN') {
    (async () => {
      try {
        const deviceId = await ensureDeviceId();
        const res = await fetch(RELAY + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: msg.userId,
            password: msg.password,
            deviceId,
            deviceLabel: deviceLabel()
          }),
          signal: AbortSignal.timeout(10000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok && body.token) {
          await setSession({ token: body.token, userId: body.userId, expiresAt: body.expiresAt });
          sendResponse({ ok: true, userId: body.userId });
        } else {
          sendResponse({ ok: false, error: body.error || body.code || `HTTP ${res.status}` });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'LOGOUT') {
    (async () => {
      const session = await getSession();
      try {
        if (session && session.token) {
          await fetch(RELAY + '/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: session.token }),
            signal: AbortSignal.timeout(5000)
          });
        }
      } catch (e) {}
      await setSession(null);
      sendResponse({ ok: true });
    })();
    return true;
  }
});
