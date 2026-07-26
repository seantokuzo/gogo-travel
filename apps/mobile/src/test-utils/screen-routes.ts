/**
 * §2.1 route map → §2.7 rule-2 root testIDs. Every screen route in the spec
 * tree, addressed by URL exactly as deep links will address it (R-nav-22:
 * a screen without testIDs can never be E2E covered).
 *
 * Trip URLs use the canonical UUID fixture (T-6.6): the `[tripId]` layout now
 * runs the membership guard, and only ids the mocked `GET /trips/:tripId`
 * recognizes render trip surfaces — a non-UUID id exercises the no-access
 * path instead. The invite URL uses the token the fixture preview mock knows.
 *
 * Consumed by BOTH halves of the route audit (T-4.4 R1):
 * - navigation-skeleton.test.tsx renders each URL and asserts the root
 *   testID mounts;
 * - route-audit.test.ts fs-walks `src/app/**` and asserts every route file
 *   is addressed by an entry here (additions fail loudly until audited).
 */
import { TEST_INVITE_TOKEN, TEST_TRIP_ID } from "./ids";

export const SCREEN_ROUTES: [url: string, rootTestID: string][] = [
  ["/sign-in", "sign-in-screen"],
  ["/onboarding", "onboarding-screen"],
  ["/new", "trip-new-screen"],
  [`/join/${TEST_INVITE_TOKEN}`, "invite-join-screen"],
  ["/profile", "profile-screen"],
  ["/capture", "capture-queue-screen"],
  ["/capture/cap-1", "capture-review-screen"],
  ["/capture/onboarding", "capture-onboarding-screen"],
  [`/${TEST_TRIP_ID}/today`, "today-screen"],
  [`/${TEST_TRIP_ID}/itinerary`, "itinerary-screen"],
  [`/${TEST_TRIP_ID}/itinerary/item/item-9`, "itinerary-item-screen"],
  [`/${TEST_TRIP_ID}/itinerary/item/new`, "itinerary-item-new-screen"],
  [`/${TEST_TRIP_ID}/itinerary/booking/bk-3`, "booking-detail-screen"],
  [`/${TEST_TRIP_ID}/map`, "map-screen"],
  [`/${TEST_TRIP_ID}/map/place/pl-7`, "place-detail-screen"],
  [`/${TEST_TRIP_ID}/money`, "money-screen"],
  [`/${TEST_TRIP_ID}/money/expense/exp-2`, "expense-detail-screen"],
  [`/${TEST_TRIP_ID}/money/expense/new`, "expense-new-screen"],
  [`/${TEST_TRIP_ID}/money/settle/mem-4`, "settle-screen"],
  [`/${TEST_TRIP_ID}/money/request/req-5`, "settle-request-screen"],
  [`/${TEST_TRIP_ID}/more`, "more-screen"],
  [`/${TEST_TRIP_ID}/more/photos`, "photos-screen"],
  [`/${TEST_TRIP_ID}/more/photos/ph-8`, "photo-viewer-screen"],
  [`/${TEST_TRIP_ID}/more/packing`, "packing-screen"],
  [`/${TEST_TRIP_ID}/more/documents`, "documents-screen"],
  [`/${TEST_TRIP_ID}/more/members`, "members-screen"],
  [`/${TEST_TRIP_ID}/more/settings`, "trip-settings-screen"],
];
