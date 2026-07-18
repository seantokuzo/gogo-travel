/**
 * Navigation skeleton integration suite (T-4.4, NAV-1..7 at skeleton depth).
 *
 * Renders the REAL `src/app` route tree through expo-router's testing
 * library (ExpoRoot + the actual layouts, providers, and screens — no route
 * stubs), so these tests break the moment the shipped topology drifts from
 * navigation.spec §2.1.
 *
 * HARNESS QUIRKS (expo-router 57 testing-library × RNTL v14 — all verified
 * empirically in this repo; revisit on upgrades):
 * 1. `renderRouter` treats RNTL's now-async `render` as sync — it returns
 *    the unresolved render promise with the router helpers assigned onto it.
 *    `renderApp` awaits the commit and re-wraps the helpers.
 * 2. `renderRouter` installs jest fake timers and never restores them;
 *    `renderApp` unmounts the previous tree and hands real timers back
 *    before mounting fresh.
 * 3. A test that PRESSES (navigates) leaves scheduled transition work that
 *    wedges any LATER mount in the same file — no afterEach flush variant
 *    fixes it. Therefore every interactive flow lives in the single
 *    walkthrough test at the END of this file (one mount, many presses —
 *    presses within one mount are fine); all other tests are pure-URL
 *    renders, which sequence cleanly.
 */
import { router } from "expo-router";
import {
  act,
  cleanup,
  fireEvent,
  renderRouter,
  screen,
  waitFor,
  within,
} from "expo-router/testing-library";

import { SCREEN_ROUTES } from "@/test-utils/screen-routes";

// Tab switches fire the `selection` haptic through the DS TabNav — keep the
// expo-haptics native call out of the loop (convention verified in
// TabNav.test.tsx / haptics.test.ts).
jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const APP_DIR = "src/app";

async function renderApp(initialUrl: string) {
  // Quirk 2: reset the previous mount + clock before rendering fresh.
  await cleanup();
  jest.useRealTimers();
  const result = renderRouter(APP_DIR, { initialUrl });
  // Quirk 1: await the async commit…
  await result;
  // …and wrap: returning the thenable from this async fn would re-await it,
  // unwrapping to the bare RenderResult and dropping the router helpers.
  return {
    getPathname: () => result.getPathname(),
    getSegments: () => result.getSegments(),
    getRouterState: () => result.getRouterState(),
  };
}

// SCREEN_ROUTES (imported above) lives in src/test-utils/screen-routes.ts so
// route-audit.test.ts can fs-walk src/app/** against the same table.

describe("entry redirect (NAV-1 skeleton of R-nav-5)", () => {
  it("lands on the trip list", async () => {
    await renderApp("/");
    expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
  });
});

describe("trip tab shell (NAV-1: R-nav-10 structure, §2.7 rule-3 tab IDs)", () => {
  it("opens a bare trip URL on the itinerary tab (planning default, R-nav-8 seam) with all five tabs", async () => {
    await renderApp("/trip-1");
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
    expect(within(itinerary).getByText("Trip trip-1")).toBeOnTheScreen();
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
  it("invite token reaches the join screen — echoed TRUNCATED (bearer credential)", async () => {
    await renderApp("/join/tok-1234567890");
    const join = await screen.findByTestId("invite-join-screen");
    // Tokens are bearer credentials (security R1): first 8 chars + ellipsis
    // only, and the full token must never appear on screen.
    expect(within(join).getByText("Invite tok-1234…")).toBeOnTheScreen();
    expect(within(join).queryByText(/tok-1234567890/)).toBeNull();
  });

  it("itinerary item id reaches the detail screen", async () => {
    await renderApp("/trip-1/itinerary/item/item-9");
    const detail = await screen.findByTestId("itinerary-item-screen");
    expect(within(detail).getByText("Item item-9")).toBeOnTheScreen();
  });

  it("settle-request id reaches the request screen (R-nav-13 target)", async () => {
    await renderApp("/trip-1/money/request/req-5");
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
    fireEvent.press(screen.getByTestId("trip-list-button-profile"));
    expect(await screen.findByTestId("profile-screen")).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId("profile-header-back"));
    await waitFor(() => expect(screen.queryByTestId("profile-screen")).toBeNull());

    // Header capture entry (R-nav-24 trips-level inbox) + back.
    fireEvent.press(screen.getByTestId("trip-list-button-capture"));
    expect(await screen.findByTestId("capture-queue-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe("/capture");
    fireEvent.press(screen.getByTestId("capture-queue-header-back"));
    await waitFor(() => expect(screen.queryByTestId("capture-queue-screen")).toBeNull());

    // EmptyState CTA → create-trip modal route (R-nav-21 form modal) + back.
    fireEvent.press(screen.getByTestId("trip-list-button-create"));
    expect(await screen.findByTestId("trip-new-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe("/new");
    fireEvent.press(screen.getByTestId("trip-new-header-back"));
    await waitFor(() => expect(screen.queryByTestId("trip-new-screen")).toBeNull());

    // Into a trip (same mount — imperative router; testRouter's built-in
    // pathname asserts depend on pre-RNTL-14 `screen` internals and crash):
    // bare trip target → itinerary default (R-nav-8 seam) + trip context.
    act(() => router.navigate("/trip-1"));
    const itinerary = await screen.findByTestId("itinerary-screen");
    expect(within(itinerary).getByText("Trip trip-1")).toBeOnTheScreen();

    // Tab switches through the design-system TabNav (§2.7 rule-3 IDs) —
    // trip context reaches navigator-instantiated tabs.
    fireEvent.press(screen.getByTestId("tab-bar-today"));
    const today = await screen.findByTestId("today-screen");
    expect(within(today).getByText("Trip trip-1")).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId("tab-bar-money"));
    await screen.findByTestId("money-screen");
    // Money's segmented control derives its §2.7 `segment` children.
    expect(screen.getByTestId("money-segment-budget")).toBeOnTheScreen();
    expect(screen.getByTestId("money-segment-balances")).toBeOnTheScreen();

    // Per-tab stack push (R-nav-10 structure).
    fireEvent.press(screen.getByTestId("tab-bar-more"));
    await screen.findByTestId("more-screen");
    fireEvent.press(screen.getByTestId("more-list-item-photos"));
    expect(await screen.findByTestId("photos-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe("/trip-1/more/photos");

    // R-nav-10 BEHAVIOR: per-tab history survives tab switches. Pathname is
    // the proof — visited screens stay mounted in the tab tree, so testID
    // presence alone can't distinguish "focused" from "kept alive".
    fireEvent.press(screen.getByTestId("tab-bar-today"));
    await waitFor(() => expect(result.getPathname()).toBe("/trip-1/today"));
    fireEvent.press(screen.getByTestId("tab-bar-more"));
    await waitFor(() => expect(result.getPathname()).toBe("/trip-1/more/photos"));
    expect(screen.getByTestId("photos-screen")).toBeOnTheScreen();

    // PageHeader back pop (R-nav-10 structure).
    fireEvent.press(screen.getByTestId("photos-header-back"));
    await waitFor(() => expect(screen.queryByTestId("photos-screen")).toBeNull());
    expect(await screen.findByTestId("more-screen")).toBeOnTheScreen();

    // More-tab capture entry routes to the TRIPS-LEVEL queue (R-nav-24): the
    // pathname carries no trip segment — the queue lives outside trip
    // context. Backing out RETURNS TO THE ENTRY POINT (the trip's More tab):
    // the queue is pushed onto history, it does not reset it. (An earlier
    // comment claimed back lands on the trip list — empirically false; this
    // assertion pins the real behavior.)
    fireEvent.press(screen.getByTestId("more-list-item-capture"));
    expect(await screen.findByTestId("capture-queue-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe("/capture");
    fireEvent.press(screen.getByTestId("capture-queue-header-back"));
    await waitFor(() => expect(screen.queryByTestId("capture-queue-screen")).toBeNull());
    await waitFor(() => expect(result.getPathname()).toBe("/trip-1/more"));

    // Itinerary FAB → add-item modal route in the tab-local stack (R-nav-21).
    // (Back landed us on the More tab — switch tabs like a user would.)
    fireEvent.press(screen.getByTestId("tab-bar-itinerary"));
    await screen.findByTestId("itinerary-screen");
    fireEvent.press(screen.getByTestId("itinerary-fab-add"));
    expect(await screen.findByTestId("itinerary-item-new-screen")).toBeOnTheScreen();
    expect(result.getPathname()).toBe("/trip-1/itinerary/item/new");
  });
});
