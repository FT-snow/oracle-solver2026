// Shared pure helpers (no node APIs — safe to import from any Convex module).

export function cleanKey(q: string): string {
  return String(q || "")
    .replace(/Question\s+\d+\s+of\s+\d+/gi, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
