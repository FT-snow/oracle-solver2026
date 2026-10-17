# Convex backend

Cloud brain of oracle-solver2026: access control (users + one-device lock) and
the shared answer database that every solver instance reads from and writes to.

## Deploy (one-time, owner machine)

```bash
npm install                       # installs the convex CLI
npx convex dev                    # links/creates the project, pushes functions
```

While `convex dev` is running (or after `npx convex deploy`):

```bash
# 1. Set the admin secret used by admin.js / seed script / answers CLI
openssl rand -hex 24                       # generate once
npx convex env set ADMIN_SECRET <that-value>

# 2. Put the same value + your deployment URL in the local .env
#    CONVEX_URL=https://<your-deployment>.convex.site
#    ADMIN_SECRET=<that-value>

# 3. Seed the shared answer database with the 1721 cached answers
npm run seed:convex
```

## HTTP API (https://<deployment>.convex.site)

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | liveness |
| `POST /auth/login` | credentials | issues bearer token, binds device |
| `POST /auth/verify` | token | validates token + device |
| `POST /auth/logout` | token | revokes session |
| `GET /answers` | token/admin | list/search answers |
| `GET /answers/stats` | token/admin | totals by source |
| `POST /answers` | token/admin | upsert one answer |
| `POST /admin/users` | admin secret | create user |
| `GET /admin/users` | admin secret | list users |
| `POST /admin/reset-device` | admin secret | unbind device (allow re-login elsewhere) |
| `POST /admin/set-password` | admin secret | change password |
| `POST /admin/set-disabled` | admin secret | enable/disable account |
| `POST /admin/remove-user` | admin secret | delete user |
| `POST /admin/seed` | admin secret | bulk upsert (<=500 items) |

Device binding rule: the FIRST device to log in with an account claims it.
Every other device gets `403 device_mismatch` until an admin runs
`node admin.js reset-device <userId>`.
