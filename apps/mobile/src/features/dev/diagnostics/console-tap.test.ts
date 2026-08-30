/**
 * Console tap (T-S3.5 leg 6) — the B-6 read-back seam. Pins: prefixed warns
 * captured, foreign warns ignored, call-through ALWAYS preserved, idempotent
 * install, and the `__DEV__` gate on BOTH arms (release never patches
 * console) with a live-flip control.
 *
 * __DEV__ is flipped via the sanctioned runtime-global pattern
 * (api-client.test.ts precedent) — installConsoleTap reads the global at
 * CALL time, so the flip exercises the real gate, not a copy.
 */
import { installConsoleTap, readConsoleTap, resetConsoleTapForTests } from "./console-tap";

const devGlobal = globalThis as unknown as { __DEV__: boolean };
const originalDev = devGlobal.__DEV__;

describe("console tap (B-6 read-back)", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    resetConsoleTapForTests();
    devGlobal.__DEV__ = true;
    // Spy BEFORE install so the tap wraps the spy: assertions can then prove
    // call-through (the spy still fires) AND capture at the same time.
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetConsoleTapForTests();
    warnSpy.mockRestore();
    devGlobal.__DEV__ = originalDev;
  });

  it("captures [auth]/[api]-prefixed warns (last + count) and calls through", () => {
    installConsoleTap();
    console.warn("[auth] google sign-in failed:", new Error("missing google id token"));
    console.warn("[api] transport failure: GET http://x", new TypeError("Network request failed"));

    const snap = readConsoleTap();
    expect(snap.installed).toBe(true);
    expect(snap.count).toBe(2);
    expect(snap.last?.text).toContain("[api] transport failure");
    expect(snap.last?.text).toContain("TypeError: Network request failed");
    // Call-through: the pre-install warn still received BOTH calls — the tap
    // observes, never swallows (falsification: drop `original(...args)` → 0).
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps Error causes in the captured text (the whole point of B-6)", () => {
    installConsoleTap();
    const err = new Error("sign-in failed");
    (err as { cause?: unknown }).cause = new Error("refused 192.168.1.69:3000");
    console.warn("[auth] apple sign-in failed:", err);
    expect(readConsoleTap().last?.text).toContain("refused 192.168.1.69:3000");
  });

  it("ignores unprefixed warns — with a live control", () => {
    installConsoleTap();
    console.warn("Require cycle: some framework noise");
    console.warn({ not: "a string first arg" });
    expect(readConsoleTap().count).toBe(0);
    // Control: the same session still captures a prefixed warn — the zero
    // above is the filter, not a dead tap.
    console.warn("[auth] real signal");
    expect(readConsoleTap().count).toBe(1);
  });

  it("is idempotent: double-install captures each warn once", () => {
    installConsoleTap();
    installConsoleTap();
    console.warn("[api] once");
    expect(readConsoleTap().count).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("RELEASE ARM: __DEV__ false → no patch, no capture — with the flip control", () => {
    devGlobal.__DEV__ = false;
    const before = console.warn;
    installConsoleTap();
    // Identity pin: console.warn untouched — a release build never carries a
    // patched console (falsification: remove the __DEV__ guard → red here).
    expect(console.warn).toBe(before);
    console.warn("[auth] should not be captured");
    expect(readConsoleTap()).toEqual({ installed: false, installedAt: null, count: 0, last: null });

    // Control (proves the pin could fail): the SAME harness with __DEV__
    // true installs and captures — the inertness above was the gate's doing.
    devGlobal.__DEV__ = true;
    installConsoleTap();
    expect(console.warn).not.toBe(before);
    console.warn("[auth] now captured");
    expect(readConsoleTap().count).toBe(1);
  });
});
