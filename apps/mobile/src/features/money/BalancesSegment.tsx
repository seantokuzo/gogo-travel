/**
 * Balances segment (T-9.5 / CMON-4 — R-cmoney-6/29/30/32; §2.2 "Balances").
 *
 * Composition (one FlatList — the transfer set is O(members²) worst case,
 * so it virtualizes; header rides `ListHeaderComponent`):
 *
 * - headline Card — the caller's position ("You're owed X" / "You owe X" /
 *   settled), SIGNED via the shared formatter only (Law #2);
 * - member chips — the trip ROSTER (`GET /members`) joined with the B1 nets
 *   (absent = 0, settled): net-signed status colors, chip tap → settle
 *   screen (§2.6 step 1), self chip inert;
 * - transfer list — PAIRWISE BY DEFAULT with the one-tap "Simplify debts"
 *   toggle to the API's `simplified` array (R-cmoney-6, resolved Gate 2 —
 *   Splitwise trust precedent); the toggle is per-VIEW `useState`, never
 *   persisted, so a remount re-defaults (pinned). Rows where the caller
 *   sits in either seat carry the action chevron and open
 *   `settle/[memberId]` — the debtor arm settles there directly, the
 *   creditor arm lands on that screen's R-cmoney-23 "Request payment" view
 *   (the §2.7 send-the-bill entry; the flow itself is T-9.7's).
 * - open-request annotations (§2.7 step 5) — subdued "Requested X on date"
 *   on matching rows, fed by the `openRequests` SEAM (see transfers.ts:
 *   no list endpoint exists on the wire, so this is fixture-tested and
 *   empty-in-prod until T-9.7 — the P-8 photo-pin precedent).
 *
 * Ex-members can legitimately appear in balances (T-9.2 kept departed
 * payers' expenses); the members read excludes them, so their rows label
 * "Former member".
 *
 * States (R-cmoney-29): "All settled up" EmptyState when no transfers ·
 * skeleton while the reads settle · ErrorBanner + retry on failure ·
 * offline = cached render + informational banner (R-cmoney-30/32 degrade
 * posture; no mutations live here — settle/request writes are T-9.7's).
 */
import type { BalancesRead, SettleRequest, TripWithRole } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { useSessionStore } from "@/auth";
import { AppText, Card, EmptyState, ErrorBanner, Icon, ListItem, Skeleton } from "@/components";
import { useTripBalances, useTripMembers, useTripOffline } from "@/data";

import { moneyLabel, signedMoneyLabel } from "./money-format";
import { buildTransferRows, type TransferRow, type TransferView } from "./transfers";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    segment: { flex: 1 },
    banner: { paddingHorizontal: t.space[4], paddingTop: t.space[2] },
    skeleton: { padding: t.space[4], gap: t.space[3] },
    state: { flex: 1, justifyContent: "center" },
    header: { padding: t.space[4], gap: t.space[3] },
    chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[1],
      borderRadius: t.radius.full,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      paddingHorizontal: t.space[3],
      minHeight: t.touchTarget,
    },
    toggle: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      minHeight: t.touchTarget,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      paddingHorizontal: t.space[3],
    },
    toggleOn: {
      borderColor: t.color.primary.solid,
      backgroundColor: t.color.bg.inset,
    },
    trailing: { flexDirection: "row", alignItems: "center", gap: t.space[2] },
  }),
);

export interface BalancesSegmentProps {
  trip: TripWithRole;
  /** Open-request annotation SEAM (module doc) — prod passes nothing (yet). */
  openRequests?: readonly SettleRequest[];
}

export function BalancesSegment({ trip, openRequests }: BalancesSegmentProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const router = useRouter();
  const me = useSessionStore((state) => state.user);
  const balances = useTripBalances(trip.id);
  const members = useTripMembers(trip.id);
  const offline = useTripOffline(trip.id);
  /** R-cmoney-6: per-view control, never persisted — remount re-defaults. */
  const [view, setView] = useState<TransferView>("pairwise");

  const callerId = me?.id ?? "";
  const settled = balances.data !== undefined && members.data !== undefined;
  const failed = balances.isError || members.isError;
  const retry = () => {
    if (balances.isError) void balances.refetch();
    if (members.isError) void members.refetch();
  };

  const names = useMemo(
    () => new Map((members.data?.items ?? []).map((m) => [m.user.id, m.user.display_name])),
    [members.data],
  );
  const nameFor = (userId: string): string => {
    if (userId === callerId) return "You";
    return names.get(userId) ?? "Former member";
  };

  const transfers = useMemo(
    () =>
      balances.data === undefined
        ? []
        : buildTransferRows(balances.data, view, callerId, openRequests ?? []),
    [balances.data, callerId, openRequests, view],
  );

  const openSettle = (memberId: string) => {
    router.push({
      pathname: "/[tripId]/money/settle/[memberId]",
      params: { tripId: trip.id, memberId },
    });
  };

  if (!settled) {
    if (failed) {
      return (
        <View style={s.banner}>
          <ErrorBanner
            message={
              offline
                ? "You're offline and this trip's balances aren't cached yet."
                : "Couldn't load the balances."
            }
            onRetry={retry}
            testID="money-balances-error"
          />
        </View>
      );
    }
    return (
      <View style={s.skeleton} testID="money-balances-loading">
        <Skeleton variant="rect" height={88} />
        <Skeleton variant="rect" height={44} />
        <Skeleton variant="rect" height={56} />
        <Skeleton variant="rect" height={56} />
      </View>
    );
  }

  const doc: BalancesRead = balances.data;
  const currency = doc.currency;
  const nets = new Map(doc.members.map((m) => [m.user_id, m.net_cents]));
  const myNet = nets.get(callerId) ?? 0;
  const netColor = (net: number): string =>
    net > 0
      ? theme.color.status.success.fg
      : net < 0
        ? theme.color.status.danger.fg
        : theme.color.text.secondary;

  const header = (
    <View style={s.header}>
      {/* Caller headline (R-cmoney-6a). */}
      <Card testID="money-headline-balances">
        <AppText role="heading" style={{ color: netColor(myNet) }}>
          {myNet > 0
            ? `You're owed ${moneyLabel(myNet, currency)}`
            : myNet < 0
              ? `You owe ${moneyLabel(-myNet, currency)}`
              : "You're all settled up"}
        </AppText>
      </Card>

      {/* Per-member net chips (R-cmoney-6b) — roster ∪ nets, absent = 0. */}
      <View style={s.chipsRow}>
        {(members.data?.items ?? []).map((member) => {
          const userId = member.user.id;
          const net = nets.get(userId) ?? 0;
          const label = (
            <>
              <AppText role="caption">{nameFor(userId)}</AppText>
              <AppText role="caption" style={{ color: netColor(net) }}>
                {signedMoneyLabel(net, currency)}
              </AppText>
            </>
          );
          if (userId === callerId) {
            return (
              <View key={userId} style={s.chip} testID={`money-balance-list-item-${userId}`}>
                {label}
              </View>
            );
          }
          return (
            <Pressable
              key={userId}
              style={s.chip}
              onPress={() => openSettle(userId)}
              accessibilityRole="button"
              accessibilityLabel={`${nameFor(userId)}, ${signedMoneyLabel(net, currency)}`}
              testID={`money-balance-list-item-${userId}`}
            >
              {label}
            </Pressable>
          );
        })}
      </View>

      {/* R-cmoney-6c: pairwise default; one-tap simplify view toggle. */}
      <Pressable
        style={[s.toggle, view === "simplified" && s.toggleOn]}
        onPress={() => setView(view === "simplified" ? "pairwise" : "simplified")}
        accessibilityRole="switch"
        accessibilityState={{ checked: view === "simplified" }}
        accessibilityLabel="Simplify debts"
        testID="money-toggle-simplify"
      >
        <AppText role="body">Simplify debts</AppText>
        <AppText role="caption" color="secondary">
          {view === "simplified" ? "Fewest transfers" : "Who paid whom"}
        </AppText>
      </Pressable>
    </View>
  );

  const renderRow = ({ item }: { item: TransferRow }) => {
    const title = `${nameFor(item.from_user_id)} → ${nameFor(item.to_user_id)}`;
    const subtitle =
      item.annotation === null
        ? undefined
        : `Requested ${moneyLabel(item.annotation.amount_cents, currency)} on ${new Date(item.annotation.created_at).toLocaleDateString()}`;
    const trailing = (
      <View style={s.trailing}>
        <AppText role="bodyStrong">{moneyLabel(item.amount_cents, currency)}</AppText>
        {item.counterpartyId !== null ? (
          <Icon name="chevron-forward" size={18} color={theme.color.text.muted} />
        ) : null}
      </View>
    );
    const testID = `money-transfer-list-item-${item.from_user_id}-${item.to_user_id}`;
    if (item.counterpartyId === null) {
      // Caller uninvolved: no action affordance (R-cmoney-6 — rows are
      // actionable only for their own parties).
      return (
        <ListItem
          title={title}
          {...(subtitle === undefined ? {} : { subtitle })}
          trailing={trailing}
          testID={testID}
        />
      );
    }
    const counterpartyId = item.counterpartyId;
    return (
      <ListItem
        title={title}
        {...(subtitle === undefined ? {} : { subtitle })}
        trailing={trailing}
        onPress={() => openSettle(counterpartyId)}
        testID={testID}
      />
    );
  };

  return (
    <View style={s.segment}>
      {offline ? (
        <View style={s.banner}>
          {/* Offline is a STATE (R-itin-29 posture) — cached balances render,
              banner informs, no retry lie. */}
          <ErrorBanner
            tone="warning"
            message="You're offline — showing your last synced balances."
            testID="money-banner-offline"
          />
        </View>
      ) : null}
      {failed && !offline ? (
        <View style={s.banner}>
          <ErrorBanner
            message="Couldn't refresh the balances."
            onRetry={retry}
            testID="money-balances-refresh-error"
          />
        </View>
      ) : null}
      <FlatList
        data={transfers}
        keyExtractor={(item) => `${item.from_user_id}-${item.to_user_id}`}
        renderItem={renderRow}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={s.state}>
            {/* R-cmoney-29: balances all zero → "All settled up". */}
            <EmptyState
              icon="checkmark-circle-outline"
              title="All settled up"
              body="Nobody owes anybody — go spend something."
              testID="money-balances-empty"
            />
          </View>
        }
        testID="money-transfer-list"
      />
    </View>
  );
}
