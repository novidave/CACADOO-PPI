import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The courier's key in its cookie (database update 75): ckr_ + 64 hex, kept as "key.signature" (HMAC-SHA-256 of
 * "courier:<key>" with SESSION_COOKIE_SECRET) while the secret is set, else the key alone. The database keeps only the
 * key's hash and checks it on every call; the signature only stops a cookie that the website did not write.
 * Server only (imported by `@/lib/courier`); shared with `food_test.ts`.
 */

export const COURIER_KEY = /^ckr_[0-9a-f]{64}$/;

const mac = (key: string, secret: string) => createHmac("sha256", secret).update(`courier:${key}`).digest("base64url");

/** The cookie's value for a key: "key.signature" with a secret, else the key alone. */
export function signCourierKey(key: string, secret: string | null): string {
  return secret ? `${key}.${mac(key, secret)}` : key;
}

/** The key from a cookie's value, or null (wrong form, or a missing or wrong signature while a secret is set). */
export function readCourierKey(value: string | undefined, secret: string | null): string | null {
  if (!value) return null;
  const [key, sig] = value.split(".", 2);
  if (!COURIER_KEY.test(key ?? "")) return null;
  if (!secret) return key;
  if (!sig) return null;
  const want = Buffer.from(mac(key, secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? key : null;
}
