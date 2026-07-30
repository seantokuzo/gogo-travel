/**
 * Members screen (T-6.8 / CT-4; R-tripui-13..17, 21) — component-level over
 * the REAL data hooks with the network mocked by descriptor (mockNavApi) and
 * the trip context provided directly (role variants). Route-level
 * reachability is members-flow.test.tsx.
 *
 * Pins: the role-gated affordance matrix (viewer none / editor invite-only /
 * owner all; NO leave affordance — §2.5 is exhaustive, leave lives on trip
 * settings), the ConfirmDialog confirm AND cancel paths, §2.6
 * optimistic-vs-reconcile behavior, invite create → OS share sheet, the
 * 4xx → banner mapping, and cache token-hygiene.
 *
 * FALSIFIABILITY (round-1): rollback tests HANG the re-sync GET that
 * `onError` fires — restoration can then only come from the snapshot
 * `setQueryData`, so deleting the rollback turns these red instead of being
 * papered over by the refetch returning the pre-mutation list.
 */
import type { InviteListItem, MemberListItem, TripMemberRole, TripWithRole } from "@gogo/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { Share } from "react-native";

import MembersScreen from "@/app/[tripId]/more/members";
import { ApiRequestError } from "@/auth";
import { queryKeys } from "@/data";
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
const DEFAULT_MEMBERS = [ME_OWNER, B_EDITOR, C_VIEWER];
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
    members: opts.members ?? DEFAULT_MEMBERS,
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
 * A members GET that serves `first` once, then HANGS (or serves `healed`) —
 * the falsifiability tool: with the re-sync refetch pinned open, only the
 * snapshot rollback can restore the pre-mutation UI.
 */
function membersGetSequence(first: MemberListItem[], later?: MemberListItem[]) {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls === 1) return Promise.resolve({ items: first });
    return later === undefined
      ? new Promise(() => undefined) // hang: the refetch never lands
      : Promise.resolve({ items: later });
  };
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

/**
 * Hold act() over a Sheet's exit-completion setState (timed slide-out at
 * duration.base = 200ms → `setExiting(false)`): a waitFor SLEEP between
 * act-wrapped checks is un-act'd, so under full-turbo contention the
 * completion otherwise lands there ("An update to Sheet was not wrapped in
 * act"). Call right after any press that closes a sheet.
 */
async function settleSheetExit() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
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
    const { client } = await renderMembers({
      role: "owner",
      invites: [makeInvite({ created_by: MEMBER_B_ID })],
    });

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
    // §2.5 enumerates this screen exhaustively — NO leave affordance here
    // (leave lives on trip settings, CT-5/T-6.9; round-1 ruling).
    expect(screen.queryByTestId("members-button-leave")).toBeNull();

    // Cache hygiene: cached invite rows carry NO bearer token (round-1).
    const cachedInvites = client.getQueryData<{ items: Record<string, unknown>[] }>(
      queryKeys.tripInvites(TEST_TRIP_ID),
    );
    expect(cachedInvites?.items.length).toBeGreaterThan(0);
    for (const row of cachedInvites?.items ?? []) {
      expect(row).not.toHaveProperty("token");
    }

    // Row press opens the manage sheet with the three §2.5 actions.
    await fireEvent.press(rowB);
    expect(await screen.findByTestId(`members-button-role-${MEMBER_B_ID}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`members-button-transfer-${MEMBER_B_ID}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`members-button-remove-${MEMBER_B_ID}`)).toBeOnTheScreen();
  });

  it("editor sees invite + own-invite revoke only; other rows are not manageable", async () => {
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
    expect(screen.queryByTestId("members-button-leave")).toBeNull();

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
    expect(screen.queryByTestId("members-button-leave")).toBeNull();
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
    await settleSheetExit();

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
    await settleSheetExit();
    await fireEvent.press(await screen.findByTestId(`members-button-remove-${MEMBER_B_ID}-cancel`));

    expect(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).toBeOnTheScreen();
    const deletes = request.mock.calls.filter(
      ([descriptor]) => (descriptor as { method: string }).method === "DELETE",
    );
    expect(deletes).toHaveLength(0);
  });

  it("a remove failure restores the row from the SNAPSHOT — the re-sync GET is held open (rollback pin)", async () => {
    await renderMembers({
      role: "owner",
      overrides: {
        "GET /trips/:tripId/members": membersGetSequence(DEFAULT_MEMBERS),
        "DELETE /trips/:tripId/members/:userId": () =>
          Promise.reject(new ApiRequestError(404, "NOT_FOUND", "already gone")),
      },
    });

    const rowB = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    await settleList();
    await fireEvent.press(rowB);
    await fireEvent.press(await screen.findByTestId(`members-button-remove-${MEMBER_B_ID}`));
    await settleSheetExit();
    await fireEvent.press(
      await screen.findByTestId(`members-button-remove-${MEMBER_B_ID}-confirm`),
    );

    // Banner maps the 404; the row is back even though the refetch hangs —
    // only the snapshot restore can have put it there.
    expect(await screen.findByText(/no longer in this trip/i)).toBeOnTheScreen();
    expect(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).toBeOnTheScreen();
    await settleList();
  });

  it("role change applies optimistically and rolls back on 403 from the SNAPSHOT (re-sync GET held open)", async () => {
    let rejectPatch: ((reason: unknown) => void) | undefined;
    await renderMembers({
      role: "owner",
      overrides: {
        "GET /trips/:tripId/members": membersGetSequence(DEFAULT_MEMBERS),
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
    await settleSheetExit();

    // Optimistic flip while the PATCH is still in flight.
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).getByText("viewer"),
      ).toBeOnTheScreen(),
    );
    await settleList();

    // Server denies → the snapshot restore flips it back (the onError
    // re-sync refetch HANGS, so a refetch cannot be what restored it) +
    // mapped banner, never a crash.
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
    await settleSheetExit();

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

  it("concurrent role changes: a failed sibling's rollback can't strand the survivor — the onError re-sync heals", async () => {
    const held: { resolve(value: unknown): void; reject(reason: unknown): void }[] = [];
    const healed = [
      ME_OWNER,
      B_EDITOR,
      makeMember({ user: { id: MEMBER_C_ID, display_name: "Casey Viewer" }, role: "editor" }),
    ];
    await renderMembers({
      role: "owner",
      overrides: {
        // Serves the initial list, then the POST-COMMIT server truth the
        // onError re-sync fetches (B's change failed, C's committed).
        "GET /trips/:tripId/members": membersGetSequence(DEFAULT_MEMBERS, healed),
        "PATCH /trips/:tripId/members/:userId": () =>
          new Promise((resolve, reject) => {
            held.push({ resolve, reject });
          }),
      },
    });

    // Mutation 1: B editor → viewer (this one will FAIL).
    const rowB = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    await settleList();
    await fireEvent.press(rowB);
    await fireEvent.press(await screen.findByTestId(`members-button-role-${MEMBER_B_ID}`));
    await fireEvent.press(await screen.findByTestId(`members-button-role-${MEMBER_B_ID}-viewer`));
    await settleSheetExit();

    // Mutation 2: C viewer → editor (this one will SUCCEED).
    await fireEvent.press(screen.getByTestId(`members-list-item-${MEMBER_C_ID}`));
    await fireEvent.press(await screen.findByTestId(`members-button-role-${MEMBER_C_ID}`));
    await fireEvent.press(await screen.findByTestId(`members-button-role-${MEMBER_C_ID}-editor`));
    await settleSheetExit();
    await waitFor(() => expect(held).toHaveLength(2));

    // C's PATCH commits first — its reconcile lands C=editor.
    await act(async () => {
      held[1].resolve({
        trip_id: TEST_TRIP_ID,
        user_id: MEMBER_C_ID,
        role: "editor",
        joined_at: "2026-07-01T00:00:00.000Z",
      });
    });
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`members-list-item-${MEMBER_C_ID}`)).getByText("editor"),
      ).toBeOnTheScreen(),
    );
    await settleList();

    // B's PATCH fails. Its snapshot pre-dates C's change, so the bare
    // rollback clobbers C back to viewer — the onError invalidate must
    // refetch server truth and heal the survivor.
    await act(async () => {
      held[0].reject(new ApiRequestError(403, "FORBIDDEN", "forbidden"));
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).getByText("editor"),
      ).toBeOnTheScreen();
      expect(
        within(screen.getByTestId(`members-list-item-${MEMBER_C_ID}`)).getByText("editor"),
      ).toBeOnTheScreen();
    });
    await settleList();
    expect(screen.getByText(/permission/i)).toBeOnTheScreen();
  });
});

describe("transfer ownership (R-tripui-17)", () => {
  it("confirms the demotion, reconciles BOTH returned rows, and fires the role re-gate invalidates", async () => {
    const { request, client } = await renderMembers({ role: "owner" });
    const invalidateSpy = jest.spyOn(client, "invalidateQueries");

    const rowB = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    await settleList();
    await fireEvent.press(rowB);
    await fireEvent.press(await screen.findByTestId(`members-button-transfer-${MEMBER_B_ID}`));
    await settleSheetExit();

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
    // Round-1: the caller's own role gates every affordance — the trip
    // detail (guard/TripProvider) AND trips list invalidates must fire.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.trip(TEST_TRIP_ID),
      exact: true,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.trips, exact: true });
  });

  it("a transfer 404 (target no longer a LIVE member) maps the banner AND refetches the list", async () => {
    const { request } = await renderMembers({
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
    await settleSheetExit();
    await fireEvent.press(
      await screen.findByTestId(`members-button-transfer-${MEMBER_B_ID}-confirm`),
    );

    expect(await screen.findByText(/no longer in this trip/i)).toBeOnTheScreen();
    // The copy says "the list has been refreshed" — make it true (round-1):
    // the onError invalidate refetches the members list.
    await waitFor(() => {
      const membersGets = request.mock.calls.filter(
        ([descriptor]) => (descriptor as { path: string }).path === "/trips/:tripId/members",
      );
      expect(membersGets.length).toBeGreaterThanOrEqual(2);
    });
    await settleList();
  });
});

describe("ConfirmDialog cancel paths (nav §2.6 — cancel never mutates)", () => {
  it("transfer cancel closes the dialog with no call and unchanged roles", async () => {
    const { request } = await renderMembers({ role: "owner" });

    const rowB = await screen.findByTestId(`members-list-item-${MEMBER_B_ID}`);
    await settleList();
    await fireEvent.press(rowB);
    await fireEvent.press(await screen.findByTestId(`members-button-transfer-${MEMBER_B_ID}`));
    await settleSheetExit();
    await fireEvent.press(
      await screen.findByTestId(`members-button-transfer-${MEMBER_B_ID}-cancel`),
    );

    await waitFor(() => expect(screen.queryByText("Make Blake Editor the owner?")).toBeNull());
    expect(
      within(screen.getByTestId(`members-list-item-${MEMBER_B_ID}`)).getByText("editor"),
    ).toBeOnTheScreen();
    const transfers = request.mock.calls.filter(
      ([descriptor]) =>
        (descriptor as { path: string }).path === "/trips/:tripId/transfer-ownership",
    );
    expect(transfers).toHaveLength(0);
  });

  it("revoke cancel closes the dialog with no call and the invite still listed", async () => {
    const { request } = await renderMembers({ role: "owner", invites: [makeInvite()] });

    await fireEvent.press(await screen.findByTestId(`members-button-revoke-${TEST_INVITE_ID}`));
    await fireEvent.press(
      await screen.findByTestId(`members-button-revoke-${TEST_INVITE_ID}-cancel`),
    );

    await waitFor(() => expect(screen.queryByText("Revoke this invite?")).toBeNull());
    expect(screen.getByTestId(`members-list-item-invite-${TEST_INVITE_ID}`)).toBeOnTheScreen();
    const revokes = request.mock.calls.filter(
      ([descriptor]) =>
        (descriptor as { path: string }).path === "/trips/:tripId/invites/:inviteId",
    );
    expect(revokes).toHaveLength(0);
  });
});

describe("invites (R-tripui-16, §3.2 revoke gating)", () => {
  it("create offers the role choice (editor first/default), opens the OS share sheet, and caches a token-free row", async () => {
    const shareSpy = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as never);
    const { request, client } = await renderMembers({ role: "owner" });

    await fireEvent.press(await screen.findByTestId("members-button-invite"));
    const editorOption = await screen.findByTestId("members-button-invite-editor");
    expect(screen.getByTestId("members-button-invite-viewer")).toBeOnTheScreen();
    await fireEvent.press(editorOption);
    await settleSheetExit();

    await waitFor(() => expect(shareSpy).toHaveBeenCalledWith({ url: CREATED_INVITE_URL }));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/trips/:tripId/invites" }),
      { params: { tripId: TEST_TRIP_ID }, body: { role: "editor" } },
    );
    // Reconcile: the created invite appears in the active list (no refetch)…
    expect(
      await screen.findByTestId(`members-list-item-invite-${CREATED_INVITE_ID}`),
    ).toBeOnTheScreen();
    // …and the cached row carries NEITHER the bearer token NOR the url.
    const cached = client.getQueryData<{ items: Record<string, unknown>[] }>(
      queryKeys.tripInvites(TEST_TRIP_ID),
    );
    const createdRow = cached?.items.find((row) => row.id === CREATED_INVITE_ID);
    expect(createdRow).toBeDefined();
    expect(createdRow).not.toHaveProperty("token");
    expect(createdRow).not.toHaveProperty("url");
    await settleList();
  });

  it("create falls back to an invalidate when the invites cache is empty (create raced the initial GET)", async () => {
    const shareSpy = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as never);
    const { client } = await renderMembers({
      role: "owner",
      overrides: {
        // The initial invites list never lands — nothing to append onto.
        "GET /trips/:tripId/invites": () => new Promise(() => undefined),
      },
    });
    expect(await screen.findByText("Test Traveler (you)")).toBeOnTheScreen();
    await settleList();
    const invalidateSpy = jest.spyOn(client, "invalidateQueries");

    await fireEvent.press(screen.getByTestId("members-button-invite"));
    await fireEvent.press(await screen.findByTestId("members-button-invite-editor"));
    await settleSheetExit();

    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    // Round-1: without this fallback the created invite is invisible until
    // staleTime lapses.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.tripInvites(TEST_TRIP_ID),
      }),
    );
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

  it("a revoke 409 already_revoked restores the hidden row from the SNAPSHOT (re-sync GET held open) + mapped banner", async () => {
    let invitesCalls = 0;
    await renderMembers({
      role: "owner",
      overrides: {
        "GET /trips/:tripId/invites": () => {
          invitesCalls += 1;
          return invitesCalls === 1
            ? Promise.resolve({ items: [makeInvite()], nextCursor: null })
            : new Promise(() => undefined); // hang the onError re-sync
        },
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
    // The optimistically-hidden row is BACK, and only the snapshot restore
    // can have done it — the refetch is pinned open.
    expect(screen.getByTestId(`members-list-item-invite-${TEST_INVITE_ID}`)).toBeOnTheScreen();
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
