/**
 * Gallery smoke (DS-10) — the whole component library composes and renders
 * under the theme runtime in BOTH schemes. Expo-router is stubbed: the
 * gallery uses Stack.Screen/Redirect/Link, PageHeader uses useRouter.
 */
import { THEME_NAMES } from "@gogo/tokens";
import { screen } from "@testing-library/react-native";

import GalleryScreen from "@/app/gallery";
import { renderWithTheme } from "@/test-utils/render";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  Redirect: () => null,
  Link: () => null,
  useRouter: () => ({ back: jest.fn() }),
}));

const SECTION_ANCHORS = [
  "gallery-header",
  "gallery-scheme",
  "gallery-palette",
  "g-btn-primary",
  "g-btn-loading",
  "g-card-pressable",
  "g-input-error",
  "g-empty",
  "g-banner-danger",
  "g-skeleton-text",
  "g-list-item-pressable",
  "g-segmented",
  "g-open-dialog",
  "g-open-sheet",
  "g-inline-header",
  "tab-bar-today",
];

describe("gallery screen (Law #7 evidence surface)", () => {
  it("renders every section in light", async () => {
    await renderWithTheme(<GalleryScreen />, { scheme: "light" });
    for (const testID of SECTION_ANCHORS) {
      expect(screen.getByTestId(testID, { includeHiddenElements: true })).toBeOnTheScreen();
    }
  });

  it("renders every section in dark", async () => {
    await renderWithTheme(<GalleryScreen />, { scheme: "dark" });
    for (const testID of SECTION_ANCHORS) {
      expect(screen.getByTestId(testID, { includeHiddenElements: true })).toBeOnTheScreen();
    }
  });

  it("renders under every registered palette (R-ds-5 zero-code guarantee)", async () => {
    // Registry-driven, not hardcoded: a future palette addition is exercised
    // automatically.
    for (const accent of THEME_NAMES) {
      await renderWithTheme(<GalleryScreen />, { accent });
      expect(screen.getByTestId("gallery-header")).toBeOnTheScreen();
    }
  });
});
