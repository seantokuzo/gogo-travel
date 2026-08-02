/**
 * @/data — the app's server-state layer (T-5.8). A single shared TanStack
 * Query client (mounted once at the root layout) plus the typed hooks screens
 * consume. Import the concrete `./query-client` (not this barrel) from the
 * session store to keep the cache-clear wiring cycle-free.
 */
export { invalidateTripLists, queryClient, queryKeys, shouldRetry } from "./query-client";
export {
  useMe,
  useUpdateMe,
  usePaymentHandlesUpdate,
  useEntitlements,
  useSessions,
  useRevokeSession,
  useTrips,
  useTrip,
  useInvitePreview,
} from "./hooks";
export {
  useTripMembers,
  useTripInvites,
  useAcceptInvite,
  useUpdateMemberRole,
  useRemoveMember,
  useTransferOwnership,
  useCreateInvite,
  useRevokeInvite,
} from "./members";
export type { InviteRow, MemberMutationOptions, MemberRoleUpdateVars } from "./members";
export {
  isSearchableDestinationQuery,
  useCreateTrip,
  usePlaceSearch,
  useTripList,
} from "./trips-mutations";
export {
  collabInvalidationPlan,
  evictTripSubtree,
  handleCollabEvent,
  useAppForegroundRefetch,
  useScreenFocusRefetch,
} from "./collab";
export type {
  CollabDeps,
  CollabInvalidationPlan,
  CollabResult,
  InvalidationTarget,
} from "./collab";
export {
  buildTripPatch,
  isBaseCurrencyLocked,
  isStaleUpdatedAt,
  useDeleteTrip,
  useUpdateTrip,
} from "./trip-settings";
export type { TripMutationOptions, TripSettingsEdits } from "./trip-settings";
export {
  applyDayOrder,
  byCalendarOrder,
  reconcileDayOrder,
  upsertItineraryItem,
  useCreateItineraryItem,
  useDayOrder,
  useItinerary,
  useItineraryBookings,
  useUpdateItineraryItem,
} from "./itinerary";
export type { DayOrderVars, ItemUpdateVars, ItineraryMutationOptions } from "./itinerary";
export {
  optimisticScheduleItemId,
  useBooking,
  useCancelledBookings,
  useCreateBooking,
  useScheduleBooking,
  useTripBookings,
  useUpdateBooking,
} from "./bookings";
export type {
  BookingMutationOptions,
  BookingUpdateVars,
  ScheduleBookingVars,
} from "./bookings";
