/**
 * features/places — the place-detail surface (T-8.4 / MAP-3+MAP-6).
 *
 * A SEPARATE feature dir from `features/map` on purpose: T-8.3 extends the
 * map barrel concurrently in the W3 parallel worktrees; keeping the detail
 * surface here keeps the two file sets disjoint (zero-contention doctrine).
 */
export {
  categoryLabel,
  COARSE_CATEGORY_ICONS,
  linkedItineraryItems,
  placeNavigateUrl,
  visiblePlacePhotos,
} from "./place-links";
export type { PlacePhotoViewer } from "./place-links";
export { freshFieldRows, PlaceFreshBlock } from "./PlaceFreshBlock";
export type { PlaceFreshBlockProps } from "./PlaceFreshBlock";
