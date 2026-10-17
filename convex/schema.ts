import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Cloud schema for oracle-solver2026:
//  - users:     access-control accounts (userId + scrypt password hash)
//  - device:    each user may be bound to EXACTLY ONE device (id + label)
//  - token:     a single active bearer session per user (hashed)
//  - answers:   the shared answer database every solver instance reads/writes
export default defineSchema({
  users: defineTable({
    userId: v.string(), // normalized lowercase
    passwordHash: v.string(), // scrypt "salt:hash" (hex)
    role: v.string(), // "user" | "admin"
    disabled: v.boolean(),
    device: v.optional(
      v.object({
        id: v.string(),
        label: v.string(),
        boundAt: v.number(),
      })
    ),
    tokenHash: v.optional(v.string()), // sha256(token)
    tokenExpiresAt: v.optional(v.number()),
    geminiKey: v.optional(v.string()), // per-user Gemini API key (set by user or admin)
    createdAt: v.number(),
    lastLoginAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_token", ["tokenHash"]),

  answers: defineTable({
    key: v.string(), // normalized question text
    question: v.string(),
    choices: v.array(v.string()),
    answerTexts: v.array(v.string()),
    source: v.string(), // seed | cache | ai | manual | guess
    answeredBy: v.string(), // userId or "seed"
    hits: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_updatedAt", ["updatedAt"])
    .searchIndex("search_question", {
      searchField: "question",
      filterFields: ["source"],
    }),
});
