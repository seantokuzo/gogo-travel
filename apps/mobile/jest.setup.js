/* eslint-env jest */
/**
 * Per-test-file setup (setupFilesAfterEnv — the jest-expo preset owns
 * `setupFiles`, so this file must NOT be listed there or it would clobber
 * the preset's RN mocks).
 *
 * Safe-area: PageHeader/TabNav/Sheet read insets; the package's sanctioned
 * jest mock provides deterministic zero insets without a provider wrapper.
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
 */
jest.mock("expo-apple-authentication", () => {
  const React = require("react");
  const { Pressable } = require("react-native");
  return {
    __esModule: true,
    AppleAuthenticationButton: ({ onPress, testID }) =>
      React.createElement(Pressable, { onPress, testID, accessibilityRole: "button" }),
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1, SIGN_UP: 2 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
    isAvailableAsync: jest.fn(async () => true),
    signInAsync: jest.fn(async () => {
      throw new Error("signInAsync not stubbed");
    }),
  };
});

jest.mock("expo-auth-session/providers/google", () => ({
  __esModule: true,
  useIdTokenAuthRequest: () => [null, null, jest.fn(async () => ({ type: "dismiss" }))],
}));

/**
 * Gesture/animation runtime (T-7.4 — the itinerary drag list rides
 * react-native-reorderable-list over gesture-handler + reanimated): all
 * three packages ship sanctioned jest environments — RNGH's jestSetup mocks
 * the native handler modules, react-native-worklets' documented jest mock
 * replaces its TurboModule (reanimated 4 initializes worklets at import, so
 * the mock must be registered FIRST), and reanimated's setUpTests installs
 * its official mock + matchers. Without these the drag list's native
 * imports fault under jest (same class as the auth stubs above).
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
jest.mock("@rnmapbox/maps", () => {
  const React = require("react");
  const { View } = require("react-native");

  const setAccessToken = jest.fn(async () => null);
  const cameraHandle = {
    setCamera: jest.fn(),
    fitBounds: jest.fn(),
    flyTo: jest.fn(),
    moveTo: jest.fn(),
    zoomTo: jest.fn(),
  };
  const shapeSourceHandle = {
    getClusterExpansionZoom: jest.fn(async () => 12),
    getClusterLeaves: jest.fn(async () => ({ type: "FeatureCollection", features: [] })),
    getClusterChildren: jest.fn(async () => ({ type: "FeatureCollection", features: [] })),
  };

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

  return {
    __esModule: true,
    default: { setAccessToken },
    setAccessToken,
    MapView,
    Camera,
    ShapeSource,
    CircleLayer,
    SymbolLayer,
    LineLayer,
    MarkerView,
    LocationPuck,
    StyleURL: {
      Light: "mapbox://styles/mapbox/light-v11",
      Dark: "mapbox://styles/mapbox/dark-v11",
    },
    __mock: { setAccessToken, camera: cameraHandle, shapeSource: shapeSourceHandle },
  };
});
