/**
 * Pin feature-collection builders (T-8.2 / MAP-1 — map spec §2.1, R-map-1/2).
 *
 * Pure module: trip data → GeoJSON FeatureCollections, one per pin family
 * (saved / itinerary / photo), each rendered by its own clustered
 * `ShapeSource` (§2.1: style-layer rendered so 500-pin trips stay cheap).
 * Jest never renders the native MapView (P-8 prep ruling) — these builders
 * carry the real pin behavior and are tested directly.
 *
 * COORDINATE RESOLUTION: neither itinerary items nor bookings carry lat/lng
 * on the wire — only `place_id`. §2.1 pins "derive from the TQ-cached trip
 * bundle … no map-specific endpoint", so coordinates resolve through a
 * PLACE INDEX built from the cached place rows we hold (today: the
 * saved-places list's embedded `place` rows). An item whose place is not in
 * the index has no renderable coordinate and is omitted — a pin without a
 * position is not a degrade state, it is unrepresentable. The index is an
 * input, so later tasks can widen it (search results, place-detail reads)
 * without touching the builder contract.
 *
 * GeoJSON shapes are typed structurally here (assignable to `ShapeSource`'s
 * `shape` prop): the global `GeoJSON` namespace comes from `@types/geojson`,
 * a transitive dep of `@rnmapbox/maps` that is not part of this app's type
 * program — do not reference it in app code.
 *
 * testID grammar note (§2.7/§2.8): style-layer pins are NOT React views, so
 * `map-pin-*` ids cannot be RN `testID` props. Each feature carries its
 * spec'd id string in `properties.testID` instead — the stable handle unit
 * tests pin and native-side feature queries can match on.
 */
import type { Booking, ItineraryItem, SavedPlaceWithPlace } from "@gogo/shared";
import type { MapColors, MapDayColors } from "@gogo/tokens";

import { dayColorFor, dayIndexFor, dayNumberLabel } from "./day-colors";

// ---------------------------------------------------------------------------
// Structural GeoJSON output types
// ---------------------------------------------------------------------------

/** Mapbox Position order: `[lng, lat]` — the wire order bboxes use too. */
export type LngLat = [number, number];

export type PinFamily = "saved" | "itinerary" | "photo";

export interface PinFeatureProperties {
  family: PinFamily;
  /** §2.8 inventory id (`map-pin-<family>-<entityId>`) — see module doc. */
  testID: string;
  /** Resolvable place for the sheet contract (null for photo pins). */
  placeId: string | null;
  itemId: string | null;
  photoId: string | null;
  /** Wall-day index from trip start (itinerary family only) — may be negative. */
  dayIndex: number | null;
  /** Paint color — data-driven via `['get', 'color']` (cluster-config.ts). */
  color: string;
  /** Day-number glyph (itinerary family only, §2.2). */
  label: string | null;
}

export interface PinFeature {
  type: "Feature";
  /** Stable entity id (§2.8: never a render index). */
  id: string;
  geometry: { type: "Point"; coordinates: LngLat };
  properties: PinFeatureProperties;
}

export interface PinFeatureCollection {
  type: "FeatureCollection";
  features: PinFeature[];
}

const emptyCollection = (): PinFeatureCollection => ({ type: "FeatureCollection", features: [] });

// ---------------------------------------------------------------------------
// Place index
// ---------------------------------------------------------------------------

export interface PlaceCoordinate {
  lat: number;
  lng: number;
}

/** placeId → coordinate, from whatever place rows the cache holds (module doc). */
export type PlaceIndex = ReadonlyMap<string, PlaceCoordinate>;

/** Build the coordinate index from the saved-places list's embedded places. */
export function buildPlaceIndex(savedPlaces: readonly SavedPlaceWithPlace[]): PlaceIndex {
  const index = new Map<string, PlaceCoordinate>();
  for (const saved of savedPlaces) {
    index.set(saved.place.id, { lat: saved.place.lat, lng: saved.place.lng });
  }
  return index;
}

// ---------------------------------------------------------------------------
// Family builders
// ---------------------------------------------------------------------------

/** Saved-place pins — accent fill (§2.2 "saved-but-unscheduled = accent"). */
export function savedPinFeatures(
  savedPlaces: readonly SavedPlaceWithPlace[],
  colors: MapColors,
): PinFeatureCollection {
  return {
    type: "FeatureCollection",
    features: savedPlaces.map((saved) => ({
      type: "Feature",
      id: saved.place.id,
      geometry: { type: "Point", coordinates: [saved.place.lng, saved.place.lat] },
      properties: {
        family: "saved",
        testID: `map-pin-saved-${saved.place.id}`,
        placeId: saved.place.id,
        itemId: null,
        photoId: null,
        dayIndex: null,
        color: colors.pinSaved,
        label: null,
      },
    })),
  };
}

export interface ItineraryPinInput {
  items: readonly ItineraryItem[];
  /** Parent bookings — the place fallback for `booking`-kind items. */
  bookings: readonly Booking[];
  placeIndex: PlaceIndex;
  dayColors: MapDayColors;
  tripStart: string;
}

/**
 * Itinerary pins — day-color coded (R-map-1, §2.2). An item's place is its
 * own `place_id` or, for `booking`-kind items, the parent booking's; items
 * with no resolvable coordinate are omitted (module doc). Multi-day items
 * pin on their `day` (check-in) index.
 */
export function itineraryPinFeatures(input: ItineraryPinInput): PinFeatureCollection {
  const bookingPlaceById = new Map(input.bookings.map((b) => [b.id, b.place_id]));
  const features: PinFeature[] = [];
  for (const item of input.items) {
    const placeId =
      item.place_id ?? (item.booking_id !== null ? (bookingPlaceById.get(item.booking_id) ?? null) : null);
    if (placeId === null) continue;
    const coordinate = input.placeIndex.get(placeId);
    if (coordinate === undefined) continue;
    const dayIndex = dayIndexFor(item.day, input.tripStart);
    features.push({
      type: "Feature",
      id: item.id,
      geometry: { type: "Point", coordinates: [coordinate.lng, coordinate.lat] },
      properties: {
        family: "itinerary",
        testID: `map-pin-itinerary-${item.id}`,
        placeId,
        itemId: item.id,
        photoId: null,
        dayIndex,
        // Euclidean modulo inside dayColorFor — the negative-index ruling.
        color: dayColorFor(input.dayColors, dayIndex),
        label: dayNumberLabel(dayIndex),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Photo-pin source rows. Photo data arrives P-12 — no `@gogo/shared` photo
 * domain exists yet, so this is the builder's INPUT contract (not a wire
 * redefine); P-12 adapts its wire shape to it. Only viewer-visible photos
 * may ever be passed in (R-map-5 — the caller filters via `canViewPhoto`
 * when the photo domain lands).
 */
export interface PhotoPinSource {
  id: string;
  lat: number;
  lng: number;
}

/**
 * Photo pins — neutral ring (§2.2). FIXTURE-TESTED, EMPTY-IN-PROD until
 * P-12 (P-8 prep ruling — the absent-legs-by-design analogue): the screen
 * passes `[]`, so the family's ShapeSource ships wired but featureless.
 */
export function photoPinFeatures(
  photos: readonly PhotoPinSource[],
  colors: MapColors,
): PinFeatureCollection {
  if (photos.length === 0) return emptyCollection();
  return {
    type: "FeatureCollection",
    features: photos.map((photo) => ({
      type: "Feature",
      id: photo.id,
      geometry: { type: "Point", coordinates: [photo.lng, photo.lat] },
      properties: {
        family: "photo",
        testID: `map-pin-photo-${photo.id}`,
        placeId: null,
        itemId: null,
        photoId: photo.id,
        dayIndex: null,
        color: colors.pinPhotoRing,
        label: null,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Press classification (R-map-2: cluster tap expands, NEVER sheets)
// ---------------------------------------------------------------------------

/**
 * The slice of `ShapeSource`'s OnPressEvent features the classifier reads.
 * Structurally a supertype of `GeoJSON.Feature`, so the SDK's press payload
 * assigns without referencing the transitive `@types/geojson` ambient.
 */
export interface MapPressFeature {
  properties?: Record<string, unknown> | null;
}

export type MapPressTarget =
  | { kind: "cluster"; feature: MapPressFeature }
  | { kind: "pin"; family: PinFamily; placeId: string | null; itemId: string | null; photoId: string | null }
  | { kind: "none" };

/**
 * Classify a ShapeSource press. Cluster features are SDK-synthesized and
 * carry `point_count` (and none of our pin properties); everything else is
 * one of our pins, read back from the properties the builders wrote.
 */
export function classifyMapPress(event: { features: MapPressFeature[] }): MapPressTarget {
  const feature = event.features[0];
  if (feature === undefined) return { kind: "none" };
  const props = feature.properties ?? {};
  if (typeof props["point_count"] === "number") return { kind: "cluster", feature };
  const family = props["family"];
  if (family !== "saved" && family !== "itinerary" && family !== "photo") return { kind: "none" };
  const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    kind: "pin",
    family,
    placeId: str(props["placeId"]),
    itemId: str(props["itemId"]),
    photoId: str(props["photoId"]),
  };
}
