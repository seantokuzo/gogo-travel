/**
 * features/map — the map tab's feature layer (T-8.2 / MAP-1 shell; T-8.3
 * MAP-2/MAP-4 interactions).
 *
 * Pure logic modules (jest never renders the native MapView — P-8 prep
 * ruling): day-colors, pin-features, camera, day-filter, cluster-config,
 * map-style, search-geo, search-pins, nav-handoff, distance, location,
 * camera-intent, photo-visibility, place-lookup. UI: the day-filter strip,
 * attribution sheet, place sheet, search overlay, locate button. Seams:
 * MapPlaceSheetSlot (FILLED, T-8.3), MapOfflinePillSlot (T-8.5),
 * pending-focus (T-8.4 senders), camera-intent + search-pins
 * (dormant emitters — integration rider drains/wires them).
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
  disableMapboxTelemetry,
  mapStyleUrlForScheme,
  resetMapboxAccessTokenForTests,
  resetMapboxTelemetryForTests,
} from "./map-style";
export {
  consumePendingMapFocus,
  setPendingMapFocus,
  usePendingMapFocusStore,
} from "./pending-focus";
export { searchGeoBoundFor, bboxParamFor } from "./search-geo";
export type { SearchGeoBound } from "./search-geo";
export {
  isSearchableMapQuery,
  MAP_SEARCH_MIN_CHARS,
  MAP_SEARCH_PAGE_LIMIT,
  useMapPlaceSearch,
} from "./map-search";
export type { MapSearchContext } from "./map-search";
export { classifySearchPinPress, searchPinFeatures } from "./search-pins";
export type {
  SearchPinFeature,
  SearchPinFeatureCollection,
  SearchPinFeatureProperties,
} from "./search-pins";
export { NAV_HANDOFF_BASE, navHandoffUrlFor } from "./nav-handoff";
export { distanceLabelFor, formatDistance, haversineMeters } from "./distance";
export {
  confirmLocateRationale,
  dismissLocateDialog,
  handleLocatePress,
  LOCATE_CAMERA_ZOOM,
  resetMapLocationForTests,
  syncLocationPermissionFromSystem,
  useMapLocationStore,
} from "./location";
export type {
  MapLocationCoordinate,
  MapLocationDialog,
  MapLocationPermission,
} from "./location";
export {
  consumePendingCameraIntent,
  setPendingCameraIntent,
  useMapCameraIntentStore,
} from "./camera-intent";
export type { MapCameraIntent } from "./camera-intent";
export { visiblePhotoPinSources } from "./photo-visibility";
export type { PhotoPinViewer } from "./photo-visibility";
export { savedPlaceRowFor } from "./place-lookup";
export { COARSE_CATEGORY_ICONS, MapPlaceSheet } from "./MapPlaceSheet";
export type { MapPlaceSheetProps } from "./MapPlaceSheet";
export { MapSearch } from "./MapSearch";
export type { MapSearchProps } from "./MapSearch";
export { MapLocateButton } from "./MapLocateButton";
export { MapPlaceSheetSlot } from "./MapPlaceSheetSlot";
export type { MapPlaceSheetSlotProps } from "./MapPlaceSheetSlot";
export { MapOfflinePillSlot } from "./MapOfflinePillSlot";
export type { MapOfflinePillSlotProps } from "./MapOfflinePillSlot";
export { MapDayFilterStrip } from "./MapDayFilter";
export type { MapDayFilterStripProps } from "./MapDayFilter";
export { MapAttributionSheet } from "./MapAttributionSheet";
export type { MapAttributionSheetProps } from "./MapAttributionSheet";
