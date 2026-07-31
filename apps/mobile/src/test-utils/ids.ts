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

/** Member user ids beyond TEST_USER (T-6.8 members screens). */
export const MEMBER_B_ID = "44444444-4444-4444-8444-444444444444";
export const MEMBER_C_ID = "55555555-5555-4555-8555-555555555555";

/** Invite row ids (T-6.8 active-invite list). */
export const TEST_INVITE_ID = "66666666-6666-4666-8666-666666666666";
export const INVITE_B_ID = "77777777-7777-4777-8777-777777777777";

/** The id/url the fixture `POST /trips/:tripId/invites` mints. */
export const CREATED_INVITE_ID = "88888888-8888-4888-8888-888888888888";
export const CREATED_INVITE_URL = "https://links.gogo.example/invite/tok-created";
