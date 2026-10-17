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
    device: v.object({ id: v.string(), label: v.string(), boundAt: v.number() }),
    tokenHash: v.string(),
    tokenExpiresAt: v.number(),
    lastLoginAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      device: args.device,
      tokenHash: args.tokenHash,
      tokenExpiresAt: args.tokenExpiresAt,
      lastLoginAt: args.lastLoginAt,
    });
    return true;
  },
});

export const clearToken = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
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

export const resetDevice = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const norm = args.userId.trim().toLowerCase();
    const doc = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", norm))
      .unique();
    if (!doc) return { ok: false as const, error: "no such user" };
    await ctx.db.patch(doc._id, {
      device: undefined,
      tokenHash: undefined,
      tokenExpiresAt: undefined,
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
    await ctx.db.patch(doc._id, {
      passwordHash: args.passwordHash,
      tokenHash: undefined,
      tokenExpiresAt: undefined,
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

export const listAll = internalQuery({
  handler: async (ctx) => {
    const docs = await ctx.db.query("users").collect();
    return docs.map((u) => ({
      userId: u.userId,
      role: u.role,
      disabled: u.disabled,
      device: u.device
        ? { id: u.device.id.slice(0, 12) + "…", label: u.device.label, boundAt: u.device.boundAt }
        : null,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt ?? null,
    }));
  },
});
