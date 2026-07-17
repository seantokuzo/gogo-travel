/**
 * @gogo/tokens/react — theme runtime binding (spec §2.7 contract).
 *
 * React is a peerDependency of this SUBPATH only; the root entry stays
 * React-free. Everything platform-bound is INJECTED, never imported
 * (R-shared-9-style DI):
 *   - persistence  → `ThemeStorage`  (app wires react-native-mmkv; MMKV's
 *     `getString`/`set` satisfy the interface structurally)
 *   - OS scheme    → `SystemAppearanceSource` (app wires RN `Appearance`)
 *
 * R-ds-1..4, R-ds-6:
 *   - no persisted pref  → resolve from the injected system source (R-ds-1)
 *   - manual pref        → persisted, applied on every launch (R-ds-2)
 *   - pref === "system"  → OS changes re-render live (R-ds-3)
 *   - storage reads are SYNCHRONOUS in the first render (useState
 *     initializers) so the first frame is already correct — no light-mode
 *     flash (R-ds-4; requires a synchronous adapter like MMKV)
 *   - accent switch swaps the resolved theme immediately (R-ds-6)
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { getTheme, isThemeName } from "../build.js";
import { DEFAULT_THEME } from "../themes.js";
import type { ThemeName } from "../themes.js";
import type { AppearancePref, ColorSchemeName, Theme } from "../types.js";

// ---------------------------------------------------------------- DI seams

// This package compiles with lib ES2023 only (no DOM/node type env — it is
// platform-agnostic). `console` exists in every host we target (RN, browser,
// node); declare just the sliver we use rather than pulling in a lib.
// Deliberate dev-signal, and the documented exception to inject-never-import:
// console is a host GLOBAL (LogBox-visible in RN), not a platform module —
// a DI seam (onWarning prop) for one warning would be ceremony without value.
declare const console: { warn(message: string): void };

/**
 * Synchronous key-value persistence seam. `react-native-mmkv`'s `MMKV`
 * instance satisfies this shape as-is (`storage={mmkv}`).
 */
export interface ThemeStorage {
  getString(key: string): string | null | undefined;
  set(key: string, value: string): void;
}

/** OS appearance seam — app adapts RN `Appearance` onto this. */
export interface SystemAppearanceSource {
  getColorScheme(): ColorSchemeName | null | undefined;
  /** Returns an unsubscribe function. */
  subscribe(listener: (scheme: ColorSchemeName | null | undefined) => void): () => void;
}

/** Persistence keys (spec §2.7). */
export const STORAGE_KEYS = {
  appearance: "gogo.appearance",
  accentTheme: "gogo.accentTheme",
} as const;

// ---------------------------------------------------------------- context

export interface ThemeContextValue {
  /** Resolved, frozen, referentially stable per (scheme, accent). */
  theme: Theme;
  /** Resolved scheme (pref + system collapsed). */
  scheme: ColorSchemeName;
  appearancePref: AppearancePref;
  /** Persists via the injected storage (R-ds-2). */
  setAppearancePref(pref: AppearancePref): void;
  accentName: ThemeName;
  /**
   * Persists; USER-level preference — a trip theme never re-skins the app
   * (R-ds-22). Unknown names are ignored (registry is the source of truth).
   */
  setAccentName(name: string): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /**
   * Omit for ephemeral theming (tests, previews) — nothing persists.
   * MUST be a referentially stable instance (module-level or memoized): an
   * inline object churns the memoized context value on every provider
   * render (app-wide re-render) and re-creates the persist callbacks.
   */
  storage?: ThemeStorage;
  /**
   * Omit to resolve `system` as light (tests, non-RN hosts).
   * MUST be a referentially stable instance (module-level or memoized): an
   * inline object additionally tears down + resubscribes the OS listener
   * every provider render.
   */
  systemAppearance?: SystemAppearanceSource;
  /** Fallback when storage holds no (valid) value. Default: "system". */
  defaultAppearancePref?: AppearancePref;
  /** Fallback when storage holds no (valid) value. Default: DEFAULT_THEME. */
  defaultAccentName?: ThemeName;
  children?: ReactNode;
}

const APPEARANCE_PREFS: readonly AppearancePref[] = ["system", "light", "dark"];

function parseAppearancePref(value: string | null | undefined): AppearancePref | null {
  return APPEARANCE_PREFS.includes(value as AppearancePref) ? (value as AppearancePref) : null;
}

function normalizeScheme(value: ColorSchemeName | null | undefined): ColorSchemeName {
  return value === "dark" ? "dark" : "light";
}

export function ThemeProvider(props: ThemeProviderProps): ReactElement {
  const { storage, systemAppearance } = props;

  // Synchronous boot reads (R-ds-4): resolved before the first frame renders.
  const [appearancePref, setAppearancePrefState] = useState<AppearancePref>(
    () =>
      parseAppearancePref(storage?.getString(STORAGE_KEYS.appearance)) ??
      props.defaultAppearancePref ??
      "system",
  );
  const [accentName, setAccentNameState] = useState<ThemeName>(() => {
    const persisted = storage?.getString(STORAGE_KEYS.accentTheme);
    // Stale persisted palette (e.g. removed in an update) falls back safely.
    return persisted != null && isThemeName(persisted)
      ? persisted
      : (props.defaultAccentName ?? DEFAULT_THEME);
  });
  const [systemScheme, setSystemScheme] = useState<ColorSchemeName>(() =>
    normalizeScheme(systemAppearance?.getColorScheme()),
  );

  // R-ds-3: follow OS scheme changes while pref === "system".
  useEffect(() => {
    if (!systemAppearance) return undefined;
    // Re-read BEFORE subscribing: a scheme change between the useState
    // initializer and this effect's flush (or across a source swap/remount)
    // would otherwise go unseen until the NEXT change event.
    setSystemScheme(normalizeScheme(systemAppearance.getColorScheme()));
    return systemAppearance.subscribe((scheme) => {
      setSystemScheme(normalizeScheme(scheme));
    });
  }, [systemAppearance]);

  const setAppearancePref = useCallback(
    (pref: AppearancePref) => {
      setAppearancePrefState(pref);
      storage?.set(STORAGE_KEYS.appearance, pref);
    },
    [storage],
  );

  const setAccentName = useCallback(
    (name: string) => {
      if (!isThemeName(name)) {
        console.warn(
          `@gogo/tokens: unknown accent theme "${name}" — ignoring. ` +
            "Register the palette in the themes record first (R-ds-5).",
        );
        return;
      }
      setAccentNameState(name);
      storage?.set(STORAGE_KEYS.accentTheme, name);
    },
    [storage],
  );

  const scheme: ColorSchemeName = appearancePref === "system" ? systemScheme : appearancePref;
  const theme = getTheme(accentName, scheme);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      scheme,
      appearancePref,
      setAppearancePref,
      accentName,
      setAccentName,
    }),
    [theme, scheme, appearancePref, setAppearancePref, accentName, setAccentName],
  );

  return createElement(ThemeContext.Provider, { value }, props.children);
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used within a <ThemeProvider> (@gogo/tokens/react).");
  }
  return value;
}
