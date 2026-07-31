/**
 * Members screen (T-6.8 / CT-4; trips spec §2.5, R-tripui-13..17) — member
 * list with role badges, owner-only management (role change via Sheet,
 * remove + make-owner via ConfirmDialog), invite create → OS share sheet,
 * active-invite list with revoke. §2.5 enumerates this screen EXHAUSTIVELY —
 * leave-trip lives on trip settings (CT-5/T-6.9), not here (round-1 ruling;
 * the LEAVE_TRIP_CONFIRM copy + owner-leave 409 mappings stay in
 * features/members for that screen to consume).
 *
 * Role gating is UI convenience only (R-tripui-14) — the §3.2 matrix
 * enforces server-side; any 4xx a raced screen produces renders a mapped
 * ErrorBanner (features/members/error-copy), never a crash:
 * - owner: manage sheet on every other row, invite section, revoke any
 * - editor: invite section, revoke OWN invites only
 * - viewer: read-only list (no invites section — the query is
 *   `enabled`-gated so the guaranteed 403 never fires)
 *
 * Mutation policy per §2.6 lives in `@/data/members` (optimistic role
 * change/remove/revoke with rollback; transfer/create reconcile from
 * returned rows). The caller's own role after a transfer refreshes through
 * the [tripId] guard invalidation — affordances re-gate from TripProvider.
 *
 * ConfirmDialog bases follow the §2.7 derivation convention (the dialog
 * carries the triggering action's testID; children derive `-confirm` /
 * `-cancel`, same as trip-new's cancel-confirm).
 */
import type { InviteGrantableRole, MemberListItem, TripMemberRole } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useMemo, useState } from "react";
import { FlatList, Platform, Share, StyleSheet, View } from "react-native";

import { useSessionStore } from "@/auth";
import {
  AppText,
  Badge,
  Button,
  ConfirmDialog,
  ErrorBanner,
  Icon,
  ListItem,
  PageHeader,
  Sheet,
  Skeleton,
} from "@/components";
import type { BadgeTone } from "@/components";
import type { InviteRow } from "@/data";
import {
  useCreateInvite,
  useRemoveMember,
  useRevokeInvite,
  useTransferOwnership,
  useTripInvites,
  useTripMembers,
  useUpdateMemberRole,
} from "@/data";
import { MemberAvatar, memberActionErrorMessage } from "@/features/members";
import { useTripContext } from "@/navigation/trip-context";

const ROLE_TONE: Record<TripMemberRole, BadgeTone> = {
  owner: "accent",
  editor: "info",
  viewer: "neutral",
};

type Row =
  | { type: "member"; item: MemberListItem }
  | { type: "invites-header" }
  | { type: "invite"; item: InviteRow }
  | { type: "invites-empty" }
  | { type: "invites-error" };

type Dialog =
  | { kind: "remove"; userId: string; name: string }
  | { kind: "transfer"; userId: string; name: string }
  | { kind: "revoke"; inviteId: string }
  | null;

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    list: { padding: t.space[4], gap: t.space[1] },
    banner: { paddingHorizontal: t.space[4], paddingTop: t.space[2] },
    loading: { padding: t.space[4] },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: t.space[3],
      paddingTop: t.space[5],
      paddingBottom: t.space[2],
    },
    emptyCaption: { paddingVertical: t.space[2] },
  }),
);

export default function MembersScreen() {
  const s = useStyles();
  const trip = useTripContext();
  const me = useSessionStore((state) => state.user);

  const callerRole = trip.role;
  const canManageInvites = callerRole === "owner" || callerRole === "editor";

  const [banner, setBanner] = useState<string | null>(null);
  const [managedId, setManagedId] = useState<string | null>(null);
  const [manageMode, setManageMode] = useState<"actions" | "role">("actions");
  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  // HOOK-level error seam, not per-call: per-call `mutate` callbacks fire
  // only for the LATEST call — a failed sibling of two in-flight row actions
  // would lose its banner (data/members.ts `MemberMutationOptions`).
  const failToBanner = {
    onMutationError: (err: unknown) => setBanner(memberActionErrorMessage(err)),
  };
  const members = useTripMembers(trip.id);
  const invites = useTripInvites(trip.id, { enabled: canManageInvites });
  const updateRole = useUpdateMemberRole(trip.id, failToBanner);
  const removeMember = useRemoveMember(trip.id, failToBanner);
  const transferOwnership = useTransferOwnership(trip.id, failToBanner);
  const createInvite = useCreateInvite(trip.id, {
    ...failToBanner,
    // HOOK-level, same reason as the error seam (T-6.9 carry from T-6.8 R2):
    // a per-call onSuccess is dropped for superseded calls — a second create
    // mid-flight would silently swallow the first's share sheet.
    onMutationSuccess: (invite) => {
      void (async () => {
        try {
          // R-tripui-16: OS share sheet with the returned url. iOS shares
          // the url payload; Android's Share only carries `message`.
          await Share.share(
            Platform.OS === "ios" ? { url: invite.url } : { message: invite.url },
          );
        } catch {
          setBanner("Couldn't open the share sheet — the invite link was still created.");
        }
      })();
    },
  });
  const revokeInvite = useRevokeInvite(trip.id, failToBanner);

  const rows = useMemo<Row[]>(() => {
    const built: Row[] = (members.data?.items ?? []).map((item) => ({ type: "member", item }));
    if (canManageInvites) {
      built.push({ type: "invites-header" });
      if (invites.isError) {
        built.push({ type: "invites-error" });
      } else {
        const active = (invites.data?.items ?? []).filter((i) => i.state === "active");
        if (active.length === 0 && invites.data !== undefined) {
          built.push({ type: "invites-empty" });
        }
        built.push(...active.map((item): Row => ({ type: "invite", item })));
      }
    }
    return built;
  }, [members.data, invites.data, invites.isError, canManageInvites]);

  const managed = members.data?.items.find((m) => m.user.id === managedId);

  const openManage = (userId: string) => {
    setManageMode("actions");
    setManagedId(userId);
  };

  const pickRole = (userId: string, role: InviteGrantableRole, current: string) => {
    setManagedId(null);
    if (role === current) return;
    updateRole.mutate({ userId, role });
  };

  const sendInvite = (role: InviteGrantableRole) => {
    setInviteSheetOpen(false);
    // Share-sheet open lives on the HOOK-level success seam (see the
    // useCreateInvite options above) — never per-call.
    createInvite.mutate({ role });
  };

  const confirmDialog = () => {
    if (dialog === null) return;
    const closing = dialog;
    setDialog(null);
    switch (closing.kind) {
      case "remove":
        removeMember.mutate({ userId: closing.userId });
        break;
      case "transfer":
        transferOwnership.mutate({ toUserId: closing.userId });
        break;
      case "revoke":
        revokeInvite.mutate({ inviteId: closing.inviteId });
        break;
    }
  };

  const renderRow = ({ item: row }: { item: Row }) => {
    switch (row.type) {
      case "member": {
        const { user, role } = row.item;
        const isMe = user.id === me?.id;
        const manageable = callerRole === "owner" && !isMe;
        const trailing = <Badge label={role} tone={ROLE_TONE[role]} />;
        const title = isMe ? `${user.display_name} (you)` : user.display_name;
        const leading = (
          <MemberAvatar displayName={user.display_name} avatarKey={user.avatar_key} />
        );
        if (manageable) {
          return (
            <ListItem
              title={title}
              leading={leading}
              trailing={trailing}
              onPress={() => openManage(user.id)}
              testID={`members-list-item-${user.id}`}
            />
          );
        }
        return (
          <ListItem
            title={title}
            leading={leading}
            trailing={trailing}
            testID={`members-list-item-${user.id}`}
          />
        );
      }
      case "invites-header":
        return (
          <View style={s.sectionHeader}>
            <AppText role="subheading">Invites</AppText>
            <Button
              title="Invite to trip"
              size="sm"
              icon="person-add-outline"
              loading={createInvite.isPending}
              onPress={() => setInviteSheetOpen(true)}
              testID="members-button-invite"
            />
          </View>
        );
      case "invite": {
        const invite = row.item;
        const canRevoke = callerRole === "owner" || invite.created_by === me?.id;
        return (
          <ListItem
            title={invite.role === "editor" ? "Editor invite" : "Viewer invite"}
            subtitle={`Expires ${invite.expires_at.slice(0, 10)} · ${invite.use_count}${
              invite.max_uses !== null ? `/${invite.max_uses}` : ""
            } uses`}
            trailing={
              canRevoke ? (
                <Button
                  title="Revoke"
                  variant="ghost"
                  size="sm"
                  onPress={() => setDialog({ kind: "revoke", inviteId: invite.id })}
                  testID={`members-button-revoke-${invite.id}`}
                />
              ) : undefined
            }
            testID={`members-list-item-invite-${invite.id}`}
          />
        );
      }
      case "invites-empty":
        return (
          <AppText role="caption" color="muted" style={s.emptyCaption}>
            No active invites yet.
          </AppText>
        );
      case "invites-error":
        return (
          <ErrorBanner
            message="Couldn't load invites."
            onRetry={() => void invites.refetch()}
            testID="members-banner-invites"
          />
        );
    }
  };

  let body;
  if (members.isPending) {
    body = (
      <View style={s.loading} testID="members-loading">
        <Skeleton variant="text" lines={4} />
      </View>
    );
  } else if (members.isError) {
    body = (
      <View style={s.banner}>
        <ErrorBanner
          message="Couldn't load members."
          onRetry={() => void members.refetch()}
          testID="members-banner-load"
        />
      </View>
    );
  } else {
    body = (
      <FlatList
        data={rows}
        renderItem={renderRow}
        keyExtractor={(row) => {
          switch (row.type) {
            case "member":
              return `member-${row.item.user.id}`;
            case "invite":
              return `invite-${row.item.id}`;
            default:
              return row.type;
          }
        }}
        contentContainerStyle={s.list}
      />
    );
  }

  return (
    <View style={s.screen} testID="members-screen">
      <PageHeader title="Members" leading="back" testID="members-header" />
      {banner !== null ? (
        <View style={s.banner}>
          <ErrorBanner message={banner} onDismiss={() => setBanner(null)} testID="members-banner" />
        </View>
      ) : null}
      {body}

      {/* Owner's per-member manage sheet (§2.5: role change / remove / make
          owner). Actions close the sheet before their ConfirmDialog opens —
          modals never stack on modals (nav §2.6). */}
      <Sheet
        visible={managed !== undefined}
        onDismiss={() => setManagedId(null)}
        title={managed?.user.display_name}
        testID="members-sheet-manage"
      >
        {managed !== undefined && manageMode === "actions" ? (
          <>
            <ListItem
              title="Change role"
              subtitle={`Currently ${managed.role}`}
              onPress={() => setManageMode("role")}
              testID={`members-button-role-${managed.user.id}`}
            />
            <ListItem
              title="Make owner"
              subtitle="Transfer ownership of this trip"
              onPress={() => {
                const { user } = managed;
                setManagedId(null);
                setDialog({ kind: "transfer", userId: user.id, name: user.display_name });
              }}
              testID={`members-button-transfer-${managed.user.id}`}
            />
            <ListItem
              title="Remove from trip"
              onPress={() => {
                const { user } = managed;
                setManagedId(null);
                setDialog({ kind: "remove", userId: user.id, name: user.display_name });
              }}
              testID={`members-button-remove-${managed.user.id}`}
            />
          </>
        ) : null}
        {managed !== undefined && manageMode === "role" ? (
          <>
            <ListItem
              title="Editor"
              subtitle="Can edit plans and invite others"
              trailing={managed.role === "editor" ? <Icon name="checkmark" size={18} /> : undefined}
              onPress={() => pickRole(managed.user.id, "editor", managed.role)}
              testID={`members-button-role-${managed.user.id}-editor`}
            />
            <ListItem
              title="Viewer"
              subtitle="Can view plans and take part in expenses"
              trailing={managed.role === "viewer" ? <Icon name="checkmark" size={18} /> : undefined}
              onPress={() => pickRole(managed.user.id, "viewer", managed.role)}
              testID={`members-button-role-${managed.user.id}-viewer`}
            />
          </>
        ) : null}
      </Sheet>

      {/* Invite role choice (R-tripui-16: defaults to editor — listed first). */}
      <Sheet
        visible={inviteSheetOpen}
        onDismiss={() => setInviteSheetOpen(false)}
        title="Invite to trip"
        testID="members-sheet-invite"
      >
        <ListItem
          title="Invite as editor"
          subtitle="Can edit plans and invite others"
          onPress={() => sendInvite("editor")}
          testID="members-button-invite-editor"
        />
        <ListItem
          title="Invite as viewer"
          subtitle="Can view plans and take part in expenses"
          onPress={() => sendInvite("viewer")}
          testID="members-button-invite-viewer"
        />
      </Sheet>

      {/* One ConfirmDialog, props by kind. Base testID = the triggering
          action's (§2.7 derivation convention — children derive -confirm /
          -cancel, same as trip-new-button-cancel-confirm). */}
      {dialog !== null ? (
        <ConfirmDialog
          visible
          {...dialogProps(dialog)}
          onConfirm={confirmDialog}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </View>
  );
}

function dialogProps(dialog: NonNullable<Dialog>): {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  testID: string;
} {
  switch (dialog.kind) {
    case "remove":
      return {
        title: `Remove ${dialog.name} from this trip?`,
        body: "They'll lose access right away. Their expenses and balances stay in the trip's history.",
        confirmLabel: "Remove",
        destructive: true,
        testID: `members-button-remove-${dialog.userId}`,
      };
    case "transfer":
      return {
        title: `Make ${dialog.name} the owner?`,
        body: "They'll take over this trip and you'll become an editor. Only the owner can delete the trip or manage members.",
        confirmLabel: "Make owner",
        testID: `members-button-transfer-${dialog.userId}`,
      };
    case "revoke":
      return {
        title: "Revoke this invite?",
        body: "Anyone with this link will no longer be able to join.",
        confirmLabel: "Revoke",
        destructive: true,
        testID: `members-button-revoke-${dialog.inviteId}`,
      };
  }
}
