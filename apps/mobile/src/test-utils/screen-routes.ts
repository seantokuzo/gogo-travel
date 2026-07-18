/**
 * §2.1 route map → §2.7 rule-2 root testIDs. Every screen route in the spec
 * tree, addressed by URL exactly as deep links will address it (R-nav-22:
 * a screen without testIDs can never be E2E covered).
 *
 * Consumed by BOTH halves of the route audit (T-4.4 R1):
 * - navigation-skeleton.test.tsx renders each URL and asserts the root
 *   testID mounts;
 * - route-audit.test.ts fs-walks `src/app/**` and asserts every route file
 *   is addressed by an entry here (additions fail loudly until audited).
 */
export const SCREEN_ROUTES: [url: string, rootTestID: string][] = [
  ["/sign-in", "sign-in-screen"],
  ["/onboarding", "onboarding-screen"],
  ["/new", "trip-new-screen"],
  ["/join/tok-123", "invite-join-screen"],
  ["/profile", "profile-screen"],
  ["/capture", "capture-queue-screen"],
  ["/capture/cap-1", "capture-review-screen"],
  ["/capture/onboarding", "capture-onboarding-screen"],
  ["/trip-1/today", "today-screen"],
  ["/trip-1/itinerary", "itinerary-screen"],
  ["/trip-1/itinerary/item/item-9", "itinerary-item-screen"],
  ["/trip-1/itinerary/item/new", "itinerary-item-new-screen"],
  ["/trip-1/itinerary/booking/bk-3", "booking-detail-screen"],
  ["/trip-1/map", "map-screen"],
  ["/trip-1/map/place/pl-7", "place-detail-screen"],
  ["/trip-1/money", "money-screen"],
  ["/trip-1/money/expense/exp-2", "expense-detail-screen"],
  ["/trip-1/money/expense/new", "expense-new-screen"],
  ["/trip-1/money/settle/mem-4", "settle-screen"],
  ["/trip-1/money/request/req-5", "settle-request-screen"],
  ["/trip-1/more", "more-screen"],
  ["/trip-1/more/photos", "photos-screen"],
  ["/trip-1/more/photos/ph-8", "photo-viewer-screen"],
  ["/trip-1/more/packing", "packing-screen"],
  ["/trip-1/more/documents", "documents-screen"],
  ["/trip-1/more/members", "members-screen"],
  ["/trip-1/more/settings", "trip-settings-screen"],
];
