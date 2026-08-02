/**
 * features/itinerary — the plan-surface building blocks (T-7.4 / IT-1+IT-2).
 * Model + resolution are pure modules; components render them. The screen
 * (`app/[tripId]/itinerary/index.tsx`) is the only composer.
 */
export { DayJumpStrip } from "./DayJumpStrip";
export type { DayJumpStripProps } from "./DayJumpStrip";
export { ItineraryDayList } from "./ItineraryDayList";
export type { ItineraryDayListHandle, ItineraryDayListProps } from "./ItineraryDayList";
export {
  addDays,
  buildDayRows,
  buildDaySet,
  formatDayChip,
  formatDayHeader,
  projectItem,
  statusBadgeTone,
} from "./model";
export type { DayEntry, DayListRow } from "./model";
export { BOOKING_DAY_LOCK_HINT, resolveDrop } from "./reorder";
export type { DropResolution } from "./reorder";
export { readItineraryViewMode, storeItineraryViewMode } from "./view-mode";
export type { ItineraryViewMode } from "./view-mode";
