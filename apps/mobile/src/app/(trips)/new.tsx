/**
 * Create trip (T-6.7 / CT-2; trips spec §2.3 — form MODAL per nav §2.6):
 *
 * 1. Name — required text input.
 * 2. Destination — structured search-as-you-type against the places spine
 *    (Overture city/locality subset, resolved Gate 2). No free-text
 *    fallback: submitting requires a PICKED result — a spine hit or the
 *    custom-destination fallback below — so `destination_lat/lng` are
 *    always PRESENT as keys, but B-7 part 3 (2026-09-13 ruling) means their
 *    VALUES may be `null` for a coordinate-less custom pick; `null` is the
 *    signal, never `(0, 0)`. Text-only search carries the ABSOLUTE 2-char
 *    floor (`PLACES_SEARCH_MIN_CHARS`, B-7 review R1 — the server picks the
 *    arm above it) — shorter input just shows guidance.
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
 * Custom-destination fallback (B-7, Sean ruling 2026-09-13, R-tripui-23):
 * WHEN structured search settles with zero hits for a non-blank trimmed
 * query, an inline row offers `Use "<typed text>" as a custom destination`.
 * One tap creates a permanent `source='custom'` place (`POST /places`,
 * `useCreateCustomDestination`) and selects it — no map-drop screen this
 * pass; trip save unblocks the same way a spine pick does. Creation failure
 * surfaces inline and preserves the typed text; the row itself becomes a
 * non-interactive "Creating…" status while a create is in flight, so a
 * second tap has nothing to press (no double-submit).
 * `onMutationSuccess` ignores a SUPERSEDED create (R1/R2 B1 review): if the
 * user has SELECTED anything by the time success lands, that selection is
 * necessarily later than the create (nothing can be selected while the
 * empty-results row that fires a create is showing) and must not be
 * clobbered — checked directly on `selectedPlace`, not on a name-equality
 * proxy for it (a same-named spine pick showed the proxy blind, R2). A
 * retype to a different UNMATCHED query with nothing yet selected is the
 * one case that proxy still earns its keep for, so it stays as a second
 * check. The busy row's own label binds to the mutation's `variables`,
 * never live state, for the same "don't trust live state after the fact"
 * reason. The row/mutate argument itself is the SEARCHED text
 * (`deferredQuery`), never the live `destinationQuery` (R1 A3) — a fast
 * typist could otherwise create a place for text that was never actually
 * searched; a failed create's error also resets on the next query change
 * (R1 A2), and the input caps at 200 chars mirroring `PlaceNameSchema`
 * (R1 A4). B-7 PART 3 (2026-09-13 ruling, `B-7/nullable-custom-coords`):
 * `PlaceCreateSchema` no longer requires coordinates — the created place
 * carries NO `lat`/`lng` at all (`useCreateCustomDestination`), and
 * `selectedPlace.lat/lng` (now `number | null`) flow straight through to
 * `TripCreate.destination_lat/lng` below with no special-casing — the wire
 * type already allows null, and `TripCreateSchema` requires the KEYS, not
 * non-null VALUES. The map tab's coordinate-less degrade (world view, honest
 * empty state, unbounded search, no offline pack) is real behavior now, not
 * a known gap; see `.specs/client/map.spec.md` R-map-26 and
 * `.specs/client/trips.spec.md` R-tripui-23/24.
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
import {
  PLACES_SEARCH_MIN_CHARS,
  TripCreateSchema,
  type Place,
  type TripCreate,
} from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useNavigation, useRouter, type Href } from "expo-router";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

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
import {
  createCustomDestinationErrorMessage,
  isNonBlankDestinationQuery,
  isSearchableDestinationQuery,
  useCreateCustomDestination,
  useCreateTrip,
  useMe,
  usePlaceSearch,
} from "@/data";
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

// createCustomDestinationErrorMessage (the custom-destination `POST /places`
// envelope mapper) is round-1-extracted to `@/data` (trips-mutations.ts) —
// one mutation, one error contract, shared with `more/settings.tsx`.

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
  // The custom-destination row/create argument is the SEARCHED text, not
  // the live query (R1 A3) — see the module doc and `handleCreateCustomDestination`.
  const trimmedSearchedDestinationQuery = deferredQuery.trim();

  const createTrip = useCreateTrip();

  // B-7 custom-destination fallback (Sean ruling 2026-09-13, R-tripui-23):
  // one tap on the empty-results row creates + selects a permanent custom
  // place. Success mirrors the pick-an-existing-result path exactly (fill
  // selectedPlace + the canonical name, clear any stale destination error).
  const createCustomDestination = useCreateCustomDestination({
    onMutationSuccess: (place) => {
      // R2 B1 (blocking, was PARTIAL): a name-equality check is not a
      // "the user picked since" signal — a spine row can share the
      // in-flight create's exact name, and selecting it never changes the
      // visible text, so the old guard saw no difference and still
      // clobbered the pick. A custom create can only ever FIRE while
      // nothing is selected (the empty-results row only renders when
      // `selectedPlace === null`), so ANY selection present when success
      // lands — same name or not — is necessarily the user's LATER pick.
      // Guard on that fact directly, not on a text proxy for it.
      if (selectedPlace !== null) return;
      // Retained (still earns its keep): the user can retype to a
      // DIFFERENT unmatched query without ever selecting anything, which
      // leaves `selectedPlace` null — live text is the only signal a
      // stale create is being superseded in that case.
      if (destinationQuery.trim() !== place.name) return;
      setSelectedPlace(place);
      setDestinationQuery(place.name);
      if (fieldErrors.destination) {
        setFieldErrors((prev) => ({ ...prev, destination: undefined }));
      }
    },
  });
  const handleCreateCustomDestination = useCallback(() => {
    // Defense in depth alongside the busy-row UI swap below (the row itself
    // stops being pressable while pending) — a render race should never be
    // the ONLY thing standing between a tap and a second in-flight create.
    if (createCustomDestination.isPending) return;
    // Guards `deferredQuery` (what actually gets created — R1 A3), not the
    // live `destinationQuery`.
    if (!isNonBlankDestinationQuery(deferredQuery)) return;
    createCustomDestination.mutate(deferredQuery);
  }, [createCustomDestination, deferredQuery]);

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
            maxLength={200}
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
                // R1 A2 (advisory): a stale create FAILURE must not survive
                // a query change — TanStack only clears `isError` on the
                // next `mutate()`, so without this a single failed create
                // permanently hides the plain create-row/idle state behind
                // the OLD error banner for every later query.
                if (createCustomDestination.isError) createCustomDestination.reset();
                if (fieldErrors.destination) {
                  setFieldErrors((prev) => ({ ...prev, destination: undefined }));
                }
              }}
              placeholder="Search cities"
              // B-20: autocorrect fights foreign place names — the core input
              // of a travel app's destination search.
              autoCorrect={false}
              // Mirrors the name field + PlaceNameSchema's 200-char cap
              // (R1 A2/A4 boundary) — without it a >200-char custom
              // destination was a reachable, avoidable 400.
              maxLength={200}
              helper={
                selectedPlace === null && destinationQuery !== "" && !searchActive
                  ? `Keep typing — search starts at ${PLACES_SEARCH_MIN_CHARS} characters.`
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
                <View style={s.fieldGroup}>
                  <AppText role="caption" color="muted">
                    No places matched — try a different spelling.
                  </AppText>
                  {createCustomDestination.isError ? (
                    <ErrorBanner
                      message={createCustomDestinationErrorMessage(createCustomDestination.error)}
                      onRetry={handleCreateCustomDestination}
                      testID="trip-new-error-create-destination"
                    />
                  ) : createCustomDestination.isPending ? (
                    <View style={s.results}>
                      <ListItem
                        // The busy title binds to the MUTATION'S OWN
                        // variables, not live state (R1 B1): if the user
                        // keeps typing while this POST is still in flight,
                        // the label must keep naming what is actually being
                        // created, never a newer, unrelated query.
                        title={`Creating "${(createCustomDestination.variables ?? "").trim()}"…`}
                        leading={
                          <ActivityIndicator
                            size="small"
                            testID="trip-new-list-item-custom-spinner"
                          />
                        }
                        testID="trip-new-list-item-custom"
                      />
                    </View>
                  ) : (
                    <View style={s.results}>
                      <ListItem
                        title={`Use "${trimmedSearchedDestinationQuery}" as a custom destination`}
                        onPress={handleCreateCustomDestination}
                        accessibilityLabel={`Use "${trimmedSearchedDestinationQuery}" as a custom destination`}
                        testID="trip-new-list-item-custom"
                      />
                    </View>
                  )}
                </View>
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
