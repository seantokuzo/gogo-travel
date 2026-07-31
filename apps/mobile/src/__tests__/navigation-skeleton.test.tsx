/**
 * Navigation skeleton integration suite (T-4.4, NAV-1..7 at skeleton depth;
 * trip URLs guard-aware since T-6.6).
 *
 * Renders the REAL `src/app` route tree through expo-router's testing
 * library (ExpoRoot + the actual layouts, providers, and screens — no route
 * stubs), so these tests break the moment the shipped topology drifts from
 * navigation.spec §2.1.
 *
 * Harness quirks live in src/test-utils/render-app.ts (shared renderApp).
 * Since T-6.6 the `[tripId]` layout runs the membership guard, so every
 * trip-URL render needs the descriptor-routed network mock (mockNavApi) and
 * a UUID trip id the mock recognizes.
 */
import { router } from "expo-router";
import { act, fireEvent, screen, waitFor, within } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_INVITE_TOKEN, TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { SCREEN_ROUTES } from "@/test-utils/screen-routes";
import { makeInvitePreview, mockNavApi } from "@/test-utils/trip-fixtures";

// Tab switches fire the `selection` haptic through the DS TabNav — keep the
// expo-haptics native call out of the loop (convention verified in
// TabNav.test.tsx / haptics.test.ts).
jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

beforeEach(() => {
  // Default universe: the planning fixture trip + a live invite preview —
  // enough for every SCREEN_ROUTES URL to render its real screen.
  mockNavApi({ invitePreviews: { [TEST_INVITE_TOKEN]: makeInvitePreview() } });
});

afterEach(() => {
  jest.restoreAllMocks();
  // Singleton client (real _layout) — drop cached trip state between tests.
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

describe("entry redirect (R-nav-5 default)", () => {
  it("lands on the trip list when no trip is active", async () => {
    await renderApp("/");
    expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
  });
});

describe("trip tab shell (NAV-1: R-nav-10 structure, §2.7 rule-3 tab IDs)", () => {
  it("opens a bare trip URL on the itinerary tab (planning default, R-nav-8) with all five tabs", async () => {
    await renderApp(`/${TEST_TRIP_ID}`);
    expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
    // Initial-tab proof must not ride solely on lazy-mount semantics: under
    // the vendored tabs' `lazy: true` default a never-visited tab renders
    // null, so today's absence pins itinerary as the focused initial tab. If
    // a future config preloads tabs, this fails LOUDLY (instead of the line
    // above passing vacuously) and the assertion strategy gets revisited.
    expect(screen.queryByTestId("today-screen")).toBeNull();
    for (const key of ["today", "itinerary", "map", "money", "more"]) {
      expect(screen.getByTestId(`tab-bar-${key}`)).toBeOnTheScreen();
    }
    // Trip context reaches navigator-instantiated tabs (the layout provides
    // it — §2.1; local params would be empty here).
    const itinerary = screen.getByTestId("itinerary-screen");
    expect(within(itinerary).getByText(`Trip ${TEST_TRIP_ID}`)).toBeOnTheScreen();
  });
});

describe("auth group scaffolds (NAV-2 targets exist unguarded)", () => {
  it("renders sign-in with its provider buttons", async () => {
    await renderApp("/sign-in");
    await screen.findByTestId("sign-in-screen");
    expect(screen.getByTestId("sign-in-button-apple")).toBeOnTheScreen();
    expect(screen.getByTestId("sign-in-button-google")).toBeOnTheScreen();
  });
});

describe("dynamic segments thread their params (deep-link plumbing for NAV-5)", () => {
  it("invite token reaches the join screen — preview shown, token NEVER echoed (bearer credential)", async () => {
    await renderApp(`/join/${TEST_INVITE_TOKEN}`);
    const join = await screen.findByTestId("invite-join-screen");
    // The screen proves param plumbing by fetching the token's preview; the
    // token itself is a bearer credential (security R1) and must never
    // appear on screen — not even truncated, since T-6.6 renders the preview.
    expect(await within(join).findByText("Kyoto")).toBeOnTheScreen();
    expect(within(join).queryByText(new RegExp(TEST_INVITE_TOKEN))).toBeNull();
  });

  it("itinerary item id reaches the detail screen", async () => {
    await renderApp(`/${TEST_TRIP_ID}/itinerary/item/item-9`);
    const detail = await screen.findByTestId("itinerary-item-screen");
    expect(within(detail).getByText("Item item-9")).toBeOnTheScreen();
  });

  it("settle-request id reaches the request screen (R-nav-13 target)", async () => {
    await renderApp(`/${TEST_TRIP_ID}/money/request/req-5`);
    const request = await screen.findByTestId("settle-request-screen");
    expect(within(request).getByText("Request req-5")).toBeOnTheScreen();
  });
});

describe("R-nav-22 rule 2 — every §2.1 route mounts with its <screen>-screen root testID", () => {
  it.each(SCREEN_ROUTES)("%s → %s", async (url, rootTestID) => {
    await renderApp(url);
    expect(await screen.findByTestId(rootTestID)).toBeOnTheScreen();
  });
});

/**
 * ALL interactive flows share this single mount (harness quirk 3) — keep it
 * the LAST test in the file.
 */
describe("interactive walkthrough (single mount — NAV-1 wiring end to end)", () => {
  it("drives header entries, tab switches, stack pushes, and modal routes", async () => {
    const result = await renderApp("/");
    await screen.findByTestId("trip-list-screen");

    // Trip-list header: profile entry (Gate-2 header contract) + back.
    await fireEvent.press(screen.getByTestId("trip-list-button-profile"));
    expect(await screen.findByTestId("profile-screen")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("profile-header-back"));
    await waitFor(() => expect(screen.queryByTestId("profile-screen")).toBeNull());

    // Header capture entry (R-nav-24 trips-level inbox) + back.
    await fireEvent.press(screen.getByTestId("trip-list-button-capture"));
    expect(await screen.findByTestId("capture-queue-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe("/capture");
    await fireEvent.press(screen.getByTestId("capture-queue-header-back"));
    await waitFor(() => expect(screen.queryByTestId("capture-queue-screen")).toBeNull());

    // FAB → create-trip modal route (R-nav-21 form modal; §2.1 create
    // entry since T-6.7) + cancel (clean form → no discard dialog).
    await fireEvent.press(screen.getByTestId("trip-list-fab-create"));
    expect(await screen.findByTestId("trip-new-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe("/new");
    await fireEvent.press(screen.getByTestId("trip-new-button-cancel"));
    await waitFor(() => expect(screen.queryByTestId("trip-new-screen")).toBeNull());

    // Into a trip (same mount — imperative router; testRouter's built-in
    // pathname asserts depend on pre-RNTL-14 `screen` internals and crash):
    // bare trip target → itinerary default (R-nav-8) + trip context.
    // Cast: typed routes only enumerate leaf routes, but bare trip URLs are
    // a real runtime surface (deeplinks) and MUST keep resolving.
    // Awaited async act: RNTL v14's act is async, so a bare `act(() => …)` that
    // schedules an update leaks a floating act — await it (determinism, B-2).
    await act(async () => {
      router.navigate(`/${TEST_TRIP_ID}` as Parameters<typeof router.navigate>[0]);
    });
    const itinerary = await screen.findByTestId("itinerary-screen");
    expect(within(itinerary).getByText(`Trip ${TEST_TRIP_ID}`)).toBeOnTheScreen();

    // Tab switches through the design-system TabNav (§2.7 rule-3 IDs) —
    // trip context reaches navigator-instantiated tabs.
    await fireEvent.press(screen.getByTestId("tab-bar-today"));
    const today = await screen.findByTestId("today-screen");
    expect(within(today).getByText(`Trip ${TEST_TRIP_ID}`)).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("tab-bar-money"));
    await screen.findByTestId("money-screen");
    // Money's segmented control derives its §2.7 `segment` children.
    expect(screen.getByTestId("money-segment-budget")).toBeOnTheScreen();
    expect(screen.getByTestId("money-segment-balances")).toBeOnTheScreen();

    // Per-tab stack push (R-nav-10 structure).
    await fireEvent.press(screen.getByTestId("tab-bar-more"));
    await screen.findByTestId("more-screen");
    await fireEvent.press(screen.getByTestId("more-list-item-photos"));
    expect(await screen.findByTestId("photos-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/more/photos`);

    // R-nav-10 BEHAVIOR: per-tab history survives tab switches. Pathname is
    // the proof — visited screens stay mounted in the tab tree, so testID
    // presence alone can't distinguish "focused" from "kept alive".
    await fireEvent.press(screen.getByTestId("tab-bar-today"));
    await waitFor(() => expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/today`));
    await fireEvent.press(screen.getByTestId("tab-bar-more"));
    await waitFor(() => expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/more/photos`));
    expect(screen.getByTestId("photos-screen")).toBeOnTheScreen();

    // PageHeader back pop (R-nav-10 structure).
    await fireEvent.press(screen.getByTestId("photos-header-back"));
    await waitFor(() => expect(screen.queryByTestId("photos-screen")).toBeNull());
    expect(await screen.findByTestId("more-screen")).toBeOnTheScreen();

    // More-tab capture entry routes to the TRIPS-LEVEL queue (R-nav-24): the
    // pathname carries no trip segment — the queue lives outside trip
    // context. Backing out RETURNS TO THE ENTRY POINT (the trip's More tab):
    // the queue is pushed onto history, it does not reset it. (An earlier
    // comment claimed back lands on the trip list — empirically false; this
    // assertion pins the real behavior.)
    await fireEvent.press(screen.getByTestId("more-list-item-capture"));
    expect(await screen.findByTestId("capture-queue-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe("/capture");
    await fireEvent.press(screen.getByTestId("capture-queue-header-back"));
    await waitFor(() => expect(screen.queryByTestId("capture-queue-screen")).toBeNull());
    await waitFor(() => expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/more`));

    // Itinerary FAB → add-item modal route in the tab-local stack (R-nav-21).
    // (Back landed us on the More tab — switch tabs like a user would.)
    await fireEvent.press(screen.getByTestId("tab-bar-itinerary"));
    await screen.findByTestId("itinerary-screen");
    await fireEvent.press(screen.getByTestId("itinerary-fab-add"));
    expect(await screen.findByTestId("itinerary-item-new-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/itinerary/item/new`);
  });
});
