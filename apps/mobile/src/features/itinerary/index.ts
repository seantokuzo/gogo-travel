/**
 * features/itinerary — the plan-surface building blocks (T-7.4 / IT-1+IT-2).
 * Model + resolution are pure modules; components render them. The screen
 * (`app/[tripId]/itinerary/index.tsx`) is the only composer.
 */
export { DayJumpStrip } from "./DayJumpStrip";
export type { DayJumpStripProps } from "./DayJumpStrip";
export { GridSurface } from "./GridSurface";
export type { GridSurfaceProps } from "./GridSurface";
export { ItineraryDayList } from "./ItineraryDayList";
export type { ItineraryDayListHandle, ItineraryDayListProps } from "./ItineraryDayList";
export {
  addDays,
  buildDayRows,
  buildDaySet,
  CATEGORY_ICONS,
  formatDayChip,
  formatDayHeader,
  projectItem,
  statusBadgeTone,
} from "./model";
export type { DayEntry, DayListRow } from "./model";
export { IdeasBucket } from "./ideas/IdeasBucket";
export type { IdeasBucketProps } from "./ideas/IdeasBucket";
export { ScheduleSheet } from "./ideas/ScheduleSheet";
export type { ScheduleSheetProps } from "./ideas/ScheduleSheet";
export {
  buildIdeasGroups,
  buildIdeasRows,
  CATEGORY_GROUP_LABELS,
  formatIdeaPrice,
  unscheduledBookings,
} from "./ideas/ideas-model";
export type { IdeaCard, IdeasGroup, IdeasRow } from "./ideas/ideas-model";
export { pickerDateToTime, TimeField, timeToPickerDate } from "./add-edit/TimeField";
export type { TimeFieldProps } from "./add-edit/TimeField";
export { BOOKING_DAY_LOCK_HINT, resolveDrop } from "./reorder";
export type { DropResolution } from "./reorder";
export { readItineraryViewMode, storeItineraryViewMode } from "./view-mode";
export type { ItineraryViewMode } from "./view-mode";
