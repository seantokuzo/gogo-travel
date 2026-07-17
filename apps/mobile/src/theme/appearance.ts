/**
 * RN Appearance → SystemAppearanceSource adapter (spec §2.1: apps/mobile/src/
 * theme is THIN ADAPTERS ONLY — no logic lives here, only wiring).
 *
 * MODULE-LEVEL SINGLETON, exported const: ThemeProvider requires a
 * referentially stable `systemAppearance` prop — an inline/per-render object
 * would tear down and resubscribe the OS listener on every provider render,
 * on top of churning the memoized context value.
 *
 * Boundary type mapping only: RN 0.86's ColorSchemeName added "unspecified" —
 * the seam speaks "light" | "dark" | null, so anything else maps to null
 * ("no OS preference"); the provider resolves null → light (R-ds-1/R-ds-3
 * resolution lives in the runtime, not here).
 */
import type { SystemAppearanceSource } from "@gogo/tokens/react";
import { Appearance, type ColorSchemeName as RNColorSchemeName } from "react-native";

function toSeamScheme(scheme: RNColorSchemeName | null | undefined): "light" | "dark" | null {
  return scheme === "light" || scheme === "dark" ? scheme : null;
}

export const systemAppearance: SystemAppearanceSource = {
  getColorScheme: () => toSeamScheme(Appearance.getColorScheme()),
  subscribe(listener) {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      listener(toSeamScheme(colorScheme));
    });
    return () => subscription.remove();
  },
};
