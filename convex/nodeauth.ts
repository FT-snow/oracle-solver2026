"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import crypto from "node:crypto";

// Password hashing must live in a node-runtime action (scrypt needs node:crypto).
// HTTP actions in the default isolate call these via ctx.runAction.

export const hashPassword = internalAction({
  args: { password: v.string() },
  handler: async (_ctx, { password }) => {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
    return `${salt}:${hash}`;
  },
});

export const verifyPassword = internalAction({
  args: { password: v.string(), stored: v.string() },
  handler: async (_ctx, { password, stored }) => {
    try {
      const [salt, hash] = String(stored || "").split(":");
      if (!salt || !hash) return false;
      const test = crypto.scryptSync(String(password), salt, 32).toString("hex");
      return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
    } catch {
      return false;
    }
  },
});
