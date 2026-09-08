/**
 * ExpensesSegment (T-9.6 / CMON-2 — R-cmoney-5/29/30) at the component
 * boundary: real data hooks, network mocked by descriptor, wire-valid
 * fixtures (schema-parsed in money-fixtures — contract drift fails here).
 *
 * Pins: rows off the E2 page (description, category Badge, payer, shared-
 * formatter amounts, "your share" only when the caller holds a share row);
 * newest-first order preserved from the wire; row → detail push + FAB/empty
 * CTA → modal (VIEWERS included — R-cmoney-5); the cursor crawl on
 * onEndReached with an exhausted-cursor control; member/category filters on
 * the wire + the "No matches"/clear pair; "No expenses yet" + pulse hint
 * (absent with rows — control); the held-read skeleton (deferred promise,
 * resolvers array, release in finally); cached rows + refresh-error banner
 * + retry recovery; ex-member payer label.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { ApiRequestError } from "@/auth";
import { MEMBER_B_ID, MEMBER_C_ID, TEST_TRIP_ID } from "@/test-utils/ids";
import {
  EXPENSE_B_ID,
  makeExpense,
  makeExpensesPage,
  TEST_EXPENSE_ID,
} from "@/test-utils/money-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeMember, makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

import { ExpensesSegment } from "./ExpensesSegment";

import { QueryClient } from "@tanstack/react-query";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

type Responder = (input: Record<string, unknown>) => Promise<unknown>;

async function renderSegment(opts?: {
  expenses?: Responder;
  role?: "owner" | "viewer";
  queryClient?: QueryClient;
}) {
  seedAuthenticated();
  const trip = makeTrip({ id: TEST_TRIP_ID, role: opts?.role ?? "owner" });
  const request = mockNavApi({
    trips: [trip],
    members: [
      makeMember(),
      makeMember({ user: { id: MEMBER_B_ID, display_name: "Blair" }, role: "editor" }),
    ],
    overrides:
      opts?.expenses !== undefined
        ? { "GET /trips/:tripId/expenses": opts.expenses }
        : {
            "GET /trips/:tripId/expenses": () => Promise.resolve(makeExpensesPage([makeExpense()])),
          },
  });
  const view = await renderWithProviders(<ExpensesSegment trip={trip} />, {
    queryClient: opts?.queryClient ?? makeTestQueryClient(),
  });
  await settle();
  return { view, request };
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockPush.mockReset();
});

it("renders rows off the wire page: formatter amounts, payer, badge, and the caller's share line", async () => {
  await renderSegment();
  const row = await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`);
  expect(row).toBeTruthy();
  expect(screen.getByText("Dinner at Menya")).toBeTruthy();
  // Shared-formatter money copy (Law #2 — the "USD 25.50" cross-surface shape).
  expect(screen.getByText("USD 25.50")).toBeTruthy();
  expect(screen.getByText("Your share: USD 12.75")).toBeTruthy();
  expect(screen.getByText("Food")).toBeTruthy();
  expect(screen.getByText(/Paid by You/)).toBeTruthy();
});

it("no share row for the caller → no 'your share' line (absent = not involved)", async () => {
  await renderSegment({
    expenses: () =>
      Promise.resolve(
        makeExpensesPage([
          makeExpense({
            paid_by: MEMBER_B_ID,
            shares: [{ user_id: MEMBER_B_ID, share_cents: 2550 }],
          }),
        ]),
      ),
  });
  await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`);
  expect(screen.queryByText(/Your share/)).toBeNull();
  expect(screen.getByText(/Paid by Blair/)).toBeTruthy();
});

it("an ex-member payer labels 'Former member' (departed payers' expenses survive)", async () => {
  await renderSegment({
    expenses: () =>
      Promise.resolve(
        makeExpensesPage([
          makeExpense({
            paid_by: MEMBER_C_ID,
            shares: [{ user_id: MEMBER_C_ID, share_cents: 2550 }],
          }),
        ]),
      ),
  });
  await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`);
  expect(screen.getByText(/Paid by Former member/)).toBeTruthy();
});

it("row press pushes expense detail; FAB pushes the add modal — for a VIEWER too (R-cmoney-5)", async () => {
  await renderSegment({ role: "viewer" });
  await fireEvent.press(await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: "/[tripId]/money/expense/[expenseId]",
    params: { tripId: TEST_TRIP_ID, expenseId: TEST_EXPENSE_ID },
  });
  await fireEvent.press(screen.getByTestId("money-fab-add-expense"));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: "/[tripId]/money/expense/new",
    params: { tripId: TEST_TRIP_ID },
  });
});

it("cursor crawl: onEndReached fetches ?cursor=; an exhausted cursor fetches nothing more", async () => {
  const expenseCalls: Record<string, unknown>[] = [];
  const page2 = makeExpensesPage(
    [makeExpense({ id: EXPENSE_B_ID, description: "Museum tickets" })],
    null,
  );
  const { request } = await renderSegment({
    expenses: (input) => {
      expenseCalls.push(input);
      const query = input["query"] as { cursor?: string } | undefined;
      return Promise.resolve(
        query?.cursor === "cur-1" ? page2 : makeExpensesPage([makeExpense()], "cur-1"),
      );
    },
  });
  await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`);

  await fireEvent(screen.getByTestId("money-expense-list"), "onEndReached");
  expect(await screen.findByTestId(`money-expense-list-item-${EXPENSE_B_ID}`)).toBeTruthy();
  expect(expenseCalls.map((call) => call["query"])).toEqual([{}, { cursor: "cur-1" }]);

  // Exhausted (page 2 returned null) — further end-reached events no-op.
  await fireEvent(screen.getByTestId("money-expense-list"), "onEndReached");
  await settle();
  expect(expenseCalls).toHaveLength(2);
  expect(request).toBeTruthy();
});

it("filters ride the wire; 'No matches' + clear restores the unfiltered list (control arm)", async () => {
  const expenseCalls: Record<string, unknown>[] = [];
  await renderSegment({
    expenses: (input) => {
      expenseCalls.push(input);
      const query = input["query"] as { category?: string } | undefined;
      return Promise.resolve(
        query?.category === "lodging" ? makeExpensesPage([]) : makeExpensesPage([makeExpense()]),
      );
    },
  });
  await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`);

  await fireEvent.press(screen.getByTestId("money-button-filter"));
  await fireEvent.press(screen.getByTestId("money-sheet-filter-category-lodging"));
  await settle();

  expect(expenseCalls.at(-1)?.["query"]).toEqual({ category: "lodging" });
  expect(await screen.findByTestId("money-expenses-no-matches")).toBeTruthy();

  await fireEvent.press(screen.getByTestId("money-expenses-clear-filters"));
  expect(await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`)).toBeTruthy();
  expect(screen.queryByTestId("money-expenses-no-matches")).toBeNull();
});

it("member filter chips send ?member=; the sheet's clear resets", async () => {
  const expenseCalls: Record<string, unknown>[] = [];
  await renderSegment({
    expenses: (input) => {
      expenseCalls.push(input);
      return Promise.resolve(makeExpensesPage([makeExpense()]));
    },
  });
  await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`);

  await fireEvent.press(screen.getByTestId("money-button-filter"));
  await fireEvent.press(screen.getByTestId(`money-sheet-filter-member-${MEMBER_B_ID}`));
  await settle();
  expect(expenseCalls.at(-1)?.["query"]).toEqual({ member: MEMBER_B_ID });

  await fireEvent.press(screen.getByTestId("money-sheet-filter-clear"));
  await settle();
  expect(expenseCalls.at(-1)?.["query"]).toEqual({});
});

it("empty universe: 'No expenses yet' + add CTA + the finite pulse hint; rows suppress both (control)", async () => {
  await renderSegment({ expenses: () => Promise.resolve(makeExpensesPage([])) });
  expect(await screen.findByTestId("money-expenses-empty")).toBeTruthy();
  expect(screen.getByTestId("money-fab-pulse-hint")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("money-expenses-empty-add"));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: "/[tripId]/money/expense/new",
    params: { tripId: TEST_TRIP_ID },
  });

  mockPush.mockReset();
  await renderSegment();
  await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`);
  expect(screen.queryByTestId("money-expenses-empty")).toBeNull();
  expect(screen.queryByTestId("money-fab-pulse-hint")).toBeNull();
});

it("held read shows the skeleton; release renders rows (deferred, release in finally)", async () => {
  const resolvers: (() => void)[] = [];
  await renderSegment({
    expenses: () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve(makeExpensesPage([makeExpense()])));
      }),
  });
  try {
    expect(screen.getByTestId("money-expenses-loading")).toBeTruthy();
    expect(screen.queryByTestId("money-expense-list")).toBeNull();
  } finally {
    for (const release of resolvers) release();
  }
  await settle();
  expect(await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`)).toBeTruthy();
  expect(screen.queryByTestId("money-expenses-loading")).toBeNull();
});

it("initial-load failure shows the error banner; retry recovers", async () => {
  let calls = 0;
  await renderSegment({
    expenses: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new ApiRequestError(500, "INTERNAL", "boom"))
        : Promise.resolve(makeExpensesPage([makeExpense()]));
    },
  });
  const banner = await screen.findByTestId("money-expenses-error");
  expect(banner).toBeTruthy();
  await fireEvent.press(screen.getByTestId("money-expenses-error-retry"));
  await settle();
  expect(await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`)).toBeTruthy();
});

it("cached rows + failing refetch → refresh-error banner, rows stay; retry recovers", async () => {
  // Prime, unmount, remount against a 500 — the survives-unmount client
  // (gcTime Infinity: the P-6 observer-less-GC landmine).
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  let mode: "ok" | "fail" = "ok";
  const responder: Responder = () =>
    mode === "ok"
      ? Promise.resolve(makeExpensesPage([makeExpense()]))
      : Promise.reject(new ApiRequestError(500, "INTERNAL", "boom"));

  const first = await renderSegment({ expenses: responder, queryClient: client });
  await screen.findByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`);
  // RNTL v14: unmount is ASYNC — un-awaited, the observer is still
  // subscribed when the next mount lands and no refetch fires (probed live).
  await first.view.unmount();
  await settle();
  jest.restoreAllMocks();

  mode = "fail";
  await renderSegment({ expenses: responder, queryClient: client });
  expect(await screen.findByTestId("money-expenses-refresh-error")).toBeTruthy();
  // Cached rows still render under the banner.
  expect(screen.getByTestId(`money-expense-list-item-${TEST_EXPENSE_ID}`)).toBeTruthy();

  mode = "ok";
  await fireEvent.press(screen.getByTestId("money-expenses-refresh-error-retry"));
  await settle();
  expect(screen.queryByTestId("money-expenses-refresh-error")).toBeNull();
});
