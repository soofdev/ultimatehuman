import { createHash } from "node:crypto";

/** Mask emails, IPs and token-looking strings before an excerpt is stored or rendered (SPEC 7). */
export function redact(s: string): string {
  return s
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .replace(/\b(?:phx|phc|sk|ghp|github_pat|xox[bp])_[A-Za-z0-9_-]{10,}\b/g, "[token]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]");
}

/** User ids are hashed per install before they reach a bundle, a prompt or the dashboard. */
export function hashUser(salt: string, id: string): string {
  return "u_" + createHash("sha256").update(salt + id).digest("hex").slice(0, 8);
}
