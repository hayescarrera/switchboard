/** Password hashing with scrypt (Node built-in). Stored as scrypt$N$r$p$salt$hash. */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

const N = 16384, R = 8, P = 1, KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Always do the work, even with no stored hash, so timing doesn't reveal which emails exist.
  const parts = (stored ?? "").split("$");
  const ok = parts.length === 6 && parts[0] === "scrypt";
  const salt = ok ? Buffer.from(parts[4]!, "base64url") : randomBytes(16);
  const want = ok ? Buffer.from(parts[5]!, "base64url") : randomBytes(KEYLEN);
  const key = await scrypt(password, salt, ok ? Number(parts[1]) : N, ok ? Number(parts[2]) : R, ok ? Number(parts[3]) : P);
  return ok && key.length === want.length && timingSafeEqual(key, want);
}

/** Simple in-memory limit on failed sign-ins (one server instance). */
export class FailureLimiter {
  private hits = new Map<string, { n: number; until: number }>();
  constructor(private readonly max = 8, private readonly windowMs = 15 * 60_000) {}
  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return !!h && h.until > now && h.n >= this.max;
  }
  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (!h || h.until <= now) this.hits.set(key, { n: 1, until: now + this.windowMs });
    else h.n++;
  }
  clear(key: string): void {
    this.hits.delete(key);
  }
}
