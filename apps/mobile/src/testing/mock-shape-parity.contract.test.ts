/**
 * SEAL-SURVIVAL pins for the mock-shape parity layer (PR #42 R1, blocking
 * finding 2). The `assertStubKeysExact` calls live in jest.setup.js — which
 * is entirely OUTSIDE tsc — so a refactor that drops them (or a stub edit
 * that dodges them) previously unplugged the whole runtime-seal layer with
 * every gate green (R1 probe h: all seals inerted + the ToS-guarded
 * `setTileCountLimit` re-added → full suite + typecheck both stayed green).
 *
 * This suite re-derives each sealed stub's surface INDEPENDENTLY of the
 * factory-time seals: `jest.requireMock` hands back exactly what consumer
 * suites get, and the arms below compare it to the type-checked parity lists
 * (the google arm-2 pattern from google-provider.contract.test.ts, extended;
 * google's own surface stays pinned THERE — one contract home per library).
 *
 * Falsification (R-test-7): re-run probe h — inert the seal calls in
 * jest.setup.js and add `setTileCountLimit` to the offlineManager stub —
 * and the offlineManager arm goes RED (mutation-verified in the R1 fix leg).
 * The final arm pins the seal FUNCTION itself, so a future no-op reimplement
 * of assertStubKeysExact cannot pass either.
 */
import {
  appleAuthStubExports,
  assertStubKeysExact,
  locationStubExports,
  mapboxCameraHandleMethods,
  mapboxOfflineManagerMethods,
  mapboxShapeSourceHandleMethods,
  mapboxStubExports,
  networkStubExports,
} from "./mock-shape-parity";

/** The stub surface as consumer suites see it, minus mock plumbing keys. */
function surfaceOf(stubModule: unknown, plumbing: readonly string[]): string[] {
  return Object.keys(stubModule as Record<string, unknown>)
    .filter((key) => !plumbing.includes(key))
    .sort();
}

function sorted(contract: readonly string[]): string[] {
  return [...contract].sort();
}

describe("runtime stub surfaces equal their type-checked parity lists (independent of the jest.setup seals)", () => {
  it("@rnmapbox/maps — module exports + offlineManager + camera/shapeSource handles", () => {
    const mapbox = jest.requireMock("@rnmapbox/maps") as {
      offlineManager: Record<string, unknown>;
      __mock: { camera: Record<string, unknown>; shapeSource: Record<string, unknown> };
    };
    expect(surfaceOf(mapbox, ["__esModule", "default", "__mock"])).toEqual(
      sorted(mapboxStubExports),
    );
    expect(surfaceOf(mapbox.offlineManager, [])).toEqual(sorted(mapboxOfflineManagerMethods));
    expect(surfaceOf(mapbox.__mock.camera, [])).toEqual(sorted(mapboxCameraHandleMethods));
    expect(surfaceOf(mapbox.__mock.shapeSource, [])).toEqual(sorted(mapboxShapeSourceHandleMethods));
  });

  it("expo-location — module exports", () => {
    expect(surfaceOf(jest.requireMock("expo-location"), ["__esModule", "__mock"])).toEqual(
      sorted(locationStubExports),
    );
  });

  it("expo-network — module exports", () => {
    expect(surfaceOf(jest.requireMock("expo-network"), ["__esModule", "__mock"])).toEqual(
      sorted(networkStubExports),
    );
  });

  it("expo-apple-authentication — module exports", () => {
    expect(surfaceOf(jest.requireMock("expo-apple-authentication"), ["__esModule"])).toEqual(
      sorted(appleAuthStubExports),
    );
  });
});

describe("assertStubKeysExact itself", () => {
  it("throws on drifted input — both directions — and passes a matching surface (control arm)", () => {
    // Falsification: a no-op reimplementation of the seal fails both throw
    // pins; one that checks a single direction fails the other.
    expect(() => assertStubKeysExact("probe", ["a", "b", "extra"], ["a", "b"])).toThrow(
      /drifted.*extra: \[extra\]/s,
    );
    expect(() => assertStubKeysExact("probe", ["a"], ["a", "b"])).toThrow(/missing: \[b\]/);
    expect(() => assertStubKeysExact("probe", ["b", "a"], ["a", "b"])).not.toThrow();
  });
});
