/**
 * features/map — the map tab's feature layer (T-8.2 / MAP-1 shell).
 *
 * Pure logic modules (jest never renders the native MapView — P-8 prep
 * ruling): day-colors, pin-features, camera, day-filter, cluster-config,
 * map-style. UI: the day-filter strip + attribution sheet. Frozen seams:
 * MapPlaceSheetSlot (T-8.3), MapOfflinePillSlot (T-8.5), pending-focus
 * (T-8.4 senders).
 */
export {
  DAY_COLOR_COUNT,
  dayColorFor,
  dayColorIndex,
  dayIndexFor,
  dayNumberLabel,
} from "./day-colors";
export {
  buildPlaceIndex,
  classifyMapPress,
  itineraryPinFeatures,
  photoPinFeatures,
  savedPinFeatures,
} from "./pin-features";
export type {
  ItineraryPinInput,
  LngLat,
  MapPressFeature,
  MapPressTarget,
  PhotoPinSource,
  PinFamily,
  PinFeature,
  PinFeatureCollection,
  PinFeatureProperties,
  PlaceCoordinate,
  PlaceIndex,
} from "./pin-features";
export {
  boundsFor,
  CAMERA_ANIMATION_MS,
  CAMERA_FIT_PADDING,
  cameraStopFor,
  cameraTargetFor,
  DESTINATION_FALLBACK_ZOOM,
  SINGLE_PIN_ZOOM,
} from "./camera";
export type { CameraBoundsBox, CameraTarget } from "./camera";
export {
  contextPinOpacity,
  dayFilterChips,
  itineraryFeaturesForFilter,
} from "./day-filter";
export type { DayFilterChip, MapDayFilter } from "./day-filter";
export {
  CLUSTER_MAX_ZOOM,
  CLUSTER_RADIUS,
  CLUSTERED_FILTER,
  clusterCircleStyle,
  clusterCountStyle,
  itineraryPinLabelStyle,
  photoPinCircleStyle,
  pinCircleStyle,
  UNCLUSTERED_FILTER,
} from "./cluster-config";
export {
  configureMapboxAccessToken,
  DEFAULT_MAP_STYLE_URLS,
  mapStyleUrlForScheme,
  resetMapboxAccessTokenForTests,
} from "./map-style";
export {
  consumePendingMapFocus,
  setPendingMapFocus,
  usePendingMapFocusStore,
} from "./pending-focus";
export { MapPlaceSheetSlot } from "./MapPlaceSheetSlot";
export type { MapPlaceSheetSlotProps } from "./MapPlaceSheetSlot";
export { MapOfflinePillSlot } from "./MapOfflinePillSlot";
export type { MapOfflinePillSlotProps } from "./MapOfflinePillSlot";
export { MapDayFilterStrip } from "./MapDayFilter";
export type { MapDayFilterStripProps } from "./MapDayFilter";
export { MapAttributionSheet } from "./MapAttributionSheet";
export type { MapAttributionSheetProps } from "./MapAttributionSheet";
