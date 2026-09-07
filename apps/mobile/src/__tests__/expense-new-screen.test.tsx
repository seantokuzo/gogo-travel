/**
 * Add/edit expense modal (T-9.6 / CMON-3 — R-cmoney-7..12, §2.4) over the
 * REAL data hooks (network mocked by descriptor). Wire bodies are re-parsed
 * with the SHARED schemas — falsifiable pins, not hope:
 *
 * - create body is a valid ExpenseCreate: Law #2 cents from the shared
 *   parser, currency DEFAULTS `trip.base_currency` (P-9 ruling ①), payer
 *   defaults the caller, date defaults today, participants default ALL
 *   members with equal resolved shares;
 * - save is DISABLED until description + amount + valid split (state
 *   asserted, never a vacuous disabled press — mobile.md), and the loading
 *   gate holds a second submit while the first is genuinely in flight
 *   (deferred promise, resolvers array, release in finally);
 * - split editors: exact remaining readout gates save; percent sum readout;
 * - JPY: whole-unit parse (1500 → 1500), decimals rejected at the field;
 * - FX (R-cmoney-10): rate auto-fetched from OUR /fx/rate + derived base on
 *   the wire; manual override wins; fetch failure → manual-entry helper and
 *   save blocked until a rate is typed;
 * - booking link (R-cmoney-11): §2.3 prefill + `booking_id` on the wire;
 * - edit (R-cmoney-12): prefill + exact-mode split; PATCH carries CHANGED
 *   FIELDS ONLY (an untouched legacy split naming an ex-member rides
 *   through by omission — R-money-5 incoming-ids); a changed split with a
 *   former member is save-blocked with visible copy;
 * - roles: viewers get the CREATE form (R-money-26); a non-creator
 *   non-owner gets the edit lock; a deleted expense is uneditable;
 * - dirty guard (nav §2.6): typed-then-dismiss intercepts with the discard
 *   Confirm; confirm releases the held action.
 */
import {
  ExpenseCreateSchema,
  ExpenseUpdateSchema,
  type Expense,
  type Paginated,
} from "@gogo/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import ExpenseNewScreen from "@/app/[tripId]/money/expense/new";
import { ApiRequestError } from "@/auth";
import { localTodayISO } from "@/navigation/trip-defaults";
import { TripProvider } from "@/navigation/trip-context";
import { MEMBER_B_ID, MEMBER_C_ID, TEST_TRIP_ID } from "@/test-utils/ids";
import { makeBooking } from "@/test-utils/itinerary-fixtures";
import { makeExpense, makeFxRateRead, TEST_EXPENSE_ID } from "@/test-utils/money-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import { makeMember, makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockDispatch = jest.fn();
let mockParams: Record<string, string> = {};
let mockBeforeRemoveListeners: ((event: BeforeRemoveEvent) => void)[] = [];

interface BeforeRemoveEvent {
  preventDefault(): void;
  data: { action: unknown };
}

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
    replace: mockReplace,
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({
    addListener: (event: string, listener: (e: BeforeRemoveEvent) => void) => {
      if (event === "beforeRemove") mockBeforeRemoveListeners.push(listener);
      return () => {
        mockBeforeRemoveListeners = mockBeforeRemoveListeners.filter((l) => l !== listener);
      };
    },
    dispatch: mockDispatch,
  }),
}));

/** Fire the navigator event every dismissal route funnels through (nav §2.6). */
async function attemptDismiss(): Promise<{ prevented: boolean }> {
  let prevented = false;
  await act(async () => {
    for (const listener of mockBeforeRemoveListeners) {
      listener({
        preventDefault: () => {
          prevented = true;
        },
        data: { action: { type: "POP" } },
      });
    }
  });
  return { prevented };
}

const ME = TEST_USER.id;
const B = MEMBER_B_ID;
const C = MEMBER_C_ID;
const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

type Responder = (input: Record<string, unknown>) => Promise<unknown>;

async function renderScreen(
  params: Record<string, string>,
  opts?: {
    overrides?: Record<string, Responder>;
    role?: "owner" | "editor" | "viewer";
    baseCurrency?: string;
  },
) {
  mockParams = { tripId: TEST_TRIP_ID, ...params };
  seedAuthenticated();
  const trip = makeTrip({
    id: TEST_TRIP_ID,
    role: opts?.role ?? "owner",
    base_currency: opts?.baseCurrency ?? "USD",
  });
  const request = mockNavApi({
    trips: [trip],
    members: [
      makeMember(),
      makeMember({ user: { id: B, display_name: "Blair" }, role: "editor" }),
    ],
    overrides: opts?.overrides ?? {},
  });
  await renderWithProviders(
    <TripProvider trip={trip}>
      <ExpenseNewScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  // Two-stage mount (members → form → bookings/fx reads) — the 4-cycle
  // settle absorbs every follow-on notify batch inside ONE act window.
  await settle();
  return { request, trip };
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockPush.mockReset();
  mockBack.mockReset();
  mockReplace.mockReset();
  mockDispatch.mockReset();
  mockParams = {};
  mockBeforeRemoveListeners = [];
});

describe("create (R-cmoney-7/8 — defaults + Law #2 wire body)", () => {
  it("posts a schema-valid ExpenseCreate: base-currency default, caller payer, today, equal shares", async () => {
    const created: Record<string, unknown>[] = [];
    await renderScreen(
      {},
      {
        overrides: {
          "POST /trips/:tripId/expenses": (input) => {
            created.push(input);
            return Promise.resolve(makeExpense());
          },
        },
      },
    );
    // The RULING pin: the currency field boots to trip.base_currency.
    expect(screen.getByTestId("expense-new-picker-currency").props.value).toBe("USD");

    await fireEvent.changeText(
      screen.getByTestId("expense-new-input-description"),
      "Dinner at Menya",
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "25.50");
    await fireEvent.press(screen.getByTestId("expense-new-picker-category-food"));
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(created).toHaveLength(1));

    const body = ExpenseCreateSchema.parse(created[0]?.["body"]);
    expect(body).toEqual({
      description: "Dinner at Menya",
      category: "food",
      paid_by: ME,
      amount_cents: 2550,
      currency: "USD",
      spent_at: localTodayISO(),
      shares: [
        { user_id: ME, share_cents: 1275 },
        { user_id: B, share_cents: 1275 },
      ],
    });
    expect(mockBack).toHaveBeenCalled();
  });

  it("save is DISABLED until description + amount are present (state, not a vacuous press)", async () => {
    await renderScreen({});
    const save = screen.getByTestId("expense-new-button-save");
    expect(save).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Snacks");
    expect(screen.getByTestId("expense-new-button-save")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "5");
    expect(screen.getByTestId("expense-new-button-save")).not.toBeDisabled();
  });

  it("a genuinely held create shows the loading gate and lands exactly ONE post", async () => {
    const resolvers: ((value: Expense) => void)[] = [];
    let posts = 0;
    await renderScreen(
      {},
      {
        overrides: {
          "POST /trips/:tripId/expenses": () => {
            posts += 1;
            return new Promise<Expense>((resolve) => {
              resolvers.push(resolve);
            });
          },
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Snacks");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "5");
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    try {
      // R-ds-14 loading gate: spinner + press-block while in flight.
      expect(await screen.findByTestId("expense-new-button-save-spinner")).toBeTruthy();
      await fireEvent.press(screen.getByTestId("expense-new-button-save"));
      expect(posts).toBe(1);
    } finally {
      for (const release of resolvers) release(makeExpense());
    }
    await settle();
    expect(posts).toBe(1);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("JPY parses whole units (Law #2) and rejects decimals at the field", async () => {
    const created: Record<string, unknown>[] = [];
    await renderScreen(
      {},
      {
        baseCurrency: "JPY",
        overrides: {
          "POST /trips/:tripId/expenses": (input) => {
            created.push(input);
            return Promise.resolve(
              makeExpense({
                amount_cents: 1500,
                currency: "JPY",
                effective_base_cents: 1500,
                shares: [
                  { user_id: ME, share_cents: 750 },
                  { user_id: B, share_cents: 750 },
                ],
              }),
            );
          },
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Ramen");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "15.00");
    expect(screen.getByTestId("expense-new-input-amount-error")).toBeTruthy();
    expect(screen.getByTestId("expense-new-button-save")).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "1500");
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(created).toHaveLength(1));
    const body = ExpenseCreateSchema.parse(created[0]?.["body"]);
    expect(body.amount_cents).toBe(1500);
    expect(body.currency).toBe("JPY");
  });

  it("exact split gates save on the remaining readout; filling it unblocks (§2.4)", async () => {
    const created: Record<string, unknown>[] = [];
    await renderScreen(
      {},
      {
        overrides: {
          "POST /trips/:tripId/expenses": (input) => {
            created.push(input);
            return Promise.resolve(makeExpense());
          },
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Tickets");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "25.50");
    await fireEvent.press(screen.getByTestId("expense-new-segment-split-exact"));
    await fireEvent.changeText(screen.getByTestId(`expense-new-input-share-${ME}`), "21.00");
    expect(screen.getByText("Remaining: USD 4.50")).toBeTruthy();
    expect(screen.getByTestId("expense-new-button-save")).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId(`expense-new-input-share-${B}`), "4.50");
    expect(screen.getByText("Remaining: USD 0.00")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(created).toHaveLength(1));
    const body = ExpenseCreateSchema.parse(created[0]?.["body"]);
    expect(body.shares).toEqual([
      { user_id: ME, share_cents: 2100 },
      { user_id: B, share_cents: 450 },
    ]);
  });

  it("percent split shows the sum readout until 100% (2dp = basis points)", async () => {
    await renderScreen({});
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Cab");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "100");
    await fireEvent.press(screen.getByTestId("expense-new-segment-split-percent"));
    await fireEvent.changeText(screen.getByTestId(`expense-new-input-percent-${ME}`), "50");
    await fireEvent.changeText(screen.getByTestId(`expense-new-input-percent-${B}`), "49.99");
    expect(screen.getByText("Sum: 99.99% — needs 100%")).toBeTruthy();
    expect(screen.getByTestId("expense-new-button-save")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId(`expense-new-input-percent-${B}`), "50");
    expect(screen.getByText("Sum: 100%")).toBeTruthy();
    expect(screen.getByTestId("expense-new-button-save")).not.toBeDisabled();
  });

  it("toggling a participant out removes their share entirely (absent, not zero)", async () => {
    const created: Record<string, unknown>[] = [];
    await renderScreen(
      {},
      {
        overrides: {
          "POST /trips/:tripId/expenses": (input) => {
            created.push(input);
            return Promise.resolve(makeExpense());
          },
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Solo lunch");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "12.00");
    await fireEvent.press(screen.getByTestId(`expense-new-toggle-participant-${B}`));
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(created).toHaveLength(1));
    const body = ExpenseCreateSchema.parse(created[0]?.["body"]);
    expect(body.shares).toEqual([{ user_id: ME, share_cents: 1200 }]);
  });

  it("payer picker changes paid_by on the wire", async () => {
    const created: Record<string, unknown>[] = [];
    await renderScreen(
      {},
      {
        overrides: {
          "POST /trips/:tripId/expenses": (input) => {
            created.push(input);
            return Promise.resolve(makeExpense());
          },
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Museum");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "30");
    await fireEvent.press(screen.getByTestId("expense-new-picker-payer"));
    await fireEvent.press(await screen.findByTestId(`expense-new-sheet-payer-${B}`));
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(ExpenseCreateSchema.parse(created[0]?.["body"]).paid_by).toBe(B);
  });
});

describe("multi-currency entry (R-cmoney-10)", () => {
  it("fetches OUR /fx/rate, prefills the rate + derived base, and puts the pair on the wire", async () => {
    const created: Record<string, unknown>[] = [];
    const fxCalls: Record<string, unknown>[] = [];
    await renderScreen(
      {},
      {
        overrides: {
          "GET /fx/rate": (input) => {
            fxCalls.push(input);
            return Promise.resolve(makeFxRateRead({ base: "EUR", quote: "USD", rate: "1.08" }));
          },
          "POST /trips/:tripId/expenses": (input) => {
            created.push(input);
            return Promise.resolve(
              makeExpense({
                currency: "EUR",
                fx_rate: "1.08",
                base_amount_cents: 2754,
                effective_base_cents: 2754,
              }),
            );
          },
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Tapas");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "25.50");
    await fireEvent.changeText(screen.getByTestId("expense-new-picker-currency"), "EUR");
    await settle();

    expect(fxCalls[0]?.["query"]).toEqual({ base: "EUR", quote: "USD" });
    await waitFor(() =>
      expect(screen.getByTestId("expense-new-input-fx-rate").props.value).toBe("1.08"),
    );
    // Derived base is READ-ONLY display: 2550 × 1.08 = 2754 (BigInt half-up).
    expect(screen.getByTestId("expense-new-input-base-amount").props.value).toBe("USD 27.54");

    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(created).toHaveLength(1));
    const body = ExpenseCreateSchema.parse(created[0]?.["body"]);
    expect(body.currency).toBe("EUR");
    expect(body.fx_rate).toBe("1.08");
    expect(body.base_amount_cents).toBe(2754);
  });

  it("manual override beats the fetched rate (always allowed)", async () => {
    const created: Record<string, unknown>[] = [];
    await renderScreen(
      {},
      {
        overrides: {
          "GET /fx/rate": () =>
            Promise.resolve(makeFxRateRead({ base: "EUR", quote: "USD", rate: "1.08" })),
          "POST /trips/:tripId/expenses": (input) => {
            created.push(input);
            return Promise.resolve(
              makeExpense({
                currency: "EUR",
                fx_rate: "1.10",
                base_amount_cents: 2805,
                effective_base_cents: 2805,
              }),
            );
          },
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Tapas");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "25.50");
    await fireEvent.changeText(screen.getByTestId("expense-new-picker-currency"), "EUR");
    await waitFor(() =>
      expect(screen.getByTestId("expense-new-input-fx-rate").props.value).toBe("1.08"),
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-fx-rate"), "1.10");
    expect(screen.getByTestId("expense-new-input-base-amount").props.value).toBe("USD 28.05");

    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(created).toHaveLength(1));
    const body = ExpenseCreateSchema.parse(created[0]?.["body"]);
    expect(body.fx_rate).toBe("1.10");
    expect(body.base_amount_cents).toBe(2805);
  });

  it("FX failure requires manual rate entry before save (helper + gate)", async () => {
    await renderScreen(
      {},
      {
        overrides: {
          "GET /fx/rate": () => Promise.reject(new ApiRequestError(503, "AI_UPSTREAM", "down")),
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Tapas");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "25.50");
    await fireEvent.changeText(screen.getByTestId("expense-new-picker-currency"), "EUR");
    await settle();

    expect(screen.getByText(/enter it manually/i)).toBeTruthy();
    expect(screen.getByTestId("expense-new-button-save")).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId("expense-new-input-fx-rate"), "1.05");
    expect(screen.getByTestId("expense-new-button-save")).not.toBeDisabled();
  });
});

describe("booking link (R-cmoney-11)", () => {
  it("selecting a booking prefills §2.3 fields and rides booking_id on the wire", async () => {
    const created: Record<string, unknown>[] = [];
    const bookingsPage: Paginated<ReturnType<typeof makeBooking>> = {
      items: [
        makeBooking({
          id: BOOKING_ID,
          category: "restaurant",
          title: "Menya Reservation",
          price_cents: 12000,
          currency: "USD",
        }),
      ],
      nextCursor: null,
    };
    await renderScreen(
      {},
      {
        overrides: {
          "GET /trips/:tripId/bookings": () => Promise.resolve(bookingsPage),
          "POST /trips/:tripId/expenses": (input) => {
            created.push(input);
            return Promise.resolve(makeExpense({ booking_id: BOOKING_ID }));
          },
        },
      },
    );
    await fireEvent.press(screen.getByTestId("expense-new-button-booking-link"));
    await fireEvent.press(await screen.findByTestId(`expense-new-sheet-booking-${BOOKING_ID}`));

    // §2.3 prefill: title → description, restaurant → food, price + currency.
    expect(screen.getByTestId("expense-new-input-description").props.value).toBe(
      "Menya Reservation",
    );
    expect(screen.getByTestId("expense-new-input-amount").props.value).toBe("120.00");

    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(created).toHaveLength(1));
    const body = ExpenseCreateSchema.parse(created[0]?.["body"]);
    expect(body.booking_id).toBe(BOOKING_ID);
    expect(body.category).toBe("food");
    expect(body.amount_cents).toBe(12000);
  });

  it("a booking link that CHANGES the currency drops a latched stored rate (edit mode — the latch×prefill interaction)", async () => {
    // EDIT a JPY expense on a USD-base trip: the stored rate latches
    // fxRateTouched at MOUNT (no manual typing needed). Linking a
    // EUR-priced booking flips the currency — the stale JPY→USD rate must
    // NOT survive to price a EUR amount (a €200 stay at 0.0067 would
    // persist as ~$1.34 of base spend and the server's consistency check
    // ACCEPTS the internally-consistent pair).
    const bookingsPage: Paginated<ReturnType<typeof makeBooking>> = {
      items: [
        makeBooking({
          id: BOOKING_ID,
          category: "lodging",
          title: "Tapas Hotel",
          price_cents: 20000,
          currency: "EUR",
        }),
      ],
      nextCursor: null,
    };
    await renderScreen(
      { expenseId: TEST_EXPENSE_ID },
      {
        overrides: {
          "GET /trips/:tripId/expenses/:expenseId": () =>
            Promise.resolve(
              makeExpense({
                amount_cents: 1500,
                currency: "JPY",
                fx_rate: "0.0067",
                base_amount_cents: 1005,
                effective_base_cents: 1005,
                shares: [
                  { user_id: ME, share_cents: 750 },
                  { user_id: B, share_cents: 750 },
                ],
              }),
            ),
          "GET /trips/:tripId/bookings": () => Promise.resolve(bookingsPage),
          "GET /fx/rate": () =>
            Promise.resolve(makeFxRateRead({ base: "EUR", quote: "USD", rate: "1.08" })),
        },
      },
    );
    // The stored JPY→USD rate is prefilled and latched.
    expect(screen.getByTestId("expense-new-input-fx-rate").props.value).toBe("0.0067");

    await fireEvent.press(screen.getByTestId("expense-new-button-booking-link"));
    await fireEvent.press(await screen.findByTestId(`expense-new-sheet-booking-${BOOKING_ID}`));
    await settle();

    // The latch dropped: the rate re-fetches for the NEW pair (EUR→USD)
    // and the base re-derives from it — never from the stale JPY rate.
    await waitFor(() =>
      expect(screen.getByTestId("expense-new-input-fx-rate").props.value).toBe("1.08"),
    );
    // 20000 EUR-cents × 1.08 = 21600 base cents (the stale-rate corruption
    // would read "USD 1.34").
    expect(screen.getByTestId("expense-new-input-base-amount").props.value).toBe("USD 216.00");
  });

  it("a booking link in the SAME currency preserves a latched rate (the difference-guard control arm)", async () => {
    const bookingsPage: Paginated<ReturnType<typeof makeBooking>> = {
      items: [
        makeBooking({
          id: BOOKING_ID,
          category: "restaurant",
          title: "Menya Reservation",
          price_cents: 3000,
          currency: "JPY",
        }),
      ],
      nextCursor: null,
    };
    await renderScreen(
      { expenseId: TEST_EXPENSE_ID },
      {
        overrides: {
          "GET /trips/:tripId/expenses/:expenseId": () =>
            Promise.resolve(
              makeExpense({
                amount_cents: 1500,
                currency: "JPY",
                fx_rate: "0.0067",
                base_amount_cents: 1005,
                effective_base_cents: 1005,
                shares: [
                  { user_id: ME, share_cents: 750 },
                  { user_id: B, share_cents: 750 },
                ],
              }),
            ),
          "GET /trips/:tripId/bookings": () => Promise.resolve(bookingsPage),
        },
      },
    );
    await fireEvent.press(screen.getByTestId("expense-new-button-booking-link"));
    await fireEvent.press(await screen.findByTestId(`expense-new-sheet-booking-${BOOKING_ID}`));
    await settle();

    // Same currency — the stored manual rate is still meaningful: kept.
    expect(screen.getByTestId("expense-new-input-fx-rate").props.value).toBe("0.0067");
    // Base re-derives from the NEW amount at the preserved rate:
    // 3000 JPY × 0.0067 = 2010 base cents.
    expect(screen.getByTestId("expense-new-input-base-amount").props.value).toBe("USD 20.10");
  });
});

describe("edit mode (R-cmoney-12 + the ex-member PATCH posture)", () => {
  const legacyExpense = () =>
    makeExpense({
      paid_by: C, // departed payer — NOT on the roster
      shares: [
        { user_id: C, share_cents: 1275 },
        { user_id: B, share_cents: 1275 },
      ],
    });

  it("prefills every field and opens the split in exact mode with the stored shares", async () => {
    await renderScreen(
      { expenseId: TEST_EXPENSE_ID },
      {
        overrides: {
          "GET /trips/:tripId/expenses/:expenseId": () => Promise.resolve(makeExpense()),
        },
      },
    );
    expect(screen.getByTestId("expense-new-input-description").props.value).toBe(
      "Dinner at Menya",
    );
    expect(screen.getByTestId("expense-new-input-amount").props.value).toBe("25.50");
    expect(screen.getByTestId(`expense-new-input-share-${ME}`).props.value).toBe("12.75");
    // R-cmoney-12: equal-detectable prefill shows the hint.
    expect(screen.getByTestId("expense-new-split-equal-hint")).toBeTruthy();
  });

  it("a description-only edit PATCHes ONLY the description (legacy ex-member shares ride by omission)", async () => {
    const patched: Record<string, unknown>[] = [];
    await renderScreen(
      { expenseId: TEST_EXPENSE_ID },
      {
        overrides: {
          "GET /trips/:tripId/expenses/:expenseId": () => Promise.resolve(legacyExpense()),
          "PATCH /trips/:tripId/expenses/:expenseId": (input) => {
            patched.push(input);
            return Promise.resolve(legacyExpense());
          },
        },
      },
    );
    await fireEvent.changeText(
      screen.getByTestId("expense-new-input-description"),
      "Dinner — corrected",
    );
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(patched).toHaveLength(1));
    const body = ExpenseUpdateSchema.parse(patched[0]?.["body"]);
    // EXACTLY the changed field — no shares, no paid_by (both name an
    // ex-member the server would reject on resend).
    expect(body).toEqual({ description: "Dinner — corrected" });
  });

  it("a CHANGED split still naming a former member is save-blocked with visible copy", async () => {
    await renderScreen(
      { expenseId: TEST_EXPENSE_ID },
      {
        overrides: {
          "GET /trips/:tripId/expenses/:expenseId": () => Promise.resolve(legacyExpense()),
        },
      },
    );
    // Change the split: bump B's exact share (C, the ex-member, stays in).
    await fireEvent.changeText(screen.getByTestId(`expense-new-input-share-${B}`), "13.75");
    await fireEvent.changeText(screen.getByTestId(`expense-new-input-share-${C}`), "11.75");
    expect(await screen.findByTestId("expense-new-split-former-blocked")).toBeTruthy();
    expect(screen.getByTestId("expense-new-button-save")).toBeDisabled();

    // Removing the former member clears the block (their share redistributed).
    await fireEvent.press(screen.getByTestId(`expense-new-toggle-participant-${C}`));
    await fireEvent.changeText(screen.getByTestId(`expense-new-input-share-${B}`), "25.50");
    expect(screen.queryByTestId("expense-new-split-former-blocked")).toBeNull();
    expect(screen.getByTestId("expense-new-button-save")).not.toBeDisabled();
  });

  it("a full split change PATCHes amount + replacement shares", async () => {
    const patched: Record<string, unknown>[] = [];
    await renderScreen(
      { expenseId: TEST_EXPENSE_ID },
      {
        overrides: {
          "GET /trips/:tripId/expenses/:expenseId": () => Promise.resolve(makeExpense()),
          "PATCH /trips/:tripId/expenses/:expenseId": (input) => {
            patched.push(input);
            return Promise.resolve(makeExpense({ amount_cents: 3000 }));
          },
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "30.00");
    await fireEvent.changeText(screen.getByTestId(`expense-new-input-share-${ME}`), "15.00");
    await fireEvent.changeText(screen.getByTestId(`expense-new-input-share-${B}`), "15.00");
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    await waitFor(() => expect(patched).toHaveLength(1));
    const body = ExpenseUpdateSchema.parse(patched[0]?.["body"]);
    expect(body.amount_cents).toBe(3000);
    expect(body.shares).toEqual([
      { user_id: ME, share_cents: 1500 },
      { user_id: B, share_cents: 1500 },
    ]);
  });

  it("roles: a viewer gets the CREATE form; a non-creator non-owner gets the edit lock; deleted is uneditable", async () => {
    await renderScreen({}, { role: "viewer" });
    expect(screen.getByTestId("expense-new-input-description")).toBeTruthy();
    expect(screen.queryByTestId("expense-new-forbidden")).toBeNull();

    await settle();
    jest.restoreAllMocks();
    await renderScreen(
      { expenseId: TEST_EXPENSE_ID },
      {
        role: "editor",
        overrides: {
          "GET /trips/:tripId/expenses/:expenseId": () =>
            Promise.resolve(makeExpense({ created_by: B, paid_by: B })),
        },
      },
    );
    expect(await screen.findByTestId("expense-new-forbidden")).toBeTruthy();

    await settle();
    jest.restoreAllMocks();
    await renderScreen(
      { expenseId: TEST_EXPENSE_ID },
      {
        overrides: {
          "GET /trips/:tripId/expenses/:expenseId": () =>
            Promise.resolve(
              makeExpense({ deleted_at: "2026-08-29T10:00:00.000Z", deleted_by: ME }),
            ),
        },
      },
    );
    expect(await screen.findByTestId("expense-new-uneditable")).toBeTruthy();
  });
});

describe("mutation-error feedback (the onMutationError → banner wiring)", () => {
  it("a failed create surfaces the generic banner — no silent-drop double-submit trap", async () => {
    const rejecters: ((reason: unknown) => void)[] = [];
    await renderScreen(
      {},
      {
        overrides: {
          "POST /trips/:tripId/expenses": () =>
            new Promise((_resolve, reject) => {
              rejecters.push(reject);
            }),
        },
      },
    );
    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "Snacks");
    await fireEvent.changeText(screen.getByTestId("expense-new-input-amount"), "5");
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    try {
      // Genuinely in flight first (deferred-reject — the members-screen
      // idiom), so the banner can only come from the settled rejection.
      expect(await screen.findByTestId("expense-new-button-save-spinner")).toBeTruthy();
    } finally {
      await act(async () => {
        for (const reject of rejecters) reject(new ApiRequestError(500, "INTERNAL", "boom"));
      });
    }
    expect(await screen.findByTestId("expense-new-error")).toBeTruthy();
    expect(screen.getByText("Couldn't save the expense. Try again.")).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("update failure discriminates the 409-deleted arm from the generic arm (distinct copies)", async () => {
    const rejecters: ((reason: unknown) => void)[] = [];
    await renderScreen(
      { expenseId: TEST_EXPENSE_ID },
      {
        overrides: {
          "GET /trips/:tripId/expenses/:expenseId": () => Promise.resolve(makeExpense()),
          "PATCH /trips/:tripId/expenses/:expenseId": () =>
            new Promise((_resolve, reject) => {
              rejecters.push(reject);
            }),
        },
      },
    );
    await fireEvent.changeText(
      screen.getByTestId("expense-new-input-description"),
      "Dinner — corrected",
    );

    // Generic arm: a 500 shows the retryable copy, NOT the deleted copy.
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    try {
      expect(await screen.findByTestId("expense-new-button-save-spinner")).toBeTruthy();
    } finally {
      await act(async () => {
        rejecters.shift()?.(new ApiRequestError(500, "INTERNAL", "boom"));
      });
    }
    expect(await screen.findByTestId("expense-new-error")).toBeTruthy();
    expect(screen.getByText("Couldn't save the changes. Try again.")).toBeTruthy();
    expect(screen.queryByText(/was deleted/)).toBeNull();

    // 409-deleted arm: unretryable state gets the unretryable copy.
    await fireEvent.press(screen.getByTestId("expense-new-button-save"));
    try {
      expect(await screen.findByTestId("expense-new-button-save-spinner")).toBeTruthy();
    } finally {
      await act(async () => {
        rejecters.shift()?.(new ApiRequestError(409, "CONFLICT", "expense deleted"));
      });
    }
    expect(
      await screen.findByText("This expense was deleted — it can't be edited anymore."),
    ).toBeTruthy();
    expect(screen.queryByText("Couldn't save the changes. Try again.")).toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe("dirty guard (nav §2.6)", () => {
  it("typed-then-dismiss intercepts with the discard Confirm; confirm releases the action", async () => {
    await renderScreen({});
    // Clean form dismisses freely.
    expect((await attemptDismiss()).prevented).toBe(false);

    await fireEvent.changeText(screen.getByTestId("expense-new-input-description"), "d");
    const { prevented } = await attemptDismiss();
    expect(prevented).toBe(true);

    await fireEvent.press(await screen.findByTestId("expense-new-button-cancel-confirm"));
    expect(mockDispatch).toHaveBeenCalledWith({ type: "POP" });
  });
});
