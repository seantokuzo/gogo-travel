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
  isSearchableDestinationQuery,
  useCreateTrip,
  usePlaceSearch,
  useTripList,
} from "./trips-mutations";
