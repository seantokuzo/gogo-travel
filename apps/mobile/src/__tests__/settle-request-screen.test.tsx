/**
 * Settle-request recipient screen (T-9.7 / CMON-6 — R-cmoney-26/27, §2.7
 * step 4). Component-level over the REAL data hooks, network mocked at the
 * descriptor boundary, fixtures wire-schema-validated.
 *
 * Pins: the debtor view's inline rail machinery off the REQUESTER's
 * member-visible handles (§2.8 `settle-request-*` ids) with pay-through
 * linking `request_id` (R-money-18) — including via the return prompt's
 * stash; the S1 409 arm surfacing SPECIFIC copy + refetching the detail
 * (state machine truth, not a generic banner); the creditor's own-request
 * view with ConfirmDialog-guarded cancel (Q3) and ITS 409 arm; the
 * uninvolved-member read-only view (party rule); resolved states —
 * settled-with-lookup ("who settled, when" from S2), cancelled, and
 * derived-resolved — rendering NO pay buttons; unknown id → EmptyState
 * with a path back to the money tab (R-cmoney-26, registry row).
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Linking from "expo-linking";

import { ApiRequestError } from "@/auth";
import { RequestContent } from "@/features/money/RequestContent";
import {
  clearSettleReturnRecord,
  consumePendingSettleReturn,
  recordSettleDeeplinkOut,
} from "@/features/money/settle-return-store";
import { MEMBER_B_ID, MEMBER_C_ID, TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import {
  makeSettleRequestDetail,
  makeSettlement,
  settleApiOverrides,
  TEST_REQUEST_ID,
  TEST_SETTLEMENT_ID,
} from "@/test-utils/settle-fixtures";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import { makeMember, makeTrip, makeUserProfile, mockNavApi } from "@/test-utils/trip-fixtures";

import type { SettleRequestDetail, TripListItem } from "@gogo/shared";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
jest.mock("expo-linking", () => ({
  canOpenURL: jest.fn(async () => true),
  openURL: jest.fn(async () => true),
}));
jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: mockReplace,
    back: jest.fn(),
    setParams: jest.fn(),
  }),
  useLocalSearchParams: () => ({}),
}));

const openURLMock = Linking.openURL as jest.Mock;

async function renderRequest(opts?: {
  trip?: TripListItem;
  detail?: SettleRequestDetail | ((input: Record<string, unknown>) => Promise<unknown>);
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
  settlements?: ReturnType<typeof makeSettlement>[];
}) {
  seedAuthenticated();
  const trip = opts?.trip ?? makeTrip({ id: TEST_TRIP_ID });
  const detail = opts?.detail;
  const request = mockNavApi({
    trips: [trip],
    members: [
      makeMember(),
      makeMember({ user: { id: MEMBER_B_ID, display_name: "Blair" }, role: "editor" }),
    ],
    overrides: {
      ...settleApiOverrides({
        ...(detail !== undefined
          ? { requestDetail: typeof detail === "function" ? detail : () => Promise.resolve(detail) }
          : {}),
        ...(opts?.settlements !== undefined ? { settlements: opts.settlements } : {}),
      }),
      ...opts?.overrides,
    },
  });
  const view = await renderWithProviders(
    <RequestContent trip={trip} requestId={TEST_REQUEST_ID} />,
    { queryClient: makeTestQueryClient() },
  );
  await settle();
  return { request, trip, view };
}

function settlementPosts(request: jest.Mock): Record<string, unknown>[] {
  return request.mock.calls
    .filter(([d]) => (d as { path: string }).path === "/trips/:tripId/settlements")
    .map(([, input]) => (input as { body: Record<string, unknown> }).body);
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockReplace.mockReset();
  openURLMock.mockReset().mockResolvedValue(true);
  clearSettleReturnRecord();
});

describe("debtor view (R-cmoney-26 — the recipient pays)", () => {
  it("headline + note + the requester's rails inline with §2.8 ids", async () => {
    await renderRequest({ detail: makeSettleRequestDetail({ note: "for the hostel" }) });
    expect(screen.getByTestId("settle-request-screen")).toBeTruthy();
    expect(screen.getByText("Blair requests USD 25.50")).toBeTruthy();
    expect(screen.getByText("for the hostel")).toBeTruthy();
    for (const id of [
      "settle-request-button-venmo",
      "settle-request-button-cashapp",
      "settle-request-button-paypal",
      "settle-request-button-zelle-copy",
      "settle-request-button-mark-settled",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    // No creditor/observer affordances leak in.
    expect(screen.queryByTestId("settle-request-button-cancel")).toBeNull();
  });

  it("pay-through links the request: mark-as-settled POSTs request_id + the request pair", async () => {
    const { request } = await renderRequest();
    await fireEvent.press(screen.getByTestId("settle-request-button-mark-settled"));
    await screen.findByTestId("settle-request-sheet-mark-settled");
    await fireEvent.press(screen.getByTestId("settle-request-sheet-mark-settled-confirm"));
    await settle();
    expect(settlementPosts(request)).toEqual([
      {
        from_user_id: TEST_USER.id,
        to_user_id: MEMBER_B_ID,
        amount_cents: 2550,
        currency: "USD",
        method: "cash",
        request_id: TEST_REQUEST_ID,
      },
    ]);
  });

  it("a rail tap stashes WITH the requestId; the return-prompt confirm rides the linkage", async () => {
    const { view, request } = await renderRequest();
    await fireEvent.press(screen.getByTestId("settle-request-button-venmo"));
    await settle();
    // Stash carries the linkage…
    await view.unmount();
    await settle();
    // …and the next mount's prompt posts it (fresh render = the return).
    const second = await renderRequest();
    expect(await screen.findByTestId("settle-request-sheet-return")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("settle-request-sheet-return-confirm"));
    await settle();
    // ONE post total across both mounts (`request` and `second.request`
    // alias the same apiClient spy): the confirm — nothing posted at rail
    // tap time.
    expect(settlementPosts(second.request)).toEqual([
      {
        from_user_id: TEST_USER.id,
        to_user_id: MEMBER_B_ID,
        amount_cents: 2550,
        currency: "USD",
        method: "venmo",
        request_id: TEST_REQUEST_ID,
      },
    ]);
    expect(request).toBe(second.request);
  });

  it("a stash from ANOTHER trip is dropped silently — no prompt, nothing posts (cross-trip guard)", async () => {
    // R1 correctness (probe-proven inverted): a rail tap that left from trip
    // B must never post through THIS trip's request screen — wrong trip,
    // wrong currency, and (if linked) a foreign requestId.
    recordSettleDeeplinkOut({
      tripId: TRIP_B_ID,
      counterpartyId: MEMBER_C_ID,
      method: "paypal",
      amountCents: 9999,
    });
    const { request } = await renderRequest();
    expect(screen.queryByTestId("settle-request-sheet-return")).toBeNull();
    expect(settlementPosts(request)).toEqual([]);
    // Dropped, never re-stashed: the consume-once slot is empty.
    expect(consumePendingSettleReturn()).toBeNull();
  });

  it("the S1 409 arm gets SPECIFIC copy and refetches the detail (state-machine truth)", async () => {
    let detailReads = 0;
    const { request } = await renderRequest({
      detail: () => {
        detailReads += 1;
        return Promise.resolve(makeSettleRequestDetail());
      },
      overrides: {
        "POST /trips/:tripId/settlements": () =>
          Promise.reject(new ApiRequestError(409, "CONFLICT", "request is not open")),
      },
    });
    const readsBefore = detailReads;
    await fireEvent.press(screen.getByTestId("settle-request-button-mark-settled"));
    await screen.findByTestId("settle-request-sheet-mark-settled");
    await fireEvent.press(screen.getByTestId("settle-request-sheet-mark-settled-confirm"));
    await settle();
    expect(settlementPosts(request)).toHaveLength(1);
    // The copy renders on BOTH surfaces (screen banner + sheet banner) —
    // target the sheet's, then confirm the plural.
    expect(await screen.findByTestId("settle-request-sheet-mark-settled-error")).toBeTruthy();
    expect(
      screen.getAllByText(/already settled or cancelled — the screen has been refreshed/).length,
    ).toBeGreaterThanOrEqual(1);
    await waitFor(() => expect(detailReads).toBeGreaterThan(readsBefore));
  });
});

describe("creditor view (own request)", () => {
  const ownRequest = () =>
    makeSettleRequestDetail({
      from_user_id: MEMBER_B_ID,
      to_user_id: TEST_USER.id,
      created_by: TEST_USER.id,
      requester: makeUserProfile(),
    });

  it("shows the outbound framing and cancels via ConfirmDialog → Q3 DELETE", async () => {
    const { request } = await renderRequest({ detail: ownRequest() });
    expect(screen.getByText("You requested USD 25.50 from Blair")).toBeTruthy();
    // No pay machinery on your own bill.
    expect(screen.queryByTestId("settle-request-button-venmo")).toBeNull();
    expect(screen.queryByTestId("settle-request-button-mark-settled")).toBeNull();

    await fireEvent.press(screen.getByTestId("settle-request-button-cancel"));
    await screen.findByTestId("settle-request-dialog-cancel");
    // Dialog cancel arm first (control): nothing deleted.
    await fireEvent.press(screen.getByTestId("settle-request-dialog-cancel-cancel"));
    await settle();
    const deletes = () =>
      request.mock.calls.filter(
        ([d, input]) =>
          (d as { method: string; path: string }).method === "DELETE" &&
          (d as { path: string }).path === "/trips/:tripId/settle-requests/:requestId" &&
          (input as { params: { requestId: string } }).params.requestId === TEST_REQUEST_ID,
      );
    expect(deletes()).toHaveLength(0);

    await fireEvent.press(screen.getByTestId("settle-request-button-cancel"));
    await fireEvent.press(await screen.findByTestId("settle-request-dialog-cancel-confirm"));
    await settle();
    expect(deletes()).toHaveLength(1);
  });

  it("a 409 cancel (request moved elsewhere) surfaces specific copy", async () => {
    await renderRequest({
      detail: ownRequest(),
      overrides: {
        "DELETE /trips/:tripId/settle-requests/:requestId": () =>
          Promise.reject(new ApiRequestError(409, "CONFLICT", "not open")),
      },
    });
    await fireEvent.press(screen.getByTestId("settle-request-button-cancel"));
    await fireEvent.press(await screen.findByTestId("settle-request-dialog-cancel-confirm"));
    await settle();
    expect(
      await screen.findByText(/already moved — it was settled or cancelled elsewhere/),
    ).toBeTruthy();
  });
});

describe("uninvolved member (party rule — read-only)", () => {
  it("renders a summary with zero action affordances", async () => {
    await renderRequest({
      detail: makeSettleRequestDetail({
        from_user_id: MEMBER_C_ID,
        to_user_id: MEMBER_B_ID,
        created_by: MEMBER_B_ID,
      }),
    });
    expect(screen.getByTestId("settle-request-observer")).toBeTruthy();
    expect(screen.queryByTestId("settle-request-button-venmo")).toBeNull();
    expect(screen.queryByTestId("settle-request-button-mark-settled")).toBeNull();
    expect(screen.queryByTestId("settle-request-button-cancel")).toBeNull();
  });
});

describe("resolved states (R-cmoney-26 — no pay buttons)", () => {
  it("settled with a linked settlement names who settled and when (S2 lookup)", async () => {
    await renderRequest({
      detail: makeSettleRequestDetail({
        status: "settled",
        resolved: true,
        settlement_id: TEST_SETTLEMENT_ID,
      }),
      settlements: [
        makeSettlement({
          created_by: MEMBER_B_ID,
          settled_at: "2026-08-23T10:00:00.000Z",
        }),
      ],
    });
    expect(await screen.findByTestId("settle-request-resolved")).toBeTruthy();
    expect(screen.getByText(/Settled by Blair on/)).toBeTruthy();
    expect(screen.queryByTestId("settle-request-button-venmo")).toBeNull();
    expect(screen.queryByTestId("settle-request-button-mark-settled")).toBeNull();
  });

  it("cancelled renders the cancelled line; derived-resolved renders the cleared line", async () => {
    const first = await renderRequest({
      detail: makeSettleRequestDetail({ status: "cancelled", resolved: false }),
    });
    expect(screen.getByText("This request was cancelled.")).toBeTruthy();
    expect(screen.queryByTestId("settle-request-button-mark-settled")).toBeNull();
    await first.view.unmount();
    await settle();

    // status 'open' but resolved (debt cleared another way — R-money-18).
    await renderRequest({
      detail: makeSettleRequestDetail({ status: "open", resolved: true }),
    });
    expect(screen.getByText(/Already settled up/)).toBeTruthy();
    expect(screen.queryByTestId("settle-request-button-venmo")).toBeNull();
  });
});

describe("unknown id / load failure (R-cmoney-26, §2.9)", () => {
  it("404 → EmptyState with a path back to the money tab (unknown ≡ non-member)", async () => {
    const { trip } = await renderRequest({
      detail: () => Promise.reject(new ApiRequestError(404, "NOT_FOUND", "not found")),
    });
    expect(await screen.findByTestId("settle-request-empty")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("settle-request-button-back"));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: "/[tripId]/money",
      params: { tripId: trip.id },
    });
  });

  it("non-404 failure → error banner with retry (recovers to the real document)", async () => {
    let calls = 0;
    await renderRequest({
      detail: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ApiRequestError(500, "INTERNAL", "boom"))
          : Promise.resolve(makeSettleRequestDetail());
      },
    });
    const banner = await screen.findByTestId("settle-request-error");
    expect(banner).toBeTruthy();
    await fireEvent.press(screen.getByText("Retry"));
    await settle();
    expect(await screen.findByText("Blair requests USD 25.50")).toBeTruthy();
  });
});
