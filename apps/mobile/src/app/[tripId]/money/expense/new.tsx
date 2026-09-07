/**
 * Add/edit expense (T-9.6 / CMON-3 — client money spec §2.1: MODAL per nav
 * R-nav-21; `?expenseId=` = edit, mirroring `itinerary/item/new`). The host
 * owns chrome + the dirty-dismissal guard (nav §2.6 form-modal rule:
 * ANY removal of a dirty form funnels through `beforeRemove` → discard
 * ConfirmDialog; a save bypasses); `ExpenseForm` owns the fields.
 *
 * Roles (api R-money-26, resolved Gate 2): CREATE is open to every member
 * INCLUDING viewers (travelers, not spectators — no viewer lock here);
 * EDIT is expense-creator-or-trip-owner — an unauthorized opener gets an
 * EmptyState, never a guaranteed-403 form (the R-ib-24 posture). A
 * soft-DELETED expense is uneditable (server PATCH 409s — the audit trail
 * stays what the deleter deleted).
 */
import { UuidSchema } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useLocalSearchParams, useNavigation, useRouter, type Href } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";

import { useSessionStore } from "@/auth";
import { ConfirmDialog, EmptyState, ErrorBanner, PageHeader, Skeleton } from "@/components";
import { useExpense, useTripMembers } from "@/data";
import { ExpenseForm } from "@/features/money";
import { useTripContext } from "@/navigation/trip-context";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    flex: { flex: 1 },
    content: { padding: t.space[4], gap: t.space[4], paddingBottom: t.space[8] },
    state: { flex: 1, justifyContent: "center" },
  }),
);

export default function ExpenseNewScreen() {
  const trip = useTripContext();
  const router = useRouter();
  const navigation = useNavigation();
  const s = useStyles();
  const me = useSessionStore((state) => state.user);
  const params = useLocalSearchParams<{ expenseId?: string }>();

  const [dirty, setDirty] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const bypassGuardRef = useRef(false);
  const pendingDismissRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Edit id validated against the shared scalar — a malformed/repeated deep
  // link degrades to the "gone" state, NEVER to a blank create (a surprise
  // duplicate is worse than a dead end).
  const rawExpenseId = params.expenseId;
  const editRequested = rawExpenseId !== undefined;
  const editingId =
    typeof rawExpenseId === "string" && UuidSchema.safeParse(rawExpenseId).success
      ? rawExpenseId
      : undefined;

  const expenseQuery = useExpense(trip.id, editingId ?? "", { enabled: editingId !== undefined });
  const members = useTripMembers(trip.id);

  useEffect(() => {
    // nav §2.6: clean forms dismiss freely; dirty forms intercept with the
    // discard Confirm — `beforeRemove` is the single chokepoint.
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (!dirty || bypassGuardRef.current) return;
      e.preventDefault();
      const action = e.data.action;
      pendingDismissRef.current = () => navigation.dispatch(action);
      setConfirmVisible(true);
    });
    return unsubscribe;
  }, [navigation, dirty]);

  const close = (): void => {
    // Cold modal-only stack fallback (trip-new R1 precedent): an external
    // URL entry mounts no list beneath — back() would be unhandled.
    if (router.canGoBack()) router.back();
    else router.replace(`/${trip.id}/money` as Href);
  };

  const onSaved = (): void => {
    // Mounted guard (itinerary-item-new precedent): a slow save settling
    // after a discard-dismiss must not pop whatever screen the user moved
    // on to — the hook-level seam already reconciled the cache.
    if (!mountedRef.current) return;
    bypassGuardRef.current = true;
    close();
  };

  const onDirty = (): void => setDirty(true);

  const callerId = me?.id ?? "";
  const editing = editRequested;

  let body;
  if (members.data === undefined) {
    if (members.isError) {
      body = (
        <ErrorBanner
          message="Couldn't load the trip members."
          onRetry={() => void members.refetch()}
          testID="expense-new-error-load"
        />
      );
    } else {
      body = <Skeleton variant="rect" height={240} testID="expense-new-loading" />;
    }
  } else if (!editing) {
    body = (
      <ExpenseForm
        trip={trip}
        members={members.data.items}
        callerId={callerId}
        onDirty={onDirty}
        onSaved={onSaved}
      />
    );
  } else if (editingId === undefined) {
    body = (
      <View style={s.state}>
        <EmptyState
          icon="alert-circle-outline"
          title="Can't edit this"
          body="This expense no longer exists."
          testID="expense-new-uneditable"
        />
      </View>
    );
  } else if (expenseQuery.data !== undefined) {
    const expense = expenseQuery.data;
    const canEdit = expense.created_by === callerId || trip.role === "owner";
    if (expense.deleted_at !== null) {
      body = (
        <View style={s.state}>
          <EmptyState
            icon="alert-circle-outline"
            title="Can't edit this"
            body="This expense was deleted — the deletion stays on the record."
            testID="expense-new-uneditable"
          />
        </View>
      );
    } else if (!canEdit) {
      // R-money-26 mirror (R-ib-24 posture): never render a guaranteed-403
      // form. Creator (any role, viewers included) or trip owner only.
      body = (
        <View style={s.state}>
          <EmptyState
            icon="lock-closed-outline"
            title="View only"
            body="Only the person who logged this expense or the trip owner can edit it."
            testID="expense-new-forbidden"
          />
        </View>
      );
    } else {
      body = (
        <ExpenseForm
          trip={trip}
          members={members.data.items}
          callerId={callerId}
          expense={expense}
          onDirty={onDirty}
          onSaved={onSaved}
        />
      );
    }
  } else if (expenseQuery.isError) {
    body = (
      <ErrorBanner
        message="Couldn't load the expense."
        onRetry={() => void expenseQuery.refetch()}
        testID="expense-new-error-load"
      />
    );
  } else {
    body = <Skeleton variant="rect" height={240} testID="expense-new-loading" />;
  }

  return (
    <View style={s.screen} testID="expense-new-screen">
      <PageHeader
        title={editing ? "Edit expense" : "Add expense"}
        testID="expense-new-header"
        trailing={[
          {
            icon: "close",
            label: "Cancel",
            onPress: close,
            testID: "expense-new-button-cancel",
          },
        ]}
      />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={confirmVisible}
        title={editing ? "Discard these changes?" : "Discard this expense?"}
        body="Nothing you've entered will be saved."
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          setConfirmVisible(false);
          bypassGuardRef.current = true;
          const dismiss = pendingDismissRef.current;
          pendingDismissRef.current = null;
          if (dismiss) dismiss();
          else close();
        }}
        onCancel={() => {
          pendingDismissRef.current = null;
          setConfirmVisible(false);
        }}
        testID="expense-new-button-cancel"
      />
    </View>
  );
}
