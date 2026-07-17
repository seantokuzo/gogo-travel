# Design System — Tokens, Theming, Core Components

> Spec for `packages/tokens` + the mobile theme runtime + the core component
> library. The contract for "thoughtful, minimalistic, customizable"
> (PLANNING § Overview). Styling law: `StyleSheet.create` + design tokens —
> NO NativeWind (ADR-004, mobile-engineer landmines).
>
> **Status:** draft — not approvable until zero `[NEEDS CLARIFICATION]` markers.
> **Depends on:** ADR-004 (stack). **Consumed by:** every `apps/mobile` screen spec.

---

## 1. Requirements (EARS)

### Appearance & theming

- **R-ds-1**: WHEN the app launches with no persisted appearance preference
  THE SYSTEM SHALL resolve light/dark from the OS color scheme.
- **R-ds-2**: WHEN the user sets a manual appearance preference
  (`light` | `dark` | `system`) THE SYSTEM SHALL persist it locally and apply
  it on every subsequent launch until changed.
- **R-ds-3**: WHEN the OS color scheme changes while the preference is
  `system` THE SYSTEM SHALL re-render all mounted screens in the new scheme
  without restart.
- **R-ds-4**: WHEN the app cold-starts with a persisted or system-resolved
  dark scheme THE SYSTEM SHALL render the first visible frame in dark — no
  light-mode flash (requires synchronous preference read before first render).
- **R-ds-5**: WHEN a new accent theme is added to the registry THE SYSTEM
  SHALL require zero component or screen code changes — a theme is pure data
  (ramps + materialized semantic sets, validated by R-ds-8). (Synced
  2026-07-17, post-T-4.1)
- **R-ds-6**: WHEN the active accent theme changes at runtime THE SYSTEM
  SHALL re-render all mounted screens with the new accent-derived tokens
  immediately.
- **R-ds-22**: WHEN a trip has a `theme` set THE SYSTEM SHALL apply it only
  to trip-scoped accent surfaces (trip card / trip header tint) — never a
  whole-app re-skin; the app-wide accent theme SHALL remain a user-level
  preference regardless of trip context. (Resolved 2026-07-09, Gate 2)

### Token consumption

- **R-ds-7**: WHEN any screen or component declares visual styles THE SYSTEM
  SHALL source every color, spacing, radius, type, elevation, and motion value
  from theme tokens via the `createStyles(theme)` factory — literal color/
  spacing values in `apps/mobile` are a lint error.
- **R-ds-8**: WHEN the token package builds THE SYSTEM SHALL verify (automated
  test) that every declared foreground/background token pair meets WCAG 2.1 AA
  contrast (≥ 4.5:1 body text, ≥ 3:1 large text and UI icons) across every
  `scheme × accent theme` combination.

### Accessibility

- **R-ds-9**: WHEN any interactive element renders THE SYSTEM SHALL provide a
  hit target of at least 44×44 pt (via padding or `hitSlop`), regardless of
  visual size.
- **R-ds-10**: WHEN the OS text size (Dynamic Type) changes THE SYSTEM SHALL
  scale all typography roles with `allowFontScaling`, capped per role by
  `maxFontSizeMultiplier`, without clipping single-line UI chrome.
- **R-ds-11**: WHEN the OS reduce-motion setting is enabled THE SYSTEM SHALL
  disable or replace non-essential animations (skeleton shimmer, entrance
  transitions) with cross-fades or static states.
- **R-ds-12**: WHEN any interactive design-system component renders THE SYSTEM
  SHALL expose a correct `accessibilityRole` and an `accessibilityLabel`
  (defaulting from its visible text) so every action is screen-reader operable.

### Component behavior

- **R-ds-13**: WHEN a Button is pressed THE SYSTEM SHALL show pressed-state
  feedback within 100 ms and fire its haptic per the convention table (§ 2.8).
- **R-ds-14**: WHEN a Button has `loading: true` THE SYSTEM SHALL show an
  inline spinner, block further presses, and keep its layout width stable.
- **R-ds-15**: WHEN a list/collection surface is fetching its initial data
  THE SYSTEM SHALL render Skeleton placeholders matching the expected layout
  (bare spinners are reserved for in-button and full-screen boot states).
- **R-ds-16**: WHEN a collection resolves to zero items THE SYSTEM SHALL
  render an EmptyState (icon + title + optional CTA) — never a blank region.
- **R-ds-17**: WHEN a recoverable error occurs on an async surface THE SYSTEM
  SHALL render an ErrorBanner with a retry affordance; errors are never
  silently swallowed.
- **R-ds-18**: WHEN a destructive action (delete trip/item/photo, remove
  member, leave trip) is invoked THE SYSTEM SHALL present a ConfirmDialog and
  execute only on explicit confirm.
- **R-ds-19**: WHEN a Sheet or Modal is open THE SYSTEM SHALL support
  swipe-down dismissal AND an explicit close affordance, move screen-reader
  focus into the sheet on open, and restore it on close.
- **R-ds-20**: WHEN any interactive design-system component is instantiated
  THE SYSTEM SHALL accept and forward a `testID` (required prop on interactive
  components, per the mobile-engineer landmine + navigation spec § testID).
- **R-ds-21**: WHEN haptics fire THE SYSTEM SHALL follow the convention table
  only — never on scroll, never on navigation push/pop, at most one haptic per
  user action.

### Resolved questions (Gate 2)

- **Brand palettes — ALL THREE proposed directions ship as user-selectable
  themes** (Resolved 2026-07-10, Gate 3 — Sean: "I kind of love all these
  palettes"). The theme registry is the product surface, not just a re-skin
  seam: users pick their palette in settings, and **adding future palettes
  must be a pure-data addition** — one theme object in `packages/tokens`, zero
  component or mapping changes (R-ds-5 already guarantees this; treat any
  palette addition that requires component edits as a design-system bug).
  **Default (first-launch) theme: `goldenHour`** — a one-line registry config,
  flippable anytime.

  Seed values from the approved artifact (full ramps derived + validated by
  the R-ds-8 contrast-matrix test at build):

  | Theme                  | Primary ramp (100/300/500/700/900)      | Accent (100/500/700)    | Light bg/ink      | Dark bg/card/ink            | Dark primary/accent |
  | ---------------------- | --------------------------------------- | ----------------------- | ----------------- | --------------------------- | ------------------- |
  | `goldenHour` (default) | #FBE3DD #F3A795 #D64933 #A83322 #6E2113 | #FDEED3 #E8A33D #9C6716 | #FBF6F0 / #2A211C | #201915 / #2B221D / #F4EBE3 | #E96A50 / #EFB35B   |
  | `deepWaters`           | #D9ECEC #7CC2BF #0E6E6B #0A4F4D #063230 | #FDE8D4 #EE8B3A #A85A14 | #F4F7F7 / #16262A | #0E1618 / #162226 / #E9F1F1 | #2FA8A0 / #F2A45E   |
  | `midnightExpress`      | #DEE3F2 #93A3CE #2B3A67 #1F2B4E #131B33 | #F3E7CD #C9994B #8A6524 | #F7F4EC / #1F2437 | #131729 / #1C2138 / #EDEEF5 | #5D74B8 / #D4A95C   |

- **Accent theme count** — v1 ships **3 palettes** (`goldenHour` default +
  `deepWaters` + `midnightExpress`), all user-selectable. (Resolved
  2026-07-10, Gate 3 — supersedes the "default + 2 alternates" framing.)
- **Theme scope** — the accent theme is a **user-level preference**;
  `trips.theme` colors small trip-scoped accents only (card/header tint) and
  never re-skins the app in v1 (R-ds-22). (Resolved 2026-07-09, Gate 2)
- **Typography** — **system fonts v1** (SF Pro on iOS / Roboto on Android):
  zero bundle cost, fastest ship; a custom font pair is a later theme
  upgrade through the existing `TypeStyle.fontFamily` seam.
  (Resolved 2026-07-09, Gate 2)
- **Haptics toggle** — no in-app toggle v1; the OS-level system-haptics
  setting is the only control. (Resolved 2026-07-09, Gate 2)

---

## 2. Design

### 2.1 Package layout & ownership

_(Synced 2026-07-17, post-T-4.1 — layout below is the shipped reality.)_

```
packages/tokens                @gogo/tokens — ROOT entry: pure data + pure
│                              functions, zero runtime deps, no React (the
│                              React runtime lives under ./react only)
├── src/ramps.ts               fixed status ramps (success/warning/danger/info)
│                              — shared by every palette
├── src/scales.ts              space, radius, type, elevation (per scheme),
│                              motion, touch, hapticEvents
├── src/themes/<palette>.ts    one pure-data PaletteDef per palette
│                              (goldenHour.ts, deepWaters.ts, midnightExpress.ts)
├── src/themes.ts              palette registry: themes, ThemeName,
│                              THEME_NAMES, DEFAULT_THEME
├── src/build.ts               buildTheme(scheme, palette) → Theme ·
│                              getTheme (memoized) · isThemeName
├── src/types.ts               all exported TypeScript types
├── src/react/                 @gogo/tokens/react — theme runtime; react is an
│   │                          OPTIONAL peerDependency of this subpath only
│   ├── context.ts             ThemeProvider · useTheme · STORAGE_KEYS; platform
│   │                          seams INJECTED (DI): ThemeStorage (MMKV satisfies
│   │                          it structurally) · SystemAppearanceSource (RN
│   │                          Appearance adapts onto it)
│   └── createStyles.ts        style factory + WeakMap<Theme, styles> cache
├── src/*.test.ts              colocated tests (incl. src/react/*.test.ts):
│                              contrast matrix (R-ds-8), pure-data/shape
│                              invariants, provider behavior, cache stability
└── scripts/derive-ramps.mjs   authoring-time ramp derivation + AA adjustment
                               report (not shipped; see § 2.2)

apps/mobile/src/theme          THIN ADAPTERS ONLY — wire MMKV → ThemeStorage,
│                              RN Appearance → SystemAppearanceSource, mount
│                              ThemeProvider
└── haptics.ts                 DS-6: maps the hapticEvents data table onto
                               expo-haptics
```

Rationale: the `@gogo/tokens` root stays importable by anything
(server-rendered emails, a future web app, tests) because it is pure data +
pure functions. The React runtime binding ships INSIDE the package under
`./react` — react is an optional peer of that subpath only, and every
platform-bound piece is injected, never imported: persistence via
`ThemeStorage` (MMKV's `getString`/`set` satisfy it structurally), OS scheme
via `SystemAppearanceSource` (RN `Appearance` adapts onto it). This achieves
the "React stays out of tokens" goal MORE strongly than an app-side runtime —
the root is test-verified React-free, and the runtime is jsdom-testable and
reusable by a future web target (§ 2.10). The bartling ThemeProvider concept
(runtime-swappable theme source) ports as: CSS `<link>` swap → **context value
swap**; CSS variables → **semantic token object**; `.dark` class →
**`buildTheme('dark', …)` output**.

### 2.2 Color system

Three layers, mirroring bartling's structure (ramps → semantic vars →
component styles), adapted to RN objects:

**Layer 1 — ramps.** 11-step ramps keyed `50…950`. Each palette ships its own
`neutral`, `primary`, and `accent` ramps — all three swap with the palette
(every Gate-3 palette carries a tinted neutral cast, a brand `primary`, and a
secondary `accent`). The four status ramps — `success` (emerald), `warning`
(amber), `danger` (red), `info` (blue) — are fixed and shared across all
palettes. (Synced 2026-07-17, post-T-4.1)

```ts
type RampStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;
type ColorRamp = Record<RampStep, string>; // hex
```

Derived stops: seeds from the Gate-3 table (§ 1) are exact; in-between stops
are OKLCH-interpolated, and any derived value participating in a contrast
pairing was minimally adjusted to WCAG AA — **seeds never move**. Reproduce
recipe, interpolation params, and the full adjustment report:
`packages/tokens/scripts/derive-ramps.mjs` (authoring tool; excluded from the
published package). Notable derived-stop adjustments (2026-07-17 AA fixes):
dark `text.accent` lands at `#EE8E6B` (goldenHour) / `#4AAFA9` (deepWaters) /
`#929FCF` (midnightExpress) so it clears 4.5:1 over both the `primary` and
`accent` `subtleBg` composites.

**Layer 2 — semantic tokens.** Components consume ONLY these. Each palette
ships fully **materialized** light + dark semantic sets, authored from the
seed table + AA fix-loop — not mapped from ramp stops at runtime. The
ramp-step notes below are **authoring guidance** for future palettes; the
R-ds-8 contrast matrix is the validator. Shipped interface (Synced
2026-07-17, post-T-4.1):

```ts
/** Solid-fill token group (buttons, pills). `onSolid` is validated ≥ 4.5:1
 *  against `solid` AND `solidPressed` by the R-ds-8 contrast matrix. */
interface SolidGroup {
  solid: string;
  solidPressed: string;
  subtleBg: string; // tinted container — opaque hex in light, 8-digit translucent in dark
  subtleBorder: string;
  onSolid: string;
}

interface SemanticColors {
  bg: {
    screen: string; // authoring guide: ~neutral-50 light / ~neutral-950 dark
    surface: string; // cards/sheets — white light / ~neutral-900 dark
    surfaceRaised: string; // elevated sheets/dialogs
    inset: string; // inputs, wells
    scrim: string; // modal backdrop — 8-digit hex with alpha
  };
  text: {
    primary: string;
    secondary: string;
    muted: string; // must pass 4.5:1 on every bg surface (matrix-validated)
    inverse: string; // ink for opposite-scheme chips/toasts
    onPrimary: string; // = primary.onSolid
    onAccent: string; // = accent.onSolid
    accent: string; // links / active tint — primary-hued, AA-adjusted
  };
  // border.strong + border.focus ≥ 3:1 vs surfaces (WCAG 1.4.11 non-text)
  border: { subtle: string; default: string; strong: string; focus: string };
  primary: SolidGroup; // brand CTA group
  accent: SolidGroup; // secondary-highlight group
  status: Record<
    "success" | "warning" | "danger" | "info",
    { fg: string; bg: string; border: string }
  >;
  interactive: {
    pressedOverlay: string; // 8-digit hex overlay for pressed feedback
    disabledBg: string; // disabled fills/inks exempt from AA (WCAG 1.4.3 exception)
    disabledText: string;
  };
}
```

**Layer 3 — palettes** (the re-skinnable part; Synced 2026-07-17,
post-T-4.1):

```ts
interface PaletteDef {
  name: string; // stable registry key, camelCase: 'goldenHour', 'deepWaters'
  label: string; // display name for the settings picker
  ramps: { neutral: ColorRamp; primary: ColorRamp; accent: ColorRamp };
  semantics: { light: SemanticColors; dark: SemanticColors };
}
```

Semantic sets are fully materialized per palette at authoring time — there is
NO override escape hatch (overrides are dead weight once semantics are
materialized). `buildTheme(scheme, palette)` composes the palette's ramps +
the chosen scheme's semantics + shared scales into a frozen `Theme`. Adding a
palette = one pure-data file in `src/themes/` + one registry line (R-ds-5);
the R-ds-8 contrast matrix validates it at build, and the derivation recipe
(`scripts/derive-ramps.mjs`, Layer 1 above) makes the authoring step
followable. Gradients (bartling used them heavily) are **out** for v1 —
minimalistic means flat surfaces; revisit only with a design pass.

### 2.3 Typography

Role-based scale; components never set raw font sizes.

```ts
type TypeRole =
  | "display"
  | "title"
  | "heading"
  | "subheading"
  | "body"
  | "bodyStrong"
  | "caption"
  | "label"
  | "mono";

interface TypeStyle {
  fontFamily?: string; // omitted ⇒ platform default (system fonts v1, Gate 2)
  fontSize: number; // pt
  lineHeight: number; // pt
  fontWeight: "400" | "500" | "600" | "700" | "800";
  letterSpacing?: number;
  maxFontSizeMultiplier: number; // R-ds-10 cap
}
```

| Role       | Size/Line | Weight | Max× | Use                                           |
| ---------- | --------- | ------ | ---- | --------------------------------------------- |
| display    | 32/38     | 800    | 1.4  | trip name hero, today greeting                |
| title      | 24/30     | 700    | 1.5  | screen titles (PageHeader large)              |
| heading    | 18/24     | 600    | 1.6  | section headers, card titles                  |
| subheading | 15/20     | 600    | 1.8  | list item titles, day headers                 |
| body       | 15/22     | 400    | 2.0  | default copy                                  |
| bodyStrong | 15/22     | 600    | 2.0  | emphasis, amounts                             |
| caption    | 13/18     | 400    | 2.0  | metadata, timestamps, travel times            |
| label      | 11/14     | 600    | 1.6  | badges, tab labels (uppercase, +0.4 tracking) |
| mono       | 13/18     | 500    | 2.0  | confirmation codes, amounts alignment         |

A `Text` primitive (`<AppText role="body" color="secondary">`) carries these;
it is the foundation the § 2.9 components build on. Font family: the shipped
scale omits `fontFamily` entirely — system fonts v1, i.e. SF Pro (iOS) /
Roboto (Android) via the platform default; a custom pair is a later, additive
upgrade through this same optional seam. (Resolved 2026-07-09, Gate 2; synced
2026-07-17, post-T-4.1)

### 2.4 Spacing, radius, touch

- **Spacing** — 4-pt grid, numeric keys (key × 4 = pt):
  `space: Record<0|1|2|3|4|5|6|8|10|12, number>` → 0, 4, 8, 12, 16, 20, 24,
  32, 40, 48. Screen gutter convention: `space[4]` (16). Card padding:
  `space[4]`; compact lists `space[3]`.
- **Radius** — `{ none: 0, sm: 6, md: 10, lg: 14, xl: 20, full: 999 }`.
  Cards/inputs `md`, sheets `xl` (top corners), badges/avatars `full`.
- **Touch** — `touchTarget: 44` (pt, R-ds-9); standard `hitSlop` presets
  `{ sm: 8, md: 12 }` for visually-small controls (icon buttons, checkboxes).

### 2.5 Elevation

RN has no box-shadow tokens à la CSS; each level is a ready-to-spread object
carrying both iOS shadow props and Android `elevation`:

```ts
interface ElevationStyle {
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  elevation: number; // Android
}
// levels: 0 none · 1 card · 2 raised card / FAB · 3 sheet · 4 dialog
// per-scheme record — Theme carries the active scheme's set:
//   theme.elevation = elevation[scheme]
elevation: Record<"light" | "dark", Record<0 | 1 | 2 | 3 | 4, ElevationStyle>>;
```

Dark scheme reduces shadow reliance (shadows read poorly on dark) and leans on
`bg.surface` / `bg.surfaceRaised` separation instead — the dark record ships
the same levels at roughly half the shadow opacity. (Synced 2026-07-17,
post-T-4.1)

### 2.6 Motion

```ts
motion: {
  duration: { fast: 120, base: 200, slow: 300, shimmer: 1200 }, // ms
  easing:   { standard, decelerate, accelerate },   // bezier params, lib-agnostic
  spring:   { sheet: { damping: number; stiffness: number } },
}
```

Conventions: pressed feedback `fast`; screen/sheet transitions `base`–`slow`;
skeleton shimmer loops on `duration.shimmer` (1200 ms — a token, not a
literal; synced 2026-07-17, post-T-4.1). Reduce-motion (R-ds-11): shimmer → static
placeholder, entrance slides → opacity fade at `fast`. Animation library
choice (Reanimated expected with Expo) is pinned at the P-3 scaffold, not here
— tokens are plain numbers usable by any driver.

### 2.7 Theme object & runtime contract

```ts
type ColorSchemeName = "light" | "dark";
type AppearancePref = "system" | "light" | "dark";

interface Theme {
  name: string; // `${accent}-${scheme}`
  scheme: ColorSchemeName;
  accent: string; // palette key (a ThemeName)
  color: SemanticColors;
  ramp: {
    neutral: ColorRamp;
    primary: ColorRamp; // (Synced 2026-07-17, post-T-4.1 — per-palette primary ramp)
    accent: ColorRamp;
    success: ColorRamp;
    warning: ColorRamp;
    danger: ColorRamp;
    info: ColorRamp;
  };
  type: Record<TypeRole, TypeStyle>;
  space: Record<SpaceKey, number>;
  radius: Record<RadiusKey, number>;
  elevation: Record<0 | 1 | 2 | 3 | 4, ElevationStyle>; // active scheme's set (§ 2.5)
  motion: Motion;
  touchTarget: number;
  hitSlop: { sm: Insets; md: Insets };
}
```

Runtime entry points, `@gogo/tokens` root (Synced 2026-07-17, post-T-4.1):

- `buildTheme(scheme, palette)` — pure, uncached composition from any
  `PaletteDef` (works for unregistered palettes: tests, previews); returns a
  deep-frozen `Theme`.
- `getTheme(accent: ThemeName, scheme)` — registry lookup memoized per
  `(accent, scheme)`; same inputs return the SAME object, so context
  consumers and the `createStyles` cache can rely on reference equality.
- `isThemeName(value)` — type guard for registry membership; validates
  persisted / wire values before they touch the registry.
- `hapticEvents` — the § 2.8 event → abstract-call table, shipped as pure
  data; DS-6 wraps it onto expo-haptics app-side.

**ThemeProvider** (`@gogo/tokens/react` — apps/mobile mounts it with thin
MMKV/Appearance adapters; synced 2026-07-17, post-T-4.1):

```ts
interface ThemeContextValue {
  theme: Theme;                              // resolved, frozen, referentially stable per (scheme, accent)
  scheme: ColorSchemeName;                   // resolved
  appearancePref: AppearancePref;
  setAppearancePref(p: AppearancePref): void; // persists (R-ds-2)
  accentName: ThemeName;                      // registry-narrowed, not a bare string
  setAccentName(name: string): void;          // persists; unknown names ignored (the
                                              //   registry is the source of truth);
                                              //   user-level preference — trip theme
                                              //   never re-skins the app (R-ds-22)
}
useTheme(): ThemeContextValue
```

- Platform seams are INJECTED, never imported: persistence via a
  `ThemeStorage` prop (MMKV's `getString`/`set` satisfy it structurally), OS
  scheme via a `SystemAppearanceSource` prop (app adapts RN `Appearance` onto
  it). Both props must be referentially stable instances.
- Persistence keys (exported as `STORAGE_KEYS`): `gogo.appearance`,
  `gogo.accentTheme`. Storage reads are synchronous in the first render
  (useState initializers) so R-ds-4 (no flash) holds — requires a synchronous
  adapter like MMKV.
- Subscribes to the injected appearance source for R-ds-3.
- Theme objects come from `getTheme` — memoized per `(scheme, accent)` so
  context consumers can use reference equality.

**createStyles pattern** (R-ds-7; lives in `@gogo/tokens/react` — synced
2026-07-17, post-T-4.1) — the RN port of bartling's component classes:

```ts
// module scope — pure declaration, no theme access yet
const useStyles = createStyles((t: Theme) =>
  StyleSheet.create({
    // app-side factories call RN's StyleSheet.create INSIDE the factory
    container: { flex: 1, backgroundColor: t.color.bg.screen, padding: t.space[4] },
    title: { ...t.type.title, color: t.color.text.primary },
  }),
);

// in component
const s = useStyles(); // internally: useTheme() → WeakMap<Theme, styles> → factory once per theme
```

`createStyles` is generic and RN-free: it caches whatever the factory returns
in a `WeakMap<Theme, styles>` — the factory runs once per theme object, not
per render (and `getTheme`'s memoization makes revisited themes cache hits).
Calling `StyleSheet.create` inside the factory is the app-side convention;
the package itself never imports react-native. Enforcement: an ESLint rule
(`no-restricted-syntax` on color literals + banning bare `StyleSheet.create`
in `apps/mobile/src/(screens|features)`) lands with the scaffold.

### 2.8 Haptics conventions (R-ds-13, R-ds-21)

The event table ships as DATA in `@gogo/tokens`
(`hapticEvents: Record<HapticEvent, HapticCall>` — abstract call names, no
expo import); DS-6's thin `apps/mobile/src/theme/haptics.ts` wrapper maps the
abstract calls onto expo-haptics. Components reference events, never raw
calls. (Synced 2026-07-17, post-T-4.1)

| Event                                                        | Call                                         |
| ------------------------------------------------------------ | -------------------------------------------- |
| `selection` — tab switch, segmented control, picker, toggle  | `selectionAsync()`                           |
| `actionLight` — primary button press (create/save)           | `impactAsync(Light)`                         |
| `dragLift` / `dragDrop` — itinerary reorder                  | `impactAsync(Medium)` / `impactAsync(Light)` |
| `success` — settle recorded, capture confirmed, trip created | `notificationAsync(Success)`                 |
| `warning` — destructive confirm executed                     | `notificationAsync(Warning)`                 |
| `error` — action-triggered failure surfaced                  | `notificationAsync(Error)`                   |

Rules: never on scroll; never on push/pop navigation; max one per user
action; ghost/secondary buttons default to none.

### 2.9 Core component inventory

All components: consume tokens only; interactive ones require `testID`
(R-ds-20) and expose `accessibilityRole`/`Label` (R-ds-12). Shapes are
contracts, not implementations.

**Text (foundation)** — `role?: TypeRole = 'body'`, `color?: keyof
SemanticColors['text'] = 'primary'`, standard RN Text props pass-through.

**Button**

```ts
interface ButtonProps {
  title: string;
  onPress(): void;
  variant?: "primary" | "secondary" | "ghost" | "destructive"; // default 'primary'
  size?: "sm" | "md" | "lg"; // default 'md'; all ≥44pt target
  icon?: IconName;
  iconPosition?: "leading" | "trailing";
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  haptic?: HapticEvent | false; // defaults: primary→actionLight, destructive→warning, else none
  testID: string; // required
  accessibilityLabel?: string; // defaults to title
}
```

Color mapping under the two-group system (DECIDED 2026-07-17 per Sean's
approved artifact mockups; synced post-T-4.1): **primary** = `primary.solid`
fill + `text.onPrimary` label, pressed fill `primary.solidPressed` — the
coral/petrol/indigo CTA in the mockups; **secondary** = primary-outline —
transparent fill, `primary.solid` border, `text.accent` label (the AA-safe
primary-hued ink); **ghost** = transparent + `text.accent`; **destructive** =
`status.danger` pair. Pressed-state feedback via `interactive.pressedOverlay`
(R-ds-13); loading per R-ds-14.

**Card** — `variant?: 'raised' | 'flat' | 'inset'` (elevation 1 / border-only
/ `bg.inset`), `onPress?`, `padded?: boolean = true`, `testID` (required when
pressable). The itinerary item, booking, expense, and trip cards all compose
this.

**Input**

```ts
interface InputProps {
  label: string;
  value: string;
  onChangeText(v: string): void;
  placeholder?: string;
  helper?: string;
  error?: string; // error state → border.focus=danger + helper slot
  leading?: ReactNode;
  trailing?: ReactNode; // icons, clear button, currency prefix
  secureTextEntry?: boolean;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoComplete?: string;
  returnKeyType?: string;
  testID: string;
}
```

Label always visible (no placeholder-as-label). Error text is announced via
`accessibilityLiveRegion`/AT focus.

**Badge** — `label: string`, `tone?: 'neutral' | 'accent' | 'success' |
'warning' | 'danger' | 'info'`, `size?: 'sm' | 'md'`. Tone mapping (DECIDED
2026-07-17, synced post-T-4.1): `accent` tone — including the "Up next" chip
surface — = `accent.subtleBg` fill + `accent.subtleBorder` + `text.accent`
ink (the contrast matrix validates `text.accent` over the `subtleBg`
composites); status tones use their `status.*` fg/bg/border trio.
Non-interactive (no testID requirement). Used for: booking status
idea/planned/booked, parse status, member roles, offline pill, "Up next"
chip.

**EmptyState** — `icon: IconName`, `title: string`, `body?: string`,
`action?: { label: string; onPress(): void; testID: string }`. (R-ds-16.)

**ErrorBanner** — `message: string`, `onRetry?(): void`, `onDismiss?():
void`, `tone?: 'danger' | 'warning' = 'danger'`, `testID: string`. Inline
banner (not toast) pinned to top of the failed surface. (R-ds-17.)

**ConfirmDialog** — `visible: boolean`, `title: string`, `body?: string`,
`confirmLabel: string`, `cancelLabel?: string = 'Cancel'`, `destructive?:
boolean`, `onConfirm(): void`, `onCancel(): void`, `testID: string` (children
derive `{testID}-confirm` / `{testID}-cancel`). Centered dialog, elevation 4,
focus-trapped. (R-ds-18.)

**TabNav** — the custom `tabBar` for the `[tripId]` Tabs navigator (see
navigation spec): items `{ key, label, icon, badge?: number | 'dot' }`,
receives router state/navigation. Active tint `primary.solid` (DECIDED
2026-07-17 — two-group system, per the approved mockups), inactive
`text.muted`, bar `bg.surface` + `border.subtle` top hairline, safe-area
aware, `selection` haptic, per-item testID `tab-bar-{key}`.

**SegmentedControl** (added 2026-07-09, Gate 2 — flagged by the client money
spec §2.1 for its budget · expenses · balances segments)

```ts
interface SegmentedControlProps {
  segments: Array<{ key: string; label: string }>;
  selectedKey: string;
  onChange(key: string): void;
  testID: string; // per-segment children derive `{testID}-{key}`
  //   (nav grammar's `segment` element noun)
}
```

Equal-width segments on a `bg.inset` track; active segment `bg.surface` +
`text.primary` (inactive `text.secondary`), radius `md`, track height ≥ 44 pt
(R-ds-9). Fires the `selection` haptic (§ 2.8 — already conventioned).
Each segment exposes `accessibilityRole` with selected state (R-ds-12).

**PageHeader** — `title: string`, `subtitle?: string`, `large?: boolean`
(title role vs heading), `leading?: 'back' | ReactNode` (back auto-wires
router), `trailing?: Array<{ icon: IconName; label: string; onPress(): void;
testID: string }>` (max 2). Safe-area top handling lives here, not in screens.

**ListItem** — `title: string`, `subtitle?: string`, `leading?: ReactNode`
(icon/avatar/thumbnail slot), `trailing?: ReactNode | 'chevron'`, `onPress?`,
`testID` (required when pressable). Min height 44pt+; rows for members,
settings, docs, packing, capture queue. Swipe actions are a v1 seam
(`trailingSwipeActions?`) — implemented only where a screen spec calls for it.

**Sheet** — `visible: boolean`, `onDismiss(): void`, `title?: string`,
`snapPoints?: Array<'content' | number>`, `children`, `testID: string`.
Bottom sheet with grab handle, `bg.surfaceRaised`, radius `xl` top, scrim,
swipe-down + close button (R-ds-19). Used for place details on map, quick
add, settle handoff. Full-screen modals route through expo-router
(navigation spec § modal conventions), not this component. v1 honors
`snapPoints[0]` only — multi-snap dragging is an additive seam. _(Synced
2026-07-18, post-T-4.3)_

**Skeleton** — `variant: 'text' | 'circle' | 'rect'`, `width? / height? /
lines?`; shimmer honors reduce-motion (R-ds-11). Composable into per-screen
skeleton layouts (R-ds-15).

### 2.10 Out of scope (explicit)

- Map styling / Mapbox theme integration (maps spec owns it; it consumes
  `Theme` for pin/route colors).
- Charts & data-viz (budget graphs get their own pass in the money spec).
- NativeWind or any second styling system (ADR-004 — requires a migration ADR).
- Web/desktop rendering of tokens (package stays compatible; no work now).
- Animation library selection (P-3 scaffold decision; tokens are lib-agnostic).
- Gradients, glow shadows, Ken-Burns-style flourishes from bartling —
  contradicts "minimalistic"; revisit only via a deliberate design pass.
- Icon set choice — pinned at P-3 scaffold via `npm view` (candidates:
  `@expo/vector-icons`, `lucide-react-native`); components reference an
  `IconName` type seam. DECIDED 2026-07-17: Ionicons via `@expo/vector-icons`
  deep import (seam-contained in `Icon.tsx`; swappable). _(Synced 2026-07-18,
  post-T-4.3)_

---

## 3. Tasks

Traceable to requirement IDs; each sized to one agent session. These become
`T-N.M` rows in `docs/QUEUE.md` when the phase is cut.

| ID    | Task                                                                                                                                                                                                                                  | Covers                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| DS-1  | Scaffold `packages/tokens`: ramps, scales (space/radius/type/elevation/motion/touch), types, exports. Zero runtime deps.                                                                                                              | R-ds-5, R-ds-7 (types)       |
| DS-2  | Materialized light/dark semantic sets per palette + palette registry + `buildTheme()`/`getTheme()`; **contrast matrix test** over every declared pair × scheme × accent. _(Synced 2026-07-17, post-T-4.1)_                            | R-ds-5, R-ds-6, R-ds-8       |
| DS-3  | Theme runtime (`@gogo/tokens/react`): ThemeProvider, `useTheme`, injected storage/appearance seams + thin MMKV/`Appearance` adapters in apps/mobile, synchronous boot read, OS appearance listener. _(Synced 2026-07-17, post-T-4.1)_ | R-ds-1..4, R-ds-6            |
| DS-4  | `createStyles` factory with per-Theme cache + ESLint rule banning literal colors/raw StyleSheet in screens.                                                                                                                           | R-ds-7                       |
| DS-5  | `Text` primitive + typography roles + Dynamic Type caps.                                                                                                                                                                              | R-ds-10, R-ds-12             |
| DS-6  | Haptics convention module wrapping expo-haptics.                                                                                                                                                                                      | R-ds-13, R-ds-21             |
| DS-7  | Components batch 1: Button, Card, Badge, ListItem, Skeleton.                                                                                                                                                                          | R-ds-9, R-ds-13..15, R-ds-20 |
| DS-8  | Components batch 2: Input, EmptyState, ErrorBanner.                                                                                                                                                                                   | R-ds-16, R-ds-17, R-ds-20    |
| DS-9  | Components batch 3: ConfirmDialog, Sheet, PageHeader, TabNav, SegmentedControl.                                                                                                                                                       | R-ds-18, R-ds-19, R-ds-20    |
| DS-10 | Dev-only Gallery screen rendering every component × variant × scheme × accent — the visual verification surface (Law #7 evidence) + reduce-motion audit.                                                                              | R-ds-11, all component reqs  |

**Tests required (minimum):**

- [ ] Contrast matrix passes for all scheme × accent combos (DS-2)
- [ ] Appearance pref persists across relaunch; `system` tracks OS change (DS-3)
- [ ] `createStyles` returns referentially stable styles per theme (DS-4)
- [ ] Button loading blocks re-press; disabled blocks press + haptic (DS-7)
- [ ] ConfirmDialog fires onConfirm only on explicit confirm (DS-9)
- [ ] Every interactive component throws type error without `testID` (DS-7..9)
