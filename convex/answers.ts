import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { cleanKey } from "./lib";

// The shared answer database. Every solver instance (yours + your friends')
// writes solved answers here and reads them back — one global brain.

const SEP = "\u00a7";

export const getByKey = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("answers")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    return doc ?? null;
  },
});

export const upsert = internalMutation({
  args: {
    question: v.string(),
    choices: v.array(v.string()),
    answerTexts: v.array(v.string()),
    source: v.string(),
    answeredBy: v.string(),
  },
  handler: async (ctx, args) => {
    const key = cleanKey(args.question);
    if (!key || !args.answerTexts.length) return null;
    const now = Date.now();
    const existing = await ctx.db
      .query("answers")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (existing) {
      const same = existing.answerTexts.join(SEP) === args.answerTexts.join(SEP);
      await ctx.db.patch(existing._id, {
        hits: (existing.hits || 0) + 1,
        answerTexts: same ? existing.answerTexts : args.answerTexts,
        choices: !same || !existing.choices.length ? args.choices : existing.choices,
        source: same ? existing.source : args.source,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("answers", {
      key,
      question: args.question.slice(0, 2000),
      choices: args.choices,
      answerTexts: args.answerTexts,
      source: args.source,
      answeredBy: args.answeredBy,
      hits: 1,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Bulk seed (quiz_cache.json import). Items: { question, answerTexts }.
export const bulkUpsert = internalMutation({
  args: {
    items: v.array(v.object({ question: v.string(), answerTexts: v.array(v.string()) })),
  },
  handler: async (ctx, { items }) => {
    const now = Date.now();
    let n = 0;
    for (const it of items) {
      const key = cleanKey(it.question);
      const answerTexts = it.answerTexts.map(String).filter(Boolean);
      if (!key || !answerTexts.length) continue;
      const existing = await ctx.db
        .query("answers")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      if (existing) {
        if (existing.answerTexts.join(SEP) !== answerTexts.join(SEP)) {
          await ctx.db.patch(existing._id, { answerTexts, updatedAt: now });
        }
      } else {
        await ctx.db.insert("answers", {
          key,
          question: it.question.slice(0, 2000),
          choices: [],
          answerTexts,
          source: "seed",
          answeredBy: "seed",
          hits: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      n++;
    }
    return n;
  },
});

export const listAnswers = internalQuery({
  args: {
    search: v.optional(v.string()),
    key: v.optional(v.string()),
    source: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, { search, key, source, limit, offset }) => {
    const lim = Math.min(Math.max(Math.floor(limit ?? 50), 1), 500);
    const off = Math.max(Math.floor(offset ?? 0), 0);

    if (key) {
      const doc = await ctx.db
        .query("answers")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      const items = doc && (!source || doc.source === source) ? [doc] : [];
      return { total: items.length, items };
    }

    if (search && search.trim()) {
      const docs = await ctx.db
        .query("answers")
        .withSearchIndex("search_question", (q) => {
          let c = q.search("question", search.trim());
          if (source) c = c.eq("source", source);
          return c;
        })
        .take(lim + off);
      return { total: docs.length, items: docs.slice(off) };
    }

    const docs = await ctx.db
      .query("answers")
      .withIndex("by_updatedAt")
      .order("desc")
      .take(lim + off);
    let items = docs.slice(off);
    if (source) items = items.filter((a) => a.source === source);
    return { total: docs.length, items };
  },
});

export const stats = internalQuery({
  handler: async (ctx) => {
    const docs = await ctx.db.query("answers").collect();
    const bySource: Record<string, number> = {};
    let lastUpdated = 0;
    for (const a of docs) {
      bySource[a.source] = (bySource[a.source] || 0) + 1;
      if (a.updatedAt > lastUpdated) lastUpdated = a.updatedAt;
    }
    return { total: docs.length, bySource, lastUpdated };
  },
});
