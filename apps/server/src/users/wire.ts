/**
 * Production wiring for the users router (T-5.5 / T-5.6). Binds the DI seams to
 * the real world: the app database, the live cash.app HEAD checker (R-user-6),
 * the Apple token revoker (R-user-9), and — until the object-storage provider
 * escalation resolves (Autonomy Contract #3; spec §3.7/§3.8) — the UNCONFIGURED
 * storage stand-in, under which avatar presign fails loud (500) and avatar
 * commits fail closed (400). Everything else on the users surface is fully live.
 *
 * Mounted iff auth is mounted (the routes are Auth: Required and depend on the
 * app-wide `requireAuth` guard) — `index.ts` enforces that pairing. That same
 * pairing means the Apple credential env is already present and gated
 * all-or-nothing by `buildAuthDepsFromEnv`; we re-assert it here (names only,
 * Law #1) so a wiring bug fails loud rather than nulling out revocation.
 */
import type { Env } from "../env.js";
import { createAppleTokenRevoker } from "../auth/apple-revoke.js";
import { parseAesKey } from "../auth/crypto.js";
import { getDb } from "../db/index.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { UNCONFIGURED_OBJECT_STORAGE } from "../storage/object-storage.js";
import { createHttpCashtagChecker } from "./cashtag.js";
import type { UsersRouterDeps } from "./routes.js";

/**
 * Process-wide store for the user-keyed windows (§3.6.3). Bucket keys are
 * rule-namespaced, so sharing one store per process is safe and keeps window
 * state coherent across surfaces.
 */
const usersRateLimitStore = new InMemoryRateLimitStore();

/** Env vars may carry PEMs with escaped newlines — normalize before import. */
function pem(value: string): string {
  return value.replace(/\\n/g, "\n");
}

export async function buildUsersDepsFromEnv(env: Env): Promise<UsersRouterDeps> {
  const { APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_CREDENTIALS_KEY } =
    env;
  if (
    !APPLE_CLIENT_ID ||
    !APPLE_TEAM_ID ||
    !APPLE_KEY_ID ||
    !APPLE_PRIVATE_KEY ||
    !APPLE_CREDENTIALS_KEY
  ) {
    // The users surface only mounts alongside auth (index.ts pairing), whose
    // wiring already gated the full Apple config — a miss here is a wiring bug,
    // not a config state. Fail loud; names only (Law #1).
    throw new Error(
      "users wiring requires the Apple credential env (account-deletion revocation, R-user-9)",
    );
  }

  return {
    db: getDb(),
    storage: UNCONFIGURED_OBJECT_STORAGE,
    cashtagChecker: createHttpCashtagChecker(),
    // Key imported at wire time — a malformed key fails LOUD at boot (mirrors
    // the exchanger; boot-parse-awaited landmine).
    appleRevoker: await createAppleTokenRevoker({
      clientId: APPLE_CLIENT_ID,
      teamId: APPLE_TEAM_ID,
      keyId: APPLE_KEY_ID,
      privateKeyPem: pem(APPLE_PRIVATE_KEY),
    }),
    appleCredentialsKey: parseAesKey(APPLE_CREDENTIALS_KEY),
    rateLimit: { store: usersRateLimitStore },
  };
}
