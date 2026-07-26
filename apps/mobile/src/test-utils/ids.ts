/**
 * Canonical fixture ids (T-6.6). PURE constants — no imports — so the
 * fs-only route-audit suite can consume SCREEN_ROUTES without dragging the
 * auth/query singletons into a node-side test.
 *
 * Real UUIDs: the `[tripId]` membership guard round-trips ids through the
 * mocked `GET /trips/:tripId`, and the server folds non-UUIDs into 404 — a
 * "trip-1" style id would exercise the no-access path, not the screens.
 */
export const TEST_TRIP_ID = "11111111-1111-4111-8111-111111111111";
export const TRIP_B_ID = "22222222-2222-4222-8222-222222222222";
export const TRIP_C_ID = "33333333-3333-4333-8333-333333333333";

/** Invite tokens the fixture API recognizes (join-screen preview). */
export const TEST_INVITE_TOKEN = "tok-123";
