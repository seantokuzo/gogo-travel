/**
 * Trip settings (T-6.9 / CT-5 — trips spec §2.5, R-tripui-14/18/19/20/21/22).
 * Role-gated rows off the guarded `TripWithRole` context:
 *
 * - details form (name/dates — editor+; destination display-only v1, the
 *   structured-search edit reuses CT-2's picker post-merge),
 * - theme (editor+, Sheet picker, optimistic apply — §2.6),
 * - base currency (owner-only; the LOCK is server-truth — R-trips-22 409
 *   `base_currency_locked` flips the row to the read-only explainer §2.5
 *   describes; the client has no expense oracle in P-6),
 * - archive/unarchive (owner-only `status` override — 'past' pins, null
 *   clears and derivation resumes; reversible, so no Confirm — R-tripui-20
 *   reserves Confirms for leave/delete),
 * - members shortcut + offline-pack placeholder (all roles; offline content
 *   is the offline spec's, later phase),
 * - leave (editor/viewer, Confirm; owner sees the transfer-first hint row
 *   deep-linking to members — R-tripui-20) and delete (owner, destructive
 *   Confirm stating permanence for ALL members).
 *
 * Conflict UX (R-tripui-19): every PATCH carries `expect_updated_at` (the
 * cached row's `updated_at` echoed verbatim — buildTripPatch owns that); a
 * stale 409 rolls back, refetches (hook-level), re-seeds the form with the
 * fresh values, and shows the non-blocking notice — never a silent overwrite.
 *
 * Exit flows (delete/leave): navigate FIRST, then evict the trip subtree on
 * this screen's unmount teardown via a microtask — evicting while the
 * `[tripId]` observers are live re-creates + refetches dead queries (the
 * T-6.6 scrub landmine).
 */
import { CurrencyCodeSchema, type Trip } from "@gogo/shared";
import { THEME_NAMES } from "@gogo/tokens";
import { createStyles } from "@gogo/tokens/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import {
  AppText,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorBanner,
  Icon,
  Input,
  ListItem,
  PageHeader,
  Sheet,
} from "@/components";
import { ApiRequestError, useSessionStore } from "@/auth";
import {
  buildTripPatch,
  evictTripSubtree,
  isBaseCurrencyLocked,
  isStaleUpdatedAt,
  queryKeys,
  useDeleteTrip,
  useRemoveMember,
  useScreenFocusRefetch,
  useUpdateTrip,
} from "@/data";
import { LEAVE_TRIP_CONFIRM, memberActionErrorMessage } from "@/features/members";
import { DateField } from "@/features/trips";
import { useTripContext } from "@/navigation/trip-context";

/** Display labels for trip accent themes (AppearanceSection's naming). */
const THEME_LABELS: Record<string, string> = {
  goldenHour: "Golden Hour",
  deepWaters: "Deep Waters",
  midnightExpress: "Midnight Express",
};

const CONFLICT_NOTICE = "Updated by someone else — review and re-save.";
const CURRENCY_LOCKED_NOTICE = "Locked — the trip already has expenses.";
const SAVE_ERROR = "Couldn't save changes. Please try again.";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: { padding: t.space[4], gap: t.space[4], paddingBottom: t.space[8] },
    section: { gap: t.space[3] },
    form: { gap: t.space[3] },
    dateRow: { flexDirection: "row", gap: t.space[3] },
    dateField: { flex: 1 },
    readonlyField: { gap: 2 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.color.border.subtle },
    sheetBody: { gap: t.space[2], paddingBottom: t.space[4] },
  }),
);

export default function TripSettingsScreen() {
  const trip = useTripContext();
  const router = useRouter();
  const client = useQueryClient();
  const s = useStyles();

  const canEdit = trip.role === "owner" || trip.role === "editor";
  const isOwner = trip.role === "owner";

  const updateTrip = useUpdateTrip(trip.id);
  const deleteTrip = useDeleteTrip(trip.id);
  // Leave = removing the CALLER's own membership row (T-6.8's capability;
  // R-trips-11). No hook-level error seam here: leave is this screen's only
  // member mutation, so the per-call onError below cannot be superseded.
  const removeMember = useRemoveMember(trip.id);
  const myUserId = useSessionStore((s) => s.user?.id);

  // R-tripui-3: returning focus (e.g. back from members) refreshes this
  // screen's query — the guarded trip row (exact; the lists are the list
  // screen's own focus concern, key-cache law).
  useScreenFocusRefetch([{ queryKey: queryKeys.trip(trip.id), exact: true }]);

  // ---- notices -------------------------------------------------------------
  const [conflictNotice, setConflictNotice] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Server said locked (R-trips-22) — sticky for the session; row goes read-only. */
  const [currencyLocked, setCurrencyLocked] = useState(false);
  /** Set on a stale-409: the NEXT refetched row re-seeds even over dirty edits. */
  const conflictRefreshPending = useRef(false);

  /** Shared error triage for every trip-row PATCH (details/theme/currency/archive). */
  const onPatchError = (error: Error) => {
    if (isStaleUpdatedAt(error)) {
      conflictRefreshPending.current = true;
      setConflictNotice(true);
      return;
    }
    if (isBaseCurrencyLocked(error)) {
      setCurrencyLocked(true);
      return;
    }
    setSaveError(SAVE_ERROR);
  };

  // ---- details form (editor+) ----------------------------------------------
  const [name, setName] = useState(trip.name);
  const [startDate, setStartDate] = useState(trip.start_date);
  const [endDate, setEndDate] = useState(trip.end_date);
  // The row snapshot the form was last seeded from — STATE, not a ref: the
  // `dirty` computation reads it during render (react-hooks/refs).
  const [seeded, setSeeded] = useState({
    updatedAt: trip.updated_at,
    name: trip.name,
    start: trip.start_date,
    end: trip.end_date,
  });

  const seedForm = (row: Pick<Trip, "name" | "start_date" | "end_date" | "updated_at">) => {
    setSeeded({
      updatedAt: row.updated_at,
      name: row.name,
      start: row.start_date,
      end: row.end_date,
    });
    setName(row.name);
    setStartDate(row.start_date);
    setEndDate(row.end_date);
  };

  const dirty =
    name.trim() !== seeded.name || startDate !== seeded.start || endDate !== seeded.end;

  // R-tripui-19 re-render half: when a fresh row lands (conflict refetch, or a
  // background refetch while the form is pristine), re-seed. Dirty edits are
  // kept UNLESS a conflict flagged them stale — save-time 409 arbitrates
  // (never a silent client-side overwrite in either direction).
  useEffect(() => {
    if (trip.updated_at === seeded.updatedAt) return;
    if (dirty && !conflictRefreshPending.current) return;
    conflictRefreshPending.current = false;
    seedForm(trip);
  });

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length === 0 || trimmedName.length > 200 ? "1–200 characters." : undefined;
  // Dates come from the native picker (DateField, T-6.7) — the wire format is
  // correct by construction, so the shared date-order rule is the only
  // reachable validation error (§2.3 point 3 posture; ISO compares lexically).
  const endError = startDate > endDate ? "Before the start date" : undefined;
  const formValid = nameError === undefined && endError === undefined;

  const onSaveDetails = () => {
    const patch = buildTripPatch(trip, {
      name: trimmedName,
      start_date: startDate,
      end_date: endDate,
    });
    if (patch === null) return;
    setSaveError(null);
    updateTrip.mutate(patch, {
      onError: onPatchError,
      onSuccess: (row) => {
        setConflictNotice(false);
        seedForm(row);
      },
    });
  };

  // ---- theme (editor+, optimistic — §2.6) ----------------------------------
  const [themeSheetOpen, setThemeSheetOpen] = useState(false);
  const onSelectTheme = (value: string | null) => {
    setThemeSheetOpen(false);
    const patch = buildTripPatch(trip, { theme: value });
    if (patch === null) return;
    updateTrip.mutate(patch, { onError: onPatchError });
  };

  // ---- base currency (owner) -----------------------------------------------
  const [currencySheetOpen, setCurrencySheetOpen] = useState(false);
  const [currencyDraft, setCurrencyDraft] = useState(trip.base_currency);
  const currencyValid = CurrencyCodeSchema.safeParse(currencyDraft).success;
  const onSaveCurrency = () => {
    setCurrencySheetOpen(false);
    const patch = buildTripPatch(trip, { base_currency: currencyDraft });
    if (patch === null) return;
    updateTrip.mutate(patch, { onError: onPatchError });
  };

  // ---- archive / unarchive (owner; key-presence: status only when touched) --
  const archived = trip.status_override === "past";
  const onToggleArchive = () => {
    const patch = buildTripPatch(trip, { status: archived ? null : "past" });
    if (patch === null) return;
    updateTrip.mutate(patch, { onError: onPatchError });
  };

  // ---- exit flows (delete / leave) + teardown eviction -----------------------
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const evictOnUnmount = useRef(false);

  useEffect(() => {
    const tripId = trip.id;
    return () => {
      if (!evictOnUnmount.current) return;
      // One macrotask later: let the unmount commit finish so the [tripId]
      // guard's observer is unsubscribed before its cache entry is removed
      // (removing an OBSERVED query re-creates + refetches it — T-6.6). Not
      // a microtask: jest's fake timers fake queueMicrotask, and React may
      // commit past the current microtask queue anyway.
      setTimeout(() => evictTripSubtree(client, tripId), 0);
    };
  }, [client, trip.id]);

  const exitToTripList = () => {
    evictOnUnmount.current = true;
    router.replace("/(trips)");
  };

  const onConfirmDelete = () => {
    setDeleteDialogOpen(false);
    deleteTrip.mutate(undefined, {
      onSuccess: exitToTripList,
      onError: () => setSaveError("Couldn't delete the trip. Please try again."),
    });
  };

  const onConfirmLeave = () => {
    setLeaveDialogOpen(false);
    if (myUserId === undefined) return; // unreachable under the auth gate
    removeMember.mutate(
      { userId: myUserId },
      {
        onSuccess: exitToTripList,
        onError: (error) => {
          // §3.5 rule 3: deletes converge — a 404 means the membership row is
          // already gone, which IS the desired end state. Exit anyway.
          if (error instanceof ApiRequestError && error.status === 404) {
            exitToTripList();
            return;
          }
          // Owner-leave races land here with the mapped 409 copy
          // (owner_transfer_required / delete_trip_instead, error-copy.ts).
          setSaveError(memberActionErrorMessage(error));
        },
      },
    );
  };

  const themeLabel = trip.theme === null ? "App default" : (THEME_LABELS[trip.theme] ?? trip.theme);

  return (
    <View style={s.screen} testID="trip-settings-screen">
      <PageHeader title="Trip settings" leading="back" testID="trip-settings-header" />
      <ScrollView contentContainerStyle={s.body}>
        {saveError !== null ? (
          <ErrorBanner
            message={saveError}
            onDismiss={() => setSaveError(null)}
            testID="trip-settings-error"
          />
        ) : null}
        {conflictNotice ? (
          <ErrorBanner
            tone="warning"
            message={CONFLICT_NOTICE}
            onDismiss={() => setConflictNotice(false)}
            testID="trip-settings-conflict-notice"
          />
        ) : null}

        {canEdit ? (
          <Card testID="trip-settings-list-item-details">
            <View style={s.form}>
              <AppText role="subheading">Trip details</AppText>
              <Input
                label="Name"
                value={name}
                onChangeText={setName}
                error={dirty ? nameError : undefined}
                returnKeyType="done"
                testID="trip-settings-input-name"
              />
              <View style={s.dateRow} testID="trip-settings-input-dates">
                <View style={s.dateField}>
                  <DateField
                    label="Start date"
                    value={startDate}
                    onSelect={setStartDate}
                    testID="trip-settings-input-dates-start"
                  />
                </View>
                <View style={s.dateField}>
                  <DateField
                    label="End date"
                    value={endDate}
                    onSelect={setEndDate}
                    error={endError}
                    testID="trip-settings-input-dates-end"
                  />
                </View>
              </View>
              <View style={s.readonlyField}>
                <AppText role="caption" color="secondary">
                  Destination
                </AppText>
                <AppText>{trip.destination_name}</AppText>
                <AppText role="caption" color="secondary">
                  Destination changes are coming soon.
                </AppText>
              </View>
              <Button
                title="Save changes"
                onPress={onSaveDetails}
                loading={updateTrip.isPending}
                disabled={!dirty || !formValid}
                testID="trip-settings-button-save"
              />
            </View>
          </Card>
        ) : null}

        <Card padded={false} testID="trip-settings-rows">
          {canEdit ? (
            <>
              <ListItem
                title="Trip theme"
                subtitle={themeLabel}
                leading={<Icon name="color-palette-outline" size={22} />}
                trailing="chevron"
                onPress={() => setThemeSheetOpen(true)}
                testID="trip-settings-list-item-theme"
              />
              <View style={s.divider} />
            </>
          ) : null}
          {isOwner ? (
            <>
              <ListItem
                title="Base currency"
                subtitle={
                  currencyLocked
                    ? `${trip.base_currency} · ${CURRENCY_LOCKED_NOTICE}`
                    : trip.base_currency
                }
                leading={<Icon name="cash-outline" size={22} />}
                trailing={currencyLocked ? <Icon name="lock-closed-outline" size={18} /> : "chevron"}
                onPress={
                  currencyLocked
                    ? undefined
                    : () => {
                        setCurrencyDraft(trip.base_currency);
                        setCurrencySheetOpen(true);
                      }
                }
                testID="trip-settings-list-item-currency"
              />
              <View style={s.divider} />
            </>
          ) : null}
          <ListItem
            title="Offline pack"
            subtitle="Maps and trip data for offline use — coming soon."
            leading={<Icon name="cloud-download-outline" size={22} />}
            trailing={<Badge label="Not available" tone="neutral" size="sm" />}
            testID="trip-settings-list-item-offline"
          />
          <View style={s.divider} />
          <ListItem
            title="Members"
            leading={<Icon name="people-outline" size={22} />}
            trailing="chevron"
            onPress={() =>
              router.push({ pathname: "/[tripId]/more/members", params: { tripId: trip.id } })
            }
            testID="trip-settings-list-item-members"
          />
          {isOwner ? (
            <>
              <View style={s.divider} />
              <ListItem
                title={archived ? "Unarchive trip" : "Archive trip"}
                subtitle={
                  archived
                    ? "Back to the status its dates imply."
                    : "Move to Past regardless of dates."
                }
                leading={<Icon name="archive-outline" size={22} />}
                onPress={onToggleArchive}
                testID="trip-settings-button-archive"
              />
            </>
          ) : null}
        </Card>

        <Card padded={false} testID="trip-settings-danger">
          {isOwner ? (
            <>
              <ListItem
                title="Leave trip"
                subtitle="Transfer ownership first — pick a new owner in Members."
                leading={<Icon name="exit-outline" size={22} />}
                trailing="chevron"
                onPress={() =>
                  router.push({ pathname: "/[tripId]/more/members", params: { tripId: trip.id } })
                }
                testID="trip-settings-button-leave"
              />
              <View style={s.divider} />
              <ListItem
                title="Delete trip"
                subtitle="Permanent, for all members."
                leading={<Icon name="trash-outline" size={22} />}
                onPress={() => setDeleteDialogOpen(true)}
                testID="trip-settings-button-delete"
              />
            </>
          ) : (
            <ListItem
              title="Leave trip"
              leading={<Icon name="exit-outline" size={22} />}
              onPress={() => setLeaveDialogOpen(true)}
              testID="trip-settings-button-leave"
            />
          )}
        </Card>
      </ScrollView>

      <Sheet
        visible={themeSheetOpen}
        onDismiss={() => setThemeSheetOpen(false)}
        title="Trip theme"
        testID="trip-settings-theme-sheet"
      >
        <View style={s.sheetBody}>
          <ListItem
            title="App default"
            trailing={trip.theme === null ? <Icon name="checkmark" size={20} /> : undefined}
            onPress={() => onSelectTheme(null)}
            testID="trip-settings-theme-option-default"
          />
          {THEME_NAMES.map((key) => (
            <ListItem
              key={key}
              title={THEME_LABELS[key] ?? key}
              trailing={trip.theme === key ? <Icon name="checkmark" size={20} /> : undefined}
              onPress={() => onSelectTheme(key)}
              testID={`trip-settings-theme-option-${key}`}
            />
          ))}
        </View>
      </Sheet>

      <Sheet
        visible={currencySheetOpen}
        onDismiss={() => setCurrencySheetOpen(false)}
        title="Base currency"
        testID="trip-settings-currency-sheet"
      >
        <View style={s.sheetBody}>
          <Input
            label="Currency code"
            value={currencyDraft}
            onChangeText={(v) => setCurrencyDraft(v.toUpperCase())}
            placeholder="USD"
            helper="Three-letter code (ISO 4217). Locked once the first expense exists."
            error={currencyDraft.length > 0 && !currencyValid ? "Three letters, e.g. USD" : undefined}
            autoComplete="off"
            testID="trip-settings-input-currency"
          />
          <Button
            title="Save currency"
            onPress={onSaveCurrency}
            disabled={!currencyValid || currencyDraft === trip.base_currency}
            testID="trip-settings-button-currency-save"
          />
        </View>
      </Sheet>

      <ConfirmDialog
        visible={leaveDialogOpen}
        title={LEAVE_TRIP_CONFIRM.title}
        body={LEAVE_TRIP_CONFIRM.body}
        confirmLabel={LEAVE_TRIP_CONFIRM.confirmLabel}
        destructive={LEAVE_TRIP_CONFIRM.destructive}
        onConfirm={onConfirmLeave}
        onCancel={() => setLeaveDialogOpen(false)}
        testID="trip-settings-leave-dialog"
      />
      <ConfirmDialog
        visible={deleteDialogOpen}
        title="Delete this trip?"
        body={`This permanently deletes "${trip.name}" for ALL members — itinerary, expenses, and photos. This cannot be undone.`}
        confirmLabel="Delete trip"
        destructive
        onConfirm={onConfirmDelete}
        onCancel={() => setDeleteDialogOpen(false)}
        testID="trip-settings-delete-dialog"
      />
    </View>
  );
}
