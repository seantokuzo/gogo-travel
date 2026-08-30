/**
 * Mock-shape parity contracts for `jest.setup.js` (T-S3.2, R-test-1 — ADR-006
 * layer 1: mock fidelity).
 *
 * The global stubs in `jest.setup.js` are hand-written CLAIMS about what real
 * libraries look like. B-4 shipped because one such claim (a Google auth
 * request carrying `nonce` on native) was a fiction the whole suite then
 * validated against itself. This module is the drift alarm for the remaining
 * claims:
 *
 * - **Stub literals live HERE**, typed `satisfies` against the REAL package's
 *   exported types (a `Pick` where the stub is a deliberate subset), and
 *   `jest.setup.js` requires them. A library upgrade that renames an enum
 *   member, changes a value, or reshapes a response turns
 *   `pnpm --filter @gogo/mobile typecheck` RED instead of silently
 *   invalidating every consumer suite.
 * - **jest.fn surfaces** (offlineManager, camera/shapeSource imperative
 *   handles) need per-suite `jest.fn` identity, so they can't be built here.
 *   Their METHOD-NAME lists live here instead, checked against `keyof` the
 *   real types (list ⊆ library at typecheck), and `jest.setup.js` seals
 *   stub === list at runtime via `assertStubKeysExact` (throws at mock-factory
 *   time, so every consumer suite reds loudly on drift in either direction).
 *
 * Falsification (R-test-7): change any literal below to a value the installed
 * library doesn't ship — e.g. `PermissionStatus.GRANTED: "allowed"`, or
 * `StyleURL.Light` back to the pre-T-S3.2 fiction `…/light-v11` — and
 * typecheck goes RED (mutation-verified; see the T-S3.2 PR evidence).
 *
 * Runtime-inert: every package import below is `import type` (erased at
 * runtime), so requiring this file never touches a native module. It is test
 * infrastructure — never import it from production code.
 *
 * String enums are nominal in TS (a raw `"granted"` is not assignable to
 * `PermissionStatus`), so parity targets project each enum member to the
 * template-literal type of its VALUE — which still pins the exact string.
 */
import type * as Mapbox from "@rnmapbox/maps";
import type * as AppleAuthentication from "expo-apple-authentication";
import type { AuthSessionResult } from "expo-auth-session";
import type * as GoogleProvider from "expo-auth-session/providers/google";
import type * as Location from "expo-location";
import type * as Network from "expo-network";

/**
 * Each enum member name mapped to the plain-literal type of its value:
 * string members via the template-literal projection (nominal-enum escape),
 * numeric members via the member type itself (numeric literals are assignable
 * to matching numeric enum members). Mapped over `keyof`, so a member the
 * library ADDS is also required here — the stub can't silently lag.
 */
type EnumShape<E extends Record<string, string | number>> = {
  [K in keyof E]: E[K] extends string ? `${E[K]}` : E[K];
};

/** `A` must be assignable to `B`; alias goes red when the real type moves. */
type MustBeAssignable<A extends B, B> = A;

// ---------------------------------------------------------------------------
// expo-apple-authentication — enums the sign-in button stub re-exports.
// Contract consumers: jest.setup.js (values), tsc (parity).
// ---------------------------------------------------------------------------

export const appleAuthEnums = {
  AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1, SIGN_UP: 2 },
  AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
} satisfies {
  AppleAuthenticationButtonType: EnumShape<
    typeof AppleAuthentication.AppleAuthenticationButtonType
  >;
  AppleAuthenticationButtonStyle: EnumShape<
    typeof AppleAuthentication.AppleAuthenticationButtonStyle
  >;
  AppleAuthenticationScope: EnumShape<typeof AppleAuthentication.AppleAuthenticationScope>;
};

/** Every name the apple stub exports must exist on the real module. */
export const appleAuthStubExports = [
  "AppleAuthenticationButton",
  "AppleAuthenticationButtonType",
  "AppleAuthenticationButtonStyle",
  "AppleAuthenticationScope",
  "isAvailableAsync",
  "signInAsync",
] as const satisfies readonly (keyof typeof AppleAuthentication)[];

// ---------------------------------------------------------------------------
// expo-auth-session/providers/google — behavioral facts live in the contract
// suite (src/auth/google-provider.contract.test.ts); this section pins the
// stub's SHAPE against the real hook's types.
// ---------------------------------------------------------------------------

/**
 * The stub's `promptAsync` resolution — must be a result the real library can
 * produce. Falsification: change `type` to a non-member (e.g. "dismissed")
 * and typecheck goes RED.
 */
export const googlePromptDismissResult = { type: "dismiss" } as const satisfies AuthSessionResult;

/** Every name the google-provider stub exports must exist on the real module. */
export const googleProviderStubExports = [
  "useIdTokenAuthRequest",
] as const satisfies readonly (keyof typeof GoogleProvider)[];

/**
 * The stub's return tuple must be assignable to the REAL hook's return type —
 * reds if the library changes the tuple's arity, order, or member types.
 */
export type GoogleIdTokenStubTuple = [null, null, () => Promise<typeof googlePromptDismissResult>];
export type GoogleStubTupleMatchesRealHook = MustBeAssignable<
  GoogleIdTokenStubTuple,
  ReturnType<typeof GoogleProvider.useIdTokenAuthRequest>
>;

// ---------------------------------------------------------------------------
// expo-location — foreground-only stub (P-8 lock: background APIs are
// deliberately absent so a prod call faults loudly).
// ---------------------------------------------------------------------------

export const locationEnums = {
  PermissionStatus: { GRANTED: "granted", UNDETERMINED: "undetermined", DENIED: "denied" },
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
} satisfies {
  PermissionStatus: EnumShape<typeof Location.PermissionStatus>;
  Accuracy: EnumShape<typeof Location.Accuracy>;
};

/** Wire view of the real permission response (string-enum field projected). */
type LocationPermissionWire = Omit<
  Awaited<ReturnType<typeof Location.getForegroundPermissionsAsync>>,
  "status"
> & { status: `${Location.PermissionStatus}` };

/** Default `getForegroundPermissionsAsync` state: PRE-CONSENT (undetermined). */
export const locationPermissionUndetermined = {
  status: "undetermined",
  granted: false,
  canAskAgain: true,
  expires: "never",
} satisfies LocationPermissionWire;

/** Default `requestForegroundPermissionsAsync` resolution: user granted. */
export const locationPermissionGranted = {
  status: "granted",
  granted: true,
  canAskAgain: true,
  expires: "never",
} satisfies LocationPermissionWire;

/** Default `getCurrentPositionAsync` fix (Kyoto) — full real coords shape. */
export const locationPositionKyoto = {
  coords: {
    latitude: 35.0116,
    longitude: 135.7681,
    altitude: null,
    accuracy: 5,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: 0,
} satisfies Awaited<ReturnType<typeof Location.getCurrentPositionAsync>>;

/** Every name the location stub exports must exist on the real module. */
export const locationStubExports = [
  "PermissionStatus",
  "Accuracy",
  "getForegroundPermissionsAsync",
  "requestForegroundPermissionsAsync",
  "getCurrentPositionAsync",
] as const satisfies readonly (keyof typeof Location)[];

// ---------------------------------------------------------------------------
// expo-network — §2.5 wifi gate's module.
// ---------------------------------------------------------------------------

export const networkEnums = {
  NetworkStateType: {
    NONE: "NONE",
    UNKNOWN: "UNKNOWN",
    CELLULAR: "CELLULAR",
    WIFI: "WIFI",
    BLUETOOTH: "BLUETOOTH",
    ETHERNET: "ETHERNET",
    WIMAX: "WIMAX",
    VPN: "VPN",
    OTHER: "OTHER",
  },
} satisfies { NetworkStateType: EnumShape<typeof Network.NetworkStateType> };

/** Wire view of the real network state (string-enum field projected). */
type NetworkStateWire = Omit<Awaited<ReturnType<typeof Network.getNetworkStateAsync>>, "type"> & {
  type?: `${Network.NetworkStateType}`;
};

/** Default `getNetworkStateAsync` state: SAFE no-connection. */
export const networkStateOffline = {
  type: "NONE",
  isConnected: false,
  isInternetReachable: false,
} satisfies NetworkStateWire;

/** The stub's `addNetworkStateListener` subscription shape. */
export type NetworkSubscriptionStub = { remove: () => void };
export type NetworkSubscriptionMatchesReal = MustBeAssignable<
  NetworkSubscriptionStub,
  Pick<ReturnType<typeof Network.addNetworkStateListener>, "remove">
>;

/** Every name the network stub exports must exist on the real module. */
export const networkStubExports = [
  "NetworkStateType",
  "getNetworkStateAsync",
  "addNetworkStateListener",
] as const satisfies readonly (keyof typeof Network)[];

// ---------------------------------------------------------------------------
// @rnmapbox/maps — full module mock (P-8 prep ruling).
// ---------------------------------------------------------------------------

/**
 * Deliberate `Pick` — the stub only carries the two styles the app's scheme
 * mapping deals in. Values are the REAL 10.3.5 enum values (`…-v10`).
 * The pre-T-S3.2 stub claimed `light-v11`/`dark-v11` — URLs the installed
 * library's `StyleURL` never contained (dormant fiction: zero consumers, but
 * exactly the B-4 class). Falsification: flip a value back to `-v11` →
 * typecheck RED.
 */
export const mapboxStyleUrls = {
  Light: "mapbox://styles/mapbox/light-v10",
  Dark: "mapbox://styles/mapbox/dark-v10",
} satisfies Pick<EnumShape<typeof Mapbox.StyleURL>, "Light" | "Dark">;

/**
 * offlineManager stub surface (subset — `setTileCountLimit` is DELIBERATELY
 * absent: raising the ceiling violates the Mapbox ToS, so a prod call must
 * fault loudly). Typecheck pins every listed name to the real class; the
 * runtime seal in jest.setup.js pins the stub object to this list.
 */
export const mapboxOfflineManagerMethods = [
  "createPack",
  "getPacks",
  "getPack",
  "deletePack",
  "invalidatePack",
  "subscribe",
  "unsubscribe",
  "setProgressEventThrottle",
] as const satisfies readonly (keyof typeof Mapbox.offlineManager)[];

/** Camera imperative-handle surface (`Mapbox.Camera` type = `CameraRef`). */
export const mapboxCameraHandleMethods = [
  "setCamera",
  "fitBounds",
  "flyTo",
  "moveTo",
  "zoomTo",
] as const satisfies readonly (keyof Mapbox.Camera)[];

/** ShapeSource imperative-handle surface (real class instance methods). */
export const mapboxShapeSourceHandleMethods = [
  "getClusterExpansionZoom",
  "getClusterLeaves",
  "getClusterChildren",
] as const satisfies readonly (keyof Mapbox.ShapeSource)[];

/**
 * Every REAL-NAME export of the mapbox stub must exist on the real module
 * (`keyof typeof Mapbox` covers value exports only — so a component or fn the
 * library drops on upgrade reds this). `__esModule`/`default`/`__mock` are
 * mock plumbing, excluded by the runtime seal in jest.setup.js.
 */
export const mapboxStubExports = [
  "setAccessToken",
  "setTelemetryEnabled",
  "offlineManager",
  "MapView",
  "Camera",
  "ShapeSource",
  "CircleLayer",
  "SymbolLayer",
  "LineLayer",
  "MarkerView",
  "LocationPuck",
  "StyleURL",
] as const satisfies readonly (keyof typeof Mapbox)[];

// ---------------------------------------------------------------------------
// Runtime seal
// ---------------------------------------------------------------------------

/**
 * Throws unless `actualKeys` is EXACTLY the contract list (order-insensitive).
 * jest.setup.js calls this inside mock factories, so a drifted stub reds
 * every suite that imports the mocked module — loudly, at import time.
 * Falsification: add or remove a method on a sealed stub object in
 * jest.setup.js without updating the list here → every consumer suite RED.
 */
export function assertStubKeysExact(
  label: string,
  actualKeys: readonly string[],
  contract: readonly string[],
): void {
  const missing = contract.filter((k) => !actualKeys.includes(k));
  const extra = actualKeys.filter((k) => !contract.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `[mock-shape-parity] ${label} stub surface drifted from its type-checked contract ` +
        `(missing: [${missing.join(", ")}], extra: [${extra.join(", ")}]). Fix jest.setup.js ` +
        `or src/testing/mock-shape-parity.ts — typecheck pins the contract to the real library.`,
    );
  }
}
