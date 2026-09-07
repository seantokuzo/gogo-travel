/**
 * Expense detail (T-9.6 / CMON-2 — R-cmoney-13; §2.1: PUSH). Shows
 * amount/currency AS LOGGED (shared formatter only — Law #2), payer, date,
 * category, the full shares breakdown per member, the linked booking
 * (tappable through to booking detail — cross-tab, so the jump goes through
 * `jumpToTripTab` + push, the sanctioned MapPlaceSheet convention), and
 * edit/delete for the expense creator or trip owner (R-money-26).
 *
 * Delete is a ConfirmDialog-gated SOFT delete (R-cmoney-13/R-money-27):
 * the row survives as the audit record, balances exclude it, and this
 * screen renders the visible audit state ("X deleted 'Dinner …'") when the
 * E3 read comes back deleted — E3 deliberately returns soft-deleted rows
 * with the audit pair populated (T-9.2 recorded interpretation).
 */
import { UuidSchema } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { useSessionStore } from "@/auth";
import {
  AppText,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  ListItem,
  PageHeader,
  Skeleton,
} from "@/components";
import { useDeleteExpense, useExpense, useTripMembers, useTripOffline } from "@/data";
import { EXPENSE_CATEGORY_LABELS, moneyLabel } from "@/features/money";
import { jumpToTripTab } from "@/navigation/tab-jump";
import { useTripContext } from "@/navigation/trip-context";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    content: { padding: t.space[4], gap: t.space[4], paddingBottom: t.space[8] },
    state: { flex: 1, justifyContent: "center" },
    headlineRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: t.space[3],
    },
    meta: { gap: t.space[1] },
    section: { gap: t.space[2] },
    actions: { gap: t.space[3] },
  }),
);

/** ISO date → local display without the UTC-midnight day-shift landmine. */
function displayDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString();
}

export default function ExpenseDetailScreen() {
  const trip = useTripContext();
  const router = useRouter();
  const navigation = useNavigation();
  const s = useStyles();
  const me = useSessionStore((state) => state.user);
  const { expenseId: rawExpenseId } = useLocalSearchParams<{ expenseId: string }>();

  // Malformed/repeated route param degrades to the gone state — the server
  // folds a bad id into the same indistinguishable 404 anyway.
  const expenseId =
    typeof rawExpenseId === "string" && UuidSchema.safeParse(rawExpenseId).success
      ? rawExpenseId
      : undefined;

  const expenseQuery = useExpense(trip.id, expenseId ?? "", { enabled: expenseId !== undefined });
  const members = useTripMembers(trip.id);
  const offline = useTripOffline(trip.id);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [deleteError, setDeleteError] = useState(false);
  const deleteExpense = useDeleteExpense(trip.id, {
    onMutationSuccess: () => {
      // Mounted guard (itinerary precedent): a slow delete settling after
      // the user already left must not pop their new screen.
      if (!mountedRef.current) return;
      router.back();
    },
    onMutationError: () => setDeleteError(true),
  });

  const callerId = me?.id ?? "";
  const names = useMemo(
    () => new Map((members.data?.items ?? []).map((m) => [m.user.id, m.user.display_name])),
    [members.data],
  );
  const nameFor = (userId: string): string => {
    if (userId === callerId) return "You";
    return names.get(userId) ?? "Former member";
  };

  let body;
  if (expenseId === undefined) {
    body = (
      <View style={s.state}>
        <EmptyState
          icon="alert-circle-outline"
          title="Expense not found"
          body="This expense no longer exists."
          testID="expense-detail-missing"
        />
      </View>
    );
  } else if (expenseQuery.data === undefined || members.data === undefined) {
    if (expenseQuery.isError || members.isError) {
      body = (
        <ErrorBanner
          message={
            offline
              ? "You're offline and this expense isn't cached yet."
              : "Couldn't load the expense."
          }
          onRetry={() => {
            if (expenseQuery.isError) void expenseQuery.refetch();
            if (members.isError) void members.refetch();
          }}
          testID="expense-detail-error"
        />
      );
    } else {
      body = <Skeleton variant="rect" height={240} testID="expense-detail-loading" />;
    }
  } else {
    const expense = expenseQuery.data;
    const deleted = expense.deleted_at !== null;
    const canEdit = !deleted && (expense.created_by === callerId || trip.role === "owner");
    const amount = moneyLabel(expense.amount_cents, expense.currency);

    body = (
      <>
        {offline ? (
          <ErrorBanner
            tone="warning"
            message="You're offline — showing the last synced version."
            testID="money-banner-offline"
          />
        ) : null}
        {deleteError ? (
          <ErrorBanner
            message="Couldn't delete the expense. Try again."
            onDismiss={() => setDeleteError(false)}
            testID="expense-detail-delete-error"
          />
        ) : null}
        {deleted ? (
          // R-money-27's visible audit trail: the deletion IS the record.
          <ErrorBanner
            tone="warning"
            message={`${
              expense.deleted_by !== null ? nameFor(expense.deleted_by) : "A member"
            } deleted "${expense.description} (${amount})" — balances no longer include it.`}
            testID="expense-detail-deleted"
          />
        ) : null}

        <Card>
          <View style={s.headlineRow}>
            <AppText role="heading">{amount}</AppText>
            <Badge label={EXPENSE_CATEGORY_LABELS[expense.category]} tone="neutral" />
          </View>
          <View style={s.meta}>
            <AppText role="subheading">{expense.description}</AppText>
            <AppText role="caption" color="secondary">
              Paid by {nameFor(expense.paid_by)} · {displayDate(expense.spent_at)}
            </AppText>
          </View>
        </Card>

        <View style={s.section}>
          <AppText role="caption" color="secondary">
            Split
          </AppText>
          {/* The R-money-2 sum invariant guarantees ≥ 1 share row — an empty
              breakdown is not a representable wire state. */}
          {expense.shares.map((share) => (
            <ListItem
              key={share.user_id}
              title={nameFor(share.user_id)}
              trailing={
                <AppText role="bodyStrong">
                  {moneyLabel(share.share_cents, expense.currency)}
                </AppText>
              }
              testID={`expense-detail-list-item-share-${share.user_id}`}
            />
          ))}
        </View>

        {expense.booking_id !== null ? (
          <Button
            title="View linked booking"
            variant="ghost"
            onPress={() => {
              const bookingId = expense.booking_id;
              if (bookingId === null) return;
              // Cross-tab landmine (mobile.md): the booking screen lives in
              // the itinerary tab — jump the TAB navigator first, then push.
              if (!jumpToTripTab(navigation, trip.id, "itinerary")) return;
              router.push({
                pathname: "/[tripId]/itinerary/booking/[bookingId]",
                params: { tripId: trip.id, bookingId },
              });
            }}
            testID="expense-detail-button-booking"
          />
        ) : null}

        {canEdit ? (
          <View style={s.actions}>
            <Button
              title="Edit expense"
              variant="secondary"
              onPress={() =>
                router.push({
                  pathname: "/[tripId]/money/expense/new",
                  params: { tripId: trip.id, expenseId: expense.id },
                })
              }
              testID="expense-detail-button-edit"
            />
            <Button
              title="Delete expense"
              variant="ghost"
              onPress={() => setConfirmVisible(true)}
              loading={deleteExpense.isPending}
              testID="expense-detail-button-delete"
            />
          </View>
        ) : null}

        <ConfirmDialog
          visible={confirmVisible}
          title="Delete this expense?"
          body={`"${expense.description}" comes out of everyone's balances. The deletion stays visible on the record.`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            setConfirmVisible(false);
            deleteExpense.mutate(expense.id);
          }}
          onCancel={() => setConfirmVisible(false)}
          testID="expense-detail-button-delete"
        />
      </>
    );
  }

  return (
    <View style={s.screen} testID="expense-detail-screen">
      <PageHeader title="Expense" leading="back" testID="expense-detail-header" />
      <ScrollView contentContainerStyle={s.content}>{body}</ScrollView>
    </View>
  );
}
