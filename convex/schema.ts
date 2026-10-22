import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Cloud schema for oracle-solver2026:
//  - users:      access-control accounts (userId + scrypt password hash)
//  - device:     each user may be bound to EXACTLY ONE device (id + label)
//  - authTokens: bearer sessions — ONE ROW PER LOGIN so an account can be
//                signed in on several devices at once (the old single
//                tokenHash column was overwritten by every login, which
//                silently killed the other device's session)
//  - answers:    the shared answer database every solver instance reads/writes
export default defineSchema({
  users: defineTable({
    userId: v.string(), // normalized lowercase
    passwordHash: v.string(), // scrypt "salt:hash" (hex)
    role: v.string(), // "user" | "admin" | "master"
    disabled: v.boolean(),
    device: v.optional(
      v.object({
        id: v.string(),
        label: v.string(),
        boundAt: v.number(),
      })
    ),
    tokenHash: v.optional(v.string()), // LEGACY: sha256(token) — kept only for sessions issued before the authTokens table
    tokenExpiresAt: v.optional(v.number()),
    master: v.optional(v.boolean()), // master accounts: no device lock, no expiry
    geminiKey: v.optional(v.string()), // per-user Gemini API key (set by user or admin)
    createdAt: v.number(),
    lastLoginAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_token", ["tokenHash"]),

  authTokens: defineTable({
    tokenHash: v.string(), // sha256(token)
    userId: v.string(), // normalized user id
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_token", ["tokenHash"])
    .index("by_user", ["userId"]),

  answers: defineTable({
    key: v.string(), // normalized question text
    question: v.string(),
    choices: v.array(v.string()),
    answerTexts: v.array(v.string()),
    source: v.string(), // seed | cache | ai | manual | guess | feedback
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

  diagnostics: defineTable({
    kind: v.string(),
    userId: v.string(),
    url: v.string(),
    question: v.string(),
    choices: v.array(v.string()),
    buttons: v.array(v.string()),
    text: v.string(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),
});
