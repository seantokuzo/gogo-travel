---
paths: ["apps/mobile/**"]
---

# apps/mobile — Expo/RN Conventions

- Styling is `StyleSheet.create` + `@gogo/tokens` ONLY. **No NativeWind / `className`** (ADR-004) — two styling sources of truth was a documented sibling-repo mess.
- 🔴 `testID` on every interactive element — E2E matches on them; point flows at the REAL UI.
- 🔴 Never gate screens on state nothing sets (e.g. `activeTripId`) — the setting flow must exist; never paper over with a hardcoded demo ID.
- 🔴 Push needs an EAS `projectId` in app config or `getExpoPushToken()` silently returns `null`.
- 🟡 `crypto.randomUUID()` doesn't exist in RN — use `react-native-get-random-values` + `uuid`, or nanoid w/ polyfill.
- 🟡 Long lists = `FlatList`/`FlashList`, never `ScrollView` + `.map()`.
- 🟡 `expo lint` has no `--max-warnings 0` cap (flag pass-through undocumented); every other package is zero-warning — don't let mobile warnings accumulate.
- Wire types come from `@gogo/shared` — no local redefines. No `any`, no `console.log`.
- Routes live in `src/app/` (expo-router, typed routes on). Server state = TanStack Query; client state = Zustand.
- Deps: ALWAYS `npx expo install <pkg>` (never bare add) and `npx expo-doctor` before relying on a native module.
- TypeScript here is pinned by the Expo template (`~6.0.3`) — independent of the root TS 5.9; don't "align" it.
- 🟡 jest is pinned `~29.7.0` because jest-expo 57 pins the jest-29 family internally (`babel-jest ^29`, `@jest/globals ^29`, …); jest 30 crashes the preset — don't "helpfully" bump (same deal as the TS `~6.0.3` pin). Verify `npm view jest-expo@<ver> dependencies` before ever touching it.
- `app.json` `plugins` entries are added by `expo-doctor`/`expo install --fix` for plugin-bearing deps — tool-driven, not hand-curated; JSON can't carry comments, so the rationale lives here.
- Screens need loading/error states, safe-area + keyboard handling; consider offline for during-trip surfaces.
- Lint = `expo lint` (local flat config, not the root one). Build = `expo export --platform ios`.
