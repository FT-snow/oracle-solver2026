// auth.js — local fallback access-control core (users, scrypt passwords,
// device binding: one device per user, bearer-token sessions).
//
// When CONVEX_URL is configured, relay.js forwards auth to Convex instead —
// this module is the offline/no-cloud fallback so the project never hard-fails.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ORACLE_DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
}

function readUsers() {
  ensureDir();
  try {
    if (fs.existsSync(USERS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (Array.isArray(parsed.users)) return parsed.users;
    }
  } catch (e) {
    console.warn('[auth] could not read users.json:', e.message);
  }
  return [];
}

function writeUsers(users) {
  ensureDir();
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, users }, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch (e) {
    return false;
  }
}

function findUser(users, userId) {
  const norm = String(userId || '').trim().toLowerCase();
  return users.find((u) => u.userId === norm) || null;
}

// Login. Enforces: valid credentials + one-device-per-user binding.
// Returns { ok:true, token, expiresAt, userId } or { ok:false, code, ... }.
function login({ userId, password, deviceId, deviceLabel }) {
  const users = readUsers();
  const user = findUser(users, userId);
  if (!user || user.disabled) return { ok: false, code: 'invalid_credentials' };
  if (!verifyPassword(password, user.pass)) return { ok: false, code: 'invalid_credentials' };

  deviceId = String(deviceId || '').trim();
  if (!deviceId) return { ok: false, code: 'device_id_required' };

  if (!user.master && user.device && user.device.id && user.device.id !== deviceId) {
    return {
      ok: false,
      code: 'device_mismatch',
      boundTo: user.device.label || 'another device',
      boundAt: user.device.boundAt
    };
  }

  const now = Date.now();
  if (!user.master && !user.device) {
    user.device = { id: deviceId, label: String(deviceLabel || '').slice(0, 120), boundAt: now };
  }
  const token = crypto.randomBytes(32).toString('hex');
  user.tokenHash = sha256(token);
  user.tokenExpiresAt = now + (user.master ? 365 * 24 * 60 * 60 * 1000 : TOKEN_TTL_MS);
  user.lastLoginAt = now;
  writeUsers(users);

  return { ok: true, token, expiresAt: user.tokenExpiresAt, userId: user.userId };
}

// Validate a bearer token. Returns { ok:true, userId } or { ok:false, code }.
function verifyToken(token, deviceId) {
  token = String(token || '').trim();
  if (!token) return { ok: false, code: 'missing_token' };
  const users = readUsers();
  const user = users.find((u) => u.tokenHash === sha256(token));
  if (!user || user.disabled) return { ok: false, code: 'invalid_token' };
  if (!user.master && user.tokenExpiresAt && user.tokenExpiresAt < Date.now()) {
    return { ok: false, code: 'token_expired' };
  }
  if (!user.master && user.device && user.device.id && deviceId && user.device.id !== deviceId) {
    return { ok: false, code: 'device_mismatch' };
  }
  return { ok: true, userId: user.userId, role: user.role || 'user' };
}

function logout(token) {
  const users = readUsers();
  const user = users.find((u) => u.tokenHash === sha256(String(token || '')));
  if (!user) return { ok: false };
  delete user.tokenHash;
  delete user.tokenExpiresAt;
  writeUsers(users);
  return { ok: true };
}

// Admin operations ------------------------------------------------------------

function addUser(userId, password, role) {
  const users = readUsers();
  const norm = String(userId || '').trim().toLowerCase();
  if (!norm || !password) return { ok: false, error: 'userId and password required' };
  if (findUser(users, norm)) return { ok: false, error: 'user already exists' };
  users.push({
    userId: norm,
    pass: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    disabled: false,
    device: null,
    createdAt: Date.now()
  });
  writeUsers(users);
  return { ok: true, userId: norm };
}

function removeUser(userId) {
  const users = readUsers();
  const user = findUser(users, userId);
  if (!user) return { ok: false, error: 'no such user' };
  writeUsers(users.filter((u) => u !== user));
  return { ok: true };
}

function resetDevice(userId) {
  const users = readUsers();
  const user = findUser(users, userId);
  if (!user) return { ok: false, error: 'no such user' };
  user.device = null;
  delete user.tokenHash;
  delete user.tokenExpiresAt;
  writeUsers(users);
  return { ok: true };
}

function setPassword(userId, password) {
  const users = readUsers();
  const user = findUser(users, userId);
  if (!user) return { ok: false, error: 'no such user' };
  user.pass = hashPassword(password);
  delete user.tokenHash;
  delete user.tokenExpiresAt;
  writeUsers(users);
  return { ok: true };
}

function listUsers() {
  return readUsers().map((u) => ({
    userId: u.userId,
    role: u.role || 'user',
    disabled: !!u.disabled,
    device: u.device ? { id: u.device.id.slice(0, 12) + '…', label: u.device.label, boundAt: u.device.boundAt } : null,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt
  }));
}

function countUsers() {
  return readUsers().length;
}

module.exports = {
  login,
  verifyToken,
  logout,
  addUser,
  removeUser,
  resetDevice,
  setPassword,
  listUsers,
  countUsers,
  hashPassword,
  verifyPassword
};
