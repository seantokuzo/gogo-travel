/**
 * MMKV → ThemeStorage adapter (spec §2.1: apps/mobile/src/theme is THIN
 * ADAPTERS ONLY — no logic lives here, only wiring).
 *
 * MODULE-LEVEL SINGLETON, exported const: ThemeProvider requires a
 * referentially stable `storage` prop — an inline/per-render instance churns
 * the memoized context value and re-creates the persist callbacks on every
 * provider render (app-wide re-render storm).
 *
 * MMKV reads are synchronous, which is what makes R-ds-4 (no light-mode
 * flash) hold: the provider reads persisted prefs in useState initializers,
 * so the first frame already has the right scheme.
 *
 * The `ThemeStorage` annotation narrows the surface to the seam contract
 * (getString/set) — an MMKV API change fails typecheck HERE, in the adapter,
 * not at the provider call site. Under jest, react-native-mmkv substitutes an
 * in-memory mock automatically, so tests exercise this real adapter.
 */
import type { ThemeStorage } from "@gogo/tokens/react";
import { createMMKV } from "react-native-mmkv";

// Default instance (id "mmkv.default"); STORAGE_KEYS are already namespaced
// ("gogo.appearance" / "gogo.accentTheme"), so no dedicated instance id needed.
export const themeStorage: ThemeStorage = createMMKV();
