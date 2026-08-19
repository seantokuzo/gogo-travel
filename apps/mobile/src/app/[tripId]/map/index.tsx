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
 * this screen):
 *  (a) `MapPlaceSheetSlot` + the `onPinSelect(placeId)` contract — T-8.3
 *      fills the sheet; selection state lives here and feeds the slot.
 *  (b) `MapOfflinePillSlot` — T-8.5 fills pack status (`map-pill-offline`).
 *  (c) pending-focus store — drained on focus into `onPinSelect`; T-8.4
 *      wires the senders (R-map-24 — imperative cross-tab pushes no-op, so
 *      the param cannot ride a URL push).
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
import { mapColors, mapDayColors } from "@gogo/tokens";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Camera, CircleLayer, MapView, ShapeSource, SymbolLayer } from "@rnmapbox/maps";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentRef, RefObject } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState, ErrorBanner, Icon } from "@/components";
import { useItinerary, useItineraryBookings, useSavedPlaces } from "@/data";
import {
  buildPlaceIndex,
  CAMERA_ANIMATION_MS,
  cameraStopFor,
  cameraTargetFor,
  classifyMapPress,
  CLUSTER_MAX_ZOOM,
  CLUSTER_RADIUS,
  CLUSTERED_FILTER,
  clusterCircleStyle,
  clusterCountStyle,
  configureMapboxAccessToken,
  consumePendingMapFocus,
  contextPinOpacity,
  dayFilterChips,
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
  UNCLUSTERED_FILTER,
  type LngLat,
  type MapDayFilter,
  type MapPressFeature,
} from "@/features/map";
import { useTripContext } from "@/navigation/trip-context";

// Runtime token seam at MODULE SCOPE — before any native MapView exists
// (module doc "TOKENLESS BUILDS"). Graceful no-op on tokenless builds.
configureMapboxAccessToken();

// The itinerary family never dims (R-map-3 dims context families only) —
// its pin style is input-free, so it hoists to a module constant.
const ITINERARY_PIN_STYLE = pinCircleStyle(1);

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
  const { theme, scheme } = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const colors = mapColors(theme);
  const dayColors = mapDayColors(theme);

  const [dayFilter, setDayFilter] = useState<MapDayFilter>("all");
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [attributionVisible, setAttributionVisible] = useState(false);

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
   * FROZEN SEAM (a) contract — pin selection. T-8.3 builds the sheet on
   * `selectedPlaceId`; T-8.4's pending-focus drain (below) and the
   * ShapeSource press handlers both land here.
   */
  const onPinSelect = useCallback((placeId: string) => {
    setSelectedPlaceId(placeId);
  }, []);
  const clearSelection = useCallback(() => {
    setSelectedPlaceId(null);
  }, []);

  // FROZEN SEAM (c): drain the pending-focus store on every tab focus —
  // consumed once + TRIP-SCOPED (a foreign trip's armed focus is discarded,
  // never presented), so a revisit never re-triggers (§2.7). T-8.4 senders.
  useFocusEffect(
    useCallback(() => {
      const placeId = consumePendingMapFocus(trip.id);
      if (placeId !== null) onPinSelect(placeId);
    }, [trip.id, onPinSelect]),
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
      if (target.kind === "pin" && target.placeId !== null) {
        onPinSelect(target.placeId);
      }
      // Photo pins (placeId null): T-8.3 routes them to the photo viewer
      // (R-map-4) — a no-op in the shell, where the family is empty anyway.
    },
    [expandCluster, onPinSelect],
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

      {/* FROZEN SEAM (a) — T-8.3 fills the place sheet (`map-sheet-place`). */}
      <MapPlaceSheetSlot
        tripId={trip.id}
        selectedPlaceId={selectedPlaceId}
        onClose={clearSelection}
      />

      <MapAttributionSheet
        visible={attributionVisible}
        onDismiss={() => setAttributionVisible(false)}
      />
    </View>
  );
}
