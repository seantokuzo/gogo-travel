/**
 * T-5.2 provider verification — adversarial suite (R-auth-1/2/3).
 *
 * Fully offline: keys are minted in-test with jose and resolved through
 * `createLocalJWKSet` via the same `JWTVerifyGetKey` seam prod wires to
 * `createRemoteJWKSet`. No Apple/Google endpoint is ever contacted (Law #5).
 */
import {
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto.js";
import {
  ProviderVerificationError,
  verifyAppleToken,
  verifyGoogleToken,
  type ProviderVerifierDeps,
  type VerificationFailureReason,
} from "./provider-verify.js";

const APPLE_AUD = "com.gogo.travel";
const GOOGLE_AUDS = ["gid-primary.apps.example", "gid-secondary.apps.example"];
const KID = "provider-kid-1";

type Signer = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let providerKey: Signer;
let rogueKey: Signer;
let ecKey: Awaited<ReturnType<typeof generateKeyPair>>;
let publicSpkiPem: string;
let deps: ProviderVerifierDeps;

beforeAll(async () => {
  const provider = await generateKeyPair("RS256", { extractable: true });
  const rogue = await generateKeyPair("RS256", { extractable: true });
  ecKey = await generateKeyPair("ES256", { extractable: true });
  providerKey = provider.privateKey;
  rogueKey = rogue.privateKey;
  publicSpkiPem = await exportSPKI(provider.publicKey);

  const jwk = { ...(await exportJWK(provider.publicKey)), kid: KID, alg: "RS256" };
  const jwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });
  deps = {
    appleJwks: jwks,
    googleJwks: jwks,
    appleAudience: APPLE_AUD,
    googleAudiences: GOOGLE_AUDS,
  };
});

interface MintOptions {
  key?: Signer;
  alg?: string;
  kid?: string;
  iss?: string;
  aud?: string;
  expired?: boolean;
  claims?: Record<string, unknown>;
}

const RAW_NONCE = "raw-nonce-123";

function mintApple(options: MintOptions = {}): Promise<string> {
  const { claims, ...rest } = options;
  return mint({
    iss: "https://appleid.apple.com",
    aud: APPLE_AUD,
    ...rest,
    claims: {
      sub: "apple-sub-1",
      email: "traveler@example.com",
      email_verified: "true",
      nonce: sha256Hex(RAW_NONCE),
      ...claims,
    },
  });
}

function mintGoogle(options: MintOptions = {}): Promise<string> {
  const { claims, ...rest } = options;
  return mint({
    iss: "accounts.google.com",
    aud: GOOGLE_AUDS[0]!,
    ...rest,
    claims: {
      sub: "google-sub-1",
      email: "traveler@example.com",
      email_verified: true,
      nonce: RAW_NONCE,
      ...claims,
    },
  });
}

async function mint(options: MintOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const { claims = {}, iss, aud } = options;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? "RS256", kid: options.kid ?? KID })
    .setIssuedAt(options.expired ? now - 3600 : now)
    .setExpirationTime(options.expired ? now - 1800 : now + 600);
  if (iss) jwt.setIssuer(iss);
  if (aud) jwt.setAudience(aud);
  return jwt.sign(options.key ?? providerKey);
}

async function expectFailure(
  promise: Promise<unknown>,
  reason?: VerificationFailureReason,
): Promise<ProviderVerificationError> {
  const error = await promise.then(
    () => {
      throw new Error("expected verification to fail");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderVerificationError);
  const failure = error as ProviderVerificationError;
  // R-auth-1: the outward-facing message NEVER varies with the failure mode.
  expect(failure.message).toBe("provider token verification failed");
  if (reason) expect(failure.reason).toBe(reason);
  return failure;
}

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("verifyAppleToken (R-auth-1, R-auth-3)", () => {
  it("accepts a valid token and extracts sub/email; Apple email is verified by construction", async () => {
    const identity = await verifyAppleToken(deps, await mintApple(), RAW_NONCE);
    expect(identity).toMatchObject({
      provider: "apple",
      sub: "apple-sub-1",
      email: "traveler@example.com",
      emailVerified: true,
    });
    expect(identity.name).toEqual({});
  });

  it("nonce binding is SHA-256: an UNHASHED nonce claim is rejected", async () => {
    const token = await mintApple({ claims: { nonce: RAW_NONCE } });
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "nonce_mismatch");
  });

  it("rejects a nonce minted for a different sign-in attempt", async () => {
    await expectFailure(
      verifyAppleToken(deps, await mintApple(), "some-other-raw-nonce"),
      "nonce_mismatch",
    );
  });

  it("rejects a missing nonce claim", async () => {
    const token = await mintApple({ claims: { nonce: undefined } });
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "nonce_missing");
  });

  it("rejects the wrong issuer", async () => {
    const token = await mintApple({ iss: "https://evil.example.com" });
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "token_invalid");
  });

  it("rejects the wrong audience (another app's token)", async () => {
    const token = await mintApple({ aud: "com.somebody.else" });
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "token_invalid");
  });

  it("rejects an expired token", async () => {
    const token = await mintApple({ expired: true });
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "token_invalid");
  });

  it("rejects a tampered payload under the original signature", async () => {
    const [header, payload, signature] = (await mintApple()).split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as {
      sub: string;
    };
    claims.sub = "apple-sub-ATTACKER";
    const tampered = `${header}.${b64url(claims)}.${signature}`;
    await expectFailure(verifyAppleToken(deps, tampered, RAW_NONCE), "token_invalid");
  });

  it("rejects a token signed by a key outside the provider JWKS (same kid)", async () => {
    const token = await mintApple({ key: rogueKey });
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "token_invalid");
  });

  it("rejects an unknown kid", async () => {
    const token = await mintApple({ kid: "kid-nobody-knows" });
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "token_invalid");
  });

  it("rejects alg:none (unsecured JWT)", async () => {
    const header = b64url({ alg: "none" });
    const payload = b64url({
      iss: "https://appleid.apple.com",
      aud: APPLE_AUD,
      sub: "apple-sub-1",
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: sha256Hex(RAW_NONCE),
    });
    await expectFailure(
      verifyAppleToken(deps, `${header}.${payload}.`, RAW_NONCE),
      "token_invalid",
    );
  });

  it("rejects HS256 alg-confusion (token HMAC'd with the public key bytes)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "apple-sub-1", nonce: sha256Hex(RAW_NONCE) })
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .setIssuer("https://appleid.apple.com")
      .setAudience(APPLE_AUD)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode(publicSpkiPem));
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "token_invalid");
  });

  it("rejects an ES256-signed token — the provider allowlist is RS256 only", async () => {
    const token = await mintApple({ key: ecKey.privateKey, alg: "ES256" });
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "token_invalid");
  });

  it("rejects garbage that is not a JWT", async () => {
    await expectFailure(verifyAppleToken(deps, "not-a-jwt", RAW_NONCE), "token_invalid");
  });

  it("rejects a token without a sub", async () => {
    const token = await mintApple({ claims: { sub: undefined } });
    await expectFailure(verifyAppleToken(deps, token, RAW_NONCE), "token_invalid");
  });

  it("honors an explicit email_verified:false from Apple (string-typed claim)", async () => {
    const token = await mintApple({ claims: { email_verified: "false" } });
    const identity = await verifyAppleToken(deps, token, RAW_NONCE);
    expect(identity.emailVerified).toBe(false);
  });

  it("treats an absent email_verified claim as verified-by-construction (spec §3.6.2)", async () => {
    const token = await mintApple({ claims: { email_verified: undefined } });
    const identity = await verifyAppleToken(deps, token, RAW_NONCE);
    expect(identity.emailVerified).toBe(true);
  });

  it("a token without an email yields email:null, never emailVerified:true", async () => {
    const token = await mintApple({ claims: { email: undefined, email_verified: undefined } });
    const identity = await verifyAppleToken(deps, token, RAW_NONCE);
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });
});

describe("verifyGoogleToken (R-auth-2, R-auth-3)", () => {
  it("accepts both documented issuers and any configured client id", async () => {
    const bare = await mintGoogle({ iss: "accounts.google.com" });
    const https = await mintGoogle({ iss: "https://accounts.google.com" });
    const secondAud = await mintGoogle({ aud: GOOGLE_AUDS[1]! });
    for (const token of [bare, https, secondAud]) {
      const identity = await verifyGoogleToken(deps, token, RAW_NONCE);
      expect(identity.provider).toBe("google");
      expect(identity.sub).toBe("google-sub-1");
    }
  });

  it("extracts name claims for display-name seeding (R-auth-5)", async () => {
    const token = await mintGoogle({
      claims: { name: "Trav Eler", given_name: "Trav", family_name: "Eler" },
    });
    const identity = await verifyGoogleToken(deps, token, RAW_NONCE);
    expect(identity.name).toEqual({ fullName: "Trav Eler", givenName: "Trav", familyName: "Eler" });
  });

  it("nonce binding is RAW match: a hashed nonce claim is rejected", async () => {
    const token = await mintGoogle({ claims: { nonce: sha256Hex(RAW_NONCE) } });
    await expectFailure(verifyGoogleToken(deps, token, RAW_NONCE), "nonce_mismatch");
  });

  it("rejects wrong issuer / wrong audience / expired", async () => {
    await expectFailure(
      verifyGoogleToken(
        deps,
        await mintGoogle({ iss: "https://accounts.google.com.evil.example" }),
        RAW_NONCE,
      ),
      "token_invalid",
    );
    await expectFailure(
      verifyGoogleToken(deps, await mintGoogle({ aud: "gid-unknown.apps.example" }), RAW_NONCE),
      "token_invalid",
    );
    await expectFailure(
      verifyGoogleToken(deps, await mintGoogle({ expired: true }), RAW_NONCE),
      "token_invalid",
    );
  });

  it("email_verified must be EXPLICITLY true — false, absent, or non-boolean means unverified", async () => {
    for (const email_verified of [false, "false", undefined, "yes"] as const) {
      const token = await mintGoogle({ claims: { email_verified } });
      const identity = await verifyGoogleToken(deps, token, RAW_NONCE);
      expect(identity.emailVerified).toBe(false);
    }
    const verified = await verifyGoogleToken(
      deps,
      await mintGoogle({ claims: { email_verified: "true" } }),
      RAW_NONCE,
    );
    expect(verified.emailVerified).toBe(true);
  });
});
