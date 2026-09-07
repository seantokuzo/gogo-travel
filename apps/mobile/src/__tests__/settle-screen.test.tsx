/**
 * Settle screen (T-9.7 / CMON-5 — R-cmoney-14..24, §2.6). Component-level
 * over the REAL data hooks with the network mocked at the descriptor
 * boundary; fixtures wire-schema-validated (settle-fixtures parses through
 * the shared schemas, so server contract drift goes RED here).
 *
 * Pins: pairwise headline both directions + prefilled/editable amount with
 * the non-blocking over-payment warning (R-cmoney-14); handoff Sheet rails
 * per counterparty handles with venmo canOpenURL scheme/web arms
 * (R-cmoney-15/16) at the §2.5 URL byte-exact; the stash-before-open order
 * + open-failure rollback keeping the screen usable (R-cmoney-21/22);
 * Zelle copy → clipboard (R-cmoney-19); mark-as-settled S1 bodies BOTH
 * directions (R-cmoney-20/23, R-money-12); non-USD rail gating w/ USD
 * control (R-cmoney-18); zero-handle hint (R-cmoney-15); the send-the-bill
 * share composition off the SHARED link template (R-cmoney-25, W2 ruling);
 * the return prompt presenting once and posting the STASHED shape.
 */
import { settleRequestDeepLink } from "@gogo/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Linking from "expo-linking";
import { Share } from "react-native";

import { ApiRequestError } from "@/auth";
import { SettleContent } from "@/features/money/SettleContent";
import {
  clearSettleReturnRecord,
  consumePendingSettleReturn,
  recordSettleDeeplinkOut,
} from "@/features/money/settle-return-store";
import { MEMBER_B_ID, MEMBER_C_ID, TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";
import {
  makeBalancesRead,
  makeSettledBalancesRead,
  makeSettleRequest,
} from "@/test-utils/money-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import {
  settleApiOverrides,
  makeHandlesProfile,
  TEST_REQUEST_ID,
} from "@/test-utils/settle-fixtures";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import { makeMember, makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

import type { BalancesRead, TripListItem, UserProfile } from "@gogo/shared";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
jest.mock("expo-linking", () => ({
  canOpenURL: jest.fn(async () => true),
  openURL: jest.fn(async () => true),
}));
jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));
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

const canOpenURLMock = Linking.canOpenURL as jest.Mock;
const openURLMock = Linking.openURL as jest.Mock;
const Clipboard = jest.requireMock("expo-clipboard") as { setStringAsync: jest.Mock };

/** Caller OWES Blair 2550 (debtor view) — the makeBalancesRead default is
 * the creditor direction, so this reverses the pair's sign. */
function debtorBalances(): BalancesRead {
  return makeBalancesRead({
    members: [
      { user_id: TEST_USER.id, net_cents: -2550 },
      { user_id: MEMBER_B_ID, net_cents: 2550 },
    ],
    pairwise: [
      { trip_id: TEST_TRIP_ID, user_id: TEST_USER.id, counterparty_id: MEMBER_B_ID, net_cents: -2550 },
    ],
    simplified: [{ from_user_id: TEST_USER.id, to_user_id: MEMBER_B_ID, amount_cents: 2550 }],
  });
}

async function renderSettle(opts?: {
  trip?: TripListItem;
  balances?: BalancesRead;
  memberId?: string;
  counterparty?: Partial<UserProfile>;
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
}) {
  seedAuthenticated();
  const trip = opts?.trip ?? makeTrip({ id: TEST_TRIP_ID });
  const request = mockNavApi({
    trips: [trip],
    members: [
      makeMember(),
      makeMember({ user: { ...makeHandlesProfile(opts?.counterparty) }, role: "editor" }),
    ],
    overrides: {
      "GET /trips/:tripId/balances": () =>
        Promise.resolve(opts?.balances ?? debtorBalances()),
      ...settleApiOverrides(),
      ...opts?.overrides,
    },
  });
  const view = await renderWithProviders(
    <SettleContent trip={trip} memberId={opts?.memberId ?? MEMBER_B_ID} />,
    { queryClient: makeTestQueryClient() },
  );
  await settle();
  return { request, trip, view };
}

/** The S1 POST bodies the mocked network received. */
function settlementPosts(request: jest.Mock): Record<string, unknown>[] {
  return request.mock.calls
    .filter(([d]) => (d as { path: string }).path === "/trips/:tripId/settlements")
    .map(([, input]) => (input as { body: Record<string, unknown> }).body);
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockPush.mockReset();
  canOpenURLMock.mockReset().mockResolvedValue(true);
  openURLMock.mockReset().mockResolvedValue(true);
  Clipboard.setStringAsync.mockReset().mockResolvedValue(true);
  clearSettleReturnRecord();
});

describe("headline + amount (R-cmoney-14)", () => {
  it("debtor: 'You owe' headline; amount prefilled to the full owed amount, editable", async () => {
    await renderSettle();
    expect(screen.getByText("You owe Blair USD 25.50")).toBeTruthy();
    const amount = screen.getByTestId("settle-input-amount");
    expect(amount.props.value).toBe("25.50");
    await fireEvent.changeText(amount, "10");
    expect(screen.getByTestId("settle-input-amount").props.value).toBe("10");
  });

  it("creditor: 'owes you' headline", async () => {
    await renderSettle({ balances: makeBalancesRead() });
    expect(screen.getByText("Blair owes you USD 25.50")).toBeTruthy();
  });

  it("even pair (net 0): 'all settled up' headline; mark-as-settled stays reachable (R-cmoney-20)", async () => {
    await renderSettle({ balances: makeSettledBalancesRead() });
    expect(screen.getByText("You're all settled up with Blair")).toBeTruthy();
    // R-cmoney-20 unconditional: enter an amount, settle up → the handoff
    // sheet still carries mark-as-settled (framed caller → counterparty).
    await fireEvent.changeText(screen.getByTestId("settle-input-amount"), "5");
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await screen.findByTestId("settle-sheet-handoff");
    expect(screen.getByTestId("settle-button-mark-settled")).toBeTruthy();
  });

  it("a value above the owed amount warns without blocking (partial settles legal)", async () => {
    await renderSettle();
    await fireEvent.changeText(screen.getByTestId("settle-input-amount"), "99.99");
    expect(screen.getByText(/More than the USD 25.50 owed/)).toBeTruthy();
    // Non-blocking: settle-up still enabled → the handoff sheet opens.
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    expect(await screen.findByTestId("settle-sheet-handoff")).toBeTruthy();
    // Control: an owed-or-below amount shows no warning.
    await fireEvent.changeText(screen.getByTestId("settle-input-amount"), "10");
    expect(screen.queryByText(/More than the/)).toBeNull();
  });
});

describe("handoff rails (R-cmoney-15..19, §2.5)", () => {
  it("renders one button per handle Blair has — §2.8 ids — plus mark-as-settled last", async () => {
    await renderSettle();
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await screen.findByTestId("settle-sheet-handoff");
    for (const id of [
      "settle-button-venmo",
      "settle-button-cashapp",
      "settle-button-paypal",
      "settle-button-zelle-copy",
      "settle-button-mark-settled",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it("venmo: canOpenURL true → app scheme opens with the §2.5 URL; stash recorded first", async () => {
    await renderSettle();
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await fireEvent.press(await screen.findByTestId("settle-button-venmo"));
    await settle();
    expect(openURLMock).toHaveBeenCalledWith(
      "venmo://paycharge?txn=pay&recipients=blair-v&amount=25.50&note=GoGo%3A%20Kyoto",
    );
    // The stash landed (present-once consume proves it, and rolls it up).
    const record = consumePendingSettleReturn();
    expect(record).toMatchObject({
      tripId: TEST_TRIP_ID,
      counterpartyId: MEMBER_B_ID,
      method: "venmo",
      amountCents: 2550,
    });
  });

  it("venmo: canOpenURL false → the probed web fallback opens (button rendered either way)", async () => {
    canOpenURLMock.mockResolvedValue(false);
    await renderSettle();
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await fireEvent.press(await screen.findByTestId("settle-button-venmo"));
    await settle();
    expect(openURLMock).toHaveBeenCalledWith(
      "https://account.venmo.com/pay?txn=pay&recipients=blair-v&amount=25.50&note=GoGo%3A%20Kyoto",
    );
  });

  it("venmo: a THROWING canOpenURL folds to the probed web URL (Android no-<queries> arm)", async () => {
    // R-cmoney-16's fallback arm covers a canOpenURL that REJECTS (Android
    // with no <queries> manifest entry) — the rail must open the web URL,
    // not die in the outer catch.
    canOpenURLMock.mockRejectedValue(new Error("Unable to query scheme"));
    await renderSettle();
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await fireEvent.press(await screen.findByTestId("settle-button-venmo"));
    await settle();
    expect(openURLMock).toHaveBeenCalledWith(
      "https://account.venmo.com/pay?txn=pay&recipients=blair-v&amount=25.50&note=GoGo%3A%20Kyoto",
    );
    expect(screen.queryByTestId("settle-handoff-error")).toBeNull();
  });

  it("rail open failure: stash rolled back, non-blocking error, screen fully usable (R-cmoney-22)", async () => {
    openURLMock.mockRejectedValue(new Error("no handler"));
    await renderSettle();
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await fireEvent.press(await screen.findByTestId("settle-button-cashapp"));
    await settle();
    // Rollback: no phantom return prompt for a payment that never started.
    expect(consumePendingSettleReturn()).toBeNull();
    expect(screen.getByTestId("settle-handoff-error")).toBeTruthy();
    // Usable: mark-as-settled still opens its sheet.
    await fireEvent.press(screen.getByTestId("settle-button-mark-settled"));
    expect(await screen.findByTestId("settle-sheet-mark-settled")).toBeTruthy();
  });

  it("zelle copy: handle to the clipboard + Copied state (R-cmoney-19 — no link ever opens)", async () => {
    await renderSettle();
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await fireEvent.press(await screen.findByTestId("settle-button-zelle-copy"));
    await settle();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("blair@example.com");
    expect(screen.getByText("Copied")).toBeTruthy();
    expect(openURLMock).not.toHaveBeenCalled();
  });

  it("non-USD trip: venmo/cashapp/zelle hidden; PayPal + mark-as-settled remain (R-cmoney-18)", async () => {
    const eurTrip = makeTrip({ id: TEST_TRIP_ID, base_currency: "EUR" });
    await renderSettle({
      trip: eurTrip,
      balances: { ...debtorBalances(), currency: "EUR" },
    });
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await screen.findByTestId("settle-sheet-handoff");
    expect(screen.queryByTestId("settle-button-venmo")).toBeNull();
    expect(screen.queryByTestId("settle-button-cashapp")).toBeNull();
    expect(screen.queryByTestId("settle-button-zelle-copy")).toBeNull();
    expect(screen.getByTestId("settle-button-paypal")).toBeTruthy();
    expect(screen.getByTestId("settle-button-mark-settled")).toBeTruthy();
  });

  it("zero handles: hint + mark-as-settled only — no disabled stubs (R-cmoney-15)", async () => {
    await renderSettle({
      counterparty: {
        venmo_username: null,
        cashtag: null,
        paypalme_username: null,
        zelle_handle: null,
        zelle_display_name: null,
      },
    });
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await screen.findByTestId("settle-sheet-handoff");
    expect(screen.getByTestId("settle-handoff-no-handles")).toBeTruthy();
    expect(screen.queryByTestId("settle-button-venmo")).toBeNull();
    expect(screen.queryByTestId("settle-button-paypal")).toBeNull();
    expect(screen.getByTestId("settle-button-mark-settled")).toBeTruthy();
  });
});

describe("mark as settled (R-cmoney-20/23; R-money-12/13)", () => {
  it("debtor records caller → counterparty with the edited amount, picked method, and note", async () => {
    const { request } = await renderSettle();
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await fireEvent.press(await screen.findByTestId("settle-button-mark-settled"));
    await screen.findByTestId("settle-sheet-mark-settled");

    await fireEvent.changeText(
      screen.getByTestId("settle-sheet-mark-settled-input-amount"),
      "20.00",
    );
    await fireEvent.press(screen.getByTestId("settle-picker-method-venmo"));
    await fireEvent.changeText(
      screen.getByTestId("settle-sheet-mark-settled-input-note"),
      "dinner",
    );
    await fireEvent.press(screen.getByTestId("settle-sheet-mark-settled-confirm"));
    await settle();

    expect(settlementPosts(request)).toEqual([
      {
        from_user_id: TEST_USER.id,
        to_user_id: MEMBER_B_ID,
        amount_cents: 2000,
        currency: "USD",
        method: "venmo",
        note: "dinner",
      },
    ]);
  });

  it("creditor 'Mark as settled' records money RECEIVED: counterparty → caller, default cash", async () => {
    const { request } = await renderSettle({ balances: makeBalancesRead() });
    expect(screen.queryByTestId("settle-button-settle-up")).toBeNull();
    await fireEvent.press(screen.getByTestId("settle-button-mark-settled"));
    await screen.findByTestId("settle-sheet-mark-settled");
    await fireEvent.press(screen.getByTestId("settle-sheet-mark-settled-confirm"));
    await settle();

    expect(settlementPosts(request)).toEqual([
      {
        from_user_id: MEMBER_B_ID,
        to_user_id: TEST_USER.id,
        amount_cents: 2550,
        currency: "USD",
        method: "cash",
      },
    ]);
  });

  it("invalid amount blocks confirm; POST failure surfaces inline and the sheet stays usable", async () => {
    const { request } = await renderSettle({
      overrides: {
        "POST /trips/:tripId/settlements": () => Promise.reject(new Error("boom")),
      },
    });
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await fireEvent.press(await screen.findByTestId("settle-button-mark-settled"));
    await screen.findByTestId("settle-sheet-mark-settled");

    // Invalid text: parser error shown, confirm inert.
    await fireEvent.changeText(
      screen.getByTestId("settle-sheet-mark-settled-input-amount"),
      "25.505",
    );
    await fireEvent.press(screen.getByTestId("settle-sheet-mark-settled-confirm"));
    await settle();
    expect(settlementPosts(request)).toEqual([]);

    // Valid amount, failing POST: inline error, sheet still open.
    await fireEvent.changeText(
      screen.getByTestId("settle-sheet-mark-settled-input-amount"),
      "25.50",
    );
    await fireEvent.press(screen.getByTestId("settle-sheet-mark-settled-confirm"));
    await settle();
    expect(await screen.findByTestId("settle-sheet-mark-settled-error")).toBeTruthy();
    expect(screen.getByTestId("settle-sheet-mark-settled")).toBeTruthy();
  });
});

describe("send the bill (R-cmoney-25, §2.7 steps 2–3; the W2 link ruling)", () => {
  it("creditor request: POSTs the explicit amount + note, then shares gogo:// primary + https form off the SHARED template", async () => {
    const shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
    const minted = makeSettleRequest();
    const { request } = await renderSettle({
      balances: makeBalancesRead(),
      overrides: {
        "POST /trips/:tripId/settle-requests": () => Promise.resolve(minted),
      },
    });
    await fireEvent.press(screen.getByTestId("settle-button-request"));
    await screen.findByTestId("settle-sheet-request");
    await fireEvent.changeText(screen.getByTestId("settle-sheet-request-input-amount"), "25.50");
    await fireEvent.changeText(screen.getByTestId("settle-sheet-request-input-note"), "hostel");
    await fireEvent.press(screen.getByTestId("settle-sheet-request-send"));
    await settle();

    const posts = request.mock.calls
      .filter(([d]) => (d as { path: string }).path === "/trips/:tripId/settle-requests")
      .map(([, input]) => (input as { body: Record<string, unknown> }).body);
    expect(posts).toEqual([
      { from_user_id: MEMBER_B_ID, amount_cents: 2550, note: "hostel" },
    ]);

    // The share message: amount + trip name + the CLIENT-COMPOSED gogo://
    // primary (SHARED template — the drift pin: a template mutation reds
    // this beside the shared/server pins) + the wire's https form; the two
    // UUIDs and nothing else ride the links.
    expect(shareSpy).toHaveBeenCalledTimes(1);
    const message = (shareSpy.mock.calls[0]?.[0] as { message: string }).message;
    expect(message).toContain("requests USD 25.50 for Kyoto");
    expect(message).toContain(settleRequestDeepLink(minted.trip_id, minted.id));
    expect(message).toContain(`gogo://t/${minted.trip_id}/request/${minted.id}`);
    expect(message).toContain(minted.link);
    expect(message).not.toContain("amount=");

    // Created state: re-share + copy affordances (§2.7 copy fallback).
    expect(await screen.findByTestId("settle-sheet-request-created")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("settle-sheet-request-copy"));
    await settle();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
      `${settleRequestDeepLink(minted.trip_id, minted.id)} (web: ${minted.link})`,
    );
  });

  it("Q1 409 (the debt evaporated) gets SPECIFIC copy, not the generic create failure", async () => {
    await renderSettle({
      balances: makeBalancesRead(),
      overrides: {
        "POST /trips/:tripId/settle-requests": () =>
          Promise.reject(new ApiRequestError(409, "CONFLICT", "no positive debt")),
      },
    });
    await fireEvent.press(screen.getByTestId("settle-button-request"));
    await screen.findByTestId("settle-sheet-request");
    await fireEvent.changeText(screen.getByTestId("settle-sheet-request-input-amount"), "25.50");
    await fireEvent.press(screen.getByTestId("settle-sheet-request-send"));
    await settle();
    expect(await screen.findByTestId("settle-sheet-request-error")).toBeTruthy();
    expect(
      screen.getByText("Nothing to request — Blair doesn't owe you right now."),
    ).toBeTruthy();
    // Compose state survives — the user can retry without redrafting.
    expect(screen.getByTestId("settle-sheet-request-send")).toBeTruthy();
  });
});

describe("return prompt (R-cmoney-21)", () => {
  it("presents once for a fresh stash and posts the STASHED method/amount on confirm", async () => {
    recordSettleDeeplinkOut({
      tripId: TEST_TRIP_ID,
      counterpartyId: MEMBER_B_ID,
      method: "cashapp",
      amountCents: 1200,
    });
    const { request } = await renderSettle();
    expect(await screen.findByTestId("settle-sheet-return")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("settle-sheet-return-confirm"));
    await settle();
    expect(settlementPosts(request)).toEqual([
      {
        from_user_id: TEST_USER.id,
        to_user_id: MEMBER_B_ID,
        amount_cents: 1200,
        currency: "USD",
        method: "cashapp",
      },
    ]);
    await waitFor(() => expect(screen.queryByTestId("settle-sheet-return")).toBeNull());
  });

  it("the return-arm 409 gets SPECIFIC copy — the linked request moved (R-money-18)", async () => {
    // Same shape as the request screen's mark-settled 409 pin: the raced
    // arm must never degrade to the generic "try again" banner (which would
    // re-409 forever and push the user into an unlinked double-record).
    recordSettleDeeplinkOut({
      tripId: TEST_TRIP_ID,
      counterpartyId: MEMBER_B_ID,
      method: "venmo",
      amountCents: 2550,
      requestId: TEST_REQUEST_ID,
    });
    const { request } = await renderSettle({
      overrides: {
        "POST /trips/:tripId/settlements": () =>
          Promise.reject(new ApiRequestError(409, "CONFLICT", "request is not open")),
      },
    });
    expect(await screen.findByTestId("settle-sheet-return")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("settle-sheet-return-confirm"));
    await settle();
    expect(settlementPosts(request)).toHaveLength(1);
    expect(await screen.findByTestId("settle-sheet-return-error")).toBeTruthy();
    expect(
      screen.getByText(
        "That request was already settled or cancelled, so it can't be paid through anymore.",
      ),
    ).toBeTruthy();
    // The sheet stays dismissible — a failed record never traps the return.
    expect(screen.getByTestId("settle-sheet-return-cancel")).toBeTruthy();
  });

  it("declining clears without posting, and a remount never re-presents (consume-once)", async () => {
    recordSettleDeeplinkOut({
      tripId: TEST_TRIP_ID,
      counterpartyId: MEMBER_B_ID,
      method: "venmo",
      amountCents: 2550,
    });
    const first = await renderSettle();
    expect(await screen.findByTestId("settle-sheet-return")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("settle-sheet-return-cancel"));
    await settle();
    expect(settlementPosts(first.request)).toEqual([]);
    await first.view.unmount();
    await settle();

    const second = await renderSettle();
    expect(screen.queryByTestId("settle-sheet-return")).toBeNull();
    expect(settlementPosts(second.request)).toEqual([]);
  });

  it("a stash from ANOTHER trip is dropped silently — no prompt, nothing posts (cross-trip guard)", async () => {
    // R1 correctness (probe-proven inverted): a rail tap on trip B's screen
    // followed by a cold-start into THIS trip's screen must never post the
    // stashed amount against this trip's ledger (wrong trip, wrong currency).
    recordSettleDeeplinkOut({
      tripId: TRIP_B_ID,
      counterpartyId: MEMBER_C_ID,
      method: "paypal",
      amountCents: 9999,
    });
    const { request } = await renderSettle();
    expect(screen.queryByTestId("settle-sheet-return")).toBeNull();
    expect(settlementPosts(request)).toEqual([]);
    // Dropped, never re-stashed: the consume-once slot is empty.
    expect(consumePendingSettleReturn()).toBeNull();
  });

  it("a stale (>30 min) stash expires silently — no prompt", async () => {
    recordSettleDeeplinkOut({
      tripId: TEST_TRIP_ID,
      counterpartyId: MEMBER_B_ID,
      method: "venmo",
      amountCents: 2550,
      timestamp: Date.now() - 31 * 60 * 1000,
    });
    await renderSettle();
    expect(screen.queryByTestId("settle-sheet-return")).toBeNull();
  });
});

describe("states (R-cmoney-29/30)", () => {
  it("root + loading skeleton while reads are held; error banner with retry on failure", async () => {
    seedAuthenticated();
    const trip = makeTrip({ id: TEST_TRIP_ID });
    mockNavApi({
      trips: [trip],
      overrides: {
        "GET /trips/:tripId/balances": () => Promise.reject(new Error("boom")),
      },
    });
    await renderWithProviders(<SettleContent trip={trip} memberId={MEMBER_B_ID} />, {
      queryClient: makeTestQueryClient(),
    });
    await settle();
    expect(screen.getByTestId("settle-screen")).toBeTruthy();
    expect(await screen.findByTestId("settle-error")).toBeTruthy();
  });

  it("counterparty missing from the roster labels 'Former member' and renders zero rails", async () => {
    await renderSettle({
      memberId: MEMBER_C_ID,
      balances: makeBalancesRead({
        members: [
          { user_id: TEST_USER.id, net_cents: -900 },
          { user_id: MEMBER_C_ID, net_cents: 900 },
        ],
        pairwise: [
          {
            trip_id: TEST_TRIP_ID,
            user_id: TEST_USER.id,
            counterparty_id: MEMBER_C_ID,
            net_cents: -900,
          },
        ],
        simplified: [{ from_user_id: TEST_USER.id, to_user_id: MEMBER_C_ID, amount_cents: 900 }],
      }),
    });
    expect(screen.getByText("You owe Former member USD 9.00")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("settle-button-settle-up"));
    await screen.findByTestId("settle-sheet-handoff");
    expect(screen.getByTestId("settle-handoff-no-handles")).toBeTruthy();
    expect(screen.getByTestId("settle-button-mark-settled")).toBeTruthy();
  });
});
