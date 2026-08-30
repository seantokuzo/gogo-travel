/**
 * Diagnostic legs (T-S3.5) — pure leg logic over fixture deps. No real
 * network (fixture transports through the injected seam — the panel's
 * production wiring is exercised by DiagnosticsScreen.test.tsx), no real
 * keychain (in-memory store fixture).
 *
 * Falsification (R-test-7) is stated per pin; the load-bearing ones:
 * - base-url device/tier-4 → FAIL is the B-5 pin (delete the check → red);
 * - health evidence carrying the EXACT cause chain is the B-6 pin (swap
 *   describeError for a generic banner → red);
 * - env evidence never carrying values (leak a value → red);
 * - google nonce-in-URL requirement is the B-4 pin (drop the URL check → red);
 * - secure-store probe never touching the refresh-token key (probe the wrong
 *   key → red).
 */
import type { ApiBaseUrlResolution } from "@/auth";

import { readConsoleTap } from "./console-tap";
import {
  describeError,
  evaluateGoogleRequestLeg,
  DIAGNOSTICS_PROBE_KEY,
  readExpoPublicEnv,
  runBaseUrlLeg,
  runEnvLeg,
  runHealthLeg,
  runLastErrorLeg,
  runSecureStoreLeg,
  type SecureStoreLike,
} from "./legs";

function makeResolution(overrides?: Partial<ApiBaseUrlResolution>): ApiBaseUrlResolution {
  return {
    url: "http://192.168.1.69:3000/api",
    tier: 3,
    source: "metro-script-url",
    inputs: {
      explicitEnv: null,
      hostUri: null,
      scriptURL: "http://192.168.1.69:8081/index.bundle?platform=ios",
    },
    ...overrides,
  };
}

describe("describeError", () => {
  it("renders name, message, and the full cause chain", () => {
    const err = new Error("network request failed");
    (err as { cause?: unknown }).cause = Object.assign(new TypeError("ECONNREFUSED"), {
      cause: "socket closed",
    });
    const text = describeError(err);
    expect(text).toContain("Error: network request failed");
    expect(text).toContain("TypeError: ECONNREFUSED");
    expect(text).toContain("socket closed");
  });

  it("caps a self-referential cause chain instead of recursing forever", () => {
    const err = new Error("loop");
    (err as { cause?: unknown }).cause = err;
    expect(describeError(err)).toContain("(cause chain truncated)");
  });
});

describe("leg 1 — base URL + tier provenance (B-5)", () => {
  it("simulator on tier 4 passes (loopback IS the dev box there)", async () => {
    const result = await runBaseUrlLeg({
      explain: () =>
        makeResolution({
          url: "http://localhost:3000/api",
          tier: 4,
          source: "localhost-fallback",
          inputs: { explicitEnv: null, hostUri: null, scriptURL: null },
        }),
      isDevice: () => false,
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("tier: 4 (localhost-fallback)");
    expect(result.evidence).toContain("runtime: simulator");
  });

  it("THE B-5 PIN: physical device on tier 4 FAILS — the phone would dial itself", async () => {
    // Falsification: remove the device/tier-4 check in runBaseUrlLeg → red.
    const result = await runBaseUrlLeg({
      explain: () =>
        makeResolution({
          url: "http://localhost:3000/api",
          tier: 4,
          source: "localhost-fallback",
          inputs: { explicitEnv: null, hostUri: null, scriptURL: null },
        }),
      isDevice: () => true,
    });
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("B-5");
  });

  it("physical device on a derived tier passes, with raw inputs in evidence", async () => {
    const result = await runBaseUrlLeg({ explain: () => makeResolution(), isDevice: () => true });
    expect(result.status).toBe("pass");
    expect(result.summary).toBe("http://192.168.1.69:3000/api via tier 3 (metro-script-url)");
    // The raw values each tier read are the evidence — one glance, no guessing.
    expect(result.evidence).toContain("expoConfig.hostUri: (empty)");
    expect(result.evidence).toContain(
      "SourceCode.scriptURL: http://192.168.1.69:8081/index.bundle?platform=ios",
    );
  });

  it("a throwing resolver fails WITH the thrown cause (never a blank row)", async () => {
    const result = await runBaseUrlLeg({
      explain: () => {
        throw new Error("Insecure API base URL: refused in release builds");
      },
      isDevice: () => true,
    });
    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("Insecure API base URL");
  });
});

describe("leg 2 — /health round-trip", () => {
  const now = (() => {
    let t = 1000;
    return () => (t += 25);
  })();

  it("passes on 200 {ok:true} with status + latency + body in evidence", async () => {
    const result = await runHealthLeg({
      baseUrl: () => "http://192.168.1.69:3000/api",
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: "0.0.1" }) }),
      now,
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("GET http://192.168.1.69:3000/api/health");
    expect(result.evidence).toContain("status: 200");
    expect(result.evidence).toMatch(/latency: \d+ms/);
    expect(result.evidence).toContain('"version":"0.0.1"');
  });

  it("fails on a non-ok status, still showing status + body", async () => {
    const result = await runHealthLeg({
      baseUrl: () => "http://192.168.1.69:3000/api",
      fetchFn: async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }),
      now,
    });
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("500");
    expect(result.evidence).toContain('"error":"boom"');
  });

  it("fails on 200 with a non-health body (a captive portal answering for us)", async () => {
    const result = await runHealthLeg({
      baseUrl: () => "http://192.168.1.69:3000/api",
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ hello: "wifi login" }) }),
      now,
    });
    expect(result.status).toBe("fail");
  });

  it("THE B-6 PIN: a transport failure surfaces the EXACT cause chain, never a generic banner", async () => {
    // Falsification: replace describeError(err) in the catch with a generic
    // "network request failed" string → red on the cause assertions.
    const cause = new TypeError("Network request failed");
    (cause as { cause?: unknown }).cause = new Error("connection refused to 192.168.1.69:3000");
    const result = await runHealthLeg({
      baseUrl: () => "http://192.168.1.69:3000/api",
      fetchFn: async () => {
        throw cause;
      },
      now,
    });
    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("TypeError: Network request failed");
    expect(result.evidence).toContain("connection refused to 192.168.1.69:3000");
    // The URL the runtime actually dialed is IN the failure evidence — the
    // one clue B-5's debugging never had.
    expect(result.evidence).toContain("GET http://192.168.1.69:3000/api/health");
  });

  it("aborts a hung request at the timeout and reports the timeout as the cause", async () => {
    const result = await runHealthLeg({
      baseUrl: () => "http://10.0.0.9:3000/api",
      fetchFn: (_input, init) =>
        new Promise((_resolve, reject) => {
          // Fixture transport honors the abort signal like real fetch does.
          init?.signal?.addEventListener("abort", () =>
            reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
          );
        }),
      now: () => Date.now(),
      timeoutMs: 30,
    });
    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("timeout after 30ms");
  });

  it("a throwing baseUrl resolver fails with that cause (unresolvable ≠ unreachable)", async () => {
    const result = await runHealthLeg({
      baseUrl: () => {
        throw new Error("Insecure API base URL");
      },
      fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
      now,
    });
    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("Insecure API base URL");
  });
});

describe("leg 3 — EXPO_PUBLIC_* inlining (names only)", () => {
  it("passes with a set/unset roster and NEVER leaks a value", async () => {
    const result = await runEnvLeg({
      read: () => [
        { name: "EXPO_PUBLIC_API_URL", present: true, blank: false },
        { name: "EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID", present: false, blank: false },
      ],
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("EXPO_PUBLIC_API_URL: set");
    expect(result.evidence).toContain("EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: unset");
  });

  it("fails naming any present-but-blank var (the .env quoting mistake)", async () => {
    // Falsification: drop the blank check in runEnvLeg → red.
    const result = await runEnvLeg({
      read: () => [{ name: "EXPO_PUBLIC_API_URL", present: true, blank: true }],
    });
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("EXPO_PUBLIC_API_URL");
    expect(result.evidence).toContain("EXPO_PUBLIC_API_URL: SET BUT BLANK");
  });

  it("readExpoPublicEnv reports presence without values — and tracks live env (control)", async () => {
    // jest doesn't inline env, so process.env manipulation drives the REAL
    // reader here. The static-member-read requirement (Metro inlining) is a
    // build-time property asserted by the comment + this suite's existence;
    // what IS runtime-checkable: presence/blank derivation and no values.
    const prev = process.env.EXPO_PUBLIC_API_URL;
    try {
      process.env.EXPO_PUBLIC_API_URL = "http://192.168.1.50:3000";
      const entries = readExpoPublicEnv();
      const apiUrl = entries.find((e) => e.name === "EXPO_PUBLIC_API_URL");
      expect(apiUrl).toEqual({ name: "EXPO_PUBLIC_API_URL", present: true, blank: false });

      const result = await runEnvLeg({ read: readExpoPublicEnv });
      // The VALUE must never surface (names only, never values — R-test-2).
      expect(result.evidence).not.toContain("192.168.1.50");

      // Control arm: unset flips presence — the reader is live, not a table.
      delete process.env.EXPO_PUBLIC_API_URL;
      const after = readExpoPublicEnv().find((e) => e.name === "EXPO_PUBLIC_API_URL");
      expect(after).toEqual({ name: "EXPO_PUBLIC_API_URL", present: false, blank: false });
    } finally {
      if (prev === undefined) delete process.env.EXPO_PUBLIC_API_URL;
      else process.env.EXPO_PUBLIC_API_URL = prev;
    }
  });
});

describe("leg 4 — Google auth-request shape (B-4)", () => {
  it("unconfigured → definite FAIL naming the missing client id", () => {
    const result = evaluateGoogleRequestLeg({ configured: false, request: null, timedOut: false });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("fail");
    expect(result?.summary).toContain("EXPO_PUBLIC_GOOGLE_");
  });

  it("configured + still loading → null (leg stays running)", () => {
    expect(
      evaluateGoogleRequestLeg({ configured: true, request: null, timedOut: false }),
    ).toBeNull();
  });

  it("configured + patience exhausted → FAIL", () => {
    const result = evaluateGoogleRequestLeg({ configured: true, request: null, timedOut: true });
    expect(result?.status).toBe("fail");
    expect(result?.summary).toContain("never finished loading");
  });

  it("THE B-4 PIN: loaded request passes ONLY when our nonce is in extraParams AND the authorize URL", () => {
    // Falsification: drop either check in evaluateGoogleRequestLeg → red on
    // one of the fail arms below.
    const nonce = "aabbccdd00112233";
    const pass = evaluateGoogleRequestLeg({
      configured: true,
      timedOut: false,
      request: {
        url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&nonce=${nonce}&redirect_uri=y`,
        extraParams: { nonce },
      },
    });
    expect(pass?.status).toBe("pass");
    // Nonce VALUES stay out of the evidence (they ride the authorize URL,
    // not QA screenshots).
    expect(pass?.evidence).not.toContain(nonce);

    const noUrlNonce = evaluateGoogleRequestLeg({
      configured: true,
      timedOut: false,
      request: {
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=y",
        extraParams: { nonce },
      },
    });
    expect(noUrlNonce?.status).toBe("fail");
    expect(noUrlNonce?.summary).toContain("authorize URL");

    const noNonceAtAll = evaluateGoogleRequestLeg({
      configured: true,
      timedOut: false,
      request: {
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=y",
        extraParams: {},
      },
    });
    expect(noNonceAtAll?.status).toBe("fail");
    expect(noNonceAtAll?.summary).toContain("no nonce supplied");
  });
});

describe("leg 5 — secure-store round-trip", () => {
  function makeMemoryStore(): { store: SecureStoreLike; map: Map<string, string>; keysTouched: Set<string> } {
    const map = new Map<string, string>();
    const keysTouched = new Set<string>();
    return {
      map,
      keysTouched,
      store: {
        async getItemAsync(key) {
          keysTouched.add(key);
          return map.get(key) ?? null;
        },
        async setItemAsync(key, value) {
          keysTouched.add(key);
          map.set(key, value);
        },
        async deleteItemAsync(key) {
          keysTouched.add(key);
          map.delete(key);
        },
      },
    };
  }

  it("passes a faithful round-trip and cleans up its probe", async () => {
    const { store, map } = makeMemoryStore();
    const result = await runSecureStoreLeg({ store });
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("write: ok");
    expect(result.evidence).toContain("read-back: ok");
    expect(result.evidence).toContain("verify-gone: ok");
    expect(map.size).toBe(0);
  });

  it("LAW-#1-ADJACENT PIN: the probe only ever touches its own key — never the refresh token's", async () => {
    // Falsification: point DIAGNOSTICS_PROBE_KEY at "gogo.refreshToken" (or
    // probe an extra key) → red. secure-storage.ts stays the ONLY reader of
    // the token key.
    const { store, keysTouched } = makeMemoryStore();
    await runSecureStoreLeg({ store });
    expect([...keysTouched]).toEqual([DIAGNOSTICS_PROBE_KEY]);
    expect(DIAGNOSTICS_PROBE_KEY).not.toBe("gogo.refreshToken");
  });

  it("fails with MISMATCH when the read-back diverges", async () => {
    const { store } = makeMemoryStore();
    const brokenStore: SecureStoreLike = {
      ...store,
      async getItemAsync() {
        return "something else entirely";
      },
    };
    const result = await runSecureStoreLeg({ store: brokenStore });
    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("read-back: MISMATCH");
  });

  it("fails naming the step + exact cause when the keychain throws", async () => {
    const { store } = makeMemoryStore();
    const throwingStore: SecureStoreLike = {
      ...store,
      async setItemAsync() {
        throw new Error("errSecInteractionNotAllowed (device locked?)");
      },
    };
    const result = await runSecureStoreLeg({ store: throwingStore });
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("write");
    expect(result.evidence).toContain("errSecInteractionNotAllowed");
  });

  it("fails when a deleted probe is still readable (stale keychain)", async () => {
    const { store, map } = makeMemoryStore();
    const stickyStore: SecureStoreLike = {
      ...store,
      async deleteItemAsync() {
        // Swallow the delete — map keeps the value.
      },
    };
    const result = await runSecureStoreLeg({ store: stickyStore });
    expect(result.status).toBe("fail");
    expect(result.evidence).toContain("verify-gone: STALE");
    expect(map.size).toBe(1); // fixture really did keep it — the pin could fail
  });
});

describe("leg 6 — last dev error (B-6 read-back)", () => {
  it("fails when the tap is not installed (blind ≠ clean)", async () => {
    // Falsification: make the leg treat uninstalled as pass → red.
    const result = await runLastErrorLeg({
      readTap: () => ({ installed: false, installedAt: null, count: 0, last: null }),
    });
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("not installed");
  });

  it("passes clean with 'none captured' when nothing warned", async () => {
    const result = await runLastErrorLeg({
      readTap: () => ({ installed: true, installedAt: 1700000000000, count: 0, last: null }),
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("captured: 0");
  });

  it("surfaces the last captured cause verbatim", async () => {
    const result = await runLastErrorLeg({
      readTap: () => ({
        installed: true,
        installedAt: 1700000000000,
        count: 3,
        last: { at: 1700000005000, text: "[api] transport failure: GET http://localhost:3000/api/health TypeError: Network request failed" },
      }),
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("captured: 3");
    expect(result.evidence).toContain("[api] transport failure");
    expect(result.evidence).toContain("TypeError: Network request failed");
  });

  it("wires against the real tap's snapshot shape (type-level via readConsoleTap)", async () => {
    // Compile-time parity: the fixture snapshots above must stay assignable
    // to what readConsoleTap actually returns — this line reds on drift.
    const result = await runLastErrorLeg({ readTap: readConsoleTap });
    expect(["pass", "fail"]).toContain(result.status);
  });
});
