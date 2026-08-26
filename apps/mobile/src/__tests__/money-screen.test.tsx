/**
 * Money tab shell + segments (T-9.5 / CMON-1+CMON-4 — R-cmoney-1/2/4/6/29/30).
 * Component-level over the REAL data hooks with the network mocked at the
 * descriptor boundary; fixtures are wire-schema-validated (money-fixtures
 * parses through the shared schemas, so T-9.4 contract drift goes RED here).
 *
 * Pins: three segments defaulting to budget with IN-SESSION memory
 * (R-cmoney-1 — remount retains, reset re-defaults); budget rows off the G1
 * document with integer-threshold progress states and shared-formatter
 * money text (Law #2 — JPY whole units); cap edits → the G2 PUT (category +
 * `total` + null-clear + reject-invalid), gated while in flight (the
 * deferred-promise/resolvers-array/release-in-finally discipline); the AI
 * CTA as a pinned-DISABLED stub (state asserted, not a vacuous disabled
 * press — mobile.md); balances headline/chips/transfer rows with the
 * R-cmoney-6 simplify toggle (off by default, not persisted); row actions →
 * settle route; offline degrade = cached render + banner (R-cmoney-30);
 * §2.8 testID inventory walk (R-cmoney-30).
 */
import { fireEvent, screen, waitFor } from "@testing-library/react-native";

import MoneyScreen from "@/app/[tripId]/money/index";
import { ApiRequestError } from "@/auth";
import { resetMoneySegmentMemory } from "@/features/money";
import { TripProvider } from "@/navigation/trip-context";
import { MEMBER_B_ID, MEMBER_C_ID, TEST_TRIP_ID } from "@/test-utils/ids";
import {
  emptyBudgetsRead,
  makeBalancesRead,
  makeBudgetsRead,
  makeSettledBalancesRead,
  moneyApiOverrides,
  type MoneyApiOptions,
} from "@/test-utils/money-fixtures";
import { lightTheme, makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import { makeMember, makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

import { QueryClient } from "@tanstack/react-query";

import type { TripListItem } from "@gogo/shared";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    back: jest.fn(),
    setParams: jest.fn(),
  }),
  useLocalSearchParams: () => ({}),
}));

/** Roster: the caller (owner) + two members — balances rows reference all three. */
function defaultMembers() {
  return [
    makeMember(),
    makeMember({ user: { id: MEMBER_B_ID, display_name: "Blair" }, role: "editor" }),
    makeMember({ user: { id: MEMBER_C_ID, display_name: "Casey" }, role: "editor" }),
  ];
}

async function renderMoney(opts?: {
  trip?: TripListItem;
  api?: MoneyApiOptions;
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
  queryClient?: QueryClient;
}) {
  seedAuthenticated();
  const trip = opts?.trip ?? makeTrip({ id: TEST_TRIP_ID });
  const request = mockNavApi({
    trips: [trip],
    members: defaultMembers(),
    overrides: { ...moneyApiOverrides(opts?.api), ...opts?.overrides },
  });
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <MoneyScreen />
    </TripProvider>,
    { queryClient: opts?.queryClient ?? makeTestQueryClient() },
  );
  // Absorb the mount queries' notify batches inside act (B-2 posture).
  await settle();
  return { request, trip, view };
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockPush.mockReset();
  // Segment memory is per-SESSION state — leaked choices would silently
  // reroute every later mount (the reset is the cold-launch stand-in).
  resetMoneySegmentMemory();
});

describe("shell + segments (R-cmoney-1)", () => {
  it("renders root, header, and the three derived segment testIDs; budget is the default", async () => {
    await renderMoney();
    expect(screen.getByTestId("money-screen")).toBeTruthy();
    expect(screen.getByTestId("money-header")).toBeTruthy();
    expect(screen.getByTestId("money-segment-budget")).toBeTruthy();
    expect(screen.getByTestId("money-segment-expenses")).toBeTruthy();
    expect(screen.getByTestId("money-segment-balances")).toBeTruthy();
    // Budget content mounts by default; the other segments' bodies don't.
    expect(await screen.findByTestId("money-budget-list-item-food")).toBeTruthy();
    expect(screen.queryByTestId("money-expenses-placeholder")).toBeNull();
    expect(screen.queryByTestId("money-headline-balances")).toBeNull();
  });

  it("keeps the in-session choice across a remount; a cold launch re-defaults (no-snap-back)", async () => {
    const first = await renderMoney();
    await fireEvent.press(screen.getByTestId("money-segment-balances"));
    expect(await screen.findByTestId("money-headline-balances")).toBeTruthy();
    await first.view.unmount();

    // Same session, fresh mount: balances retained.
    const second = await renderMoney();
    expect(await screen.findByTestId("money-headline-balances")).toBeTruthy();
    expect(screen.queryByTestId("money-budget-list-item-food")).toBeNull();
    await second.view.unmount();

    // Cold launch (memory reset): back to the budget default — the control
    // arm that proves the retention above was the memory, not chance.
    resetMoneySegmentMemory();
    await renderMoney();
    expect(await screen.findByTestId("money-budget-list-item-food")).toBeTruthy();
    expect(screen.queryByTestId("money-headline-balances")).toBeNull();
  });
});

describe("budget segment (R-cmoney-2/4/29)", () => {
  it("renders one row per shared-enum category off the G1 document with shared-formatter amounts", async () => {
    await renderMoney();
    for (const category of [
      "lodging",
      "transport",
      "food",
      "activities",
      "shopping",
      "other",
    ] as const) {
      expect(await screen.findByTestId(`money-budget-list-item-${category}`)).toBeTruthy();
    }
    // Spend/cap text goes through the shared ISO-4217 formatter (Law #2).
    expect(screen.getByText("USD 85.00 of USD 100.00")).toBeTruthy();
    expect(screen.getByText("USD 345.00 spent")).toBeTruthy(); // total header
    // AI estimate column renders value + timestamp when present.
    expect(screen.getByText(/AI est\. USD 300\.00 · /)).toBeTruthy();
  });

  it("progress states are integer-threshold: ≥80% warning, >100% over (semantic tokens)", async () => {
    await renderMoney();
    const warning = await screen.findByTestId("money-budget-progress-food"); // 8500/10000 = 85%
    const over = screen.getByTestId("money-budget-progress-transport"); // 6000/5000
    const normal = screen.getByTestId("money-budget-progress-lodging"); // 20%
    expect(warning).toHaveStyle({ backgroundColor: lightTheme.color.status.warning.fg });
    expect(over).toHaveStyle({ backgroundColor: lightTheme.color.status.danger.fg });
    // Control arm: the normal row uses the primary fill, not a status tone.
    expect(normal).toHaveStyle({ backgroundColor: lightTheme.color.primary.solid });
    expect(over).toHaveStyle({ width: "100%" });
  });

  it("a category cap edit PUTs integer cents and reconciles to the server's document", async () => {
    const { request } = await renderMoney();
    const input = await screen.findByTestId("money-input-cap-food");
    await fireEvent.changeText(input, "250");
    await fireEvent(input, "endEditing");
    await settle();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT", path: "/trips/:tripId/budgets/:category" }),
      expect.objectContaining({
        params: { tripId: TEST_TRIP_ID, category: "food" },
        body: { cap_cents: 25000 },
      }),
    );
    // The responder applied the cap — the row now shows the server's number.
    expect(await screen.findByText("USD 85.00 of USD 250.00")).toBeTruthy();
  });

  it("the overall trip cap edits through the `total` pseudo-category (R-cmoney-2)", async () => {
    const { request } = await renderMoney();
    const input = await screen.findByTestId("money-input-cap-total");
    await fireEvent.changeText(input, "1500");
    await fireEvent(input, "endEditing");
    await settle();
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        params: { tripId: TEST_TRIP_ID, category: "total" },
        body: { cap_cents: 150000 },
      }),
    );
  });

  it("clearing the field PUTs null (G2 cap clear); an unchanged value PUTs nothing", async () => {
    const { request } = await renderMoney();
    const input = await screen.findByTestId("money-input-cap-food");
    // Unchanged: end editing with the prefilled value → no PUT (control arm
    // for the null-clear below — proves commits are change-gated).
    await fireEvent(input, "endEditing");
    await settle();
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT" }),
      expect.anything(),
    );
    await fireEvent.changeText(input, "");
    await fireEvent(input, "endEditing");
    await settle();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT" }),
      expect.objectContaining({
        params: { tripId: TEST_TRIP_ID, category: "food" },
        body: { cap_cents: null },
      }),
    );
  });

  it("rejects invalid amounts with a visible error and NO request (R-cmoney-8 kin)", async () => {
    const { request } = await renderMoney();
    const input = await screen.findByTestId("money-input-cap-food");
    await fireEvent.changeText(input, "25.505");
    await fireEvent(input, "endEditing");
    await settle();
    expect(screen.getByTestId("money-input-cap-food-error")).toBeTruthy();
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT" }),
      expect.anything(),
    );
    // Ungated control arm: a valid amount from the same field does PUT.
    await fireEvent.changeText(input, "25.50");
    await fireEvent(input, "endEditing");
    await settle();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT" }),
      expect.objectContaining({ body: { cap_cents: 2550 } }),
    );
  });

  it("JPY trips parse WHOLE units and reject decimals (zero-decimal — the 100×-off precedent)", async () => {
    const trip = makeTrip({ id: TEST_TRIP_ID, base_currency: "JPY" });
    const { request } = await renderMoney({
      trip,
      api: { budgets: makeBudgetsRead({ currency: "JPY" }) },
    });
    const input = await screen.findByTestId("money-input-cap-food");
    // JPY money text renders whole units end to end.
    expect(screen.getByText("JPY 8500 of JPY 10000")).toBeTruthy();
    await fireEvent.changeText(input, "2500.50");
    await fireEvent(input, "endEditing");
    await settle();
    expect(screen.getByTestId("money-input-cap-food-error")).toBeTruthy();
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT" }),
      expect.anything(),
    );
    await fireEvent.changeText(input, "2500");
    await fireEvent(input, "endEditing");
    await settle();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PUT" }),
      expect.objectContaining({ body: { cap_cents: 2500 } }),
    );
  });

  it("commits are GATED while a PUT is genuinely in flight; release re-arms them", async () => {
    // Deferred-promise discipline (mobile.md): resolvers in an ARRAY,
    // release EVERY one in finally — the control-arm PUT below mints a
    // second held promise, and a finally that ran before it would strand
    // it and wedge the file (the exact T-7.9-r1 landmine shape).
    const resolvers: ((value: unknown) => void)[] = [];
    const putCalls: Record<string, unknown>[] = [];
    const serverDoc = makeBudgetsRead({ items: { food: { cap_cents: 30000 } } });
    try {
      await renderMoney({
        api: {
          putBudget: (input) => {
            putCalls.push(input);
            return new Promise((resolve) => {
              resolvers.push(resolve);
            });
          },
        },
      });
      const input = await screen.findByTestId("money-input-cap-food");
      await fireEvent.changeText(input, "300");
      await fireEvent(input, "endEditing");
      await waitFor(() => expect(putCalls).toHaveLength(1));
      // Second commit attempt while the first is HELD in flight → gated.
      await fireEvent.changeText(input, "400");
      await fireEvent(input, "endEditing");
      await settle();
      expect(putCalls).toHaveLength(1);

      // Release the first PUT (resolving again in finally is a no-op) —
      // the gate re-arms and the SAME interaction now issues a second PUT:
      // the ungated control arm proving the block above was the gate.
      resolvers[0]?.(serverDoc);
      await settle();
      await fireEvent.changeText(input, "400");
      await fireEvent(input, "endEditing");
      await waitFor(() => expect(putCalls).toHaveLength(2));
      expect(putCalls[1]).toMatchObject({ body: { cap_cents: 40000 } });
    } finally {
      for (const release of resolvers) release(serverDoc);
    }
    await settle();
  });

  it("a failed cap save surfaces a dismissible error banner (mutations fail visibly)", async () => {
    await renderMoney({
      api: {
        putBudget: () => Promise.reject(new ApiRequestError(403, "FORBIDDEN", "nope")),
      },
    });
    const input = await screen.findByTestId("money-input-cap-food");
    await fireEvent.changeText(input, "300");
    await fireEvent(input, "endEditing");
    expect(await screen.findByTestId("money-budget-save-error")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("money-budget-save-error-dismiss"));
    expect(screen.queryByTestId("money-budget-save-error")).toBeNull();
  });

  it("untouched budget → 'Plan your spending' EmptyState; set-caps reveals the editor (§2.9)", async () => {
    await renderMoney({ api: { budgets: emptyBudgetsRead() } });
    await screen.findByTestId("money-budget-empty");
    // The AI CTA is part of the empty arm (§2.9: set-caps + AI CTAs)…
    expect(screen.getByTestId("money-button-ai-estimate")).toBeTruthy();
    // …and no row editor is mounted yet (control for the reveal below).
    expect(screen.queryByTestId("money-input-cap-food")).toBeNull();

    await fireEvent.press(screen.getByTestId("money-budget-empty-set-caps"));
    expect(await screen.findByTestId("money-input-cap-food")).toBeTruthy();
    expect(screen.getByTestId("money-input-cap-total")).toBeTruthy();
    expect(screen.queryByTestId("money-budget-empty")).toBeNull();
  });

  it("viewers get read-only rows — no cap inputs, no set-caps action (editor+ gate)", async () => {
    const viewer = makeTrip({ id: TEST_TRIP_ID, role: "viewer" });
    const first = await renderMoney({ trip: viewer });
    await screen.findByTestId("money-budget-list-item-food");
    expect(screen.queryByTestId("money-input-cap-food")).toBeNull();
    expect(screen.queryByTestId("money-input-cap-total")).toBeNull();
    // Read-only cap presentation instead (total has no cap in the fixture).
    expect(screen.getByText("No overall cap")).toBeTruthy();
    await first.view.unmount();

    // Untouched + viewer: the EmptyState renders WITHOUT the set-caps action.
    await renderMoney({ trip: viewer, api: { budgets: emptyBudgetsRead() } });
    await screen.findByTestId("money-budget-empty");
    expect(screen.queryByTestId("money-budget-empty-set-caps")).toBeNull();
  });

  it("a failed initial read renders ErrorBanner; retry recovers the rows", async () => {
    let calls = 0;
    await renderMoney({
      overrides: {
        "GET /trips/:tripId/budgets": () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new ApiRequestError(500, "INTERNAL", "boom"))
            : Promise.resolve(makeBudgetsRead());
        },
      },
    });
    await screen.findByTestId("money-budget-error");
    await fireEvent.press(screen.getByTestId("money-budget-error-retry"));
    await settle();
    expect(await screen.findByTestId("money-budget-list-item-food")).toBeTruthy();
    expect(screen.queryByTestId("money-budget-error")).toBeNull();
  });
});

describe("AI estimate CTA (MON-7 deferred — visible disabled stub)", () => {
  it("renders, is DISABLED, and carries the §2.8 testID (state pin, not a vacuous press)", async () => {
    await renderMoney();
    const cta = await screen.findByTestId("money-button-ai-estimate");
    expect(cta.props.accessibilityState).toMatchObject({ disabled: true });
  });
});

describe("expenses segment seam (T-9.6 fills; FAB ships now)", () => {
  it("shows the placeholder and the add-expense FAB for every member — viewers included (R-cmoney-5)", async () => {
    await renderMoney({ trip: makeTrip({ id: TEST_TRIP_ID, role: "viewer" }) });
    await fireEvent.press(screen.getByTestId("money-segment-expenses"));
    expect(await screen.findByTestId("money-expenses-placeholder")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("money-fab-add-expense"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/[tripId]/money/expense/new",
      params: { tripId: TEST_TRIP_ID },
    });
  });
});

describe("balances segment (R-cmoney-6/29)", () => {
  async function openBalances(opts?: Parameters<typeof renderMoney>[0]) {
    const rendered = await renderMoney(opts);
    await fireEvent.press(screen.getByTestId("money-segment-balances"));
    await settle();
    return rendered;
  }

  it("headline shows the caller's signed position; chips show every roster member's net", async () => {
    await openBalances();
    const headline = await screen.findByTestId("money-headline-balances");
    expect(headline).toBeTruthy();
    expect(screen.getByText("You're owed USD 25.50")).toBeTruthy();
    expect(screen.getByTestId(`money-balance-list-item-${TEST_USER.id}`)).toBeTruthy();
    expect(screen.getByTestId(`money-balance-list-item-${MEMBER_B_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`money-balance-list-item-${MEMBER_C_ID}`)).toBeTruthy();
    expect(screen.getByText("+USD 25.50")).toBeTruthy();
    expect(screen.getByText("-USD 24.50")).toBeTruthy();
  });

  it("transfers render PAIRWISE by default; the simplify toggle switches to the API's simplified set", async () => {
    await openBalances();
    // Pairwise rows: B→me and C→B; the simplified-only C→me row is absent.
    await screen.findByTestId(`money-transfer-list-item-${MEMBER_B_ID}-${TEST_USER.id}`);
    expect(
      screen.getByTestId(`money-transfer-list-item-${MEMBER_C_ID}-${MEMBER_B_ID}`),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(`money-transfer-list-item-${MEMBER_C_ID}-${TEST_USER.id}`),
    ).toBeNull();

    await fireEvent.press(screen.getByTestId("money-toggle-simplify"));
    await settle();
    // Simplified rows: C→me and B→me; the pairwise-only C→B row is gone.
    expect(
      await screen.findByTestId(`money-transfer-list-item-${MEMBER_C_ID}-${TEST_USER.id}`),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(`money-transfer-list-item-${MEMBER_C_ID}-${MEMBER_B_ID}`),
    ).toBeNull();

    // Toggle back — a per-view control, symmetric.
    await fireEvent.press(screen.getByTestId("money-toggle-simplify"));
    await settle();
    expect(
      await screen.findByTestId(`money-transfer-list-item-${MEMBER_C_ID}-${MEMBER_B_ID}`),
    ).toBeTruthy();
  });

  it("the toggle is NOT persisted — a remount re-defaults to pairwise (R-cmoney-6)", async () => {
    const first = await openBalances();
    await fireEvent.press(screen.getByTestId("money-toggle-simplify"));
    // Control arm first: simplified IS active before the unmount…
    expect(
      await screen.findByTestId(`money-transfer-list-item-${MEMBER_C_ID}-${TEST_USER.id}`),
    ).toBeTruthy();
    await first.view.unmount();

    // …and gone after a remount (segment memory keeps BALANCES selected —
    // that part persists by design; the VIEW toggle must not).
    await openBalances();
    expect(
      await screen.findByTestId(`money-transfer-list-item-${MEMBER_C_ID}-${MEMBER_B_ID}`),
    ).toBeTruthy();
    expect(
      screen.queryByTestId(`money-transfer-list-item-${MEMBER_C_ID}-${TEST_USER.id}`),
    ).toBeNull();
  });

  it("a creditor row and a member chip both open the settle screen for the counterparty (§2.6)", async () => {
    await openBalances();
    await fireEvent.press(
      await screen.findByTestId(`money-transfer-list-item-${MEMBER_B_ID}-${TEST_USER.id}`),
    );
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/[tripId]/money/settle/[memberId]",
      params: { tripId: TEST_TRIP_ID, memberId: MEMBER_B_ID },
    });
    mockPush.mockReset();
    await fireEvent.press(screen.getByTestId(`money-balance-list-item-${MEMBER_C_ID}`));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/[tripId]/money/settle/[memberId]",
      params: { tripId: TEST_TRIP_ID, memberId: MEMBER_C_ID },
    });
  });

  it("a DEBTOR row opens settle for the creditor (the settle screen owns the R-cmoney-23 branch)", async () => {
    const debtorBalances = makeBalancesRead({
      members: [
        { user_id: TEST_USER.id, net_cents: -2550 },
        { user_id: MEMBER_B_ID, net_cents: 2550 },
      ],
      pairwise: [
        {
          trip_id: TEST_TRIP_ID,
          user_id: TEST_USER.id,
          counterparty_id: MEMBER_B_ID,
          net_cents: -2550,
        },
      ],
      simplified: [{ from_user_id: TEST_USER.id, to_user_id: MEMBER_B_ID, amount_cents: 2550 }],
    });
    await openBalances({ api: { balances: debtorBalances } });
    expect(await screen.findByText("You owe USD 25.50")).toBeTruthy();
    await fireEvent.press(
      screen.getByTestId(`money-transfer-list-item-${TEST_USER.id}-${MEMBER_B_ID}`),
    );
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/[tripId]/money/settle/[memberId]",
      params: { tripId: TEST_TRIP_ID, memberId: MEMBER_B_ID },
    });
  });

  it("a row NOT involving the caller has no action: press navigates nowhere (control: caller row does)", async () => {
    await openBalances();
    const bystanderRow = await screen.findByTestId(
      `money-transfer-list-item-${MEMBER_C_ID}-${MEMBER_B_ID}`,
    );
    await fireEvent.press(bystanderRow);
    expect(mockPush).not.toHaveBeenCalled();
    // Ungated control arm: the caller's row from the SAME render navigates.
    await fireEvent.press(
      screen.getByTestId(`money-transfer-list-item-${MEMBER_B_ID}-${TEST_USER.id}`),
    );
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("all-zero balances render the 'All settled up' EmptyState (R-cmoney-29)", async () => {
    await openBalances({ api: { balances: makeSettledBalancesRead() } });
    expect(await screen.findByTestId("money-balances-empty")).toBeTruthy();
    expect(await screen.findByText("You're all settled up")).toBeTruthy();
    // Control arm: the default universe renders rows, not the EmptyState
    // (asserted throughout the sibling tests).
    expect(screen.queryByTestId(`money-transfer-list-item-${MEMBER_B_ID}-${TEST_USER.id}`)).toBeNull();
  });

  it("a failed balances read renders ErrorBanner; retry recovers", async () => {
    let calls = 0;
    await openBalances({
      overrides: {
        "GET /trips/:tripId/balances": () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new ApiRequestError(500, "INTERNAL", "boom"))
            : Promise.resolve(makeBalancesRead());
        },
      },
    });
    await screen.findByTestId("money-balances-error");
    await fireEvent.press(screen.getByTestId("money-balances-error-retry"));
    await settle();
    expect(await screen.findByTestId("money-headline-balances")).toBeTruthy();
  });
});

describe("offline degrade (R-cmoney-30 posture)", () => {
  it("no cache + transport failure → offline-flavored error, not a generic one", async () => {
    await renderMoney({
      overrides: {
        "GET /trips/:tripId/budgets": () =>
          Promise.reject(new ApiRequestError(0, "NETWORK", "offline")),
      },
    });
    const banner = await screen.findByTestId("money-budget-error");
    expect(banner).toBeTruthy();
    expect(
      screen.getByText("You're offline and this trip's budget isn't cached yet."),
    ).toBeTruthy();
  });

  it("cached data keeps rendering under a transport failure, with the offline banner (no blanking)", async () => {
    // Mount 1 primes the cache; mount 2 shares the client and its refetch
    // fails at the transport layer (status 0) — the rows must survive.
    // gcTime Infinity, NOT makeTestQueryClient's 0 (the P-6 landmine): with
    // gcTime 0 the unmount arms a GC timer that can collect the "cached"
    // entry before mount 2 subscribes — under CI's 2-core contention it
    // reliably wins, and the test then exercises the no-cache arm instead.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false, gcTime: 0 },
      },
    });
    const first = await renderMoney({ queryClient: client });
    await screen.findByTestId("money-budget-list-item-food");
    await first.view.unmount();

    await renderMoney({
      queryClient: client,
      overrides: {
        "GET /trips/:tripId/budgets": () =>
          Promise.reject(new ApiRequestError(0, "NETWORK", "offline")),
      },
    });
    expect(await screen.findByTestId("money-banner-offline")).toBeTruthy();
    // Cached rows still render — offline never blanks the surface.
    expect(screen.getByTestId("money-budget-list-item-food")).toBeTruthy();
    // The offline banner replaces the retry-bearing refresh error (a retry
    // while the transport is down is a lie) — control arm for the banner.
    expect(screen.queryByTestId("money-budget-refresh-error")).toBeNull();
  });
});

describe("§2.8 testID inventory walk (R-cmoney-30 — shell scope)", () => {
  it("every T-9.5 surface carries its inventory testID", async () => {
    await renderMoney();
    await screen.findByTestId("money-budget-list-item-food");
    for (const id of [
      "money-screen",
      "money-segment-budget",
      "money-segment-expenses",
      "money-segment-balances",
      "money-button-ai-estimate",
      "money-input-cap-total",
      "money-input-cap-lodging",
      "money-input-cap-transport",
      "money-input-cap-food",
      "money-input-cap-activities",
      "money-input-cap-shopping",
      "money-input-cap-other",
      "money-budget-list-item-lodging",
      "money-budget-list-item-transport",
      "money-budget-list-item-food",
      "money-budget-list-item-activities",
      "money-budget-list-item-shopping",
      "money-budget-list-item-other",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    await fireEvent.press(screen.getByTestId("money-segment-expenses"));
    expect(await screen.findByTestId("money-fab-add-expense")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("money-segment-balances"));
    expect(await screen.findByTestId("money-toggle-simplify")).toBeTruthy();
    expect(screen.getByTestId(`money-balance-list-item-${MEMBER_B_ID}`)).toBeTruthy();
    expect(
      screen.getByTestId(`money-transfer-list-item-${MEMBER_B_ID}-${TEST_USER.id}`),
    ).toBeTruthy();
  });
});
