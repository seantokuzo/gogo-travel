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
export { AddOptionList } from "./add-edit/AddOptionList";
export type { AddOptionListProps } from "./add-edit/AddOptionList";
export { AddOptionsSheet } from "./add-edit/AddOptionsSheet";
export type { AddOptionsSheetProps } from "./add-edit/AddOptionsSheet";
export { BookingForm } from "./add-edit/BookingForm";
export type { BookingFormProps } from "./add-edit/BookingForm";
export { ItemForm } from "./add-edit/ItemForm";
export type { ItemFormProps } from "./add-edit/ItemForm";
export { OptionChips } from "./add-edit/OptionChips";
export type { OptionChipsProps } from "./add-edit/OptionChips";
export { PlacePickerField } from "./add-edit/PlacePickerField";
export type { PlacePickerFieldProps } from "./add-edit/PlacePickerField";
export {
  ADD_OPTION_LABELS,
  ADD_OPTION_ORDER,
  addOptionSlug,
  buildDetails,
  CATEGORY_FIELDS,
  centsToMoneyText,
  composeLocalDateTime,
  CREATE_STATUS_OPTIONS,
  deeplinkInputFor,
  emptyFormState,
  parseMoneyToCents,
  primaryStartKey,
  stateFromDetails,
  statusOptionsFor,
} from "./add-edit/form-model";
export type {
  AddOptionId,
  BookingFieldConfig,
  DateTimeValue,
  DetailsFormState,
  FieldValue,
  MoneyParse,
} from "./add-edit/form-model";
export { BOOKING_DAY_LOCK_HINT, resolveDrop } from "./reorder";
export type { DropResolution } from "./reorder";
export { readItineraryViewMode, storeItineraryViewMode } from "./view-mode";
export type { ItineraryViewMode } from "./view-mode";
