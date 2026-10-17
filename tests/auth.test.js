// auth.test.js — local fallback auth: hashing, login, one-device lock, tokens.
process.env.ORACLE_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'osolver-auth-'));

const assert = require('assert');
const auth = require('../auth');

const r1 = auth.addUser('Rahul.K', 'secret123');
assert.ok(r1.ok, 'addUser should succeed');
const dup = auth.addUser('rahul.k', 'x');
assert.ok(!dup.ok, 'duplicate userId (case-insensitive) must be rejected');

// Wrong password
assert.strictEqual(auth.login({ userId: 'rahul.k', password: 'nope', deviceId: 'devA' }).code, 'invalid_credentials');

// First login binds the device
const ok = auth.login({ userId: 'rahul.k', password: 'secret123', deviceId: 'devA', deviceLabel: 'Laptop A' });
assert.ok(ok.ok && ok.token, 'first login ok');

// Token verifies for the bound device
const v = auth.verifyToken(ok.token, 'devA');
assert.ok(v.ok && v.userId === 'rahul.k', 'token valid on bound device');

// Second device is LOCKED OUT
const mismatch = auth.login({ userId: 'rahul.k', password: 'secret123', deviceId: 'devB', deviceLabel: 'PC B' });
assert.strictEqual(mismatch.code, 'device_mismatch', 'one-device rule enforced');

// Token from device A does not validate as device B
assert.strictEqual(auth.verifyToken(ok.token, 'devB').code, 'device_mismatch');

// Logout revokes the session
auth.logout(ok.token);
assert.strictEqual(auth.verifyToken(ok.token, 'devA').code, 'invalid_token');

// reset-device allows a new binding
auth.resetDevice('rahul.k');
const ok2 = auth.login({ userId: 'rahul.k', password: 'secret123', deviceId: 'devB' });
assert.ok(ok2.ok, 'login after reset-device ok');
assert.strictEqual(auth.verifyToken(ok2.token, 'devA').code, 'device_mismatch', 'old device rejected after rebind');

// set-password + remove
auth.setPassword('rahul.k', 'newpass');
assert.ok(auth.login({ userId: 'rahul.k', password: 'newpass', deviceId: 'devB' }).ok);
assert.ok(auth.removeUser('rahul.k').ok);
assert.strictEqual(auth.login({ userId: 'rahul.k', password: 'newpass', deviceId: 'devB' }).code, 'invalid_credentials');

console.log('PASS auth.test.js — scrypt hashing, one-device lock, tokens, reset, removal verified');
