/**
 * Trip settings (T-6.9 / CT-5 — trips spec §2.5, R-tripui-14/18/19/20/21/22).
 * Role-gated rows off the guarded `TripWithRole` context:
 *
 * - details form (name / destination / dates — editor+): destination is the
 *   CT-2 structured search (Overture spine typeahead, 4-char floor, no free
 *   text — editing after a pick voids it so lat/lng always match the visible
 *   text); dates ride T-6.7's native `DateField` pickers,
 * - theme (editor+, Sheet picker, optimistic apply — §2.6; labels come from
 *   `@gogo/tokens` themes so a palette add is one line, R-ds-5),
 * - base currency (owner-only; the LOCK is server-truth — R-trips-22 409
 *   `base_currency_locked` flips the row to the read-only explainer §2.5
 *   describes; the client has no expense oracle in P-6),
 * - members shortcut + offline-pack placeholder (all roles; offline content
 *   is the offline spec's, later phase),
 * - leave (editor/viewer, Confirm; owner sees the transfer-first hint row
 *   deep-linking to members — R-tripui-20) and delete (owner, destructive
 *   Confirm stating permanence for ALL members).
 *
 * Mutation callbacks are HOOK-level (round-1 blocker; `TripMutationOptions`
 * in data/trip-settings.ts): all four PATCH affordances share one
 * `useUpdateTrip`, and per-call callbacks are dropped for superseded calls —
 * the error triage and the details re-seed must fire for EVERY settled call.
 *
 * Conflict UX (R-tripui-19): every PATCH carries `expect_updated_at` (the
 * cached row's `updated_at` echoed verbatim — buildTripPatch owns that); a
 * stale 409 rolls back, refetches (hook-level), re-seeds the form with the
 * fresh values, and shows the non-blocking notice — never a silent overwrite.
 *
 * Exit flows (delete/leave): navigate FIRST, then evict the trip subtree on
 * this screen's unmount teardown one macrotask later — evicting while the
 * `[tripId]` observers are live re-creates + refetches dead queries (the
 * T-6.6 scrub landmine).
 */
import { CurrencyCodeSchema, type Place, type Trip, type TripUpdate } from "@gogo/shared";
import { isThemeName, THEME_NAMES, themes } from "@gogo/tokens";
import { createStyles } from "@gogo/tokens/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";

import { ApiRequestError, useSessionStore } from "@/auth";
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
  Skeleton,
} from "@/components";
import {
  buildTripPatch,
  evictTripSubtree,
  invalidateTripLists,
  isBaseCurrencyLocked,
  isSearchableDestinationQuery,
  isStaleUpdatedAt,
  queryKeys,
  useDeleteTrip,
  usePlaceSearch,
  useRemoveMember,
  useScreenFocusRefetch,
  useUpdateTrip,
} from "@/data";
import { LEAVE_TRIP_CONFIRM, memberActionErrorMessage } from "@/features/members";
import { DateField } from "@/features/trips";
import { useTripContext } from "@/navigation/trip-context";

const CONFLICT_NOTICE = "Updated by someone else — review and re-save.";
const CURRENCY_LOCKED_NOTICE = "Locked — the trip already has expenses.";
const SAVE_ERROR = "Couldn't save changes. Please try again.";

/** Bounded typeahead render (CT-2 parity — server page ≤ 50, typeahead wants few). */
const MAX_RESULTS = 8;

/**
 * Trip accent label from the tokens registry (R-ds-5: palette add = one
 * line). `isThemeName` is an OWN-property check — a member-stored garbage
 * key ("constructor", …) falls through to the raw string, never a
 * prototype-chain hit (round-1 security finding).
 */
function themeLabelFor(key: string | null): string {
  if (key === null) return "App default";
  return isThemeName(key) ? themes[key].label : key;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: { padding: t.space[4], gap: t.space[4], paddingBottom: t.space[8] },
    form: { gap: t.space[3] },
    fieldGroup: { gap: t.space[1] },
    results: {
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      borderRadius: t.radius.md,
      backgroundColor: t.color.bg.surface,
    },
    dateRow: { flexDirection: "row", gap: t.space[3] },
    dateField: { flex: 1 },
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
  const myUserId = useSessionStore((state) => state.user?.id);

  // ---- notices -------------------------------------------------------------
  const [conflictNotice, setConflictNotice] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Server said locked (R-trips-22) — sticky for the session; row goes read-only. */
  const [currencyLocked, setCurrencyLocked] = useState(false);
  /** Set on a stale-409: the NEXT refetched row re-seeds even over dirty edits. */
  const conflictRefreshPending = useRef(false);

  // ---- details form (editor+) ----------------------------------------------
  const [name, setName] = useState(trip.name);
  const [startDate, setStartDate] = useState(trip.start_date);
  const [endDate, setEndDate] = useState(trip.end_date);
  // Destination = CT-2 structured search: the text is a QUERY until a result
  // is picked; text equal to the seeded name means "unchanged".
  const [destinationQuery, setDestinationQuery] = useState(trip.destination_name);
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [destinationError, setDestinationError] = useState<string | undefined>(undefined);
  // The row snapshot the form was last seeded from — STATE, not a ref: the
  // `dirty` computation reads it during render (react-hooks/refs).
  const [seeded, setSeeded] = useState({
    updatedAt: trip.updated_at,
    name: trip.name,
    start: trip.start_date,
    end: trip.end_date,
    destination: trip.destination_name,
  });

  const seedForm = (
    row: Pick<Trip, "name" | "start_date" | "end_date" | "destination_name" | "updated_at">,
  ) => {
    setSeeded({
      updatedAt: row.updated_at,
      name: row.name,
      start: row.start_date,
      end: row.end_date,
      destination: row.destination_name,
    });
    setName(row.name);
    setStartDate(row.start_date);
    setEndDate(row.end_date);
    setDestinationQuery(row.destination_name);
    setSelectedPlace(null);
    setDestinationError(undefined);
  };

  const dirty =
    name.trim() !== seeded.name ||
    startDate !== seeded.start ||
    endDate !== seeded.end ||
    selectedPlace !== null ||
    destinationQuery !== seeded.destination;

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

  // CT-2 typeahead: search only while the text is EDITED away from the seeded
  // destination with no pick yet — a pristine form must never fire a search
  // (its initial value is already a valid ≥4-char destination name).
  const deferredQuery = useDeferredValue(destinationQuery);
  const destinationEditing = selectedPlace === null && destinationQuery !== seeded.destination;
  const searchActive = destinationEditing && isSearchableDestinationQuery(deferredQuery);
  const search = usePlaceSearch(destinationEditing ? deferredQuery : "");
  const results = (search.data?.items ?? []).slice(0, MAX_RESULTS);

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length === 0 || trimmedName.length > 200 ? "1–200 characters." : undefined;
  // Dates come from the native picker (DateField, T-6.7) — the wire format is
  // correct by construction, so the shared date-order rule is the only
  // reachable validation error (§2.3 point 3 posture; ISO compares lexically).
  const endError = startDate > endDate ? "Before the start date" : undefined;
  const formValid = nameError === undefined && endError === undefined;

  // ---- hook-level mutation seam (round-1 blocker: superseded-call drop) ----
  /** Shared error triage for every trip-row PATCH (details/theme/currency). */
  const onPatchError = (error: unknown) => {
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
  /** Every settled PATCH clears the conflict; details-family saves re-seed. */
  const onPatchSuccess = (row: Trip, patch: TripUpdate) => {
    setConflictNotice(false);
    const touchedDetails =
      patch.name !== undefined ||
      patch.start_date !== undefined ||
      patch.end_date !== undefined ||
      patch.destination_name !== undefined ||
      patch.destination_lat !== undefined ||
      patch.destination_lng !== undefined;
    if (touchedDetails) seedForm(row);
  };

  const updateTrip = useUpdateTrip(trip.id, {
    onMutationError: onPatchError,
    onMutationSuccess: onPatchSuccess,
  });
  const deleteTrip = useDeleteTrip(trip.id);
  // Leave = removing the CALLER's own membership row (T-6.8's capability;
  // R-trips-11). No hook-level seam here: leave is this screen's only member
  // mutation, so the per-call onError below cannot be superseded.
  const removeMember = useRemoveMember(trip.id);

  // R-tripui-3: returning focus (e.g. back from members) refreshes this
  // screen's query — the guarded trip row (exact; the lists are the list
  // screen's own focus concern, key-cache law).
  useScreenFocusRefetch([{ queryKey: queryKeys.trip(trip.id), exact: true }]);

  const onSaveDetails = () => {
    if (!formValid) return; // Button disables too — belt for a raced press.
    // Structured-destination invariant (§2.3, no free text): edited text
    // without a picked result cannot be saved.
    if (selectedPlace === null && destinationQuery.trim() !== seeded.destination) {
      setDestinationError("Pick a destination from the search results.");
      return;
    }
    const patch = buildTripPatch(trip, {
      name: trimmedName,
      start_date: startDate,
      end_date: endDate,
      ...(selectedPlace !== null
        ? {
            destination_name: selectedPlace.name,
            destination_lat: selectedPlace.lat,
            destination_lng: selectedPlace.lng,
          }
        : {}),
    });
    if (patch === null) return;
    setSaveError(null);
    updateTrip.mutate(patch);
  };

  // ---- theme (editor+, optimistic — §2.6) ----------------------------------
  const [themeSheetOpen, setThemeSheetOpen] = useState(false);
  const onSelectTheme = (value: string | null) => {
    setThemeSheetOpen(false);
    const patch = buildTripPatch(trip, { theme: value });
    if (patch === null) return;
    updateTrip.mutate(patch);
  };

  // ---- base currency (owner) -----------------------------------------------
  const [currencySheetOpen, setCurrencySheetOpen] = useState(false);
  const [currencyDraft, setCurrencyDraft] = useState(trip.base_currency);
  const currencyValid = CurrencyCodeSchema.safeParse(currencyDraft).success;
  const onSaveCurrency = () => {
    setCurrencySheetOpen(false);
    const patch = buildTripPatch(trip, { base_currency: currencyDraft });
    if (patch === null) return;
    updateTrip.mutate(patch);
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
          // already gone, which IS the desired end state. The lists still go
          // stale (delete converges inside its mutationFn, so its onSuccess
          // invalidation covers both paths; leave's converged 404 must match).
          if (error instanceof ApiRequestError && error.status === 404) {
            invalidateTripLists(client);
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

  return (
    <View style={s.screen} testID="trip-settings-screen">
      <PageHeader title="Trip settings" leading="back" testID="trip-settings-header" />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {saveError !== null ? (
          <ErrorBanner
            message={saveError}
            onDismiss={() => setSaveError(null)}
            testID="trip-settings-banner"
          />
        ) : null}
        {conflictNotice ? (
          <ErrorBanner
            tone="warning"
            message={CONFLICT_NOTICE}
            onDismiss={() => setConflictNotice(false)}
            testID="trip-settings-banner-conflict"
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
              <View style={s.fieldGroup}>
                <Input
                  label="Destination"
                  value={destinationQuery}
                  onChangeText={(value) => {
                    setDestinationQuery(value);
                    // Editing after a pick voids it — lat/lng must always
                    // match the visible text (CT-2 structured posture).
                    setSelectedPlace(null);
                    setDestinationError(undefined);
                  }}
                  placeholder="Search cities"
                  helper={
                    destinationEditing && !searchActive && destinationQuery !== ""
                      ? "Keep typing — search starts at 4 characters."
                      : undefined
                  }
                  error={destinationError}
                  testID="trip-settings-input-destination"
                />
                {searchActive ? (
                  search.isPending ? (
                    <Skeleton variant="text" lines={2} />
                  ) : search.isError ? (
                    <ErrorBanner
                      message="Destination search failed."
                      onRetry={() => void search.refetch()}
                      testID="trip-settings-banner-search"
                    />
                  ) : results.length === 0 ? (
                    <AppText role="caption" color="muted">
                      No places matched — try a different spelling.
                    </AppText>
                  ) : (
                    <View style={s.results}>
                      {results.map((place) => (
                        <ListItem
                          key={place.id}
                          title={place.name}
                          subtitle={place.category ?? undefined}
                          onPress={() => {
                            setSelectedPlace(place);
                            setDestinationQuery(place.name);
                            setDestinationError(undefined);
                          }}
                          testID={`trip-settings-list-item-destination-${place.id}`}
                        />
                      ))}
                    </View>
                  )
                ) : null}
              </View>
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

        <Card padded={false}>
          {canEdit ? (
            <>
              <ListItem
                title="Trip theme"
                subtitle={themeLabelFor(trip.theme)}
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
        </Card>

        <Card padded={false}>
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
                trailing={deleteTrip.isPending ? <ActivityIndicator size="small" /> : undefined}
                onPress={() => {
                  // Pending guard: the row is the honest spinner surface while
                  // the DELETE is in flight (round-1 advisory).
                  if (!deleteTrip.isPending) setDeleteDialogOpen(true);
                }}
                testID="trip-settings-button-delete"
              />
            </>
          ) : (
            <ListItem
              title="Leave trip"
              leading={<Icon name="exit-outline" size={22} />}
              trailing={removeMember.isPending ? <ActivityIndicator size="small" /> : undefined}
              onPress={() => {
                // Same pending guard as delete (symmetric exit flows).
                if (!removeMember.isPending) setLeaveDialogOpen(true);
              }}
              testID="trip-settings-button-leave"
            />
          )}
        </Card>
      </ScrollView>

      <Sheet
        visible={themeSheetOpen}
        onDismiss={() => setThemeSheetOpen(false)}
        title="Trip theme"
        testID="trip-settings-sheet-theme"
      >
        <View style={s.sheetBody}>
          <ListItem
            title="App default"
            trailing={trip.theme === null ? <Icon name="checkmark" size={20} /> : undefined}
            onPress={() => onSelectTheme(null)}
            testID="trip-settings-list-item-theme-default"
          />
          {THEME_NAMES.map((key) => (
            <ListItem
              key={key}
              title={themes[key].label}
              trailing={trip.theme === key ? <Icon name="checkmark" size={20} /> : undefined}
              onPress={() => onSelectTheme(key)}
              testID={`trip-settings-list-item-theme-${key}`}
            />
          ))}
        </View>
      </Sheet>

      <Sheet
        visible={currencySheetOpen}
        onDismiss={() => setCurrencySheetOpen(false)}
        title="Base currency"
        testID="trip-settings-sheet-currency"
      >
        <View style={s.sheetBody}>
          <Input
            label="Currency code"
            value={currencyDraft}
            onChangeText={(v) => setCurrencyDraft(v.toUpperCase())}
            placeholder="USD"
            helper="Three-letter code (ISO 4217). Locked once the first expense exists."
            error={
              currencyDraft.length > 0 && !currencyValid ? "Three letters, e.g. USD" : undefined
            }
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

      {/* §2.7 rule 4: dialogs derive -confirm/-cancel from the TRIGGERING
          button's id (members-screen convention) — never an invented base. */}
      <ConfirmDialog
        visible={leaveDialogOpen}
        title={LEAVE_TRIP_CONFIRM.title}
        body={LEAVE_TRIP_CONFIRM.body}
        confirmLabel={LEAVE_TRIP_CONFIRM.confirmLabel}
        destructive={LEAVE_TRIP_CONFIRM.destructive}
        onConfirm={onConfirmLeave}
        onCancel={() => setLeaveDialogOpen(false)}
        testID="trip-settings-button-leave"
      />
      <ConfirmDialog
        visible={deleteDialogOpen}
        title="Delete this trip?"
        body={`This permanently deletes "${trip.name}" for ALL members — itinerary, expenses, and photos. This cannot be undone.`}
        confirmLabel="Delete trip"
        destructive
        onConfirm={onConfirmDelete}
        onCancel={() => setDeleteDialogOpen(false)}
        testID="trip-settings-button-delete"
      />
    </View>
  );
}
