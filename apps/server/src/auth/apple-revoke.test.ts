/**
 * T-5.6 Apple token revocation (R-user-9) — offline, fetch injected. Verifies
 * the revoke request construction (endpoint, form params, ES256 client secret)
 * and the token-hygiene posture of failures. No network (Law #5).
 */
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { APPLE_ISSUER, APPLE_REVOKE_URL } from "../config.js";
import { createAppleTokenRevoker, type AppleRevokeConfig } from "./apple-revoke.js";

let config: AppleRevokeConfig;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  publicKey = pair.publicKey;
  config = {
    clientId: "com.gogo.travel",
    teamId: "TEAM123456",
    keyId: "APPLEKEY01",
    privateKeyPem: await exportPKCS8(pair.privateKey),
  };
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

describe("createAppleTokenRevoker", () => {
  it("POSTs the revoke form with the refresh token + hint; client secret is a valid ES256 JWT", async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const revoker = await createAppleTokenRevoker(config, impl);

    await revoker.revoke("apple-refresh-secret");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(APPLE_REVOKE_URL);
    expect(calls[0]!.init.method).toBe("POST");

    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get("token")).toBe("apple-refresh-secret");
    expect(form.get("token_type_hint")).toBe("refresh_token");
    expect(form.get("client_id")).toBe(config.clientId);

    // The client secret must verify against our Apple Sign-in key with the
    // exact registration claims (shared signer, apple-client-secret.ts).
    const clientSecret = form.get("client_secret");
    expect(clientSecret).toBeTruthy();
    const { payload, protectedHeader } = await jwtVerify(clientSecret!, publicKey, {
      issuer: config.teamId,
      audience: APPLE_ISSUER,
      algorithms: ["ES256"],
    });
    expect(protectedHeader.kid).toBe(config.keyId);
    expect(payload.sub).toBe(config.clientId);
    expect(payload.exp! - payload.iat!).toBe(5 * 60);
  });

  it("throws on a non-2xx with the status only — no token or body content leaks", async () => {
    const { impl } = fakeFetch(() => new Response("apple error body", { status: 400 }));
    const revoker = await createAppleTokenRevoker(config, impl);
    const error = await revoker.revoke("secret-refresh-token").then(
      () => {
        throw new Error("expected revoke to fail");
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe("apple token revoke failed (status 400)");
    expect(error.message).not.toContain("secret-refresh-token");
    expect(error.message).not.toContain("apple error body");
  });

  it("aborts a hung Apple endpoint via the timeout signal (R-user-9 — a stall can't hang deletion)", async () => {
    const { impl, calls } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject((init.signal as AbortSignal).reason as Error),
          );
        }),
    );
    const revoker = await createAppleTokenRevoker(config, impl, () => new Date(), 20);

    const error = await revoker.revoke("secret-refresh-token").then(
      () => {
        throw new Error("expected the hung revoke to abort");
      },
      (e: unknown) => e as Error,
    );
    expect(error.name).toBe("TimeoutError");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(error.message).not.toContain("secret-refresh-token");
  });

  it("rejects at construction (boot) on a malformed private key — fail loud, not on first deletion", async () => {
    const { impl } = fakeFetch(() => new Response(null, { status: 200 }));
    await expect(
      createAppleTokenRevoker(
        {
          ...config,
          privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----",
        },
        impl,
      ),
    ).rejects.toThrow();
  });
});
