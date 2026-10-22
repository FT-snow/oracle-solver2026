import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

type SetArgs = { userId: string; geminiKey: string };

async function setGeminiKeyImpl(ctx: any, args: SetArgs) {
  const norm = args.userId.trim().toLowerCase();
  const doc = await ctx.db
    .query("users")
    .withIndex("by_userId", (q: any) => q.eq("userId", norm))
    .unique();
  if (!doc) return { ok: false as const, error: "no such user" };
  const key = args.geminiKey.trim();
  if (key) {
    try {
      await ctx.db.patch(doc._id, { geminiKey: key });
      return { ok: true as const, cleared: false as const };
    } catch (e: any) {
      return { ok: false as const, error: "patch failed: " + String(e?.message || e) };
    }
  }
  await ctx.db.patch(doc._id, { geminiKey: undefined });
  return { ok: true as const, cleared: true as const };
}

// Internal user operations used by the HTTP actions in http.ts.

export const getByUserId = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const norm = args.userId.trim().toLowerCase();
    const doc = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", norm))
      .unique();
    return doc ?? null;
  },
});

export const getUserByTokenHash = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    return doc ?? null;
  },
});

// ---- Multi-session bearer tokens -------------------------------------------
// One row PER LOGIN (in authTokens) so an account can be signed in on
// several devices at once. The single tokenHash column on `users` was
// overwritten by every login, silently killing the other device's session.

const MAX_TOKENS_PER_USER = 5;

export const createToken = internalMutation({
  args: {
    userId: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("authTokens", {
      tokenHash: args.tokenHash,
      userId: args.userId,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });
    // Cap sessions per user: drop the oldest beyond MAX_TOKENS_PER_USER.
    const all = await ctx.db
      .query("authTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    if (all.length > MAX_TOKENS_PER_USER) {
      const oldest = all.sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - MAX_TOKENS_PER_USER);
      for (const t of oldest) await ctx.db.delete(t._id);
    }
    return true;
  },
});

export const getTokenByHash = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("authTokens")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    return doc ? { userId: doc.userId, expiresAt: doc.expiresAt } : null;
  },
});

export const deleteTokenByHash = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("authTokens")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (doc) await ctx.db.delete(doc._id);
    return true;
  },
});

// Invalidate EVERY session of a user (device reset / password change / removal).
export const deleteAllTokensForUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("authTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const t of docs) await ctx.db.delete(t._id);
    return docs.length;
  },
});

export const createUser = internalMutation({
  args: {
    userId: v.string(),
    passwordHash: v.string(),
    role: v.string(),
  },
  handler: async (ctx, args) => {
    const norm = args.userId.trim().toLowerCase();
    const existing = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", norm))
      .unique();
    if (existing) return { ok: false as const, error: "user already exists" };
    await ctx.db.insert("users", {
      userId: norm,
      passwordHash: args.passwordHash,
      role: args.role === "admin" ? "admin" : "user",
      disabled: false,
      device: undefined,
      createdAt: Date.now(),
    });
    return { ok: true as const };
  },
});

export const bindDeviceAndToken = internalMutation({
  args: {
    id: v.id("users"),
    device: v.optional(v.object({ id: v.string(), label: v.string(), boundAt: v.number() })),
    lastLoginAt: v.number(),
  },
  handler: async (ctx, args) => {
    // NOTE: tokens are NO LONGER stored here — every login adds a row to the
    // authTokens table (see createToken) so multiple devices can stay
    // signed in to the same account at once.
    await ctx.db.patch(args.id, {
      device: args.device ?? undefined,
      lastLoginAt: args.lastLoginAt,
    });
    return true;
  },
});

export const clearToken = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    // New-style: one row per login in authTokens.
    const row = await ctx.db
      .query("authTokens")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (row) await ctx.db.delete(row._id);
    // Legacy: single tokenHash column on users (pre multi-session tokens).
    const doc = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (doc) {
      await ctx.db.patch(doc._id, { tokenHash: undefined, tokenExpiresAt: undefined });
    }
    return true;
  },
});

// Remove every stored session token of a user (new rows + legacy column).
async function wipeTokens(ctx: any, userId: string) {
  const rows = await ctx.db
    .query("authTokens")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const t of rows) await ctx.db.delete(t._id);
  const user = await ctx.db
    .query("users")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (user) await ctx.db.patch(user._id, { tokenHash: undefined, tokenExpiresAt: undefined });
}

export const resetDevice = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const norm = args.userId.trim().toLowerCase();
    const doc = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", norm))
      .unique();
    if (!doc) return { ok: false as const, error: "no such user" };
    await wipeTokens(ctx, doc.userId);
    await ctx.db.patch(doc._id, {
      device: undefined,
    });
    return { ok: true as const };
  },
});

export const setPasswordHash = internalMutation({
  args: { userId: v.string(), passwordHash: v.string() },
  handler: async (ctx, args) => {
    const norm = args.userId.trim().toLowerCase();
    const doc = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", norm))
      .unique();
    if (!doc) return { ok: false as const, error: "no such user" };
    await wipeTokens(ctx, doc.userId);
    await ctx.db.patch(doc._id, {
      passwordHash: args.passwordHash,
    });
    return { ok: true as const };
  },
});

export const setDisabled = internalMutation({
  args: { userId: v.string(), disabled: v.boolean() },
  handler: async (ctx, args) => {
    const norm = args.userId.trim().toLowerCase();
    const doc = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", norm))
      .unique();
    if (!doc) return { ok: false as const, error: "no such user" };
    await ctx.db.patch(doc._id, { disabled: args.disabled });
    return { ok: true as const };
  },
});

export const setGeminiKey = internalMutation({
  args: { userId: v.string(), geminiKey: v.string() },
  handler: async (ctx, args) => setGeminiKeyImpl(ctx, args),
});

export const removeUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const norm = args.userId.trim().toLowerCase();
    const doc = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", norm))
      .unique();
    if (!doc) return { ok: false as const, error: "no such user" };
    await ctx.db.delete(doc._id);
    return { ok: true as const };
  },
});

export const setMaster = internalMutation({
  args: { userId: v.string(), master: v.boolean() },
  handler: async (ctx, args) => {
    const norm = args.userId.trim().toLowerCase();
    const doc = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", norm))
      .unique();
    if (!doc) return { ok: false as const, error: "no such user" };
    await ctx.db.patch(doc._id, { master: args.master, role: args.master ? "master" : doc.role });
    return { ok: true as const };
  },
});

export const listAll = internalQuery({
  handler: async (ctx) => {
    const docs = await ctx.db.query("users").collect();
    return docs.map((u) => ({
      userId: u.userId,
      role: u.role,
      disabled: u.disabled,
      master: !!u.master,
      geminiKeySet: !!u.geminiKey,
      device: u.device
        ? { id: u.device.id.slice(0, 12) + "…", label: u.device.label, boundAt: u.device.boundAt }
        : null,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt ?? null,
    }));
  },
});
