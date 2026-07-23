/**
 * T-5.3 stateless access-token verification (AU-4 / R-auth-12). Pure jose —
 * no DB, no network. Adversarial focus: the algorithm allowlist is the
 * load-bearing defense (algorithm confusion + `none`), plus iss/aud/exp/claim
 * discipline. Valid tokens are minted through the SAME `signAccessToken` the
 * issuer + rotation paths use, so this pins the verify side of that contract.
 */
import { SignJWT, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { JWT_AUDIENCE, JWT_ISSUER } from "../config.js";
import {
  AccessTokenInvalidError,
  verifyAccessToken,
  type AccessTokenVerifier,
} from "./access-verify.js";
import { signAccessToken, type AccessTokenSigner } from "./token-issuer.js";

const KID = "test-es256-kid";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

let signer: AccessTokenSigner;
let verifier: AccessTokenVerifier;
/** A second, unrelated ES256 keypair — its tokens must never verify. */
let foreignSigner: AccessTokenSigner;

beforeAll(async () => {
  // Extractable so the alg-confusion test can export the raw public key.
  const pair = await generateKeyPair("ES256", { extractable: true });
  signer = { privateKey: pair.privateKey, kid: KID };
  verifier = { publicKey: pair.publicKey };

  const foreign = await generateKeyPair("ES256");
  foreignSigner = { privateKey: foreign.privateKey, kid: "foreign-kid" };
});

/** Mint a well-formed token with tweakable claims/header for the negative tests. */
async function mint(overrides: {
  iss?: string;
  aud?: string;
  sub?: string | null;
  sid?: string | null;
  expOffsetSec?: number;
  key?: AccessTokenSigner;
}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const key = overrides.key ?? signer;
  const claims: Record<string, unknown> = {};
  if (overrides.sid !== null) claims.sid = overrides.sid ?? SESSION_ID;

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: key.kid })
    .setIssuer(overrides.iss ?? JWT_ISSUER)
    .setAudience(overrides.aud ?? JWT_AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + (overrides.expOffsetSec ?? 900));
  if (overrides.sub !== null) jwt = jwt.setSubject(overrides.sub ?? USER_ID);

  return jwt.sign(key.privateKey);
}

describe("verifyAccessToken", () => {
  it("accepts a token minted by the paired signer, returning sub/sid as userId/sessionId", async () => {
    const token = await signAccessToken(signer, USER_ID, SESSION_ID, new Date());
    const claims = await verifyAccessToken(verifier, token);
    expect(claims).toEqual({ userId: USER_ID, sessionId: SESSION_ID });
  });

  it("rejects an expired token", async () => {
    const token = await mint({ expOffsetSec: -60 });
    await expect(verifyAccessToken(verifier, token)).rejects.toBeInstanceOf(
      AccessTokenInvalidError,
    );
  });

  it("rejects a validly-signed token that carries NO exp claim (exp required-present)", async () => {
    // jose validates `exp` only WHEN present, so a signed-but-exp-less token
    // would otherwise verify as non-expiring. `requiredClaims: ["exp"]` (R-auth-12)
    // rejects it. Minted via raw SignJWT with no `.setExpirationTime(...)`.
    const nowSec = Math.floor(Date.now() / 1000);
    const noExp = await new SignJWT({ sid: SESSION_ID })
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setSubject(USER_ID)
      .setIssuedAt(nowSec)
      .sign(signer.privateKey);

    const err = await verifyAccessToken(verifier, noExp).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessTokenInvalidError);
    // The specific failure — jose's missing-required-claim on `exp`, not some
    // other rejection — so this test can't pass for the wrong reason.
    const cause = (err as AccessTokenInvalidError).cause as { code?: string; claim?: string };
    expect(cause?.code).toBe("ERR_JWT_CLAIM_VALIDATION_FAILED");
    expect(cause?.claim).toBe("exp");
  });

  it("rejects a wrong issuer", async () => {
    const token = await mint({ iss: "https://evil.example" });
    await expect(verifyAccessToken(verifier, token)).rejects.toBeInstanceOf(
      AccessTokenInvalidError,
    );
  });

  it("rejects a wrong audience", async () => {
    const token = await mint({ aud: "some-other-app" });
    await expect(verifyAccessToken(verifier, token)).rejects.toBeInstanceOf(
      AccessTokenInvalidError,
    );
  });

  it("rejects a token signed by a different ES256 key (bad signature)", async () => {
    const token = await mint({ key: foreignSigner });
    await expect(verifyAccessToken(verifier, token)).rejects.toBeInstanceOf(
      AccessTokenInvalidError,
    );
  });

  it("rejects a signed token missing the sid claim", async () => {
    const token = await mint({ sid: null });
    await expect(verifyAccessToken(verifier, token)).rejects.toBeInstanceOf(
      AccessTokenInvalidError,
    );
  });

  it("rejects a signed token missing the sub claim", async () => {
    const token = await mint({ sub: null });
    await expect(verifyAccessToken(verifier, token)).rejects.toBeInstanceOf(
      AccessTokenInvalidError,
    );
  });

  it("rejects a garbage / non-JWT string", async () => {
    await expect(verifyAccessToken(verifier, "not-a-jwt")).rejects.toBeInstanceOf(
      AccessTokenInvalidError,
    );
  });

  // ---- The algorithm allowlist is the headline defense (R-auth-12) ----------

  it("rejects an HS256 token even when the shared secret IS the raw public key (alg confusion)", async () => {
    // The classic asymmetric→symmetric confusion: an attacker signs HS256
    // using the (public) verification key bytes as the HMAC secret. Pinning
    // `algorithms: [ES256]` rejects it at the header before any signature math.
    const publicJwk = await crypto.subtle.exportKey(
      "raw",
      verifier.publicKey as unknown as CryptoKey,
    );
    const forged = await new SignJWT({ sid: SESSION_ID })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new Uint8Array(publicJwk));
    await expect(verifyAccessToken(verifier, forged)).rejects.toBeInstanceOf(
      AccessTokenInvalidError,
    );
  });

  it("rejects an unsecured (alg:none) token", async () => {
    // Hand-crafted unsecured JWS — jose will not mint one. Empty signature.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        sub: USER_ID,
        sid: SESSION_ID,
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString("base64url");
    const unsecured = `${header}.${payload}.`;
    await expect(verifyAccessToken(verifier, unsecured)).rejects.toBeInstanceOf(
      AccessTokenInvalidError,
    );
  });
});
