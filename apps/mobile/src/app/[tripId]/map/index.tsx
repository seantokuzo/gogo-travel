/**
 * Map tab — the trip map shell (T-8.2 / MAP-1; map spec §2.1/§2.2,
 * R-map-1..3, R-map-6, R-map-7).
 *
 * Composition: full-bleed themed MapView (config-swap style URLs — P-8 prep
 * ruling) · Camera (initial fit ladder §2.1) · three clustered ShapeSource
 * pin families (photo → saved → itinerary, bottom-up per the §2.1 z-order;
 * within a family: cluster bubble + count below the unclustered pins) · top
 * overlay with the day-filter strip (R-map-3) + the offline-pill slot ·
 * attribution ornaments bottom-left + the spine-attribution info sheet
 * (R-map-6) · the place-sheet mount slot.
 *
 * THE THREE FROZEN SEAMS (W2 anchor — fillers change their own files, not
 * this screen; the T-8.7 integration rider is the ONE sanctioned screen
 * edit, closing PR #24's E1–E5 escalations):
 *  (a) `MapPlaceSheetSlot` + the `onPinSelect(placeId)` contract — T-8.3
 *      filled the sheet; selection state lives here and feeds the slot.
 *      T-8.7 lifted the SEARCH selection here too (search-pin taps and
 *      result-list taps land on one state — slot doc) and added the
 *      itinerary-pin item context for the sheet's per-kind
 *      view-in-itinerary (R-map-23).
 *  (b) `MapOfflinePillSlot` — T-8.5 fills pack status (`map-pill-offline`).
 *  (c) pending-focus store — drained on focus into `onPinSelect`; T-8.4
 *      wires the senders (R-map-24 — imperative cross-tab pushes no-op, so
 *      the param cannot ride a URL push). T-8.7 added the R-map-24 camera
 *      half: a focus-originated selection centers the camera once its
 *      coordinate resolves.
 *
 * T-8.7 RIDER WIRING (each item cites its escalation record):
 *  - E1: `map-source-search` non-clustered ShapeSource over the rows the
 *    search list currently shows (reported up through the slot) — temp pins
 *    clear when the search does (R-map-25).
 *  - E2: `<LocationPuck>` gated on `permission === "granted"` + an
 *    AppState-active permission re-sync so a Settings grant/revoke is
 *    observed (PR #24 corr A2).
 *  - E3: the camera-intent drain — the sanctioned consumer of
 *    `consumePendingCameraIntent()` (locate fly-to, R-map-17).
 *  - E4: photo-pin taps cross-tab push the photo viewer (tab jump first —
 *    mobile.md landmine; the route is the T-4.x placeholder until P-12).
 *  - Telemetry: `disableMapboxTelemetry()` at module scope beside the token
 *    hand-off (map-style.ts doc).
 *
 * ALL pin logic is pure and separately tested (jest mocks `@rnmapbox/maps`
 * entirely — P-8 prep ruling): builders, camera math, day filter, cluster
 * config. This file only composes and applies.
 *
 * Data: pins derive from the TQ-cached trip bundle (saved places +
 * itinerary items + bookings) — no map-specific endpoint (§2.1); a warm
 * cache renders offline (R-map-1; the offline acceptance bar is
 * warm-session, P-8 prep ruling). Photo pins: builder fixture-tested,
 * EMPTY-IN-PROD until P-12 (prep ruling).
 *
 * TOKENLESS BUILDS: `configureMapboxAccessToken` no-ops without the
 * env-driven token — blank basemap on sim until phase QA is EXPECTED; every
 * overlay, pin build, and seam still functions (map-style.ts doc).
 * The call sits at MODULE SCOPE (below) — the SDK-documented pattern — so
 * the token lands BEFORE the first native MapView is created: the SDK's
 * global set is async and nothing re-triggers a failed style load, so a
 * post-mount effect races native view creation on the with-token path
 * (R1 review, corr A4).
 */
import type { Place } from "@gogo/shared";
import { mapColors, mapDayColors } from "@gogo/tokens";
import { createStyles, useTheme } from "@gogo/tokens/react";
import {
  Camera,
  CircleLayer,
  LocationPuck,
  MapView,
  ShapeSource,
  SymbolLayer,
} from "@rnmapbox/maps";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentRef, RefObject } from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState, ErrorBanner, Icon } from "@/components";
import { useItinerary, useItineraryBookings, useSavedPlaces } from "@/data";
import {
  buildPlaceIndex,
  CAMERA_ANIMATION_MS,
  cameraStopFor,
  cameraTargetFor,
  classifyMapPress,
  classifySearchPinPress,
  CLUSTER_MAX_ZOOM,
  CLUSTER_RADIUS,
  CLUSTERED_FILTER,
  clusterCircleStyle,
  clusterCountStyle,
  configureMapboxAccessToken,
  consumePendingCameraIntent,
  consumePendingMapFocus,
  contextPinOpacity,
  dayFilterChips,
  disableMapboxTelemetry,
  itineraryFeaturesForFilter,
  itineraryPinFeatures,
  itineraryPinLabelStyle,
  MapAttributionSheet,
  MapDayFilterStrip,
  MapOfflinePillSlot,
  MapPlaceSheetSlot,
  mapStyleUrlForScheme,
  photoPinCircleStyle,
  photoPinFeatures,
  pinCircleStyle,
  savedPinFeatures,
  searchPinFeatures,
  syncLocationPermissionFromSystem,
  UNCLUSTERED_FILTER,
  useMapCameraIntentStore,
  useMapLocationStore,
  type LngLat,
  type MapDayFilter,
  type MapPressFeature,
} from "@/features/map";
import { jumpToTripTab } from "@/navigation/tab-jump";
import { useTripContext } from "@/navigation/trip-context";

// Runtime token seam at MODULE SCOPE — before any native MapView exists
// (module doc "TOKENLESS BUILDS"). Graceful no-op on tokenless builds.
configureMapboxAccessToken();
// Telemetry OFF at the same moment (T-8.7 rider — map-style.ts doc): before
// any native MapView exists, idempotent, graceful when the test mock omits
// the API.
disableMapboxTelemetry();

// The itinerary family never dims (R-map-3 dims context families only) —
// its pin style is input-free, so it hoists to a module constant.
const ITINERARY_PIN_STYLE = pinCircleStyle(1);
// Search temp pins never dim either (transient highlights, not context —
// E1 rider; paint reads `['get', 'color']`, features carry pinSelectedRing).
const SEARCH_PIN_STYLE = pinCircleStyle(1);

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    map: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
    topOverlay: { position: "absolute", top: 0, left: 0, right: 0, gap: t.space[2] },
    pillRow: { alignItems: "center" },
    banner: { paddingHorizontal: t.space[4] },
    emptyOverlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: "center",
      pointerEvents: "none",
    },
    attributionButton: {
      position: "absolute",
      right: t.space[4],
      bottom: t.space[4],
      width: 36,
      height: 36,
      borderRadius: t.radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.bg.surface,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
    },
  }),
);

/**
 * Horizontal clearance so the SDK's attribution (i) sits beside the wordmark
 * instead of on top of it (both are pinned bottom-left, §2.1; exact fit is a
 * phase-QA visual check — ornaments only render with a live style).
 */
const ATTRIBUTION_LOGO_CLEARANCE = 96;

/** The press-event slice the handlers read (structural — see pin-features). */
interface SourcePressEvent {
  features: MapPressFeature[];
  coordinates: { latitude: number; longitude: number };
}

type ShapeSourceRef = RefObject<ShapeSource | null>;

export default function MapScreen() {
  const trip = useTripContext();
  const router = useRouter();
  const navigation = useNavigation();
  const { theme, scheme } = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const colors = mapColors(theme);
  const dayColors = mapDayColors(theme);

  const [dayFilter, setDayFilter] = useState<MapDayFilter>("all");
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  /**
   * The itinerary ITEM a selection came from (itinerary-pin taps only) —
   * the sheet's per-kind "View in itinerary" context (R-map-23, E5). Null
   * for saved-pin taps, search selections, and focus drains.
   */
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  /**
   * Search-selection source, LIFTED from the slot (T-8.7 — slot doc): a
   * search-pin tap on the map and a result-list tap land on the SAME state,
   * and the precedence/lifecycle invariants keep one selection active.
   */
  const [searchPlace, setSearchPlace] = useState<Place | null>(null);
  /** The rows the search list currently shows — the temp-pin feed (E1). */
  const [searchResults, setSearchResults] = useState<readonly Place[]>([]);
  const [attributionVisible, setAttributionVisible] = useState(false);
  const locationPermission = useMapLocationStore((state) => state.permission);

  const savedQuery = useSavedPlaces(trip.id);
  const itineraryQuery = useItinerary(trip.id);
  const bookingsQuery = useItineraryBookings(trip.id);

  const savedPlaces = savedQuery.data?.items;
  const items = itineraryQuery.data?.items;
  const bookings = bookingsQuery.data?.items;

  const placeIndex = useMemo(() => buildPlaceIndex(savedPlaces ?? []), [savedPlaces]);
  const savedPins = useMemo(() => savedPinFeatures(savedPlaces ?? [], colors), [savedPlaces, colors]);
  const itineraryPins = useMemo(
    () =>
      itineraryPinFeatures({
        items: items ?? [],
        bookings: bookings ?? [],
        placeIndex,
        dayColors,
        tripStart: trip.start_date,
      }),
    [items, bookings, placeIndex, dayColors, trip.start_date],
  );
  // EMPTY-IN-PROD until P-12 (prep ruling) — the family ships wired, featureless.
  const photoPins = useMemo(() => photoPinFeatures([], colors), [colors]);
  const visibleItineraryPins = useMemo(
    () => itineraryFeaturesForFilter(itineraryPins, dayFilter),
    [itineraryPins, dayFilter],
  );
  // R-map-25 temp pins (E1): mirrors the search list exactly — empty input
  // (cleared / offline / error / sub-floor) empties the source.
  const searchPins = useMemo(() => searchPinFeatures(searchResults, colors), [searchResults, colors]);

  const chips = useMemo(
    () => dayFilterChips({ start_date: trip.start_date, end_date: trip.end_date }, dayColors),
    [trip.start_date, trip.end_date, dayColors],
  );

  const destination = useMemo(
    () => ({ lat: trip.destination_lat, lng: trip.destination_lng }),
    [trip.destination_lat, trip.destination_lng],
  );

  const allPinCoordinates = useMemo<LngLat[]>(
    () =>
      [...savedPins.features, ...itineraryPins.features, ...photoPins.features].map(
        (feature) => feature.geometry.coordinates,
      ),
    [savedPins, itineraryPins, photoPins],
  );

  // ---------------------------------------------------------------- camera
  const cameraRef = useRef<ComponentRef<typeof Camera>>(null);
  // §2.1 initial ladder resolved synchronously: destination z12 until pins land.
  const initialStop = useMemo(() => cameraStopFor(cameraTargetFor([], destination)), [destination]);

  const settled =
    !savedQuery.isPending && !itineraryQuery.isPending && !bookingsQuery.isPending;
  const fittedRef = useRef(false);
  useEffect(() => {
    // One initial fit when the pin data first settles (§2.1 "fit all visible
    // pins"); later refetches never yank the camera.
    if (!settled || fittedRef.current) return;
    fittedRef.current = true;
    const stop = cameraStopFor(cameraTargetFor(allPinCoordinates, destination));
    if (stop !== undefined) cameraRef.current?.setCamera(stop);
  }, [settled, allPinCoordinates, destination]);

  const handleDayFilterChange = useCallback(
    (filter: MapDayFilter) => {
      setDayFilter(filter);
      // R-map-3: recenter to fit the selected subset ("All" refits every
      // pin — PR interpretation); an empty subset moves nothing.
      const subset =
        filter === "all"
          ? allPinCoordinates
          : itineraryFeaturesForFilter(itineraryPins, filter).features.map(
              (feature) => feature.geometry.coordinates,
            );
      if (subset.length === 0) return;
      const stop = cameraStopFor(cameraTargetFor(subset, destination), { animate: true });
      if (stop !== undefined) cameraRef.current?.setCamera(stop);
    },
    [allPinCoordinates, itineraryPins, destination],
  );

  // ------------------------------------------------------------- selection
  /**
   * R-map-24's camera half (T-8.7): the place a FOCUS DRAIN selected, still
   * owed a camera centering. A ref, not state — it only gates the effect
   * below; any user-originated selection (pin tap, search) disarms it.
   */
  const focusCameraPlaceRef = useRef<string | null>(null);

  /**
   * Seam (a) contract — pin selection. The pending-focus drain (below) and
   * the ShapeSource press handlers both land here. Clears the OTHER
   * selection source (search) — one selection active, slot doc.
   */
  const onPinSelect = useCallback((placeId: string) => {
    focusCameraPlaceRef.current = null;
    setSearchPlace(null);
    setSelectedItemId(null);
    setSelectedPlaceId(placeId);
  }, []);
  const clearSelection = useCallback(() => {
    focusCameraPlaceRef.current = null;
    setSelectedPlaceId(null);
    setSelectedItemId(null);
    setSearchPlace(null);
  }, []);

  /**
   * Search-selection path (E1/R-map-25): result-list taps arrive via the
   * slot's `onSelectSearchPlace`; search-pin taps arrive from the search
   * ShapeSource handler below. Clearing the pin selection first keeps the
   * one-selection invariant (slot precedence: `selectedPlaceId` wins).
   */
  const handleSelectSearchPlace = useCallback((place: Place | null) => {
    focusCameraPlaceRef.current = null;
    setSelectedPlaceId(null);
    setSelectedItemId(null);
    setSearchPlace(place);
  }, []);
  const handleSearchResultsChange = useCallback((places: readonly Place[]) => {
    setSearchResults(places);
  }, []);

  // FROZEN SEAM (c): drain the pending-focus store on every tab focus —
  // consumed once + TRIP-SCOPED (a foreign trip's armed focus is discarded,
  // never presented), so a revisit never re-triggers (§2.7). T-8.4 senders.
  // The camera ref arms AFTER onPinSelect (which disarms it as a
  // user-selection guard) — order matters.
  useFocusEffect(
    useCallback(() => {
      const placeId = consumePendingMapFocus(trip.id);
      if (placeId !== null) {
        onPinSelect(placeId);
        focusCameraPlaceRef.current = placeId;
      }
    }, [trip.id, onPinSelect]),
  );

  // R-map-24 "center the camera on it" (T-8.7): a focus-originated
  // selection centers once its coordinate resolves through the place index
  // (the saved query may still be in flight at drain time — the effect
  // waits for BOTH). Coordinate never resolves (interim pin-coverage gap,
  // QUEUE Blocked row) ⇒ no move — the sheet side degrades the same way.
  useEffect(() => {
    const target = focusCameraPlaceRef.current;
    if (target === null || selectedPlaceId !== target) return;
    const coordinate = placeIndex.get(target);
    if (coordinate === undefined) return;
    focusCameraPlaceRef.current = null;
    const stop = cameraStopFor(cameraTargetFor([[coordinate.lng, coordinate.lat]], destination), {
      animate: true,
    });
    if (stop !== undefined) {
      // Any DELIBERATE camera write satisfies the initial fit (R1 corr B1):
      // the three pin queries have no order guarantee, so a late settle
      // would otherwise stomp this centering with the all-pins envelope
      // while the sheet is open on the focused place. The pre-fit view is
      // covered by the defaultSettings destination stop.
      fittedRef.current = true;
      cameraRef.current?.setCamera(stop);
    }
  }, [selectedPlaceId, placeIndex, destination]);

  // E3 (R-map-17): THE sanctioned camera-intent consumer — the locate flow
  // arms {center, zoom: LOCATE_CAMERA_ZOOM}; this drain applies it.
  // Reactive subscription: consumes on arrival AND drains an intent armed
  // before mount. Consume-once semantics live in the store.
  const pendingCameraIntent = useMapCameraIntentStore((state) => state.pending);
  useEffect(() => {
    if (pendingCameraIntent === null) return;
    const intent = consumePendingCameraIntent();
    if (intent === null) return;
    // R1 corr B1 (same rule as the focus-center effect above): a locate
    // fly-to applied while slow queries are still in flight must not be
    // teleport-yanked by the envelope fit when they settle — a deliberate
    // write satisfies the fit.
    fittedRef.current = true;
    cameraRef.current?.setCamera({
      centerCoordinate: intent.center,
      zoomLevel: intent.zoom,
      animationDuration: CAMERA_ANIMATION_MS,
    });
  }, [pendingCameraIntent]);

  // E2 (PR #24 corr A2): a Settings grant/revoke happens outside the app —
  // re-read the system truth on every background → active transition so the
  // puck gate observes it. The listener itself calls nothing at mount
  // (R-map-16's lazy pin holds: only a real transition triggers the read).
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") void syncLocationPermissionFromSystem();
    });
    return () => subscription.remove();
  }, []);

  /**
   * E4 (R-map-4 photo arm): photo pins route to the photo viewer — a
   * cross-tab PUSH, so tab jump first (mobile.md landmine), then the push
   * in the now-active more stack. The route is the T-4.x placeholder until
   * P-12 fills the screen; the wiring is real either way.
   */
  const openPhotoViewer = useCallback(
    (photoId: string) => {
      if (!jumpToTripTab(navigation, trip.id, "more")) return;
      router.push({
        pathname: "/[tripId]/more/photos/[photoId]",
        params: { tripId: trip.id, photoId },
      });
    },
    [navigation, trip.id, router],
  );

  const savedSourceRef = useRef<ShapeSource>(null);
  const itinerarySourceRef = useRef<ShapeSource>(null);
  const photoSourceRef = useRef<ShapeSource>(null);

  const expandCluster = useCallback(async (ref: ShapeSourceRef, event: SourcePressEvent) => {
    const feature = event.features[0];
    if (feature === undefined) return;
    try {
      // The SDK types the param as GeoJSON.Feature (transitive ambient);
      // press features satisfy it structurally — see MapPressFeature.
      const zoom = await ref.current?.getClusterExpansionZoom(
        feature as Parameters<ShapeSource["getClusterExpansionZoom"]>[0],
      );
      if (zoom === undefined) return;
      cameraRef.current?.setCamera({
        centerCoordinate: [event.coordinates.longitude, event.coordinates.latitude],
        zoomLevel: zoom,
        animationDuration: CAMERA_ANIMATION_MS,
      });
    } catch {
      // Cluster dissolved under the tap (data refresh) — nothing to expand.
    }
  }, []);

  // The ref is handed over at EVENT time, never during render
  // (react-hooks/refs) — each family's handler closes over its own ref.
  const handleSourcePress = useCallback(
    (ref: ShapeSourceRef, event: SourcePressEvent) => {
      const target = classifyMapPress(event);
      if (target.kind === "cluster") {
        // R-map-2: clusters zoom/expand — NEVER a sheet.
        void expandCluster(ref, event);
        return;
      }
      if (target.kind !== "pin") return;
      if (target.family === "photo") {
        // E4 (R-map-4): photo pins open the viewer, never the place sheet.
        if (target.photoId !== null) openPhotoViewer(target.photoId);
        return;
      }
      if (target.placeId !== null) {
        onPinSelect(target.placeId);
        // R-map-23 fidelity (E5): an itinerary pin remembers ITS item so
        // the sheet's "View in itinerary" lands on THAT item, per kind.
        setSelectedItemId(target.family === "itinerary" ? target.itemId : null);
      }
    },
    [expandCluster, onPinSelect, openPhotoViewer],
  );
  const handleSavedSourcePress = useCallback(
    (event: SourcePressEvent) => handleSourcePress(savedSourceRef, event),
    [handleSourcePress],
  );
  const handleItinerarySourcePress = useCallback(
    (event: SourcePressEvent) => handleSourcePress(itinerarySourceRef, event),
    [handleSourcePress],
  );
  const handlePhotoSourcePress = useCallback(
    (event: SourcePressEvent) => handleSourcePress(photoSourceRef, event),
    [handleSourcePress],
  );
  // E1: a search temp-pin tap feeds the SHEET's search-selection path, not
  // the saved-places lookup — the row may not be saved (search-pins doc).
  // Never clustered, so no cluster arm.
  const handleSearchSourcePress = useCallback(
    (event: SourcePressEvent) => {
      const placeId = classifySearchPinPress(event);
      if (placeId === null) return;
      const row = searchResults.find((place) => place.id === placeId);
      if (row === undefined) return;
      handleSelectSearchPlace(row);
    },
    [searchResults, handleSelectSearchPlace],
  );

  // ----------------------------------------------------------------- state
  const failed = savedQuery.isError || itineraryQuery.isError || bookingsQuery.isError;
  const retryFetch = useCallback(() => {
    if (savedQuery.isError) void savedQuery.refetch();
    if (itineraryQuery.isError) void itineraryQuery.refetch();
    if (bookingsQuery.isError) void bookingsQuery.refetch();
  }, [savedQuery, itineraryQuery, bookingsQuery]);

  // §2.1 world arm — structurally dormant while destination coords are
  // schema-guaranteed; kept total so a malformed row degrades, never crashes.
  const showEmpty =
    settled && cameraTargetFor(allPinCoordinates, destination).kind === "world";

  // Layer styles are memoized on their actual inputs (R1 review, perf A6):
  // a fresh object per render re-sends reactStyle across the bridge and
  // Mapbox re-applies paint on every layer per re-render — the exact
  // interaction T-8.3's per-tap re-renders make hot.
  const contextOpacity = contextPinOpacity(dayFilter, colors.dimOpacity);
  const clusterCircle = useMemo(() => clusterCircleStyle(colors), [colors]);
  const clusterCount = useMemo(() => clusterCountStyle(colors), [colors]);
  const photoPinStyle = useMemo(
    () => photoPinCircleStyle(colors, contextOpacity),
    [colors, contextOpacity],
  );
  const contextPinStyle = useMemo(() => pinCircleStyle(contextOpacity), [contextOpacity]);
  const itineraryLabelStyle = useMemo(() => itineraryPinLabelStyle(colors), [colors]);

  return (
    <View style={s.screen} testID="map-screen">
      <MapView
        style={s.map}
        styleURL={mapStyleUrlForScheme(scheme)}
        attributionEnabled
        attributionPosition={{ bottom: theme.space[2], left: ATTRIBUTION_LOGO_CLEARANCE }}
        logoEnabled
        logoPosition={{ bottom: theme.space[2], left: theme.space[4] }}
        compassEnabled
        scaleBarEnabled={false}
        onPress={clearSelection}
        testID="map-view"
      >
        <Camera
          ref={cameraRef}
          {...(initialStop !== undefined ? { defaultSettings: initialStop } : {})}
        />

        {/* §2.1 z-order, bottom-up: photo → saved → itinerary. */}
        <ShapeSource
          id="map-source-photo"
          ref={photoSourceRef}
          shape={photoPins}
          cluster
          clusterRadius={CLUSTER_RADIUS}
          clusterMaxZoomLevel={CLUSTER_MAX_ZOOM}
          onPress={handlePhotoSourcePress}
        >
          <CircleLayer
            id="map-layer-photo-cluster"
            filter={CLUSTERED_FILTER}
            style={clusterCircle}
          />
          <SymbolLayer
            id="map-layer-photo-cluster-count"
            filter={CLUSTERED_FILTER}
            style={clusterCount}
          />
          <CircleLayer
            id="map-layer-photo-pin"
            filter={UNCLUSTERED_FILTER}
            style={photoPinStyle}
          />
        </ShapeSource>

        <ShapeSource
          id="map-source-saved"
          ref={savedSourceRef}
          shape={savedPins}
          cluster
          clusterRadius={CLUSTER_RADIUS}
          clusterMaxZoomLevel={CLUSTER_MAX_ZOOM}
          onPress={handleSavedSourcePress}
        >
          <CircleLayer
            id="map-layer-saved-cluster"
            filter={CLUSTERED_FILTER}
            style={clusterCircle}
          />
          <SymbolLayer
            id="map-layer-saved-cluster-count"
            filter={CLUSTERED_FILTER}
            style={clusterCount}
          />
          <CircleLayer
            id="map-layer-saved-pin"
            filter={UNCLUSTERED_FILTER}
            style={contextPinStyle}
          />
        </ShapeSource>

        <ShapeSource
          id="map-source-itinerary"
          ref={itinerarySourceRef}
          shape={visibleItineraryPins}
          cluster
          clusterRadius={CLUSTER_RADIUS}
          clusterMaxZoomLevel={CLUSTER_MAX_ZOOM}
          onPress={handleItinerarySourcePress}
        >
          <CircleLayer
            id="map-layer-itinerary-cluster"
            filter={CLUSTERED_FILTER}
            style={clusterCircle}
          />
          <SymbolLayer
            id="map-layer-itinerary-cluster-count"
            filter={CLUSTERED_FILTER}
            style={clusterCount}
          />
          <CircleLayer
            id="map-layer-itinerary-pin"
            filter={UNCLUSTERED_FILTER}
            style={ITINERARY_PIN_STYLE}
          />
          <SymbolLayer
            id="map-layer-itinerary-pin-label"
            filter={UNCLUSTERED_FILTER}
            style={itineraryLabelStyle}
          />
        </ShapeSource>

        {/* E1 (R-map-25): search temp pins — rendered LAST so transient
            highlights sit above every family (§2.1 z-order predates the
            search family; topmost is the interpretation). Non-clustered:
            ≤ MAP_SEARCH_PAGE_LIMIT features never need it. */}
        <ShapeSource id="map-source-search" shape={searchPins} onPress={handleSearchSourcePress}>
          <CircleLayer id="map-layer-search-pin" style={SEARCH_PIN_STYLE} />
        </ShapeSource>

        {/* E2 (R-map-15): the puck mounts ONLY under a when-in-use grant —
            the SDK manages its own location stream from there. */}
        {locationPermission === "granted" ? <LocationPuck /> : null}
      </MapView>

      {showEmpty ? (
        <View style={s.emptyOverlay}>
          <EmptyState
            icon="map-outline"
            title="Add places to see them here"
            testID="map-empty-state"
          />
        </View>
      ) : null}

      <View style={[s.topOverlay, { paddingTop: insets.top + theme.space[2] }]} pointerEvents="box-none">
        <MapDayFilterStrip
          chips={chips}
          value={dayFilter}
          onChange={handleDayFilterChange}
          selectedInk={colors.clusterText}
        />
        <View style={s.pillRow} pointerEvents="box-none">
          {/* FROZEN SEAM (b) — T-8.5 fills pack status (`map-pill-offline`). */}
          <MapOfflinePillSlot tripId={trip.id} />
        </View>
        {failed ? (
          <View style={s.banner}>
            <ErrorBanner
              message="Couldn't load map pins."
              onRetry={retryFetch}
              testID="map-error"
            />
          </View>
        ) : null}
      </View>

      <Pressable
        style={s.attributionButton}
        onPress={() => setAttributionVisible(true)}
        testID="map-button-attribution"
        accessibilityRole="button"
        accessibilityLabel="Map data attribution"
      >
        <Icon name="information-circle-outline" size={20} color={theme.color.text.secondary} />
      </Pressable>

      {/* Seam (a) — T-8.3's slot; T-8.7 extended the contract (slot doc):
          search selection lifted here, results reported up for the temp
          pins, itinerary-pin item context for per-kind view-in-itinerary. */}
      <MapPlaceSheetSlot
        tripId={trip.id}
        selectedPlaceId={selectedPlaceId}
        selectedItemId={selectedItemId}
        searchPlace={searchPlace}
        onSelectSearchPlace={handleSelectSearchPlace}
        onSearchResultsChange={handleSearchResultsChange}
        onClose={clearSelection}
      />

      <MapAttributionSheet
        visible={attributionVisible}
        onDismiss={() => setAttributionVisible(false)}
      />
    </View>
  );
}
