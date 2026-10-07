/**
 * Offline pack controller (T-8.5 / MAP-5 — map spec §2.5, R-map-18..21): the
 * ONE module that touches `offlineManager` and `expo-network`. Decisions live
 * in the pure machine (`offline-packs.ts`); this file carries them to the
 * SDK behind a seam jest mocks wholesale (jest.setup.js — the machine's
 * suites never see a native module).
 *
 * TOKENLESS POSTURE (P-8 prep / T-6.4 $0 precedent): real `offlineManager`
 * downloads need the runtime `pk.` token — a phase-QA Sean item. Until then
 * every path here runs against the jest mock or no-ops on device (createPack
 * errors surface as the `failed` state with retry, which is the R-map-21
 * contract anyway). Nothing blocks: pack state never gates map interaction.
 *
 * Exactly-once download semantics (R-map-18 "starts download exactly once"):
 * `startPackDownload`'s guard section is SYNCHRONOUS — in-flight latch and
 * the `downloading` store flip happen with no await between check and set,
 * so two controller instances racing one wifi event (or the controller and
 * a manual retry) can never double-start on one trip.
 *
 * ONE controller per trip scope (Q2-186 ruling): the effect-bearing
 * `useOfflinePackController` is mounted exactly once, by the `[tripId]`
 * layout's `TripShell` (via `<OfflinePackController />`), so activation fires
 * wherever the user is inside the trip. Surfaces (map pill, settings row,
 * management sheet) are READERS — they consume the store through
 * `useOfflinePackState` and never run the activation effects. The latch
 * above stays as the correctness backstop; the single mount is what keeps
 * the network listener / reconcile / orphan-sweep work from multiplying.
 * `liveOfflinePackControllers` is the test-observable that pins it.
 *
 * ToS: `setTileCountLimit` is NEVER called (readiness brief headline 4 —
 * bypassing the ceiling violates the Mapbox ToS). Hygiene (R-map-20 purge +
 * orphan sweep) keeps the device under the 750-region ceiling instead.
 */
import { offlineManager } from "@rnmapbox/maps";
import * as Network from "expo-network";
import type { Paginated, TripListItem, TripStatus } from "@gogo/shared";
import { useTheme } from "@gogo/tokens/react";
import type { InfiniteData } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { create } from "zustand";

import { queryClient, queryKeys } from "@/data/query-client";

import {
  annotatedPackState,
  downloadProgressPercent,
  isDownloadComplete,
  isWifiState,
  OFFLINE_PACK_MAX_ZOOM,
  OFFLINE_PACK_MIN_ZOOM,
  packBoundsFor,
  packNameFor,
  packRegionKeyFor,
  planCeilingPurge,
  shouldAutoDownloadPack,
  tripIdFromPackName,
  usableDestinationCoords,
  type CeilingPurgeCandidate,
  type OfflinePackState,
} from "./offline-packs";
import {
  readPackAnnotation,
  removePackAnnotation,
  writePackAnnotation,
} from "./offline-pack-annotation";
import { mapStyleUrlForScheme } from "./map-style";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface OfflinePackStoreState {
  packs: Record<string, OfflinePackState>;
}

/** Reactive per-trip pack state; actions are module functions (house pattern). */
export const useOfflinePackStore = create<OfflinePackStoreState>(() => ({ packs: {} }));

const NONE: OfflinePackState = { phase: "none" };

/** Imperative read (effects, guards) — store entry or `none`. */
export function offlinePackStateFor(tripId: string): OfflinePackState {
  return useOfflinePackStore.getState().packs[tripId] ?? NONE;
}

function statesEqual(a: OfflinePackState, b: OfflinePackState): boolean {
  if (a.phase !== b.phase) return false;
  switch (a.phase) {
    case "downloading":
      return b.phase === "downloading" && a.progress === b.progress;
    case "ready":
    case "stale":
      return (
        (b.phase === "ready" || b.phase === "stale") &&
        a.sizeBytes === b.sizeBytes &&
        a.completedAt === b.completedAt
      );
    case "failed":
      return b.phase === "failed" && a.message === b.message;
    default:
      return true;
  }
}

/** Equality-guarded set — no store churn (and no act noise) on a no-op. */
function setPackState(tripId: string, state: OfflinePackState): void {
  const current = offlinePackStateFor(tripId);
  if (statesEqual(current, state)) return;
  useOfflinePackStore.setState((prev) => ({ packs: { ...prev.packs, [tripId]: state } }));
}

// ---------------------------------------------------------------------------
// Session latches
// ---------------------------------------------------------------------------

/** Trips with a createPack in flight — the exactly-once latch (module doc). */
const inFlight = new Set<string>();
let orphanSweepDone = false;
/** Mounted `useOfflinePackController` instances per trip — the single-mount pin's observable. */
const liveControllers = new Map<string, number>();

// ---------------------------------------------------------------------------
// Network fan-out (ONE native listener, never removed)
// ---------------------------------------------------------------------------

/** What a waiting controller needs from a network event / state read. */
type NetworkSnapshot = { type?: string; isConnected?: boolean };

/** Controllers currently deferred ("waiting for the next wifi window"). */
const networkWaiters = new Set<(event: NetworkSnapshot) => void>();
let nativeNetworkListening = false;

/**
 * Register a waiter for network-state events and return its withdrawal.
 *
 * WHY one never-removed native subscription (PR #98 round 1, blocking): on
 * iOS, expo-network 57's `NetworkModule.swift` holds ONE `NWPathMonitor`
 * created at module init, `start`ed when the JS listener count goes 0 -> 1
 * (`OnStartObserving`) and `cancel`led when it drops to 0
 * (`OnStopObserving`). A cancelled `NWPathMonitor` never delivers again
 * (review-lane Swift probe: 0 path updates after cancel -> start, 1 for a
 * fresh monitor), so removing the LAST JS listener — which every controller
 * cleanup (trip leave, trip switch, theme flip) used to do — left the NEXT
 * deferred wait on a dead monitor: "defer and retry on the next wifi" silently
 * never retried. `getNetworkStateAsync()` is unaffected (it builds a temporary
 * monitor per call). Android is unaffected. Candidate upstream expo-network
 * bug — NOT patched here.
 *
 * So the native listener is created on first need and left alone for the
 * life of the JS runtime; controllers join/leave THIS set, never the native
 * subscription. (One idle path monitor for the app's lifetime is the cost;
 * it only wakes on real path changes.)
 */
function awaitNetworkEvents(onEvent: (event: NetworkSnapshot) => void): () => void {
  networkWaiters.add(onEvent);
  if (!nativeNetworkListening) {
    nativeNetworkListening = true;
    Network.addNetworkStateListener((event) => {
      // Snapshot: a waiter that finishes (and withdraws) mid-dispatch must not
      // perturb the iteration.
      for (const waiter of [...networkWaiters]) waiter(event);
    });
  }
  return () => {
    networkWaiters.delete(onEvent);
  };
}

/**
 * How many controller instances are mounted for the trip right now. The
 * contract is `1` for any trip with a mounted `[tripId]` shell (`0` outside
 * one); `2` means a surface re-mounted the effect-bearing hook (Q2-186).
 */
export function liveOfflinePackControllers(tripId: string): number {
  return liveControllers.get(tripId) ?? 0;
}

/** Test-only: clear store + latches (mirrors resetMapLocationForTests). */
export function resetOfflinePacksForTests(): void {
  useOfflinePackStore.setState({ packs: {} });
  inFlight.clear();
  orphanSweepDone = false;
  networkWaiters.clear();
  nativeNetworkListening = false;
}

// ---------------------------------------------------------------------------
// Derivation + reconcile
// ---------------------------------------------------------------------------

export interface PackFingerprint {
  styleUrl: string;
  regionKey: string;
}

/**
 * Seed/refresh the store from the MMKV annotation (sync — first frame is
 * right, house no-flash posture). Session states the annotation can't know
 * about (`downloading`, `failed`) are preserved.
 */
export function syncPackStateFromAnnotation(tripId: string, current: PackFingerprint): void {
  const existing = offlinePackStateFor(tripId);
  if (existing.phase === "downloading" || existing.phase === "failed") return;
  setPackState(tripId, annotatedPackState(readPackAnnotation(tripId), current));
}

/**
 * Async truth-check against the SDK (§2.5: the SDK is the source of truth
 * for pack existence): an annotation whose pack vanished is cleared (state
 * falls back to `none`); a `trip-{id}` pack with NO annotation is
 * unaccounted-for on this install and removed (same policy as the orphan
 * sweep). No-drift is a no-op — the equality-guarded store never churns.
 */
export async function reconcilePackState(tripId: string, current: PackFingerprint): Promise<void> {
  if (inFlight.has(tripId)) return;
  try {
    const pack = await offlineManager.getPack(packNameFor(tripId));
    if (inFlight.has(tripId)) return; // download started while we awaited
    const annotation = readPackAnnotation(tripId);
    if (annotation !== undefined && pack === undefined) {
      removePackAnnotation(tripId);
      syncPackStateFromAnnotation(tripId, current);
      return;
    }
    if (annotation === undefined && pack !== undefined) {
      await offlineManager.deletePack(packNameFor(tripId));
      syncPackStateFromAnnotation(tripId, current);
    }
  } catch {
    // Reconcile is hygiene, not a user surface — SDK errors here never
    // disturb the rendered state (R-map-21: pack state never blocks).
  }
}

// ---------------------------------------------------------------------------
// Hygiene (R-map-20)
// ---------------------------------------------------------------------------

/**
 * Effective status of a trip from the query cache (detail row, then either
 * trips list). `undefined` (not cached) trips are NEVER purge candidates —
 * conservative by design: the first-page list cache can't see every trip,
 * and deleting a live pack is worse than briefly exceeding the threshold.
 */
function tripStatusFromCache(tripId: string): TripStatus | undefined {
  const detail = queryClient.getQueryData<{ status: TripStatus }>(queryKeys.trip(tripId));
  if (detail !== undefined) return detail.status;
  const page = queryClient.getQueryData<Paginated<TripListItem>>(queryKeys.trips);
  const fromPage = page?.items.find((trip) => trip.id === tripId);
  if (fromPage !== undefined) return fromPage.status;
  const infinite = queryClient.getQueryData<InfiniteData<Paginated<TripListItem>>>(
    queryKeys.tripsList,
  );
  for (const p of infinite?.pages ?? []) {
    const row = p.items.find((trip) => trip.id === tripId);
    if (row !== undefined) return row.status;
  }
  return undefined;
}

/** The SDK types `OfflinePack.name` as `any` — narrow it once, here. */
function sdkPackName(pack: { name: unknown }): string | null {
  return typeof pack.name === "string" ? pack.name : null;
}

/**
 * R-map-20 ceiling purge, executed before a new download: enumerate regions,
 * delete past-trip packs oldest-first while the count nears the ceiling.
 * The incoming trip's own pack is never a candidate AND never counted —
 * replace deletes it before createPack re-registers the name.
 */
async function purgeForNewDownload(
  tripId: string,
  tripStatusFor: (id: string) => TripStatus | undefined,
): Promise<void> {
  const packs = await offlineManager.getPacks();
  const candidates: CeilingPurgeCandidate[] = [];
  // Replace semantics: the incoming trip's own pack (if present) is deleted
  // before createPack, so a refresh nets ZERO regions — counting it (round 1)
  // purged a past trip's saved map one download earlier than the threshold
  // requires.
  let packCount = packs.length;
  for (const pack of packs) {
    const name = sdkPackName(pack);
    const packTripId = name === null ? null : tripIdFromPackName(name);
    if (name === null || packTripId === null) continue;
    if (packTripId === tripId) {
      packCount -= 1;
      continue;
    }
    candidates.push({
      name,
      tripStatus: tripStatusFor(packTripId),
      completedAt: readPackAnnotation(packTripId)?.completedAt ?? null,
    });
  }
  for (const name of planCeilingPurge(packCount, candidates)) {
    await offlineManager.deletePack(name);
    const purgedTripId = tripIdFromPackName(name);
    if (purgedTripId !== null) {
      removePackAnnotation(purgedTripId);
      setPackState(purgedTripId, NONE);
    }
  }
}

/**
 * §2.5 orphan sweep (once per session): `trip-{id}` packs with no MMKV
 * annotation are unaccounted-for on this install — removed. Trips deleted
 * REMOTELY keep their pack until the local delete/leave hook or this
 * install's annotation loses them; a full local-trip-list reconciliation
 * needs a complete list source the client can't safely assume (the cached
 * first page isn't one) — documented interpretation, PR record.
 */
export async function runOrphanPackSweep(): Promise<void> {
  if (orphanSweepDone) return;
  orphanSweepDone = true;
  try {
    const packs = await offlineManager.getPacks();
    for (const pack of packs) {
      const name = sdkPackName(pack);
      const tripId = name === null ? null : tripIdFromPackName(name);
      if (name === null || tripId === null || inFlight.has(tripId)) continue;
      if (readPackAnnotation(tripId) === undefined) {
        await offlineManager.deletePack(name);
      }
    }
  } catch {
    // Sweep is best-effort hygiene; it re-arms next session.
  }
}

// ---------------------------------------------------------------------------
// Lifecycle actions (download / retry / refresh / delete)
// ---------------------------------------------------------------------------

export interface PackDownloadTarget {
  tripId: string;
  // Unchanged (B-7 part 3 spec 3.3) — deliberately non-null: callers must
  // resolve `isUsableDestination`/`usableDestinationCoords` FIRST and never
  // construct one for a null-coordinate trip.
  destinationLat: number;
  destinationLng: number;
  styleUrl: string;
}

/**
 * Start (or restart) the trip's pack download. Returns whether a download
 * was actually started — `false` means one is already in flight (the
 * exactly-once latch). Retry (R-map-21) and refresh (§2.5 trigger 3,
 * replaces under the same id) are the same operation: any previous pack is
 * deleted first, then `createPack` re-registers `trip-{tripId}`.
 */
export function startPackDownload(
  target: PackDownloadTarget,
  opts?: { tripStatusFor?: (id: string) => TripStatus | undefined },
): boolean {
  const { tripId, styleUrl } = target;
  // SYNC guard section — no await between check and latch (module doc).
  if (inFlight.has(tripId) || offlinePackStateFor(tripId).phase === "downloading") {
    return false;
  }
  inFlight.add(tripId);
  setPackState(tripId, { phase: "downloading", progress: 0 });

  const name = packNameFor(tripId);
  const regionKey = packRegionKeyFor(target.destinationLat, target.destinationLng);
  const tripStatusFor = opts?.tripStatusFor ?? tripStatusFromCache;

  const finishFailed = (message: string): void => {
    if (!inFlight.has(tripId)) return;
    inFlight.delete(tripId);
    offlineManager.unsubscribe(name);
    setPackState(tripId, { phase: "failed", message });
  };

  void (async () => {
    try {
      await purgeForNewDownload(tripId, tripStatusFor);
      // Replace semantics: createPack on an existing name errors, so any
      // previous pack (ready, stale, or half-downloaded) goes first — and its
      // annotation with it (round 1): if createPack then fails, a surviving
      // annotation would seed a lying "ready" for a pack the SDK no longer
      // holds on the next launch AND suppress the R-map-18 re-attempt.
      // Completion rewrites the annotation; failure leaves an honest none.
      await offlineManager.deletePack(name).catch(() => undefined);
      removePackAnnotation(tripId);
      await offlineManager.createPack(
        {
          name,
          styleURL: styleUrl,
          bounds: packBoundsFor(target.destinationLat, target.destinationLng),
          minZoom: OFFLINE_PACK_MIN_ZOOM,
          maxZoom: OFFLINE_PACK_MAX_ZOOM,
          metadata: { tripId },
        },
        (_pack, status) => {
          if (!inFlight.has(tripId)) return; // late event after settle
          if (isDownloadComplete(status)) {
            inFlight.delete(tripId);
            offlineManager.unsubscribe(name);
            const completedAt = new Date().toISOString();
            const sizeBytes = status.completedResourceSize;
            writePackAnnotation({ tripId, styleUrl, regionKey, completedAt, sizeBytes });
            setPackState(tripId, { phase: "ready", sizeBytes, completedAt });
            return;
          }
          setPackState(tripId, {
            phase: "downloading",
            progress: downloadProgressPercent(status),
          });
        },
        (_pack, error) => finishFailed(error.message),
      );
    } catch (error) {
      finishFailed(error instanceof Error ? error.message : "Download failed");
    }
  })();
  return true;
}

/**
 * R-map-20 delete arms: management UI, trip delete/leave hooks, past-trip
 * offer. Removes pack + annotation; state falls to `none`.
 */
export async function deleteTripPack(tripId: string): Promise<void> {
  inFlight.delete(tripId);
  offlineManager.unsubscribe(packNameFor(tripId));
  await offlineManager.deletePack(packNameFor(tripId)).catch(() => undefined);
  removePackAnnotation(tripId);
  setPackState(tripId, NONE);
}

// ---------------------------------------------------------------------------
// Controller (ONE per trip scope) + state reader (every surface)
// ---------------------------------------------------------------------------

/** The trip fields the controller needs (structural — `TripWithRole` fits).
 *  B-7 part 3: nullable — a custom-place destination may carry no
 *  coordinates; `usableDestinationCoords` (offline-packs.ts) already treats
 *  null as unusable, standing the whole machine down (module doc). */
export interface OfflinePackTrip {
  id: string;
  status: TripStatus;
  destination_lat: number | null;
  destination_lng: number | null;
}

/**
 * The inputs both hooks derive from the trip + theme. The region grid THROWS
 * on unusable coords — null (B-7 part 3: a coordinate-less custom
 * destination) or NaN/out-of-range (R-map-1 world fallback) — so the whole
 * machine stands down: no fingerprint, no effects, state pinned to `none`.
 * Routed through the SAME `usableDestinationCoords` narrowing companion
 * `OfflinePackManager.tsx` uses (round-1 architecture fix) — one usability
 * rule, not three hand-rolled copies. Memoized on the primitive lat/lng (not
 * recomputed every render) so the controller effect can depend on `coords`
 * directly and satisfy exhaustive-deps without re-running on every unrelated
 * re-render.
 */
function usePackInputs(trip: OfflinePackTrip) {
  const { scheme } = useTheme();
  const styleUrl = mapStyleUrlForScheme(scheme);
  const { id: tripId, status, destination_lat: lat, destination_lng: lng } = trip;
  const coords = useMemo(() => usableDestinationCoords(lat, lng), [lat, lng]);
  const regionKey = coords !== null ? packRegionKeyFor(coords.lat, coords.lng) : "";
  return { tripId, status, styleUrl, coords, regionKey };
}

/**
 * The R-map-18 activation controller — EFFECTS ONLY, returns nothing. Mount
 * it ONCE per trip scope: the `[tripId]` layout's `TripShell` does, through
 * `<OfflinePackController />` (Q2-186 ruling: the trigger evaluates wherever
 * the user is inside the trip, not only on the map/settings surfaces, so a
 * trip that flips `active` while the user sits on Today downloads NOW, not
 * on the next visit). Surfaces must NOT call this — they read pack state
 * through `useOfflinePackState`; a second instance multiplies the network
 * listener, reconcile and sweep work (downloads stay exactly-once through
 * the `startPackDownload` latch, but the duplicate work is the bug).
 * `liveOfflinePackControllers` pins the count.
 *
 * Wifi gate (R-map-18): on wifi → download now; connected-but-not-wifi or
 * offline → defer ("next wifi + app-active window"): the controller joins the
 * module's network fan-out (`awaitNetworkEvents` — ONE never-removed native
 * listener, see there for the iOS NWPathMonitor reason) AND re-reads
 * `getNetworkStateAsync()` on every AppState -> `active` (a wifi change while
 * backgrounded delivers no event to a suspended JS thread). Unmount withdraws
 * the wait (set membership + AppState subscription) — no leak, and the native
 * listener is untouched. A download already in flight survives the unmount
 * (module-level latch + SDK listener): leaving or switching trips never
 * cancels it.
 *
 * Auto-download reads the phase IMPERATIVELY (not a dep): a manual delete
 * flips state to `none`, and re-running the effect on that change would
 * instantly re-download what the user just deleted.
 */
export function useOfflinePackController(trip: OfflinePackTrip): void {
  const { tripId, status, styleUrl, coords, regionKey } = usePackInputs(trip);

  // Live-instance accounting (the single-mount pin's observable).
  useEffect(() => {
    liveControllers.set(tripId, (liveControllers.get(tripId) ?? 0) + 1);
    return () => {
      const remaining = (liveControllers.get(tripId) ?? 1) - 1;
      if (remaining <= 0) liveControllers.delete(tripId);
      else liveControllers.set(tripId, remaining);
    };
  }, [tripId]);

  useEffect(() => {
    if (coords === null) return;
    const current: PackFingerprint = { styleUrl, regionKey };
    syncPackStateFromAnnotation(tripId, current);
    void runOrphanPackSweep();
    void reconcilePackState(tripId, current);

    if (!shouldAutoDownloadPack({ tripStatus: status, phase: offlinePackStateFor(tripId).phase })) {
      return;
    }
    const target: PackDownloadTarget = {
      tripId,
      destinationLat: coords.lat,
      destinationLng: coords.lng,
      styleUrl,
    };
    let cancelled = false;
    let stopWaiting: (() => void) | undefined;
    const finishWaiting = (): void => {
      stopWaiting?.();
      stopWaiting = undefined;
    };
    // One handler for every network signal while deferred (native event,
    // AppState re-read): wifi -> start (if still armed) and stop waiting.
    const onNetwork = (state: NetworkSnapshot): void => {
      if (cancelled || !isWifiState(state)) return;
      if (
        shouldAutoDownloadPack({ tripStatus: status, phase: offlinePackStateFor(tripId).phase })
      ) {
        startPackDownload(target);
      }
      finishWaiting();
    };
    const deferUntilWifi = (): void => {
      if (stopWaiting !== undefined) return;
      const withdraw = awaitNetworkEvents(onNetwork);
      const appState = AppState.addEventListener("change", (nextState) => {
        if (nextState !== "active") return;
        // A failed re-read leaves the wait in place (the next event/foreground retries).
        void Network.getNetworkStateAsync().then(onNetwork, () => undefined);
      });
      stopWaiting = () => {
        withdraw();
        appState.remove();
      };
    };
    void Network.getNetworkStateAsync().then(
      (state) => {
        if (cancelled) return;
        if (isWifiState(state)) {
          startPackDownload(target);
          return;
        }
        deferUntilWifi();
      },
      () => {
        // The controller now mounts for every trip shell, so a failed read
        // (native module error) must not escape as an unhandled rejection.
        // "Unknown" is treated like offline (R-map-18): defer to the next
        // wifi event rather than guess.
        if (!cancelled) deferUntilWifi();
      },
    );
    return () => {
      cancelled = true;
      finishWaiting();
    };
  }, [tripId, status, styleUrl, regionKey, coords]);
}

/**
 * The mount shape for the controller: a null-rendering component, so the
 * theme subscription inside the hook re-renders THIS leaf, never the shell
 * that hosts it.
 */
export function OfflinePackController({ trip }: { trip: OfflinePackTrip }): null {
  useOfflinePackController(trip);
  return null;
}

/**
 * Read-only pack state for a trip — what the pill, the settings row and the
 * management sheet render. NO effects: it never touches the SDK, the network
 * or the annotation (that is the controller's job, mounted once at the trip
 * root), it only subscribes to the store the controller owns.
 *
 * Re-renders its subscriber on every distinct download percent (unthrottled
 * on Android) — keep it in leaf components (settings.tsx's `OfflineMapRow`).
 * First-frame value before the controller seeds the store: a sync MMKV read
 * (house no-flash posture — the settings row never blinks "Not downloaded").
 */
export function useOfflinePackState(trip: OfflinePackTrip): OfflinePackState {
  const { tripId, styleUrl, coords, regionKey } = usePackInputs(trip);
  const usable = coords !== null;
  const stored = useOfflinePackStore((state) => state.packs[tripId]);
  return useMemo(() => {
    if (!usable) return NONE;
    return stored ?? annotatedPackState(readPackAnnotation(tripId), { styleUrl, regionKey });
  }, [stored, tripId, styleUrl, regionKey, usable]);
}
