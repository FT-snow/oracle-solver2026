// popup-smoke.test.js — runs extension/popup.js in a stubbed chrome environment
// and verifies the Start/Stop button wiring executes without ReferenceErrors.
const assert = require('assert');

const fired = { storageSet: [], tabReloaded: false, sends: [] };

const flash = (msg) => fired.sends.push(msg);
global.chrome = {
  runtime: {
    sendMessage: (msg) => {
      fired.sends.push({ type: msg.type });
      if (msg.type === 'GET_SESSION') {
        return Promise.resolve({ session: null, deviceId: 'dev-x', relay: { ok: true, auth: { required: true, mode: 'cloud' } } });
      }
      return Promise.resolve({ ok: true, status: 200, body: { ok: true, userId: 'prakhar', hasKey: true } });
    }
  },
  storage: {
    local: {
      get(_keys, cb) { cb({ autopilotEnabled: true }); },
      set(obj) { fired.storageSet.push(obj); }
    },
    onChanged: { addListener: () => {} }
  },
  tabs: { query: (o, cb) => cb([{ id: 1 }]), reload: () => { fired.tabReloaded = true; } }
};

global.setInterval = () => {}; // no background timers in test

function el(id) {
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    checked: true,
    disabled: false,
    className: '',
    style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    click: function () { (this.listeners.click || []).forEach((fn) => fn()); },
    change: function () { (this.listeners.change || []).forEach((fn) => fn()); }
  };
}

const ids = ['relayDot', 'relayVal', 'authDot', 'authVal', 'deviceDot', 'deviceVal', 'loginForm', 'userId', 'password', 'loginBtn', 'loginMsg', 'loggedIn', 'autopilotToggle', 'solveBtn', 'solveState', 'apiInput', 'saveKey', 'keyMsg', 'keyState', 'keyHelp', 'keyHelpToggle', 'logoutBtn', 'reloadTabBtn', 'foot'];
const els = {};
for (const id of ids) els[id] = el(id);
els.keyState = els.keyState;

global.document = {
  _els: els,
  getElementById(id) { return els[id] || null; }
};

require('../extension/popup.js');

// simulate clicking STOP while running
els.solveBtn.click();
assert.strictEqual(fired.storageSet.length, 1, 'storage.set called once');
assert.strictEqual(fired.storageSet[0].autopilotEnabled, false, 'autopilot disabled by STOP');
assert(els.solveBtn.textContent.includes('START'), 'button flips to START SOLVING after stopping');

// simulate clicking START again
els.solveBtn.click();
assert.strictEqual(fired.storageSet[1].autopilotEnabled, true, 'autopilot enabled by START');

console.log('wiring OK — checking async renders…');
setTimeout(() => {
  console.log('DEBUG relayVal =', JSON.stringify(els.relayVal.textContent), '| keyState =', JSON.stringify(els.keyState.textContent));
  assert.ok(els.relayVal.textContent.length > 0, 'relay row rendered (got empty string)');
  console.log('PASS popup-smoke.test.js — start/stop wiring, session render, no ReferenceErrors');
  process.exit(0);
}, 80);
