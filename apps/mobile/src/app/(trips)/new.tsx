/**
 * Create trip (T-6.7 / CT-2; trips spec §2.3 — form MODAL per nav §2.6):
 *
 * 1. Name — required text input.
 * 2. Destination — structured search-as-you-type against the places spine
 *    (Overture city/locality subset, resolved Gate 2). No free-text
 *    fallback: submitting requires a PICKED result, so
 *    `destination_lat/lng` are always present. Text-only search carries the
 *    4-char floor (shared scale bound) — shorter input just shows guidance.
 * 3. Dates — REQUIRED range picker (§2.3 point 3; resolved Gate 2):
 *    start/end platform date pickers (`@react-native-community/
 *    datetimepicker`, R1 review) composing the range under one
 *    `trip-new-input-dates` control. The picker is the only input, so the
 *    wire format is correct by construction; the shared date-order rule is
 *    the reachable validation.
 *
 * NOT in the form (R-tripui-6): `base_currency` defaults to
 * `UserPrefs.home_currency ?? 'USD'` (omitted from the body when unknown —
 * the server defaults 'USD'); `theme` is trip-settings'.
 *
 * Validation is the shared `TripCreateSchema` client-mirrored (caps, date
 * format, date order) — the wire schema stays the single source of truth.
 *
 * Submit (R-tripui-7): pending disables the control (Button loading);
 * success replace-navigates into the new trip, where the nav default-tab
 * rules land it (R-nav-7/8 — planning trips → itinerary); failure renders
 * an ErrorBanner with retry and every entered value preserved.
 *
 * Dirty dismissal (R-tripui-8, nav §2.6 form-modal rule): ANY removal of a
 * dirty form — cancel button, swipe-down, Android back — funnels through
 * the navigator's `beforeRemove` event, which is intercepted with a discard
 * ConfirmDialog (`trip-new-button-cancel` derives `-confirm`/`-cancel`).
 */
import { TripCreateSchema, type Place, type TripCreate } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useNavigation, useRouter, type Href } from "expo-router";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";

import { ApiRequestError } from "@/auth";
import {
  AppText,
  Button,
  ConfirmDialog,
  ErrorBanner,
  Input,
  ListItem,
  PageHeader,
  Skeleton,
} from "@/components";
import { isSearchableDestinationQuery, useCreateTrip, useMe, usePlaceSearch } from "@/data";
import { DateField } from "@/features/trips";

/** Bounded result render (server page ≤ 50, default 20; typeahead wants few). */
const MAX_RESULTS = 8;

interface FieldErrors {
  name?: string;
  destination?: string;
  start_date?: string;
  end_date?: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    flex: { flex: 1 },
    content: { padding: t.space[4], gap: t.space[4], paddingBottom: t.space[8] },
    results: {
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      borderRadius: t.radius.md,
      backgroundColor: t.color.bg.surface,
    },
    datesRow: { flexDirection: "row", gap: t.space[3] },
    dateField: { flex: 1 },
    fieldGroup: { gap: t.space[1] },
  }),
);

/** Map a create failure onto a safe, actionable banner message (§3.5 envelope). */
function createErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 400) {
      return "The server rejected the trip details — check the fields and try again.";
    }
    if (error.status === 409) {
      return "That change conflicted with another update — try again.";
    }
    if (error.status === 0) {
      return "No connection — check your network and retry.";
    }
  }
  return "Couldn't create the trip. Retry?";
}

export default function TripNewScreen() {
  const s = useStyles();
  const router = useRouter();
  const navigation = useNavigation();

  const [name, setName] = useState("");
  const [destinationQuery, setDestinationQuery] = useState("");
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [confirmVisible, setConfirmVisible] = useState(false);

  // R-tripui-6: base_currency defaults from prefs without occupying the
  // form. Resolution is DETERMINISTIC (R1 review): submit awaits the /me
  // read when it is still in flight (joining it, not racing it), so a fast
  // submit can never silently fall to USD for a non-USD user — the schema
  // fallback (omit → server 'USD') applies only when the profile is
  // genuinely unavailable. The currency stays editable in trip settings
  // until the first expense locks it (API §3.6).
  const me = useMe();
  const [resolvingPrefs, setResolvingPrefs] = useState(false);

  // useDeferredValue over a timer debounce: React-scheduled (no stray
  // setTimeout state update to leak outside act), cancels stale searches
  // via the query-signal forwarding when the key advances.
  const deferredQuery = useDeferredValue(destinationQuery);
  const searchActive = selectedPlace === null && isSearchableDestinationQuery(deferredQuery);
  const search = usePlaceSearch(selectedPlace === null ? deferredQuery : "");

  const createTrip = useCreateTrip();

  const dirty = name !== "" || destinationQuery !== "" || startDate !== "" || endDate !== "";
  // The dialog decision needs the CURRENT dirty state inside a listener
  // that re-subscribes on change — refs keep the submit bypass race-free.
  const bypassGuardRef = useRef(false);
  const pendingDismissRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // nav §2.6: swipe-down/back POP a clean form freely; a dirty form
    // intercepts with a discard Confirm. `beforeRemove` is the single
    // chokepoint — the cancel button just asks the navigator to go back.
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (!dirty || bypassGuardRef.current) return;
      e.preventDefault();
      const action = e.data.action;
      pendingDismissRef.current = () => navigation.dispatch(action);
      setConfirmVisible(true);
    });
    return unsubscribe;
  }, [navigation, dirty]);

  const submit = useCallback(async () => {
    // Re-entrance guard: the async prefs window below runs before the
    // mutation's own isPending covers the button.
    if (createTrip.isPending || resolvingPrefs) return;

    const errors: FieldErrors = {};
    if (name.trim() === "") errors.name = "Give the trip a name.";
    if (selectedPlace === null) errors.destination = "Search and pick a destination.";
    if (startDate === "") errors.start_date = "Pick a start date.";
    if (endDate === "") errors.end_date = "Pick an end date.";
    if (Object.keys(errors).length > 0 || selectedPlace === null) {
      setFieldErrors(errors);
      return;
    }

    // Deterministic base_currency (R1): join the in-flight /me read
    // (cancelRefetch:false — never restarts it) instead of racing it.
    let homeCurrency = me.data?.prefs.home_currency;
    if (me.isPending) {
      setResolvingPrefs(true);
      try {
        const settled = await me.refetch({ cancelRefetch: false });
        homeCurrency = settled.data?.prefs.home_currency;
      } finally {
        setResolvingPrefs(false);
      }
    }

    const candidate: TripCreate = {
      name,
      destination_name: selectedPlace.name,
      destination_lat: selectedPlace.lat,
      destination_lng: selectedPlace.lng,
      start_date: startDate,
      end_date: endDate,
      ...(homeCurrency !== undefined ? { base_currency: homeCurrency } : {}),
    };
    const parsed = TripCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "name") errors.name = "Trip names run 1–200 characters.";
        else if (field === "start_date") errors.start_date = "Use YYYY-MM-DD.";
        else if (field === "end_date") {
          errors.end_date =
            issue.code === "custom"
              ? "End date must be on or after the start date."
              : "Use YYYY-MM-DD.";
        } else if (field === "destination_name") {
          errors.destination = "Pick a destination from the search results.";
        }
      }
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    createTrip.mutate(parsed.data, {
      onSuccess: (trip) => {
        // Landing is the [tripId] layout's default-tab resolution (R-nav-8).
        // The replace REMOVES this modal → beforeRemove fires → bypass it.
        bypassGuardRef.current = true;
        router.replace(`/${trip.id}` as Href);
      },
    });
  }, [name, selectedPlace, startDate, endDate, me, resolvingPrefs, createTrip, router]);

  const results = (search.data?.items ?? []).slice(0, MAX_RESULTS);

  return (
    <View style={s.screen} testID="trip-new-screen">
      <PageHeader
        title="New trip"
        testID="trip-new-header"
        trailing={[
          {
            icon: "close",
            label: "Cancel",
            // Both paths route through beforeRemove — dirty forms get the
            // discard Confirm, clean forms just dismiss (R-tripui-8). The
            // replace fallback covers a COLD modal-only stack (external
            // `gogo://new` entry mounts no list beneath — R1 walkthrough
            // caught back() unhandled there).
            onPress: () => {
              if (router.canGoBack()) router.back();
              else router.replace("/(trips)");
            },
            testID: "trip-new-button-cancel",
          },
        ]}
      />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {createTrip.isError ? (
            <ErrorBanner
              message={createErrorMessage(createTrip.error)}
              onRetry={() => void submit()}
              testID="trip-new-error"
            />
          ) : null}

          <Input
            label="Name"
            value={name}
            onChangeText={(value) => {
              setName(value);
              if (fieldErrors.name) setFieldErrors((prev) => ({ ...prev, name: undefined }));
            }}
            placeholder="Spring in Kyoto"
            error={fieldErrors.name}
            returnKeyType="next"
            testID="trip-new-input-name"
          />

          <View style={s.fieldGroup}>
            <Input
              label="Destination"
              value={destinationQuery}
              onChangeText={(value) => {
                setDestinationQuery(value);
                // Editing after a pick voids it — lat/lng must always match
                // the visible text (structured input, no free-text fallback).
                setSelectedPlace(null);
                if (fieldErrors.destination) {
                  setFieldErrors((prev) => ({ ...prev, destination: undefined }));
                }
              }}
              placeholder="Search cities"
              helper={
                selectedPlace === null && destinationQuery !== "" && !searchActive
                  ? "Keep typing — search starts at 4 characters."
                  : undefined
              }
              error={fieldErrors.destination}
              testID="trip-new-input-destination"
            />
            {searchActive ? (
              search.isPending ? (
                <Skeleton variant="text" lines={2} />
              ) : search.isError ? (
                <ErrorBanner
                  message="Destination search failed."
                  onRetry={() => void search.refetch()}
                  testID="trip-new-error-search"
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
                      }}
                      testID={`trip-new-list-item-${place.id}`}
                    />
                  ))}
                </View>
              )
            ) : null}
          </View>

          <View style={s.fieldGroup} testID="trip-new-input-dates">
            <View style={s.datesRow}>
              <View style={s.dateField}>
                <DateField
                  label="Start date"
                  value={startDate}
                  // B-10b: an empty side of the range opens on its sibling,
                  // not on today — a far-future trip needs no month paging.
                  contextDate={endDate}
                  onSelect={(value) => {
                    setStartDate(value);
                    if (fieldErrors.start_date) {
                      setFieldErrors((prev) => ({ ...prev, start_date: undefined }));
                    }
                  }}
                  error={fieldErrors.start_date}
                  testID="trip-new-input-dates-start"
                />
              </View>
              <View style={s.dateField}>
                <DateField
                  label="End date"
                  value={endDate}
                  contextDate={startDate}
                  onSelect={(value) => {
                    setEndDate(value);
                    if (fieldErrors.end_date) {
                      setFieldErrors((prev) => ({ ...prev, end_date: undefined }));
                    }
                  }}
                  error={fieldErrors.end_date}
                  testID="trip-new-input-dates-end"
                />
              </View>
            </View>
            <AppText role="caption" color="muted">
              Dates are required — they drive the itinerary and trip status.
            </AppText>
          </View>

          <Button
            title="Create trip"
            onPress={() => void submit()}
            loading={createTrip.isPending || resolvingPrefs}
            fullWidth
            testID="trip-new-button-create"
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={confirmVisible}
        title="Discard this trip?"
        body="Your name, destination, and dates won't be saved."
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          setConfirmVisible(false);
          bypassGuardRef.current = true;
          const dismiss = pendingDismissRef.current;
          pendingDismissRef.current = null;
          if (dismiss) dismiss();
          else router.back();
        }}
        onCancel={() => {
          pendingDismissRef.current = null;
          setConfirmVisible(false);
        }}
        testID="trip-new-button-cancel"
      />
    </View>
  );
}
