/**
 * Expense detail (T-9.6 / CMON-2 — R-cmoney-13) over the REAL data hooks,
 * network mocked by descriptor, fixtures wire-schema-valid.
 *
 * Pins: amount/category/payer/date + the full §2.8 shares breakdown
 * (`expense-detail-list-item-share-{userId}`); creator-or-owner gating of
 * edit/delete (creator arm + non-creator control); ConfirmDialog-gated E5
 * delete → back(); the DELETED audit state (banner copy from the wire's
 * audit pair, actions gone); the booking link's sanctioned cross-tab jump
 * (tab navigator first, THEN the push — the MapPlaceSheet convention);
 * missing/malformed id and load-error arms.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import ExpenseDetailScreen from "@/app/[tripId]/money/expense/[expenseId]";
import { ApiRequestError } from "@/auth";
import { jumpToTripTab } from "@/navigation/tab-jump";
import { TripProvider } from "@/navigation/trip-context";
import { MEMBER_B_ID, TEST_TRIP_ID } from "@/test-utils/ids";
import { makeExpense, TEST_EXPENSE_ID } from "@/test-utils/money-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import { makeMember, makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
jest.mock("@/navigation/tab-jump", () => ({ jumpToTripTab: jest.fn(() => true) }));

const mockPush = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = {};

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
    replace: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
}));

const B = MEMBER_B_ID;
const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

type Responder = (input: Record<string, unknown>) => Promise<unknown>;

async function renderScreen(
  params: Record<string, string>,
  opts?: { overrides?: Record<string, Responder>; role?: "owner" | "editor" | "viewer" },
) {
  mockParams = { tripId: TEST_TRIP_ID, expenseId: TEST_EXPENSE_ID, ...params };
  seedAuthenticated();
  const trip = makeTrip({ id: TEST_TRIP_ID, role: opts?.role ?? "owner" });
  const request = mockNavApi({
    trips: [trip],
    members: [
      makeMember(),
      makeMember({ user: { id: B, display_name: "Blair" }, role: "editor" }),
    ],
    overrides: {
      "GET /trips/:tripId/expenses/:expenseId": () => Promise.resolve(makeExpense()),
      ...opts?.overrides,
    },
  });
  await renderWithProviders(
    <TripProvider trip={trip}>
      <ExpenseDetailScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  await settle();
  return { request, trip };
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockPush.mockReset();
  mockBack.mockReset();
  (jumpToTripTab as jest.Mock).mockClear();
  mockParams = {};
});

it("renders amount, category, payer, date, and the per-member shares breakdown (§2.8 ids)", async () => {
  await renderScreen({});
  expect(screen.getByTestId("expense-detail-screen")).toBeTruthy();
  // Shared-formatter money copy only (Law #2).
  expect(screen.getByText("USD 25.50")).toBeTruthy();
  expect(screen.getByText("Dinner at Menya")).toBeTruthy();
  expect(screen.getByText("Food")).toBeTruthy();
  expect(screen.getByText(/Paid by You/)).toBeTruthy();
  expect(screen.getByTestId(`expense-detail-list-item-share-${TEST_USER.id}`)).toBeTruthy();
  expect(screen.getByTestId(`expense-detail-list-item-share-${B}`)).toBeTruthy();
  expect(screen.getAllByText("USD 12.75")).toHaveLength(2);
});

it("delete: ConfirmDialog gates the E5 call; success navigates back", async () => {
  const deletes: Record<string, unknown>[] = [];
  await renderScreen(
    {},
    {
      overrides: {
        "DELETE /trips/:tripId/expenses/:expenseId": (input) => {
          deletes.push(input);
          return Promise.resolve(undefined);
        },
      },
    },
  );
  await fireEvent.press(screen.getByTestId("expense-detail-button-delete"));
  // Nothing fired yet — the dialog is the gate.
  expect(deletes).toHaveLength(0);
  await fireEvent.press(await screen.findByTestId("expense-detail-button-delete-confirm"));
  await waitFor(() => expect(deletes).toHaveLength(1));
  expect(deletes[0]?.["params"]).toEqual({
    tripId: TEST_TRIP_ID,
    expenseId: TEST_EXPENSE_ID,
  });
  expect(mockBack).toHaveBeenCalled();
});

it("a failed delete surfaces the dismissible error banner and stays put (no silent drop)", async () => {
  const rejecters: ((reason: unknown) => void)[] = [];
  await renderScreen(
    {},
    {
      overrides: {
        "DELETE /trips/:tripId/expenses/:expenseId": () =>
          new Promise((_resolve, reject) => {
            rejecters.push(reject);
          }),
      },
    },
  );
  await fireEvent.press(screen.getByTestId("expense-detail-button-delete"));
  await fireEvent.press(await screen.findByTestId("expense-detail-button-delete-confirm"));
  await act(async () => {
    for (const reject of rejecters) reject(new ApiRequestError(500, "INTERNAL", "boom"));
  });
  const banner = await screen.findByTestId("expense-detail-delete-error");
  expect(banner).toBeTruthy();
  expect(screen.getByText("Couldn't delete the expense. Try again.")).toBeTruthy();
  // Failure never navigates — the record is still on screen for retry.
  expect(mockBack).not.toHaveBeenCalled();
  expect(screen.getByText("Dinner at Menya")).toBeTruthy();
});

it("cancel keeps the expense: dialog dismissed, no E5 call (control arm)", async () => {
  const deletes: Record<string, unknown>[] = [];
  await renderScreen(
    {},
    {
      overrides: {
        "DELETE /trips/:tripId/expenses/:expenseId": (input) => {
          deletes.push(input);
          return Promise.resolve(undefined);
        },
      },
    },
  );
  await fireEvent.press(screen.getByTestId("expense-detail-button-delete"));
  await fireEvent.press(await screen.findByTestId("expense-detail-button-delete-cancel"));
  await settle();
  expect(deletes).toHaveLength(0);
  expect(mockBack).not.toHaveBeenCalled();
});

it("a soft-deleted expense renders the audit state — banner copy, no edit/delete", async () => {
  await renderScreen(
    {},
    {
      overrides: {
        "GET /trips/:tripId/expenses/:expenseId": () =>
          Promise.resolve(
            makeExpense({ deleted_at: "2026-08-29T10:00:00.000Z", deleted_by: B }),
          ),
      },
    },
  );
  const banner = await screen.findByTestId("expense-detail-deleted");
  expect(banner).toBeTruthy();
  expect(
    screen.getByText(/Blair deleted "Dinner at Menya \(USD 25\.50\)"/),
  ).toBeTruthy();
  expect(screen.queryByTestId("expense-detail-button-edit")).toBeNull();
  expect(screen.queryByTestId("expense-detail-button-delete")).toBeNull();
});

it("authz: creator sees edit/delete; a non-creator editor does not (owner override does)", async () => {
  // Creator arm (caller created the fixture expense).
  await renderScreen({});
  expect(screen.getByTestId("expense-detail-button-edit")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("expense-detail-button-edit"));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: "/[tripId]/money/expense/new",
    params: { tripId: TEST_TRIP_ID, expenseId: TEST_EXPENSE_ID },
  });

  // Non-creator, non-owner: actions gone.
  await settle();
  jest.restoreAllMocks();
  await renderScreen(
    {},
    {
      role: "editor",
      overrides: {
        "GET /trips/:tripId/expenses/:expenseId": () =>
          Promise.resolve(makeExpense({ created_by: B, paid_by: B })),
      },
    },
  );
  await screen.findByText(/Paid by Blair/);
  expect(screen.queryByTestId("expense-detail-button-edit")).toBeNull();
  expect(screen.queryByTestId("expense-detail-button-delete")).toBeNull();

  // Owner dispute-breaker: someone else's expense, actions present.
  await settle();
  jest.restoreAllMocks();
  await renderScreen(
    {},
    {
      role: "owner",
      overrides: {
        "GET /trips/:tripId/expenses/:expenseId": () =>
          Promise.resolve(makeExpense({ created_by: B, paid_by: B })),
      },
    },
  );
  await screen.findByText(/Paid by Blair/);
  expect(screen.getByTestId("expense-detail-button-edit")).toBeTruthy();
  expect(screen.getByTestId("expense-detail-button-delete")).toBeTruthy();
});

it("the linked booking jumps the TAB NAVIGATOR first, then pushes booking detail (cross-tab landmine)", async () => {
  await renderScreen(
    {},
    {
      overrides: {
        "GET /trips/:tripId/expenses/:expenseId": () =>
          Promise.resolve(makeExpense({ booking_id: BOOKING_ID })),
      },
    },
  );
  await fireEvent.press(await screen.findByTestId("expense-detail-button-booking"));
  expect(jumpToTripTab).toHaveBeenCalledWith(expect.anything(), TEST_TRIP_ID, "itinerary");
  expect(mockPush).toHaveBeenCalledWith({
    pathname: "/[tripId]/itinerary/booking/[bookingId]",
    params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_ID },
  });
});

it("no booking linked → no booking button (control arm)", async () => {
  await renderScreen({});
  expect(screen.queryByTestId("expense-detail-button-booking")).toBeNull();
});

it("malformed id renders the gone state; a failed load shows the error banner with retry recovery", async () => {
  await renderScreen({ expenseId: "not-a-uuid" });
  expect(screen.getByTestId("expense-detail-missing")).toBeTruthy();

  await settle();
  jest.restoreAllMocks();
  let calls = 0;
  await renderScreen(
    {},
    {
      overrides: {
        "GET /trips/:tripId/expenses/:expenseId": () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new ApiRequestError(500, "INTERNAL", "boom"))
            : Promise.resolve(makeExpense());
        },
      },
    },
  );
  expect(await screen.findByTestId("expense-detail-error")).toBeTruthy();
  await fireEvent.press(screen.getByTestId("expense-detail-error-retry"));
  await settle();
  expect(await screen.findByText("Dinner at Menya")).toBeTruthy();
});
