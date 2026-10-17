"use node";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import crypto from "node:crypto";

// Cloud access-control + shared answer-database API.
//
// Auth model:
//   - Login with userId + password + deviceId -> bearer token (30 days).
//   - Each user is bound to EXACTLY ONE device; a second device is rejected
//     with `device_mismatch` until an admin resets the binding.
//   - Admin routes require the `x-admin-secret` header (Convex env ADMIN_SECRET).
//
// Routes (all JSON, CORS-enabled):
//   GET  /health
//   POST /auth/login        { userId, password, deviceId, deviceLabel }
//   POST /auth/verify       { token, deviceId }
//   POST /auth/logout       { token }
//   GET  /answers?key|search|source|limit|offset     (admin secret or bearer token)
//   GET  /answers/stats
//   POST /answers           { question, choices, answerTexts, source }
//   POST /admin/users       { userId, password, role }              (admin)
//   GET  /admin/users                                               (admin)
//   POST /admin/reset-device { userId }                             (admin)
//   POST /admin/set-password { userId, password }                   (admin)
//   POST /admin/remove-user  { userId }                             (admin)
//   POST /admin/seed        { items: [{ question, answerTexts }] }  (admin)

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SEP = "\u00a7";

function cleanKey(q: string): string {
  return String(q || "")
    .replace(/Question\s+\d+\s+of\s+\d+/gi, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(pw: string, stored: string): boolean {
  try {
    const [salt, hash] = String(stored || "").split(":");
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(String(pw), salt, 32).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
  } catch {
    return false;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Id, X-Admin-Secret",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown, max = 2000): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

// Admin guard: constant-time-ish comparison on hashes.
function isAdmin(req: Request): boolean {
  const expected = process.env.ADMIN_SECRET || "";
  const provided = req.headers.get("x-admin-secret") || "";
  if (!expected || !provided) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sha256(provided)), Buffer.from(sha256(expected)));
  } catch {
    return false;
  }
}

// Bearer-token guard -> { ok, userId } (device id checked when provided).
async function isTokenValid(ctxPlus: { runQuery: (ref: unknown, args: unknown) => Promise<unknown> }, req: Request): Promise<{ ok: boolean; userId?: string }> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false };
  try {
    const user = (await ctxPlus.runQuery(internal.auth.getUserByTokenHash, { tokenHash: sha256(token) })) as {
      disabled?: boolean;
      tokenExpiresAt?: number;
      userId: string;
    } | null;
    if (!user || user.disabled) return { ok: false };
    if (user.tokenExpiresAt && user.tokenExpiresAt < Date.now()) return { ok: false };
    return { ok: true, userId: user.userId };
  } catch {
    return { ok: false };
  }
}

async function authenticate(ctxPlus: { runQuery: (ref: unknown, args: unknown) => Promise<unknown> }, req: Request): Promise<{ ok: boolean; userId?: string; via?: string }> {
  if (isAdmin(req)) return { ok: true, userId: "admin", via: "admin" };
  const t = await isTokenValid(ctxPlus, req);
  if (t.ok) return { ok: true, userId: t.userId, via: "token" };
  return { ok: false };
}

const http = httpRouter();

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => json({ ok: true, service: "oracle-solver-auth", time: Date.now() })),
});

http.route({
  path: "/auth/login",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJson(req);
    const userId = str(body.userId, 120).trim().toLowerCase();
    const password = str(body.password, 200);
    const deviceId = str(body.deviceId, 120).trim();
    const deviceLabel = str(body.deviceLabel, 120);
    if (!userId || !password || !deviceId) return json({ ok: false, code: "bad_request", error: "userId, password and deviceId are required" }, 400);

    const user = (await ctx.runQuery(internal.auth.getByUserId, { userId })) as {
      _id: string;
      userId: string;
      passwordHash: string;
      disabled: boolean;
      role: string;
      device?: { id: string; label: string; boundAt: number };
    } | null;
    if (!user || user.disabled) return json({ ok: false, code: "invalid_credentials" }, 401);
    if (!verifyPassword(password, user.passwordHash)) return json({ ok: false, code: "invalid_credentials" }, 401);

    if (user.device && user.device.id && user.device.id !== deviceId) {
      return json(
        {
          ok: false,
          code: "device_mismatch",
          error: `This account is locked to another device (${user.device.label || "unknown"}). Ask the admin to reset the device binding.`,
          boundTo: user.device.label || "another device",
          boundAt: user.device.boundAt,
        },
        403
      );
    }

    const token = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const expiresAt = now + TOKEN_TTL_MS;
    await ctx.runMutation(internal.auth.bindDeviceAndToken, {
      id: user._id,
      device: user.device
        ? { id: user.device.id, label: user.device.label, boundAt: user.device.boundAt }
        : { id: deviceId, label: deviceLabel, boundAt: now },
      tokenHash: sha256(token),
      tokenExpiresAt: expiresAt,
      lastLoginAt: now,
    });
    return json({ ok: true, token, expiresAt, userId: user.userId, role: user.role });
  }),
});

http.route({
  path: "/auth/verify",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJson(req);
    const token = str(body.token, 200).trim();
    const deviceId = str(body.deviceId, 120).trim();
    if (!token) return json({ ok: false, code: "missing_token" }, 400);
    const user = (await ctx.runQuery(internal.auth.getUserByTokenHash, { tokenHash: sha256(token) })) as {
      disabled?: boolean;
      tokenExpiresAt?: number;
      userId: string;
      role: string;
      device?: { id: string };
    } | null;
    if (!user || user.disabled) return json({ ok: false, code: "invalid_token" }, 401);
    if (user.tokenExpiresAt && user.tokenExpiresAt < Date.now()) return json({ ok: false, code: "token_expired" }, 401);
    if (deviceId && user.device && user.device.id !== deviceId) return json({ ok: false, code: "device_mismatch" }, 403);
    return json({ ok: true, userId: user.userId, role: user.role });
  }),
});

http.route({
  path: "/auth/logout",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await readJson(req);
    const token = str(body.token, 200).trim();
    if (token) await ctx.runMutation(internal.auth.clearToken, { tokenHash: sha256(token) });
    return json({ ok: true });
  }),
});

// ---- Answers (shared database) --------------------------------------------

http.route({
  path: "/answers/stats",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req);
    if (!auth.ok) return json({ ok: false, error: "unauthorized" }, 401);
    return json(await ctx.runQuery(internal.answers.stats, {}));
  }),
});

http.route({
  path: "/answers",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req);
    if (!auth.ok) return json({ ok: false, error: "unauthorized" }, 401);
    const url = new URL(req.url);
    const result = await ctx.runQuery(internal.answers.listAnswers, {
      search: url.searchParams.get("search") || undefined,
      key: url.searchParams.get("key") || undefined,
      source: url.searchParams.get("source") || undefined,
      limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined,
      offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!, 10) : undefined,
    });
    return json(result);
  }),
});

http.route({
  path: "/answers",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const auth = await authenticate(ctx, req);
    if (!auth.ok) return json({ ok: false, error: "unauthorized" }, 401);
    const body = await readJson(req);
    const question = str(body.question);
    const choices = Array.isArray(body.choices) ? body.choices.map((c) => String(c).slice(0, 500)) : [];
    const answerTexts = Array.isArray(body.answerTexts) ? body.answerTexts.map((c) => String(c).slice(0, 500)) : [];
    if (!question || !answerTexts.length) return json({ ok: false, error: "question and answerTexts are required" }, 400);
    await ctx.runMutation(internal.answers.upsert, {
      question,
      choices,
      answerTexts,
      source: str(body.source, 20) || "ai",
      answeredBy: auth.userId || "local",
    });
    return json({ ok: true });
  }),
});

// ---- Admin -----------------------------------------------------------------

function adminRoute(pathName: string, method: "GET" | "POST", handler: (ctx: any, req: Request, body: Record<string, unknown>) => Promise<Response>) {
  http.route({
    path: pathName,
    method,
    handler: httpAction(async (ctx, req) => {
      if (!isAdmin(req)) return json({ ok: false, error: "admin secret required" }, 401);
      const body = method === "POST" ? await readJson(req) : {};
      return handler(ctx, req, body);
    }),
  });
}

adminRoute("/admin/users", "POST", async (ctx, _req, body) => {
  const userId = str(body.userId, 120).trim().toLowerCase();
  const password = str(body.password, 200);
  const role = str(body.role, 10) || "user";
  if (!userId || !password) return json({ ok: false, error: "userId and password required" }, 400);
  const result = await ctx.runMutation(internal.auth.createUser, { userId, passwordHash: hashPassword(password), role });
  return json(result, result.ok ? 200 : 409);
});

adminRoute("/admin/users", "GET", async (ctx) => json(await ctx.runQuery(internal.auth.listAll, {})));

adminRoute("/admin/reset-device", "POST", async (ctx, _req, body) => {
  const userId = str(body.userId, 120);
  if (!userId) return json({ ok: false, error: "userId required" }, 400);
  return json(await ctx.runMutation(internal.auth.resetDevice, { userId }));
});

adminRoute("/admin/set-password", "POST", async (ctx, _req, body) => {
  const userId = str(body.userId, 120);
  const password = str(body.password, 200);
  if (!userId || !password) return json({ ok: false, error: "userId and password required" }, 400);
  return json(await ctx.runMutation(internal.auth.setPasswordHash, { userId, passwordHash: hashPassword(password) }));
});

adminRoute("/admin/set-disabled", "POST", async (ctx, _req, body) => {
  const userId = str(body.userId, 120);
  const disabled = !!body.disabled;
  if (!userId) return json({ ok: false, error: "userId required" }, 400);
  return json(await ctx.runMutation(internal.auth.setDisabled, { userId, disabled }));
});

adminRoute("/admin/remove-user", "POST", async (ctx, _req, body) => {
  const userId = str(body.userId, 120);
  if (!userId) return json({ ok: false, error: "userId required" }, 400);
  return json(await ctx.runMutation(internal.auth.removeUser, { userId }));
});

adminRoute("/admin/seed", "POST", async (ctx, _req, body) => {
  const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  if (!items.length) return json({ ok: false, error: "items required (max 500 per batch)" }, 400);
  const cleaned = items
    .map((it: any) => ({ question: str(it?.question, 2000), answerTexts: Array.isArray(it?.answerTexts) ? it.answerTexts.map((a: unknown) => String(a).slice(0, 500)) : [] }))
    .filter((it: { question: string; answerTexts: string[] }) => it.question && it.answerTexts.length);
  const n = await ctx.runMutation(internal.answers.bulkUpsert, { items: cleaned });
  return json({ ok: true, seeded: n });
});

// CORS preflight
http.route({
  pathPrefix: "/",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: corsHeaders() })),
});

export default http;
