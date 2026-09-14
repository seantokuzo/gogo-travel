/**
 * The E2E session door (S-4/T3 — `.specs/testing/session-door.spec.md`).
 *
 * One unauthenticated route, `POST /auth/e2e/session`, that mints a real
 * session for a deterministic fixture user THROUGH THE SAME
 * `createSessionWithTokens` path sign-in uses (R-door-4 — zero new token
 * code). It exists only when every one of §3.2's gates holds:
 *
 *   G0  E2E_SESSION_DOOR is explicitly "1"
 *   G1  NODE_ENV was explicitly provided (never defaulted) and is
 *       "development" or "test"
 *   G2  E2E_SESSION_DOOR_SECRET is set and >= 32 chars
 *   G5  the request's SOCKET PEER (never a header) is loopback/private,
 *       checked before the secret compare and before any DB access
 *
 * `e2eDoorGatesPass`/`buildE2eDoorDepsFromEnv` evaluate G0/G1/G2 at boot
 * (`app.ts`/`index.ts` mount the route only when the latter returns non-null
 * — the router itself is never constructed otherwise, so there is nothing
 * for a request to reach). `createE2eDoorRouter`'s handler enforces G5 plus
 * every other §3.6 failure mode with ONE outcome: the uniform 401
 * `UNAUTHENTICATED` envelope, byte-identical to an unauthenticated request
 * to an unknown path (R-door-3 — no oracle). The real reason is logged
 * server-side only, with the requestId, never the secret/tokens/email
 * (R-door-6).
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { e2eEndpoints, E2eSessionRequestSchema } from "@gogo/shared/domains/e2e";
import type { SignInResponse } from "@gogo/shared/domains/auth";
import {
  E2E_DOOR_BODY_LIMIT_MAX_BYTES,
  E2E_DOOR_MAX_FIXTURE_USERS,
  RATE_LIMITS,
} from "../config.js";
import { createUserWithEntitlements, type DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { Env } from "../env.js";
import {
  apiError,
  requestIdOf,
  UNAUTHENTICATED_MESSAGE,
  type RequestVars,
} from "../http/errors.js";
import {
  clientIp,
  InMemoryRateLimitStore,
  isLoopbackOrPrivatePeer,
  type RateLimitStore,
} from "../http/rate-limit.js";
import { safeEqual } from "./crypto.js";
import type { AuthLogger } from "./routes.js";
import { isUniqueViolation } from "./sign-in.js";
import { createSessionWithTokens, type AccessTokenSigner } from "./token-issuer.js";
import { toUserWire } from "./serialize.js";

type UserRow = typeof schema.users.$inferSelect;

// ---------------------------------------------------------------------------
// Gates (§3.2 G0/G1/G2) — evaluated once, at boot, from the typed `Env`.
// ---------------------------------------------------------------------------

/**
 * G0 AND G1 AND G2 (§3.2). `NODE_ENV_EXPLICIT` (env.ts) is what makes G1 a
 * POSITIVE opt-in rather than accepting the schema's `"development"` default
 * (R-door-1 / review round-1 B3's fix — see the spec's §3.8 residual-risk
 * note: this is the layer that actually closes "forgot to configure
 * anything", not G5).
 */
export function e2eDoorGatesPass(env: Env): boolean {
  const g0 = env.E2E_SESSION_DOOR === "1";
  const g1 = env.NODE_ENV_EXPLICIT && (env.NODE_ENV === "development" || env.NODE_ENV === "test");
  const secret = env.E2E_SESSION_DOOR_SECRET;
  const g2 = secret !== undefined && secret.length >= 32;
  return g0 && g1 && g2;
}

/** R-door-6 boot warning — ASCII-only, no em dash (Hermes/`strings` trap, `.claude/rules/mobile.md`). Names the route; never a value. */
export const E2E_DOOR_BOOT_WARNING =
  "[boot] E2E SESSION DOOR ENABLED - POST /auth/e2e/session mints sessions " +
  "without provider verification. Local test rigs only.";

// ---------------------------------------------------------------------------
// R-door-13 (SHOULD) — constant-work floor
// ---------------------------------------------------------------------------

const DOOR_DUMMY_SECRET_A = "0".repeat(64);
const DOOR_DUMMY_SECRET_B = "1".repeat(64);

/**
 * A fixed-cost dummy digest-and-`timingSafeEqual` comparison — the SHOULD in
 * R-door-13, for callers with no real secret to compare against (the route
 * isn't mounted at all, or the body never parsed far enough to read
 * `secret`). Every in-handler rejection instead compares the PRESENTED
 * secret against the real one (still discarding the result) so the cost is
 * the same shape either way.
 */
export function performDoorConstantWorkFloor(): void {
  safeEqual(DOOR_DUMMY_SECRET_A, DOOR_DUMMY_SECRET_B);
}

// ---------------------------------------------------------------------------
// R-door-5 / R-door-14 — fixture identity find-or-create
// ---------------------------------------------------------------------------

export class FixtureCapError extends Error {
  readonly count: number;
  readonly max: number;
  constructor(count: number, max: number) {
    super("e2e fixture cap reached");
    this.name = "FixtureCapError";
    this.count = count;
    this.max = max;
  }
}

export class FixtureConflictError extends Error {
  constructor() {
    super("e2e fixture identity conflict");
    this.name = "FixtureConflictError";
  }
}

/**
 * R-door-5: find-or-create the fixture user for `user_key`. A live match
 * (`apple_sub = e2e:<key>`) whose other provider identity is set, or whose
 * `deleted_at` is non-null, is rejected (`FixtureConflictError`) rather than
 * minted into — the door can never touch a scrubbed or foreign-identity row.
 * R-door-14: creating a NEW row past `maxFixtureUsers` live `e2e:`-prefixed
 * users rejects with `FixtureCapError`; lookups of existing keys are
 * unaffected. Mirrors `resolveSignIn`'s unique-violation retry (same-key
 * race, `sign-in.ts`) — a low-probability event given the "unique
 * `user_key` per run" convention, but cheap to close the same way.
 *
 * Disclosed trade-off, NOT closed (review round 1 correctness advisory 5 /
 * security cross-lane note): the count-then-insert above is three
 * statements with no transaction or lock, so two concurrent door calls for
 * two DISTINCT new keys can both read `liveFixtureCount = maxFixtureUsers -
 * 1`, both pass the check, and both insert — one row over the cap. This is
 * a DIFFERENT race than the same-key one above (this repo's R-door-14 test
 * obligation only exercises one call at a time). Accepted rather than
 * fenced with a transaction-scoped advisory lock: `E2E_DOOR_MAX_FIXTURE_
 * USERS` is a growth bound on a loopback-only dev/CI rig, not a security
 * boundary (R-door-11 + the shared secret are), and the overshoot is capped
 * at the concurrency of simultaneous NEW-key door calls (never a real-world
 * pattern for this fixture-per-flow lane). See session-door spec R-door-14.
 */
async function findOrCreateFixtureUser(
  db: DbClient,
  userKey: string,
  maxFixtureUsers: number,
): Promise<{ user: UserRow; created: boolean }> {
  const appleSub = `e2e:${userKey}`;

  const lookup = async (): Promise<UserRow | undefined> => {
    const [row] = await db.select().from(schema.users).where(eq(schema.users.appleSub, appleSub));
    return row;
  };

  const existing = await lookup();
  if (existing) {
    if (existing.deletedAt !== null || existing.googleSub !== null) {
      throw new FixtureConflictError();
    }
    return { user: existing, created: false };
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.users)
    .where(and(like(schema.users.appleSub, "e2e:%"), isNull(schema.users.deletedAt)));
  const liveFixtureCount = row?.count ?? 0;
  if (liveFixtureCount >= maxFixtureUsers) {
    throw new FixtureCapError(liveFixtureCount, maxFixtureUsers);
  }

  try {
    const { user } = await createUserWithEntitlements(db, {
      email: `e2e+${userKey}@gogotravel.invalid`,
      displayName: `E2E ${userKey}`,
      appleSub,
    });
    return { user, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const rematch = await lookup();
    if (!rematch) throw error;
    if (rematch.deletedAt !== null || rematch.googleSub !== null) throw new FixtureConflictError();
    return { user: rematch, created: false };
  }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export interface E2eDoorRateLimitConfig {
  store: RateLimitStore;
  /** Injectable clock (ms) — defaults to `Date.now`. */
  now?: () => number;
}

export interface E2eDoorRouterDeps {
  db: DbClient;
  /** The SAME signer sign-in uses (R-door-4) — never a second key. */
  signer: AccessTokenSigner;
  secret: string;
  rateLimit: E2eDoorRateLimitConfig;
  maxFixtureUsers: number;
  logger?: AuthLogger;
  /** Clock seam for tests. */
  now?: () => Date;
  /**
   * R-door-11: injectable peer resolver, defaulting to `clientIp`. Tests
   * drive both the allowed and disallowed sides without a real socket.
   */
  peerOf?: (c: Context<RequestVars>) => string | null;
}

export function createE2eDoorRouter(deps: E2eDoorRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const logger = deps.logger ?? console;
  const peerOf = deps.peerOf ?? ((c: Context<RequestVars>) => clientIp(c));

  const reject = (c: Context<RequestVars>, reason: string, extra?: string): Response => {
    logger.warn(
      `[auth] e2e door rejected (requestId=${requestIdOf(c)}, reason=${reason}${
        extra ? `, ${extra}` : ""
      })`,
    );
    return apiError(c, "UNAUTHENTICATED", UNAUTHENTICATED_MESSAGE);
  };

  // §3.6 / R-door-3 error boundary: ANYTHING that throws on this router
  // (malformed JSON's `HTTPException` from Hono's body parser, ahead of
  // Zod; any unexpected handler error) becomes the SAME uniform 401 — never
  // the app-wide `onError`'s 400/500, which would prove the route exists (a
  // distinguishable status is exactly the oracle §3.6 forbids).
  //
  // A plain try/catch middleware does NOT work here (verified empirically):
  // `@hono/zod-validator`'s "json" target throws its `HTTPException` from
  // INSIDE the low-level `validator()` middleware Hono's body parser calls
  // before Zod ever runs, and that throw propagates straight past any
  // try/catch middleware registered on this sub-router, landing on the
  // PARENT app's `onError` instead. Hono DOES special-case a sub-app's own
  // `onError` (`router.onError`, not a route-level try/catch) — that is the
  // one mechanism the app-middleware.ts docblock's "a sub-router that adds
  // its own onError would shadow this one" warning is about, and shadowing
  // the shared envelope is exactly what this ONE router needs to do.
  router.onError((err, c) => {
    performDoorConstantWorkFloor();
    const reason = err instanceof HTTPException ? "malformed_body" : "internal_error";
    return reject(c, reason, err instanceof Error ? `name=${err.name}` : undefined);
  });

  // R-door-11 / G5 — socket peer, evaluated as the router's FIRST
  // middleware: BEFORE the body-size cap, BEFORE JSON parsing, BEFORE the
  // secret compare, and BEFORE any database access, regardless of
  // G0/G1/G2 (defense-in-depth). Review round 1 A2: this used to run
  // INSIDE the handler, after `doorBodyLimit` had already buffered the
  // request and `zValidator` had already JSON-parsed it — a disallowed
  // peer was charged none of that cost but the SERVER still paid an
  // unbounded unauthenticated buffer/parse surface for every request that
  // reached it. No presented secret exists at this point (the body is
  // unread), so the constant-work floor uses the fixed-cost dummy compare
  // — the same shape `performDoorConstantWorkFloor` already provides for
  // the "route not mounted" and "malformed body" paths.
  const peerGate = createMiddleware<RequestVars>(async (c, next) => {
    const peer = peerOf(c);
    if (!isLoopbackOrPrivatePeer(peer)) {
      performDoorConstantWorkFloor();
      return reject(c, "peer_disallowed");
    }
    await next();
    return undefined;
  });

  // §3.6 body-size-ordering note: this per-route limit must be evaluated
  // (and mounted in `app.ts`) BEFORE the app-wide `bodyLimit` can observe
  // the request — an oversized body answered by the 256 KiB app-wide cap's
  // 413 would itself be a door-exists oracle. `onError` returns the uniform
  // 401, never `PAYLOAD_TOO_LARGE`. `maxSize` is the door-SHAPED cap
  // (`E2E_DOOR_BODY_LIMIT_MAX_BYTES`, review round 1 A2), not the app-wide
  // 256 KiB one — the legitimate body is under 1 KiB. `onError` also pays
  // the R-door-13 constant-work floor (review round 1 F2): this path has no
  // presented secret to compare (the body never finished parsing), so it
  // uses the same fixed-cost dummy compare as the peer gate above.
  const doorBodyLimit = bodyLimit({
    maxSize: E2E_DOOR_BODY_LIMIT_MAX_BYTES,
    onError: (c: Context<RequestVars>) => {
      performDoorConstantWorkFloor();
      return reject(c, "oversized_body");
    },
  });

  router.post(
    e2eEndpoints.mintSession.path,
    peerGate,
    doorBodyLimit,
    zValidator("json", E2eSessionRequestSchema, (result, c) => {
      if (result.success) return undefined;
      performDoorConstantWorkFloor();
      // zValidator's hook context is Hono's base Env, not our RequestVars —
      // the same single-cast pattern `http/validation.ts`'s
      // `rejectInvalidBody` uses.
      return reject(c as unknown as Context<RequestVars>, "malformed_body");
    }),
    async (c) => {
      const body = c.req.valid("json");

      // R-door-9 / §3.7 — own bucket, keyed on the SAME peer the `peerGate`
      // middleware above already proved allowed, no 429 ever: a limit hit
      // folds into the identical uniform 401.
      const peer = peerOf(c);
      const nowMs = deps.rateLimit.now ? deps.rateLimit.now() : Date.now();
      const [minuteWindow, dayWindow] = RATE_LIMITS.e2eDoor;
      const minuteHit = deps.rateLimit.store.hit(
        `e2eDoor:min:${peer}`,
        minuteWindow.limit,
        minuteWindow.windowMs,
        nowMs,
      );
      const dayHit = deps.rateLimit.store.hit(
        `e2eDoor:day:${peer}`,
        dayWindow.limit,
        dayWindow.windowMs,
        nowMs,
      );
      if (!minuteHit.allowed || !dayHit.allowed) {
        safeEqual(body.secret, deps.secret); // R-door-13 constant work
        return reject(c, "rate_limited");
      }

      // R-door-12: SHA-256 digests compared with `crypto.timingSafeEqual`
      // (`safeEqual`, `auth/crypto.ts`) — never `===`/`==`/`.localeCompare`.
      if (!safeEqual(body.secret, deps.secret)) {
        return reject(c, "secret_mismatch");
      }

      let mint: { user: UserRow; created: boolean };
      try {
        mint = await findOrCreateFixtureUser(deps.db, body.user_key, deps.maxFixtureUsers);
      } catch (error) {
        if (error instanceof FixtureCapError) {
          return reject(c, "fixture_cap", `count=${error.count}, max=${error.max}`);
        }
        if (error instanceof FixtureConflictError) {
          return reject(c, "fixture_conflict");
        }
        throw error;
      }

      // R-door-4: the SAME issuance path sign-in uses — no new token code.
      const now = deps.now ? deps.now() : new Date();
      const issued = await createSessionWithTokens(deps.db, {
        userId: mint.user.id,
        device: { deviceName: body.device.device_name, platform: body.device.platform },
        signer: deps.signer,
        now,
      });

      // R-door-6: requestId/sessionId/user_key/created-flag ONLY — never the
      // secret, the tokens, or the email.
      logger.warn(
        `[auth] e2e door mint (requestId=${requestIdOf(c)}, sessionId=${issued.sessionId}, ` +
          `user_key=${body.user_key}, created=${mint.created})`,
      );

      const responseBody: SignInResponse = {
        user: toUserWire(mint.user),
        tokens: {
          access_token: issued.accessToken,
          refresh_token: issued.refreshToken,
          expires_in: issued.expiresIn,
        },
        is_new_user: body.first_run ?? false,
      };
      return c.json(responseBody);
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/** Process-wide door rate-limit store — its own bucket, never shared with `RATE_LIMITS.signIn` (`auth/wire.ts` precedent). */
const e2eDoorRateLimitStore = new InMemoryRateLimitStore();

/**
 * `index.ts`'s wiring seam: null unless every one of G0/G1/G2 holds, in
 * which case `app.ts` mounts the route; otherwise the path is indistinguishable
 * from an unknown route. `auth` supplies the SAME `db`/`signer` sign-in uses
 * (R-door-4) — this never builds its own.
 */
export function buildE2eDoorDepsFromEnv(
  env: Env,
  auth: { db: DbClient; signer: AccessTokenSigner },
): E2eDoorRouterDeps | null {
  if (!e2eDoorGatesPass(env)) return null;
  return {
    db: auth.db,
    signer: auth.signer,
    // Proven defined and >=32 chars by `e2eDoorGatesPass` (G2) above.
    secret: env.E2E_SESSION_DOOR_SECRET as string,
    rateLimit: { store: e2eDoorRateLimitStore },
    maxFixtureUsers: E2E_DOOR_MAX_FIXTURE_USERS,
  };
}
