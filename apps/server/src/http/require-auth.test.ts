/**
 * App-wide `requireAuth` unit suite (AU-5, R-authz-1/4 / R-auth-12 / §3.6.4).
 * No DB — verification is stateless. Covers the public allowlist, the uniform
 * 401 posture, and the R-authz-4 ORDER invariant (auth precedes validation:
 * an invalid token on a malformed body is a 401, never a 400).
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { z } from "zod";
import { beforeAll, describe, expect, it } from "vitest";
import { JWT_AUDIENCE, JWT_ISSUER } from "../config.js";
import type { AccessTokenVerifier } from "../auth/access-verify.js";
import { requestIdMiddleware } from "./app-middleware.js";
import type { RequestVars } from "./errors.js";
import { authContextOf, createRequireAuth } from "./require-auth.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ALLOWLIST = new Set(["POST /public"]);

let signKey: CryptoKey;
let verifier: AccessTokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signKey = pair.privateKey;
  verifier = { publicKey: pair.publicKey };
});

/** Mint a valid access token, or an invalid variant for adversarial cases. */
async function mint(opts: { exp?: number; alg?: string; sub?: string; sid?: string } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: opts.sid ?? SESSION_ID })
    .setProtectedHeader({ alg: opts.alg ?? "ES256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(opts.sub ?? USER_ID)
    .setIssuedAt(nowSec)
    .setExpirationTime(opts.exp ?? nowSec + 900)
    .sign(signKey);
}

function makeApp() {
  const app = new Hono<RequestVars>();
  app.use("*", requestIdMiddleware);
  app.use(
    "*",
    createRequireAuth({ verifier, allowlist: ALLOWLIST, logger: { warn: () => undefined } }),
  );

  // Public (allowlisted): runs with no token.
  app.post("/public", (c) => c.json({ ok: true }));
  // Protected + validated: exercises the requireAuth → validation order.
  app.post("/protected", zValidator("json", z.object({ n: z.number() })), (c) => {
    const { userId, sessionId } = authContextOf(c);
    return c.json({ userId, sessionId, body: c.req.valid("json") });
  });
  return app;
}

interface Envelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}
const protectedReq = (app: Hono<RequestVars>, headers: Record<string, string>, body = "{}") =>
  app.request("/protected", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

describe("requireAuth — public allowlist", () => {
  it("lets an allowlisted route run with NO token", async () => {
    const res = await makeApp().request("/public", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("requireAuth — protected routes", () => {
  it("a valid token authenticates and attaches { userId, sessionId }", async () => {
    const res = await protectedReq(
      makeApp(),
      { authorization: `Bearer ${await mint()}` },
      JSON.stringify({ n: 1 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: USER_ID, sessionId: SESSION_ID, body: { n: 1 } });
  });

  it("no / garbage / expired / wrong-alg tokens are ALL a uniform 401 (byte-identical modulo requestId)", async () => {
    const app = makeApp();
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await mint({ exp: nowSec - 1 });
    // A `none`-alg token is the classic alg-confusion probe.
    const noneAlg = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: USER_ID, sid: SESSION_ID })).toString("base64url")}.`;

    const cases = [
      await protectedReq(app, {}),
      await protectedReq(app, { authorization: "Bearer garbage" }),
      await protectedReq(app, { authorization: `Bearer ${expired}` }),
      await protectedReq(app, { authorization: `Bearer ${noneAlg}` }),
    ];
    const bodies: Envelope[] = [];
    for (const res of cases) {
      expect(res.status).toBe(401);
      bodies.push((await res.json()) as Envelope);
    }
    for (const body of bodies) {
      expect(body.error.code).toBe("UNAUTHENTICATED");
      expect(body.error.message).toBe(bodies[0]!.error.message);
      expect(body.error.details).toBeUndefined();
      expect(body.error.requestId).toBeTruthy();
    }
  });

  it("ORDER (R-authz-4): invalid token + invalid body → 401, NOT 400 — auth precedes validation", async () => {
    // Body is malformed JSON AND the token is bad. If validation ran first we'd
    // see 400; requireAuth runs first, so it's a 401 with the handler untouched.
    const res = await protectedReq(makeApp(), { authorization: "Bearer nope" }, "{not json");
    expect(res.status).toBe(401);
    expect(((await res.json()) as Envelope).error.code).toBe("UNAUTHENTICATED");
  });

  it("valid token + invalid body → 400 (validation runs once auth passes)", async () => {
    // The point is ordering: auth passed, so control reached zValidator, which
    // rejects the body. (This minimal app doesn't wire the envelope hook — the
    // 400 status alone proves validation ran; the envelope shape is covered in
    // error-middleware.test.ts and signin-routes.db.test.ts.)
    const res = await protectedReq(
      makeApp(),
      { authorization: `Bearer ${await mint()}` },
      JSON.stringify({ n: "not-a-number" }),
    );
    expect(res.status).toBe(400);
  });
});
