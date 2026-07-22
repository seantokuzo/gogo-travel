/**
 * Auth crypto primitives (T-5.2 / AU-3).
 *
 * - `sha256Hex` — refresh-token hashing (R-auth-9) + Apple nonce binding
 *   (R-auth-3: Apple's `nonce` claim is `SHA-256(raw_nonce)` hex).
 * - `mintRefreshToken` — 256-bit CSPRNG, base64url (spec §3.2).
 * - `encryptSecret`/`decryptSecret` — AES-256-GCM for `apple_credentials`
 *   ciphertext (spec §3.3.3; Law #1: key from env, plaintext never stored,
 *   never logged).
 *
 * Token hygiene: nothing in this module logs, throws, or embeds credential
 * material in an error message.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Constant-time string comparison. Both sides are hashed first so length
 * never short-circuits — used for nonce binding (R-auth-3).
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Opaque refresh token — 256-bit CSPRNG, URL-safe base64 (43 chars, §3.2). */
export function mintRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** AES-256-GCM key from base64 env material — must decode to exactly 32 bytes. */
export function parseAesKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    // Length only — never echo key material (Law #1).
    throw new Error(`AES-256 key must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const CIPHERTEXT_VERSION = "v1";

/**
 * AES-256-GCM encrypt. Output format: `v1.<base64url(iv ‖ ciphertext ‖ tag)>`
 * — versioned so a future key/format rotation can coexist with stored rows.
 * A fresh random IV per call; never reused (GCM hard requirement).
 */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CIPHERTEXT_VERSION}.${Buffer.concat([iv, ciphertext, tag]).toString("base64url")}`;
}

/**
 * AES-256-GCM decrypt. Throws on tampering (GCM auth failure), truncation,
 * or an unknown format version — error messages carry no key/plaintext
 * material.
 */
export function decryptSecret(key: Buffer, sealed: string): string {
  const dot = sealed.indexOf(".");
  if (dot === -1 || sealed.slice(0, dot) !== CIPHERTEXT_VERSION) {
    throw new Error("unrecognized ciphertext format");
  }
  const raw = Buffer.from(sealed.slice(dot + 1), "base64url");
  if (raw.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw new Error("ciphertext too short");
  }
  const iv = raw.subarray(0, GCM_IV_BYTES);
  const tag = raw.subarray(raw.length - GCM_TAG_BYTES);
  const ciphertext = raw.subarray(GCM_IV_BYTES, raw.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
