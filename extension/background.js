const RELAY = 'http://127.0.0.1:8787';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'RELAY_FETCH') return;

  (async () => {
    try {
      const res = await fetch(RELAY + msg.path, {
        method: msg.method || 'GET',
        headers: msg.body ? { 'Content-Type': 'application/json' } : undefined,
        body: msg.body ? JSON.stringify(msg.body) : undefined
      });
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
});
