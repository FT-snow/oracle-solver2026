// admin.js — issue and manage access credentials.
//
// Cloud mode (default when CONVEX_URL is set): talks to the Convex HTTP API
// with the admin secret. Local mode: edits data/users.json directly.
//
//   node admin.js add-user <userId> [password] [--role admin]
//   node admin.js list
//   node admin.js reset-device <userId>       # unbind (allows a new device)
//   node admin.js set-password <userId> [newPassword]
//   node admin.js remove <userId>
//   node admin.js genpass                     # random strong password

require('./env').loadEnv();
const crypto = require('crypto');

const CONVEX_URL = (process.env.CONVEX_URL || '').trim().replace(/\/+$/, '');
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();

function genPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

async function cloud(pathName, body, method) {
  const res = await fetch(CONVEX_URL + pathName, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000)
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--')).slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`Usage:
  node admin.js add-user <userId> [password] [--role admin]
  node admin.js list
  node admin.js reset-device <userId>
  node admin.js set-password <userId> [newPassword]
  node admin.js remove <userId>
  node admin.js genpass`);
    process.exit(0);
  }

  if (cmd === 'genpass') {
    console.log(genPassword());
    return;
  }

  if (CONVEX_URL && !ADMIN_SECRET && cmd !== 'help') {
    console.error('CONVEX_URL is set but ADMIN_SECRET is missing — add it to .env');
    process.exit(1);
  }

  switch (cmd) {
    case 'add-user': {
      const userId = positional[0];
      const password = positional[1] || genPassword();
      const role = flags.includes('--role') ? 'admin' : 'user';
      if (!userId) { console.error('userId required'); process.exit(1); }
      let result;
      if (CONVEX_URL) {
        const r = await cloud('/admin/users', { userId, password, role });
        result = r.status === 200 && r.data.ok ? { ok: true } : { ok: false, error: r.data.error || `HTTP ${r.status}` };
      } else {
        result = require('./auth').addUser(userId, password, role);
      }
      if (result.ok) {
        console.log(`Created user "${String(userId).toLowerCase()}"`);
        console.log(`  password: ${password}`);
        console.log('  (share these with the user — the first device they log in from gets locked to the account)');
      } else {
        console.error('Failed:', result.error);
        process.exit(1);
      }
      break;
    }
    case 'list': {
      let users;
      if (CONVEX_URL) {
        const r = await cloud('/admin/users');
        users = Array.isArray(r.data) ? r.data : [];
      } else {
        users = require('./auth').listUsers();
      }
      if (!users.length) { console.log('No users yet — create one: node admin.js add-user <userId>'); return; }
      for (const u of users) {
        const dev = u.device ? `device=${u.device.label || u.device.id}` : 'device=UNBOUND';
        const dis = u.disabled ? ' [DISABLED]' : '';
        console.log(`  ${u.userId.padEnd(20)} role=${u.role || 'user'}  ${dev}${dis}`);
      }
      console.log(`\n${users.length} user(s)`);
      break;
    }
    case 'reset-device': {
      const userId = positional[0];
      if (!userId) { console.error('userId required'); process.exit(1); }
      let result;
      if (CONVEX_URL) {
        const r = await cloud('/admin/reset-device', { userId });
        result = r.status === 200 && r.data.ok ? { ok: true } : { ok: false, error: r.data.error || `HTTP ${r.status}` };
      } else {
        result = require('./auth').resetDevice(userId);
      }
      if (result.ok) console.log(`Device binding cleared for "${userId}" — they can now log in from a new device.`);
      else { console.error('Failed:', result.error); process.exit(1); }
      break;
    }
    case 'set-password': {
      const userId = positional[0];
      const password = positional[1] || genPassword();
      if (!userId) { console.error('userId required'); process.exit(1); }
      let result;
      if (CONVEX_URL) {
        const r = await cloud('/admin/set-password', { userId, password });
        result = r.status === 200 && r.data.ok ? { ok: true } : { ok: false, error: r.data.error || `HTTP ${r.status}` };
      } else {
        result = require('./auth').setPassword(userId, password);
      }
      if (result.ok) console.log(`Password updated for "${userId}": ${password}`);
      else { console.error('Failed:', result.error); process.exit(1); }
      break;
    }
    case 'set-key': {
      const userId = positional[0];
      const key = positional[1];
      if (!userId || !key) { console.error('Usage: node admin.js set-key <userId> <geminiApiKey>'); process.exit(1); }
      if (!key.startsWith('AIza')) { console.error('That does not look like a Gemini key (AI Studio keys start with AIza…).'); process.exit(1); }
      let result;
      if (CONVEX_URL) {
        const r = await cloud('/admin/set-user-key', { userId, geminiKey: key });
        result = r.status === 200 && r.data.ok ? { ok: true } : { ok: false, error: r.data.error || `HTTP ${r.status}` };
      } else {
        require('./settings').setGeminiKey(key);
        result = { ok: true, note: 'local mode: key stored for this machine' };
      }
      if (result.ok) console.log(`Gemini key saved for "${userId}"${result.note ? ` (${result.note})` : ''} — their solver will use it automatically.`);
      else { console.error('Failed:', result.error); process.exit(1); }
      break;
    }
    case 'remove': {
      const userId = positional[0];
      if (!userId) { console.error('userId required'); process.exit(1); }
      let result;
      if (CONVEX_URL) {
        const r = await cloud('/admin/remove-user', { userId });
        result = r.status === 200 && r.data.ok ? { ok: true } : { ok: false, error: r.data.error || `HTTP ${r.status}` };
      } else {
        result = require('./auth').removeUser(userId);
      }
      if (result.ok) console.log(`Removed "${userId}".`);
      else { console.error('Failed:', result.error); process.exit(1); }
      break;
    }
    default:
      console.error(`Unknown command: ${cmd} — try: node admin.js help`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('admin.js failed:', e.message);
  process.exit(1);
});
