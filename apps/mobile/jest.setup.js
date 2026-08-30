/* eslint-env jest */
/**
 * Per-test-file setup (setupFilesAfterEnv — the jest-expo preset owns
 * `setupFiles`, so this file must NOT be listed there or it would clobber
 * the preset's RN mocks).
 *
 * MOCK-FIDELITY CONTRACT (T-S3.2, R-test-1 — ADR-006 layer 1): every global
 * stub below carries a "Contract:" pointer to the suite or module that pins
 * its claims against the REAL library. Hand-rolled stubs source their shapes
 * from `src/testing/mock-shape-parity.ts` (typecheck pins those shapes to the
 * installed package's types) and/or a `*.contract.test.ts` suite that
 * exercises the real library. A stub with no contract pointer is a review
 * finding. B-4 is why: a stub shape the library never produces let every
 * downstream test verify fiction.
 *
 * Safe-area: PageHeader/TabNav/Sheet read insets; the package's sanctioned
 * jest mock provides deterministic zero insets without a provider wrapper.
 * Contract: library-owned — the mock ships inside react-native-safe-area-context
 * itself, versioned with the code it mocks; its fidelity is the package's own.
 */
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);

/**
 * Auth native modules (T-5.7): the `(auth)/sign-in` route file is eagerly
 * required whenever the route tree is rendered (renderRouter builds the whole
 * manifest), so the native Apple button + Google auth-session hook get global
 * jest stubs here — otherwise the native view / hook would fault outside a
 * device. The button stub forwards its testID + onPress so E2E-style flows
 * still reach it. Tests that exercise the real flows (apple.test/google.test)
 * declare their own file-local jest.mock, which overrides these.
 *
 * Contract: src/testing/mock-shape-parity.ts (`appleAuthEnums` pins every
 * enum member name + value to the installed package; `appleAuthStubExports`
 * pins the export names, sealed below at mock-build time; seal survival is
 * pinned by src/testing/mock-shape-parity.contract.test.ts).
 */
jest.mock("expo-apple-authentication", () => {
  const React = require("react");
  const { Pressable } = require("react-native");
  const shapes = require("./src/testing/mock-shape-parity");
  const moduleExports = {
    __esModule: true,
    AppleAuthenticationButton: ({ onPress, testID }) =>
      React.createElement(Pressable, { onPress, testID, accessibilityRole: "button" }),
    ...shapes.appleAuthEnums,
    isAvailableAsync: jest.fn(async () => true),
    signInAsync: jest.fn(async () => {
      throw new Error("signInAsync not stubbed");
    }),
  };
  shapes.assertStubKeysExact(
    "expo-apple-authentication module",
    Object.keys(moduleExports).filter((k) => k !== "__esModule"),
    shapes.appleAuthStubExports,
  );
  return moduleExports;
});

/**
 * Contract: src/auth/google-provider.contract.test.ts — imports the REAL
 * `expo-auth-session/providers/google` (only expo-crypto native primitives
 * mocked; expo-application loads real — the contract passes an explicit
 * redirectUri so `applicationId` is never read) and pins the facts this
 * stub's shape relies on:
 * the loaded native request resolves to the Code flow, never mints an
 * instance `nonce` (the B-4 fact), and carries OUR `extraParams.nonce` into
 * the authorize URL. That suite also pins THIS stub: `request` must stay
 * `null` (the unloaded state — the only universally-true native state); a
 * fabricated loaded request here goes RED there. Shape parity
 * (`googlePromptDismissResult`, tuple type): src/testing/mock-shape-parity.ts.
 */
jest.mock("expo-auth-session/providers/google", () => {
  const shapes = require("./src/testing/mock-shape-parity");
  return {
    __esModule: true,
    useIdTokenAuthRequest: () => [
      null,
      null,
      jest.fn(async () => ({ ...shapes.googlePromptDismissResult })),
    ],
  };
});

/**
 * Gesture/animation runtime (T-7.4 — the itinerary drag list rides
 * react-native-reorderable-list over gesture-handler + reanimated): all
 * three packages ship sanctioned jest environments — RNGH's jestSetup mocks
 * the native handler modules, react-native-worklets' documented jest mock
 * replaces its TurboModule (reanimated 4 initializes worklets at import, so
 * the mock must be registered FIRST), and reanimated's setUpTests installs
 * its official mock + matchers. Without these the drag list's native
 * imports fault under jest (same class as the auth stubs above).
 *
 * Contract: library-owned — all three mocks ship inside their packages and
 * version with them; their fidelity is the packages' own.
 */
require("react-native-gesture-handler/jestSetup");
jest.mock("react-native-worklets", () => require("react-native-worklets/lib/module/mock"));
require("react-native-reanimated").setUpTests();

/**
 * Mapbox (T-8.2): jest mocks `@rnmapbox/maps` ENTIRELY — no native map
 * rendering under jest (P-8 prep ruling). The package's own `setup-jest.js`
 * only stubs the NativeModules layer and still renders the real JS
 * components (native view manager config faults, nondeterministic); a full
 * module mock is the same class as the auth-native stubs above. Components
 * render as Views forwarding their props (testID falls back to the source/
 * layer `id`, so composition tests query `map-source-*`/`map-layer-*`; the
 * Mapbox layer `style` object is remapped to `layerStyle` so RN's style
 * pipeline never sees paint props). Imperative handles (camera setCamera,
 * source getClusterExpansionZoom) are shared jest.fns exposed on `__mock` —
 * suites read them via `jest.requireMock("@rnmapbox/maps")` and clear them
 * in their own beforeEach. All pin/camera/filter LOGIC lives in pure modules
 * (`features/map/*`) with their own suites; the screen test proves
 * composition only.
 */
/**
 * expo-location (T-8.3): global stub in the auth-native class above — the
 * map slot's locate flow imports it, so any suite rendering the map surface
 * would fault on the native module outside a device. Defaults are the
 * PRE-CONSENT state (undetermined, canAskAgain) so no test accidentally
 * exercises a granted path it didn't arrange; suites steer per-test via
 * `jest.requireMock("expo-location").__mock` (the mapbox pattern) and reset
 * in their own beforeEach. Only FOREGROUND APIs exist here — a test
 * reaching for a background API should fault loudly (P-8 foreground-only
 * lock).
 *
 * Contract: src/testing/mock-shape-parity.ts (`locationEnums`,
 * `locationPermissionUndetermined`/`locationPermissionGranted`,
 * `locationPositionKyoto`, `locationStubExports` — each shape typechecked
 * against the installed package). Responses are spread per call so no suite
 * can mutate another's copy.
 */
jest.mock("expo-location", () => {
  const shapes = require("./src/testing/mock-shape-parity");
  const getForegroundPermissionsAsync = jest.fn(async () => ({
    ...shapes.locationPermissionUndetermined,
  }));
  const requestForegroundPermissionsAsync = jest.fn(async () => ({
    ...shapes.locationPermissionGranted,
  }));
  const getCurrentPositionAsync = jest.fn(async () => ({
    ...shapes.locationPositionKyoto,
    coords: { ...shapes.locationPositionKyoto.coords },
  }));
  const moduleExports = {
    __esModule: true,
    PermissionStatus: { ...shapes.locationEnums.PermissionStatus },
    Accuracy: { ...shapes.locationEnums.Accuracy },
    getForegroundPermissionsAsync,
    requestForegroundPermissionsAsync,
    getCurrentPositionAsync,
    __mock: {
      getForegroundPermissionsAsync,
      requestForegroundPermissionsAsync,
      getCurrentPositionAsync,
    },
  };
  shapes.assertStubKeysExact(
    "expo-location module",
    Object.keys(moduleExports).filter((k) => !["__esModule", "__mock"].includes(k)),
    shapes.locationStubExports,
  );
  return moduleExports;
});

/**
 * Contract: src/testing/mock-shape-parity.ts (`mapboxStyleUrls` — REAL 10.3.5
 * values; `mapboxOfflineManagerMethods`/`mapboxCameraHandleMethods`/
 * `mapboxShapeSourceHandleMethods` pin each surface to the real types, and
 * the `assertStubKeysExact` seals below pin these stub objects to those
 * lists at mock-build time; `mapboxStubExports` pins the module's export
 * names). T-S3.2 fidelity fix: the previous stub claimed
 * `light-v11`/`dark-v11` StyleURLs the installed library never contained.
 */
jest.mock("@rnmapbox/maps", () => {
  const React = require("react");
  const { View } = require("react-native");
  const shapes = require("./src/testing/mock-shape-parity");

  const setAccessToken = jest.fn(async () => shapes.mapboxDefaultResolutions.setAccessToken);
  // T-8.7 coordination: the map screen feature-detects setTelemetryEnabled —
  // the mock carries it so the detect exercises the call path under jest.
  const setTelemetryEnabled = jest.fn();
  /**
   * offlineManager (T-8.5): jest.fn surface matching the installed 10.3.5
   * typings (modules/offline/offlineManager.d.ts). Defaults are the EMPTY
   * device (no packs) so no suite inherits pack state it didn't arrange;
   * suites steer via `jest.requireMock("@rnmapbox/maps").__mock.offlineManager`
   * and drive downloads by invoking the progress/error listeners captured in
   * `createPack.mock.calls` (the machine carries the pins — P-8 prep ruling).
   * `setTileCountLimit` is DELIBERATELY absent: raising the ceiling violates
   * the Mapbox ToS (readiness brief), so a prod call should fault loudly
   * (same posture as background APIs missing from the expo-location stub).
   */
  const offlineManager = {
    createPack: jest.fn(async () => undefined),
    getPacks: jest.fn(async () => [...shapes.mapboxDefaultResolutions.getPacks]),
    getPack: jest.fn(async () => shapes.mapboxDefaultResolutions.getPack),
    deletePack: jest.fn(async () => undefined),
    invalidatePack: jest.fn(async () => undefined),
    subscribe: jest.fn(async () => undefined),
    unsubscribe: jest.fn(),
    setProgressEventThrottle: jest.fn(),
  };
  const cameraHandle = {
    setCamera: jest.fn(),
    fitBounds: jest.fn(),
    flyTo: jest.fn(),
    moveTo: jest.fn(),
    zoomTo: jest.fn(),
  };
  const shapeSourceHandle = {
    getClusterExpansionZoom: jest.fn(
      async () => shapes.mapboxDefaultResolutions.getClusterExpansionZoom,
    ),
    // Cluster collections: the real methods return Promise<any>, so these
    // literals stay inline — a parity `satisfies` would pin nothing (the
    // name-only floor; see mock-shape-parity.ts header).
    getClusterLeaves: jest.fn(async () => ({ type: "FeatureCollection", features: [] })),
    getClusterChildren: jest.fn(async () => ({ type: "FeatureCollection", features: [] })),
  };
  // Runtime seals: stub surface === type-checked contract, both directions
  // (typecheck pins the lists to the real library; this pins the objects to
  // the lists). NAME-level only — jest.fn signatures are below this floor
  // (mock-shape-parity.ts header states the boundary); default resolutions
  // with concrete real return types come typed from mapboxDefaultResolutions.
  // Throws at mock-build time → every consumer suite reds loudly. Seal
  // survival is pinned by src/testing/mock-shape-parity.contract.test.ts.
  shapes.assertStubKeysExact(
    "@rnmapbox/maps offlineManager",
    Object.keys(offlineManager),
    shapes.mapboxOfflineManagerMethods,
  );
  shapes.assertStubKeysExact(
    "@rnmapbox/maps Camera handle",
    Object.keys(cameraHandle),
    shapes.mapboxCameraHandleMethods,
  );
  shapes.assertStubKeysExact(
    "@rnmapbox/maps ShapeSource handle",
    Object.keys(shapeSourceHandle),
    shapes.mapboxShapeSourceHandleMethods,
  );

  const hostView = (displayName, handle, { remapStyle = false } = {}) => {
    const Component = React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => handle ?? {});
      const { children, style, ...rest } = props;
      const forwarded = remapStyle ? { ...rest, layerStyle: style } : { ...rest, style };
      return React.createElement(
        View,
        { ...forwarded, testID: props.testID ?? props.id },
        children,
      );
    });
    Component.displayName = displayName;
    return Component;
  };

  const MapView = hostView("MapView");
  const Camera = hostView("Camera", cameraHandle);
  const ShapeSource = hostView("ShapeSource", shapeSourceHandle);
  const CircleLayer = hostView("CircleLayer", undefined, { remapStyle: true });
  const SymbolLayer = hostView("SymbolLayer", undefined, { remapStyle: true });
  const LineLayer = hostView("LineLayer", undefined, { remapStyle: true });
  const MarkerView = hostView("MarkerView");
  const LocationPuck = hostView("LocationPuck");

  const moduleExports = {
    __esModule: true,
    default: { setAccessToken, setTelemetryEnabled },
    setAccessToken,
    setTelemetryEnabled,
    offlineManager,
    MapView,
    Camera,
    ShapeSource,
    CircleLayer,
    SymbolLayer,
    LineLayer,
    MarkerView,
    LocationPuck,
    StyleURL: { ...shapes.mapboxStyleUrls },
    __mock: {
      setAccessToken,
      setTelemetryEnabled,
      camera: cameraHandle,
      shapeSource: shapeSourceHandle,
      offlineManager,
    },
  };
  shapes.assertStubKeysExact(
    "@rnmapbox/maps module",
    Object.keys(moduleExports).filter((k) => !["__esModule", "default", "__mock"].includes(k)),
    shapes.mapboxStubExports,
  );
  return moduleExports;
});

/**
 * expo-network (T-8.5): the §2.5 wifi gate's module. Default is the SAFE
 * no-connection state (`NONE`) — the expo-location pre-consent posture: no
 * suite accidentally triggers a wifi-gated auto-download it didn't arrange.
 * Suites steer via `jest.requireMock("expo-network").__mock` and drive the
 * deferred-retry path by invoking listeners captured in
 * `addNetworkStateListener.mock.calls`.
 *
 * Contract: src/testing/mock-shape-parity.ts (`networkEnums`,
 * `networkStateOffline`, `networkStubExports` — typechecked against the
 * installed package).
 */
jest.mock("expo-network", () => {
  const shapes = require("./src/testing/mock-shape-parity");
  const getNetworkStateAsync = jest.fn(async () => ({ ...shapes.networkStateOffline }));
  const addNetworkStateListener = jest.fn(() => ({ remove: jest.fn() }));
  const moduleExports = {
    __esModule: true,
    NetworkStateType: { ...shapes.networkEnums.NetworkStateType },
    getNetworkStateAsync,
    addNetworkStateListener,
    __mock: { getNetworkStateAsync, addNetworkStateListener },
  };
  shapes.assertStubKeysExact(
    "expo-network module",
    Object.keys(moduleExports).filter((k) => !["__esModule", "__mock"].includes(k)),
    shapes.networkStubExports,
  );
  return moduleExports;
});
