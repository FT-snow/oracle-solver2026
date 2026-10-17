import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Diagnostics recorded by the extension when an automated step fails
// (e.g. no finish button found on the last question). Lets the owner see the
// actual page state instead of guessing.

export const create = internalMutation({
  args: {
    kind: v.string(),
    userId: v.string(),
    url: v.string(),
    question: v.string(),
    choices: v.array(v.string()),
    buttons: v.array(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("diagnostics", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const listRecent = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const lim = Math.min(Math.max(Math.floor(limit ?? 50), 1), 200);
    const docs = await ctx.db
      .query("diagnostics")
      .withIndex("by_createdAt")
      .order("desc")
      .take(lim);
    return docs;
  },
});
