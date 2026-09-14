/**
 * E2E session door entry route (S-4 T4; .specs/testing/session-door.spec.md
 * §4.5) — `gogo://e2e-session?user_key=...&first_run=...`, the deep-link-only
 * black-box door the Maestro E2E lane uses to get behind sign-in in one
 * `openLink`. Follows the `(auth)/diagnostics.tsx` pattern exactly.
 *
 * RENDER GATE (R-door-7, R-door-16): a build renders the enabled arm only
 * when ALL of (1) the client secret was build-inlined at >=32 chars (G3 —
 * `isDoorSecretConfigured`), (2) the resolved API base's host is
 * loopback/private (`isLocalOrPrivateHost` — the SAME predicate the rest of
 * the client already trusts, `auth/config.ts`), AND (3) the REAL installed
 * bundle id carries the `.e2edoor` suffix (`isDoorBundleId` —
 * review round 1 B1: a bare `expo run:ios` against an already-prebuilt
 * `ios/` dir never re-consults `app.config.ts`, so (1)+(2) alone can pass in
 * a mis-built binary still wearing the shipping `CFBundleIdentifier`). All
 * three checks are synchronous so the correct arm renders on the FIRST
 * frame; failing any renders the INERT marker below, issues NO network
 * request, and never reads a real secret value — a door-free build never had
 * one to read in the first place (Metro folds the unset
 * `process.env.EXPO_PUBLIC_E2E_DOOR_SECRET` member expression to the
 * literal `undefined` at compile time; nothing at runtime can un-fold that).
 *
 * 🔴 THE `flex: 1` ON THE INERT MARKER IS LOAD-BEARING — DO NOT DROP IT
 * (mirrors `(auth)/diagnostics.tsx`, S-4 PR #61, first real device run
 * 2026-09-07). A zero-frame view is excluded from the XCUITest accessibility
 * hierarchy outright, so `assertVisible` can never see it no matter how long
 * it retries.
 *
 * ORDERING (R-door-8), exactly this order: (1) wait for
 * `useSessionStore(s => s.hydrated)` — otherwise boot hydration from a stale
 * Keychain refresh token races the mint and can end up the LAST writer of
 * `accessToken`/`user`; (2) `openSessionDoor` awaits `resetLocalSession()`
 * strictly BEFORE the mint POST — skipping it leaks the previous run's
 * account state into this one, the exact Law-#3 class this repo has fixed
 * five separate times; (3) mint, then apply the response through the real
 * `applySignIn` session-apply path — the door introduces no new client
 * state handling of its own; (4) this route never navigates: `AuthGate`'s
 * `resume` branch (`authed && inAuthGroup`) fires `router.replace` on the
 * next effect cycle once `applySignIn` flips `user`, and takes the app out
 * of `(auth)` by itself.
 *
 * No text, no `user_key` rendered anywhere on screen — nothing identifying
 * in a screenshot artifact (§4.5). The only params ever read are the two
 * typed below; an extraneous `?secret=...` on the link is never looked at
 * (R-door-7: the secret travels only build-inlined, never over the wire).
 *
 * 🔴 ONLY THE LATEST INVOCATION MAY EVER APPLY A SESSION (review round 1
 * A4). If the params change (a second `openLink` with a different
 * `user_key` lands before the first one's mint resolves), the effect's
 * cleanup sets `cancelled = true` for the SUPERSEDED invocation — but a
 * superseded invocation's `openSessionDoor` call keeps running regardless
 * (nothing aborts an in-flight `fetch`), so `cancelled` MUST also guard the
 * `applySignIn` call, not just the final `setState`. Otherwise whichever of
 * the two mints happens to resolve LAST wins the store, regardless of which
 * `openLink` was actually the later (intended) one.
 *
 * 🔴 REVIEW ROUND 2 (A4 residual): `cancelled` also guards the CONTINUATION
 * past `resetLocalSession()` — passed to `openSessionDoor` as
 * `isSuperseded`. A superseded invocation's reset can still be genuinely in
 * flight when a later one wins and fully applies its session; without this,
 * the loser would resume once its reset resolves and fire a pointless mint
 * request. `applySignIn` stays independently guarded too (a run can still
 * lose AFTER this checkpoint, while its own mint is in flight).
 */
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { apiClient, useSessionStore } from "@/auth";
import { hostOf, isLocalOrPrivateHost, resolveApiBaseUrl } from "@/auth/config";
import {
  isDoorBundleId,
  isDoorSecretConfigured,
  openSessionDoor,
  parseFirstRun,
  resolveUserKey,
} from "@/features/dev/e2e-door/door";

// A plain object literal, NOT `StyleSheet.create` (matches `(auth)/diagnostics.tsx`
// — the DS lint rule (R-ds-7) requires `StyleSheet.create` to go through
// `createStyles(theme)`, but this screen renders nothing theme-derived, only
// the load-bearing static `flex: 1`).
const flexStyle = { flex: 1 };

type DoorState = "pending" | "ready" | "error";

export default function E2eSessionRoute() {
  const params = useLocalSearchParams<{ user_key?: string; first_run?: string }>();
  const hydrated = useSessionStore((s) => s.hydrated);
  const [state, setState] = useState<DoorState>("pending");

  const apiBase = resolveApiBaseUrl();
  // Synchronous triple gate (R-door-7, R-door-16) — computed on every render
  // so the correct arm is the FIRST thing that ever paints.
  const doorReady =
    isDoorSecretConfigured() && isLocalOrPrivateHost(hostOf(apiBase)) && isDoorBundleId();
  const userKey = resolveUserKey(params.user_key);
  const firstRun = parseFirstRun(params.first_run);

  useEffect(() => {
    if (!doorReady || !hydrated) return;
    let cancelled = false;
    void (async () => {
      const result = await openSessionDoor(
        { userKey, firstRun },
        {
          api: apiClient,
          apiBase,
          resetLocalSession: () => useSessionStore.getState().resetLocalSession(),
          // Guarded by `cancelled` (review round 1 A4): a superseded
          // invocation (params changed before this one's mint resolved)
          // must never apply its session — only the CURRENT invocation may.
          applySignIn: (response) => {
            if (cancelled) return Promise.resolve();
            return useSessionStore.getState().applySignIn(response);
          },
          // Review round 2 (A4 residual): bail before the mint POST if a
          // later invocation already won while this one's reset was still
          // in flight — same `cancelled` token, checked earlier.
          isSuperseded: () => cancelled,
        },
      );
      if (cancelled) return;
      setState(result.ok ? "ready" : "error");
    })();
    return () => {
      cancelled = true;
    };
  }, [doorReady, hydrated, userKey, firstRun, apiBase]);

  if (!doorReady) {
    return <View style={flexStyle} testID="e2e-session-screen-inert" />;
  }

  return (
    <View style={flexStyle} testID="e2e-session-screen">
      <View style={flexStyle} testID={`e2e-session-${state}`} />
    </View>
  );
}
