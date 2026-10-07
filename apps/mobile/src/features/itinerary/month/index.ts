/**
 * features/itinerary/month — the R-itin-35 Month surface (T-7.14).
 *
 * Deliberately NOT re-exported from `features/itinerary/index.ts`: that shared
 * barrel is T-7.16's to extend (it mounts `MonthSurface` and owns the screen).
 * Until then, import from `features/itinerary/month`.
 */
export { MonthSurface } from "./MonthSurface";
export type { MonthSurfaceProps } from "./MonthSurface";
export {
  buildMonthModel,
  cellLabel,
  DEFAULT_WEEK_START,
  landingMonthKey,
  MAX_DOTS,
  stepMonthIndex,
  weekdayHeaders,
} from "./model";
export type {
  BuildMonthModelOptions,
  MonthDayCell,
  MonthGrid,
  MonthModel,
  MonthSpanBar,
  MonthWeek,
  WeekStart,
} from "./model";
