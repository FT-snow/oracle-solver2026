# Oracle Solver 2026 — website

Next.js (App Router) static site: landing page + extension download.

## Deploy to Vercel

1. Push this repo to GitHub (already done).
2. On Vercel: **Add New → Project → Import** the repo.
3. Framework Preset: **Next.js** (auto-detected).
4. **Root Directory: `web`** — this is important, the app lives in `web/`.
5. Deploy. The extension zip is served from `/oracle-solver-extension.zip`.

No environment variables needed — the site is fully static (`output: 'export'`).

## After changing the extension

```bash
npm run build:zip     # from the repo root; refreshes web/public/oracle-solver-extension.zip
```

Commit the refreshed zip so the deployed site serves the new build.
