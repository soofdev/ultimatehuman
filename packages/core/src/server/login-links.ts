import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Single-use dashboard login links. `ultimatehuman dashboard` prints
 * http://127.0.0.1:4747/login#code=... ; the SPA reads the fragment (never sent
 * in a request line or logged), POSTs it to /api/auth/redeem, gets an HttpOnly
 * SameSite=Strict session cookie, and wipes the fragment. Codes expire in 10 min.
 */
export class LoginLinks {
  private pending = new Map<string, number>(); // sha256(code) -> expiresAt
  private sessions = new Map<string, number>();

  issue(ttlMs = 10 * 60_000): string {
    const code = randomBytes(24).toString("base64url");
    this.pending.set(hash(code), Date.now() + ttlMs);
    return code;
  }

  /** Returns a session id on success. The code is consumed either way. */
  redeem(code: string): string | null {
    const h = hash(code);
    const exp = this.pending.get(h);
    this.pending.delete(h);
    if (!exp || exp < Date.now()) return null;
    const sid = randomBytes(32).toString("base64url");
    this.sessions.set(hash(sid), Date.now() + 7 * 24 * 3600_000);
    return sid;
  }

  check(sid: string | undefined): boolean {
    if (!sid) return false;
    const h = hash(sid);
    for (const [k, exp] of this.sessions) {
      if (exp > Date.now() && k.length === h.length && timingSafeEqual(Buffer.from(k), Buffer.from(h))) return true;
    }
    return false;
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
