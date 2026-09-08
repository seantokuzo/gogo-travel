/**
 * Expenses segment (T-9.6 / CMON-2 — R-cmoney-5/29/30/32, §2.2 "Expenses").
 * Fills the FROZEN W4 seam T-9.5 left: the call site's `{ trip }` prop is
 * unchanged; navigation stays router-owned in here.
 *
 * Composition (one FlatList — expense lists grow unbounded, so it
 * virtualizes; the filter row rides `ListHeaderComponent`):
 *
 * - list rows, newest first per the SERVER's E2 order (`spent_at DESC,
 *   created_at DESC`): description, category Badge, "Paid by {name}",
 *   `spent_at`, amount in its LOGGED currency (shared formatter only —
 *   Law #2), and the subdued per-item "your share" line (rendered when the
 *   caller holds a share row — absent means not involved);
 * - infinite scroll on the shared `Paginated` cursor (server default 50 /
 *   cap 100 — `useTripExpenses` consumes `nextCursor` until null);
 * - member + category filters in a Sheet (nav §2.6 "filters") — applied on
 *   tap, per-view state (never persisted), with the §2.9 "no matches"
 *   EmptyState + clear-filters action when a filter empties the list;
 * - add-expense FAB for EVERY member INCLUDING viewers (R-cmoney-5; api
 *   R-money-26) → the `expense/new` modal; the empty state adds a finite
 *   FAB pulse hint (§2.9 — reduce-motion honored, native-driver transform);
 * - ex-member payers label "Former member" (T-9.2 keeps departed payers'
 *   expenses — the BalancesSegment convention).
 *
 * States (R-cmoney-29): "No expenses yet" EmptyState + add CTA · skeleton
 * while the reads settle · ErrorBanner + retry on failure · offline =
 * cached render + informational banner (R-itin-29 posture — mutations live
 * on the form modal, not here).
 */
import type { Expense, TripWithRole } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Animated, FlatList, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSessionStore } from "@/auth";
import {
  AppText,
  Badge,
  EmptyState,
  ErrorBanner,
  Icon,
  ListItem,
  Sheet,
  Skeleton,
  useReduceMotion,
} from "@/components";
import { useTripExpenses, useTripMembers, useTripOffline, type ExpenseListFilters } from "@/data";
import { Fab } from "@/features/trips";

import { EXPENSE_CATEGORY_LABELS, EXPENSE_CATEGORY_OPTIONS } from "./expenses/expense-form-model";
import { moneyLabel } from "./money-format";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    segment: { flex: 1 },
    banner: { paddingHorizontal: t.space[4], paddingTop: t.space[2] },
    skeleton: { padding: t.space[4], gap: t.space[3] },
    state: { flex: 1, justifyContent: "center" },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      paddingHorizontal: t.space[4],
      paddingVertical: t.space[2],
    },
    filterButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[2],
      minHeight: t.touchTarget,
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      paddingHorizontal: t.space[3],
    },
    filterOn: {
      borderColor: t.color.primary.solid,
      backgroundColor: t.color.bg.inset,
    },
    trailingColumn: { alignItems: "flex-end", gap: 2 },
    sheetSection: { gap: t.space[2], paddingBottom: t.space[3] },
    chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
    chip: {
      borderRadius: t.radius.full,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      paddingHorizontal: t.space[3],
      minHeight: t.touchTarget,
      justifyContent: "center",
    },
    chipOn: {
      borderColor: t.color.primary.solid,
      backgroundColor: t.color.bg.inset,
    },
    clearRow: { paddingTop: t.space[2] },
    // Mirrors the Fab's own 56pt frame + right inset (its module constants);
    // `bottom` needs the runtime safe-area inset, applied inline.
    pulseRing: {
      position: "absolute",
      right: t.space[4],
      width: 56,
      height: 56,
      borderRadius: t.radius.full,
    },
  }),
);

/** ISO date → local display without the UTC-midnight day-shift landmine. */
function displayDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString();
}

export interface ExpensesSegmentProps {
  trip: TripWithRole;
}

export function ExpensesSegment({ trip }: ExpensesSegmentProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useSessionStore((state) => state.user);
  /** Per-VIEW filters (R-cmoney-5) — never persisted; remount clears. */
  const [filters, setFilters] = useState<ExpenseListFilters>({});
  const [filterOpen, setFilterOpen] = useState(false);

  const expenses = useTripExpenses(trip.id, filters);
  const members = useTripMembers(trip.id);
  const offline = useTripOffline(trip.id);
  const reduceMotion = useReduceMotion();

  const callerId = me?.id ?? "";
  const settled = expenses.data !== undefined && members.data !== undefined;
  const failed = expenses.isError || members.isError;
  const retry = () => {
    if (expenses.isError) void expenses.refetch();
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

  const items = useMemo(
    () => expenses.data?.pages.flatMap((page) => page.items) ?? [],
    [expenses.data],
  );
  const filtersActive = filters.member !== undefined || filters.category !== undefined;
  const filterCount =
    (filters.member !== undefined ? 1 : 0) + (filters.category !== undefined ? 1 : 0);

  const openNew = () => {
    router.push({
      pathname: "/[tripId]/money/expense/new",
      params: { tripId: trip.id },
    });
  };
  const openDetail = (expenseId: string) => {
    router.push({
      pathname: "/[tripId]/money/expense/[expenseId]",
      params: { tripId: trip.id, expenseId },
    });
  };

  // §2.9 "FAB pulse hint" — a ring SIBLING behind the FAB (the Fab anchors
  // itself absolutely, so wrapping it would break its position). FINITE
  // (3 cycles, native-driver scale+fade, no React re-render, nothing left
  // looping for jest or low-power devices), and only when motion is welcome.
  const [ringScale] = useState(() => new Animated.Value(1));
  const [ringOpacity] = useState(() => new Animated.Value(0));
  const shouldPulse = settled && items.length === 0 && !filtersActive && !reduceMotion;
  useEffect(() => {
    if (!shouldPulse) return undefined;
    const cycle = Animated.parallel([
      Animated.sequence([
        Animated.timing(ringScale, { toValue: 1, duration: 0, useNativeDriver: true }),
        Animated.timing(ringScale, { toValue: 1.5, duration: 700, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.timing(ringOpacity, { toValue: 0.35, duration: 0, useNativeDriver: true }),
        Animated.timing(ringOpacity, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    ]);
    const loop = Animated.loop(cycle, { iterations: 3 });
    loop.start();
    return () => loop.stop();
  }, [shouldPulse, ringScale, ringOpacity]);

  if (!settled) {
    if (failed) {
      return (
        <View style={s.segment}>
          <View style={s.banner}>
            <ErrorBanner
              message={
                offline
                  ? "You're offline and this trip's expenses aren't cached yet."
                  : "Couldn't load the expenses."
              }
              onRetry={retry}
              testID="money-expenses-error"
            />
          </View>
          <Fab icon="add" label="Add expense" onPress={openNew} testID="money-fab-add-expense" />
        </View>
      );
    }
    return (
      <View style={s.segment}>
        <View style={s.skeleton} testID="money-expenses-loading">
          <Skeleton variant="rect" height={56} />
          <Skeleton variant="rect" height={56} />
          <Skeleton variant="rect" height={56} />
        </View>
        <Fab icon="add" label="Add expense" onPress={openNew} testID="money-fab-add-expense" />
      </View>
    );
  }

  const header = (
    <View style={s.headerRow}>
      <Pressable
        style={[s.filterButton, filtersActive && s.filterOn]}
        onPress={() => setFilterOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={filtersActive ? `Filters, ${filterCount} active` : "Filter expenses"}
        testID="money-button-filter"
      >
        <Icon name="filter" size={16} color={theme.color.text.secondary} />
        <AppText role="caption">{filtersActive ? `Filters (${filterCount})` : "Filters"}</AppText>
      </Pressable>
    </View>
  );

  const renderRow = ({ item }: { item: Expense }) => {
    const payer = nameFor(item.paid_by);
    const amount = moneyLabel(item.amount_cents, item.currency);
    const myShare = item.shares.find((share) => share.user_id === callerId);
    return (
      <ListItem
        title={item.description}
        subtitle={`Paid by ${payer} · ${displayDate(item.spent_at)}`}
        leading={<Badge label={EXPENSE_CATEGORY_LABELS[item.category]} tone="neutral" />}
        trailing={
          <View style={s.trailingColumn}>
            <AppText role="bodyStrong">{amount}</AppText>
            {myShare !== undefined ? (
              <AppText role="caption" color="secondary">
                Your share: {moneyLabel(myShare.share_cents, item.currency)}
              </AppText>
            ) : null}
          </View>
        }
        onPress={() => openDetail(item.id)}
        accessibilityLabel={`${item.description}, ${amount}, paid by ${payer}${
          myShare !== undefined
            ? `, your share ${moneyLabel(myShare.share_cents, item.currency)}`
            : ""
        }`}
        testID={`money-expense-list-item-${item.id}`}
      />
    );
  };

  const memberChip = (userId: string) => {
    const active = filters.member === userId;
    return (
      <Pressable
        key={userId}
        style={[s.chip, active && s.chipOn]}
        onPress={() =>
          setFilters((prev) => {
            const { member: _member, ...rest } = prev;
            return active ? rest : { ...rest, member: userId };
          })
        }
        accessibilityRole="radio"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`Filter by ${nameFor(userId)}`}
        testID={`money-sheet-filter-member-${userId}`}
      >
        <AppText role="caption">{nameFor(userId)}</AppText>
      </Pressable>
    );
  };

  return (
    <View style={s.segment}>
      {offline ? (
        <View style={s.banner}>
          {/* Offline is a STATE (R-itin-29 posture) — cached rows render,
              banner informs, no retry lie. */}
          <ErrorBanner
            tone="warning"
            message="You're offline — showing your last synced expenses."
            testID="money-banner-offline"
          />
        </View>
      ) : null}
      {failed && !offline ? (
        <View style={s.banner}>
          <ErrorBanner
            message="Couldn't refresh the expenses."
            onRetry={retry}
            testID="money-expenses-refresh-error"
          />
        </View>
      ) : null}

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={renderRow}
        ListHeaderComponent={header}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (expenses.hasNextPage && !expenses.isFetchingNextPage) {
            void expenses.fetchNextPage();
          }
        }}
        ListFooterComponent={
          expenses.isFetchingNextPage ? (
            <View style={s.skeleton} testID="money-expense-list-footer-loading">
              <Skeleton variant="rect" height={56} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={s.state}>
            {filtersActive ? (
              <EmptyState
                icon="funnel-outline"
                title="No matches"
                body="Nothing fits these filters."
                action={{
                  label: "Clear filters",
                  onPress: () => setFilters({}),
                  testID: "money-expenses-clear-filters",
                }}
                testID="money-expenses-no-matches"
              />
            ) : (
              <EmptyState
                icon="receipt-outline"
                title="No expenses yet"
                body="Log the first one — every member can, viewers included."
                action={{
                  label: "Add expense",
                  onPress: openNew,
                  testID: "money-expenses-empty-add",
                }}
                testID="money-expenses-empty"
              />
            )}
          </View>
        }
        testID="money-expense-list"
      />

      {shouldPulse ? (
        <Animated.View
          pointerEvents="none"
          testID="money-fab-pulse-hint"
          style={[
            s.pulseRing,
            {
              bottom: insets.bottom + theme.space[4],
              backgroundColor: theme.color.primary.solid,
              opacity: ringOpacity,
              transform: [{ scale: ringScale }],
            },
          ]}
        />
      ) : null}
      <Fab icon="add" label="Add expense" onPress={openNew} testID="money-fab-add-expense" />

      <Sheet
        visible={filterOpen}
        onDismiss={() => setFilterOpen(false)}
        title="Filter expenses"
        testID="money-sheet-filter"
      >
        <View style={s.sheetSection}>
          <AppText role="caption" color="secondary">
            Member
          </AppText>
          <View style={s.chipsRow}>
            {(members.data?.items ?? []).map((member) => memberChip(member.user.id))}
          </View>
        </View>
        <View style={s.sheetSection}>
          <AppText role="caption" color="secondary">
            Category
          </AppText>
          <View style={s.chipsRow}>
            {EXPENSE_CATEGORY_OPTIONS.map((option) => {
              const active = filters.category === option;
              return (
                <Pressable
                  key={option}
                  style={[s.chip, active && s.chipOn]}
                  onPress={() =>
                    setFilters((prev) => {
                      const { category: _category, ...rest } = prev;
                      return active ? rest : { ...rest, category: option };
                    })
                  }
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Filter by ${EXPENSE_CATEGORY_LABELS[option]}`}
                  testID={`money-sheet-filter-category-${option}`}
                >
                  <AppText role="caption">{EXPENSE_CATEGORY_LABELS[option]}</AppText>
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={s.clearRow}>
          <Pressable
            style={s.filterButton}
            onPress={() => {
              setFilters({});
              setFilterOpen(false);
            }}
            accessibilityRole="button"
            accessibilityLabel="Clear filters"
            testID="money-sheet-filter-clear"
          >
            <AppText role="caption">Clear filters</AppText>
          </Pressable>
        </View>
      </Sheet>
    </View>
  );
}
