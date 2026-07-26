/**
 * Members screen (T-6.8 / CT-4; R-tripui-13..17, 21) — component-level over
 * the REAL data hooks with the network mocked by descriptor (mockNavApi) and
 * the trip context provided directly (role variants). Route-level
 * reachability is members-flow.test.tsx.
 *
 * Pins: the role-gated affordance matrix (viewer none / editor invite-only /
 * owner all), the ConfirmDialog paths (remove, transfer, leave, revoke),
 * §2.6 optimistic-vs-reconcile behavior (role change rollback, transfer
 * two-row reconcile, revoke rollback on already_revoked), invite create →
 * OS share sheet with the returned url, and the 4xx → banner mapping.
 */
import type { InviteListItem, MemberListItem, TripMemberRole, TripWithRole } from "@gogo/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { Share } from "react-native";

import MembersScreen from "@/app/[tripId]/more/members";
import { ApiRequestError } from "@/auth";
import { TripProvider } from "@/navigation/trip-context";
import {
  CREATED_INVITE_ID,
  CREATED_INVITE_URL,
  INVITE_B_ID,
  MEMBER_B_ID,
  MEMBER_C_ID,
  TEST_INVITE_ID,
  TEST_TRIP_ID,
} from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import {
  makeInvite,
  makeMember,
  makeTrip,
  mockNavApi,
  type NavApiOptions,
} from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, back: jest.fn(), push: jest.fn() }),
}));

const ME_OWNER = makeMember();
const B_EDITOR = makeMember({
  user: { id: MEMBER_B_ID, display_name: "Blake Editor" },
  role: "editor",
});
const C_VIEWER = makeMember({
  user: { id: MEMBER_C_ID, display_name: "Casey Viewer" },
  role: "viewer",
});
/** Non-owner-caller universes: someone else owns the trip. */
const B_OWNER = makeMember({ user: { id: MEMBER_B_ID, display_name: "Blake Owner" } });
const ME_EDITOR = makeMember({ role: "editor" });
const ME_VIEWER = makeMember({ role: "viewer" });

async function renderMembers(opts: {
  role?: TripMemberRole;
  members?: MemberListItem[];
  invites?: InviteListItem[];
  overrides?: NavApiOptions["overrides"];
}) {
  seedAuthenticated();
  const request = mockNavApi({
    members: opts.members ?? [ME_OWNER, B_EDITOR, C_VIEWER],
    invites: opts.invites ?? [],
    overrides: opts.overrides,
  });
  const trip: TripWithRole = makeTrip({ id: TEST_TRIP_ID, role: opts.role ?? "owner" });
  const client = makeTestQueryClient();
  await renderWithProviders(
    <TripProvider trip={trip}>
      <MembersScreen />
    </TripProvider>,
    { queryClient: client },
  );
  return { request, client };
}

/**
 * Hold an act() window over VirtualizedList's deferred cell-batch update
 * (B-2 family, T-6.8 variant): every FlatList DATA change schedules a
 * Batchinator setState ~50ms later, and RNTL's waitFor sleeps BETWEEN
 * act-wrapped checks — under CI's 2-core contention that timer lands in an
 * un-act'd sleep window ("An update to VirtualizedList was not wrapped in
 * act"). Call after every checkpoint that renders or mutates the list.
 */
async function settleList() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

afterEach(async () => {
  // Drain the Sheet exit animation (duration.base = 200ms) + TanStack's
  // queued notifyManager macrotasks + any straggling VirtualizedList batch
  // INSIDE act, so no state update lands un-act-wrapped after the test ends
  // (B-2 flake family).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  jest.restoreAllMocks();
  mockReplace.mockClear();
});

describe("role-gated affordances (R-tripui-13/14)", () => {
  it("owner sees everything: list w/ roles + (you), manage sheet, invite CTA, revoke on any invite", async () => {
    await renderMembers({ role: "owner", invites: [makeInvite({ created_by: MEMBER_B_ID })] });

    expect(await screen.findByText("Test Traveler (you)")).toBeOnTheScreen();
    await settleList();
    expect(screen.getByTestId("members-screen")).toBeOnTheScreen();
    const rowB = screen.getByTestId(`members-list-item-${MEMBER_B_ID}`);
    expect(within(rowB).getByText("editor")).toBeOnTheScreen();
    expect(
      within(screen.getByTestId(`members-list-item-${MEMBER_C_ID}`)).getByText("viewer"),
    ).toBeOnTheScreen();
    expect(screen.getByTestId("members-button-invite")).toBeOnTheScreen();
    // Owner revokes ANY invite (§3.2), including one created by an editor.
    expect(screen.getByTestId(`members-button-revoke-${TEST_INVITE_ID}`)).toBeOnTheScreen();
    // The owner has no leave affordance (transfer-first, R-trips-11).
    expect(screen.queryByTestId("members-button-leave")).toBeNull();

    // Row press opens the manage sheet with the three §2.5 actions.
    await fireEvent.press(rowB);
    expect(await screen.findByTestId(`members-button-role-${MEMBER_B_ID}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`members-button-transfer-${MEMBER_B_ID}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`members-button-remove-${MEMBER_B_ID}`)).toBeOnTheScreen();
  });

  it("editor sees invite + own-invite revoke only; other rows are not manageable; self can leave", async () => {
    await renderMembers({
      role: "editor",
      members: [B_OWNER, ME_EDITOR],
      invites: [
        makeInvite(), // created_by TEST_USER (own)
        makeInvite({ id: INVITE_B_ID, created_by: MEMBER_B_ID }),
      ],
    });

    expect(await screen.findByText("Test Traveler (you)")).toBeOnTheScreen();
    await settleList();
    expect(screen.getByTestId("members-button-invite")).toBeOnTheScreen();
    expect(screen.getByTestId(`members-button-revoke-${TEST_INVITE_ID}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`members-button-revoke-${INVITE_B_ID}`)).toBeNull();
    expect(screen.getByTestId("members-button-leave")).toBeOnTheScreen();

    // Pressing another member's row opens nothing for a non-owner.
    await fireEvent.press(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`));
    expect(screen.queryByTestId(`members-button-role-${MEMBER_B_ID}`)).toBeNull();
    expect(screen.queryByTestId(`members-button-remove-${MEMBER_B_ID}`)).toBeNull();
  });

  it("viewer sees NO admin affordances and the invites query never fires (enabled gate)", async () => {
    const { request } = await renderMembers({ role: "viewer", members: [B_OWNER, ME_VIEWER] });

    expect(await screen.findByText("Test Traveler (you)")).toBeOnTheScreen();
    await settleList();
    expect(screen.queryByTestId("members-button-invite")).toBeNull();
    expect(screen.queryByText("Invites")).toBeNull();
    expect(screen.queryByTestId(`members-button-role-${MEMBER_B_ID}`)).toBeNull();
    expect(screen.getByTestId("members-button-leave")).toBeOnTheScreen();
    const inviteCalls = request.mock.calls.filter(
      ([descriptor]) => (descriptor as { path: string }).path === "/trips/:tripId/invites",
    );
    expect(inviteCalls).toHaveLength(0);
    // Role badges still render for everyone (R-tripui-13).
    expect(
      within(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).getByText("owner"),
    ).toBeOnTheScreen();
  });
});

describe("remove & role change (R-tripui-15, §2.6 optimistic)", () => {
  it("remove flows through a ConfirmDialog naming the member + the balances note, then removes", async () => {
    const { request } = await renderMembers({ role: "owner" });

    const rowB = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    await settleList();
    await fireEvent.press(rowB);
    await fireEvent.press(await screen.findByTestId(`members-button-remove-${MEMBER_B_ID}`));

    expect(await screen.findByText("Remove Blake Editor from this trip?")).toBeOnTheScreen();
    expect(screen.getByText(/expenses and balances stay/i)).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId(`members-button-remove-${MEMBER_B_ID}-confirm`));

    await waitFor(() =>
      expect(screen.queryByTestId(`members-list-item-${MEMBER_B_ID}`)).toBeNull(),
    );
    await settleList();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: "/trips/:tripId/members/:userId" }),
      { params: { tripId: TEST_TRIP_ID, userId: MEMBER_B_ID } },
    );
  });

  it("remove cancel makes no call and keeps the member", async () => {
    const { request } = await renderMembers({ role: "owner" });

    const rowB = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    await settleList();
    await fireEvent.press(rowB);
    await fireEvent.press(await screen.findByTestId(`members-button-remove-${MEMBER_B_ID}`));
    await fireEvent.press(await screen.findByTestId(`members-button-remove-${MEMBER_B_ID}-cancel`));

    expect(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).toBeOnTheScreen();
    const deletes = request.mock.calls.filter(
      ([descriptor]) => (descriptor as { method: string }).method === "DELETE",
    );
    expect(deletes).toHaveLength(0);
  });

  it("role change applies optimistically, rolls back on 403, and maps the ErrorBanner (R-tripui-14/21)", async () => {
    let rejectPatch: ((reason: unknown) => void) | undefined;
    await renderMembers({
      role: "owner",
      overrides: {
        "PATCH /trips/:tripId/members/:userId": () =>
          new Promise((_resolve, reject) => {
            rejectPatch = reject;
          }),
      },
    });

    const rowB = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    expect(within(rowB).getByText("editor")).toBeOnTheScreen();
    await settleList();

    await fireEvent.press(rowB);
    await fireEvent.press(await screen.findByTestId(`members-button-role-${MEMBER_B_ID}`));
    await fireEvent.press(await screen.findByTestId(`members-button-role-${MEMBER_B_ID}-viewer`));

    // Optimistic flip while the PATCH is still in flight.
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).getByText("viewer"),
      ).toBeOnTheScreen(),
    );
    await settleList();

    // Server denies → rollback + mapped banner, never a crash.
    await act(async () => {
      rejectPatch?.(new ApiRequestError(403, "FORBIDDEN", "forbidden"));
    });
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).getByText("editor"),
      ).toBeOnTheScreen(),
    );
    await settleList();
    expect(screen.getByTestId("members-banner")).toBeOnTheScreen();
    expect(screen.getByText(/permission/i)).toBeOnTheScreen();
  });

  it("role change reconciles with the returned row on success", async () => {
    const { request } = await renderMembers({ role: "owner" });

    const rowBFound = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    await settleList();
    await fireEvent.press(rowBFound);
    await fireEvent.press(await screen.findByTestId(`members-button-role-${MEMBER_B_ID}`));
    await fireEvent.press(await screen.findByTestId(`members-button-role-${MEMBER_B_ID}-viewer`));

    await waitFor(() =>
      expect(
        within(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).getByText("viewer"),
      ).toBeOnTheScreen(),
    );
    await settleList();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PATCH", path: "/trips/:tripId/members/:userId" }),
      { params: { tripId: TEST_TRIP_ID, userId: MEMBER_B_ID }, body: { role: "viewer" } },
    );
  });
});

describe("transfer ownership (R-tripui-17)", () => {
  it("confirms the demotion, then reconciles BOTH returned rows (R-trips-19)", async () => {
    const { request } = await renderMembers({ role: "owner" });

    const rowB = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    await settleList();
    await fireEvent.press(rowB);
    await fireEvent.press(await screen.findByTestId(`members-button-transfer-${MEMBER_B_ID}`));

    expect(await screen.findByText("Make Blake Editor the owner?")).toBeOnTheScreen();
    expect(screen.getByText(/you'll become an editor/i)).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId(`members-button-transfer-${MEMBER_B_ID}-confirm`));

    await waitFor(() =>
      expect(
        within(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).getByText("owner"),
      ).toBeOnTheScreen(),
    );
    await settleList();
    expect(
      within(screen.getByTestId(`members-list-item-${TEST_USER.id}`)).getByText("editor"),
    ).toBeOnTheScreen();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/trips/:tripId/transfer-ownership" }),
      { params: { tripId: TEST_TRIP_ID }, body: { to_user_id: MEMBER_B_ID } },
    );
  });

  it("a transfer 404 (target no longer a LIVE member) maps to the stale-list banner", async () => {
    await renderMembers({
      role: "owner",
      overrides: {
        "POST /trips/:tripId/transfer-ownership": () =>
          Promise.reject(new ApiRequestError(404, "NOT_FOUND", "target not a member")),
      },
    });

    const rowB = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    await settleList();
    await fireEvent.press(rowB);
    await fireEvent.press(await screen.findByTestId(`members-button-transfer-${MEMBER_B_ID}`));
    await fireEvent.press(
      await screen.findByTestId(`members-button-transfer-${MEMBER_B_ID}-confirm`),
    );

    expect(await screen.findByText(/no longer in this trip/i)).toBeOnTheScreen();
    await settleList();
  });
});

describe("leave (self) with ConfirmDialog", () => {
  it("confirms, DELETEs self, and lands on the trip list", async () => {
    const { request } = await renderMembers({ role: "editor", members: [B_OWNER, ME_EDITOR] });

    await fireEvent.press(await screen.findByTestId("members-button-leave"));
    expect(await screen.findByText("Leave this trip?")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("members-button-leave-confirm"));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/(trips)"));
    await settleList();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: "/trips/:tripId/members/:userId" }),
      { params: { tripId: TEST_TRIP_ID, userId: TEST_USER.id } },
    );
  });

  it("a leave 409 maps the owner-leave reason (transfer-first path) and stays put", async () => {
    await renderMembers({
      role: "editor",
      members: [B_OWNER, ME_EDITOR],
      overrides: {
        "DELETE /trips/:tripId/members/:userId": () =>
          Promise.reject(
            new ApiRequestError(409, "CONFLICT", "owner leave", {
              reason: "owner_transfer_required",
            }),
          ),
      },
    });

    await fireEvent.press(await screen.findByTestId("members-button-leave"));
    await fireEvent.press(await screen.findByTestId("members-button-leave-confirm"));

    expect(await screen.findByText(/transfer ownership to someone else/i)).toBeOnTheScreen();
    await settleList();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe("invites (R-tripui-16, §3.2 revoke gating)", () => {
  it("create offers the role choice (editor first/default) and opens the OS share sheet with the returned url", async () => {
    const shareSpy = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as never);
    const { request } = await renderMembers({ role: "owner" });

    await fireEvent.press(await screen.findByTestId("members-button-invite"));
    const editorOption = await screen.findByTestId("members-button-invite-editor");
    expect(screen.getByTestId("members-button-invite-viewer")).toBeOnTheScreen();
    await fireEvent.press(editorOption);

    await waitFor(() => expect(shareSpy).toHaveBeenCalledWith({ url: CREATED_INVITE_URL }));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/trips/:tripId/invites" }),
      { params: { tripId: TEST_TRIP_ID }, body: { role: "editor" } },
    );
    // Reconcile: the created invite appears in the active list (no refetch).
    expect(
      await screen.findByTestId(`members-list-item-invite-${CREATED_INVITE_ID}`),
    ).toBeOnTheScreen();
    await settleList();
  });

  it("revoke confirms then optimistically drops the invite from the active list", async () => {
    const { request } = await renderMembers({ role: "owner", invites: [makeInvite()] });

    await fireEvent.press(await screen.findByTestId(`members-button-revoke-${TEST_INVITE_ID}`));
    expect(await screen.findByText("Revoke this invite?")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`members-button-revoke-${TEST_INVITE_ID}-confirm`));

    await waitFor(() =>
      expect(screen.queryByTestId(`members-list-item-invite-${TEST_INVITE_ID}`)).toBeNull(),
    );
    await settleList();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: "/trips/:tripId/invites/:inviteId" }),
      { params: { tripId: TEST_TRIP_ID, inviteId: TEST_INVITE_ID } },
    );
  });

  it("a revoke 409 already_revoked rolls back and shows the mapped banner", async () => {
    await renderMembers({
      role: "owner",
      invites: [makeInvite()],
      overrides: {
        "DELETE /trips/:tripId/invites/:inviteId": () =>
          Promise.reject(
            new ApiRequestError(409, "CONFLICT", "already revoked", {
              reason: "already_revoked",
            }),
          ),
      },
    });

    await fireEvent.press(await screen.findByTestId(`members-button-revoke-${TEST_INVITE_ID}`));
    await fireEvent.press(
      await screen.findByTestId(`members-button-revoke-${TEST_INVITE_ID}-confirm`),
    );

    expect(await screen.findByText(/already revoked/i)).toBeOnTheScreen();
    await settleList();
  });
});

describe("load states", () => {
  it("a members load failure renders the retry banner (R-ds-17) and retry recovers", async () => {
    let calls = 0;
    await renderMembers({
      role: "viewer",
      members: [B_OWNER, ME_VIEWER],
      overrides: {
        "GET /trips/:tripId/members": () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new ApiRequestError(500, "INTERNAL", "boom"))
            : Promise.resolve({ items: [B_OWNER, ME_VIEWER] });
        },
      },
    });

    expect(await screen.findByTestId("members-banner-load")).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId("members-banner-load-retry"));
    expect(await screen.findByText("Test Traveler (you)")).toBeOnTheScreen();
    await settleList();
  });
});
