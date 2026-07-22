/**
 * T-5.2 Apple code exchange (R-auth-7) — offline, fetch injected. Verifies
 * the client-secret JWT construction against an in-test ES256 key and the
 * token-hygiene posture of failures.
 */
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { APPLE_ISSUER, APPLE_TOKEN_URL } from "../config.js";
import { createAppleCodeExchanger, type AppleExchangeConfig } from "./apple-exchange.js";

let config: AppleExchangeConfig;
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

describe("createAppleCodeExchanger", () => {
  it("POSTs the form exchange and returns Apple's refresh token; client secret is a valid ES256 JWT", async () => {
    const { impl, calls } = fakeFetch(() =>
      Response.json({ access_token: "at", refresh_token: "apple-refresh-secret" }),
    );
    const exchanger = await createAppleCodeExchanger(config, impl);

    const refreshToken = await exchanger.exchange("auth-code-123");
    expect(refreshToken).toBe("apple-refresh-secret");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(APPLE_TOKEN_URL);
    expect(calls[0]!.init.method).toBe("POST");

    // The exchanger always sends a URL-encoded string body.
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code-123");
    expect(form.get("client_id")).toBe(config.clientId);

    // The client secret must verify against our Apple Sign-in key with the
    // exact registration claims (§ R-auth-7 mechanics).
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

  it("throws on a non-2xx with the status only — no code, secret, or body content", async () => {
    const { impl } = fakeFetch(() => new Response("apple error body", { status: 400 }));
    const exchanger = await createAppleCodeExchanger(config, impl);
    const error = await exchanger.exchange("auth-code-XYZ").then(
      () => {
        throw new Error("expected exchange to fail");
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe("apple token exchange failed (status 400)");
    expect(error.message).not.toContain("auth-code-XYZ");
    expect(error.message).not.toContain("apple error body");
  });

  it("throws when a 2xx response carries no refresh_token", async () => {
    const { impl } = fakeFetch(() => Response.json({ access_token: "at-only" }));
    const exchanger = await createAppleCodeExchanger(config, impl);
    await expect(exchanger.exchange("auth-code-123")).rejects.toThrowError(/no refresh_token/);
  });

  it("aborts a hung Apple endpoint via the timeout signal so a stall can't block sign-in (R-auth-7)", async () => {
    // A fetch that NEVER resolves on its own — only the injected AbortSignal
    // can end it. Without the timeout the sign-in would hang for undici's
    // ~300s default; the caller's try/catch tolerates a failure, not a stall.
    const { impl, calls } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // AbortSignal.timeout aborts with a "TimeoutError" DOMException as
          // `.reason` (an Error) — surface it verbatim so the caller sees the
          // real abort cause.
          init.signal?.addEventListener("abort", () =>
            reject((init.signal as AbortSignal).reason as Error),
          );
        }),
    );
    // Tiny timeout keeps the test deterministic and fast (real timers).
    const exchanger = await createAppleCodeExchanger(config, impl, () => new Date(), 20);

    const error = await exchanger.exchange("auth-code-hang").then(
      () => {
        throw new Error("expected the hung exchange to abort");
      },
      (e: unknown) => e as Error,
    );
    // AbortSignal.timeout surfaces a TimeoutError → the caller catches it and
    // continues the sign-in (logging only `error.name`, never the code).
    expect(error.name).toBe("TimeoutError");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(error.message).not.toContain("auth-code-hang");
  });

  it("imports the signing key once, not per exchange (perf hoist)", async () => {
    // Two exchanges through one exchanger both succeed off the single hoisted
    // key import — behavioral proof the hoist didn't break per-call signing.
    const { impl, calls } = fakeFetch(() =>
      Response.json({ refresh_token: "apple-refresh-secret" }),
    );
    const exchanger = await createAppleCodeExchanger(config, impl);
    expect(await exchanger.exchange("code-1")).toBe("apple-refresh-secret");
    expect(await exchanger.exchange("code-2")).toBe("apple-refresh-secret");
    expect(calls).toHaveLength(2);
    // Each call still mints a fresh, valid client-secret JWT.
    for (const call of calls) {
      const secret = new URLSearchParams(call.init.body as string).get("client_secret");
      const { protectedHeader } = await jwtVerify(secret!, publicKey, {
        issuer: config.teamId,
        audience: APPLE_ISSUER,
        algorithms: ["ES256"],
      });
      expect(protectedHeader.kid).toBe(config.keyId);
    }
  });

  it("rejects at construction (boot) on a malformed private key — fail loud, not on first sign-in", async () => {
    // The key parse is awaited inside the factory, so a bad APPLE_PRIVATE_KEY
    // throws at wire time (like the ES256 signer key) instead of rejecting
    // inside the error-swallowed store path on every Apple sign-in, which would
    // silently leave apple_credentials empty and break revocation (R-user-9).
    const { impl } = fakeFetch(() => Response.json({ refresh_token: "unreachable" }));
    await expect(
      createAppleCodeExchanger(
        {
          ...config,
          privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----",
        },
        impl,
      ),
    ).rejects.toThrow();
  });
});
