/**
 * Booking add/edit form (T-7.6 / IT-7 — itinerary spec §2.4, R-itin-19/21):
 * per-category fields from `CATEGORY_FIELDS` (mirroring the shared
 * `BookingDetails` shapes), plus the common booking section — status
 * selector (idea/planned/booked), price + currency (paired, Law #2 integer
 * cents), confirmation code, optional place attach — and the §2.7
 * DeeplinkPanel driven live by the form's fields (R-itin-21; consumed,
 * never modified — T-7.8's module).
 *
 * Save routing (§2.4): timeless → bucket; timed → auto-scheduled server-side
 * (I-2); DAY-PICKED timeless (a `?day=` prefill without detail times) →
 * create then the schedule endpoint (R-ib-8) — chained through the
 * HOOK-LEVEL seams only (superseded-call landmine). A schedule-step failure
 * is never silent: the booking exists in Ideas, the form says so and
 * offers Done (no re-create risk — save is retired once created).
 *
 * R-itin-20 (T-7.5): the details' primary times run through the SHARED
 * `deriveAutoItems` — the exact placement the server will create (R-ib-5) —
 * and any overlap with existing items surfaces as a NON-BLOCKING inline
 * notice. Deriving rather than re-deriving keeps the notice honest: what the
 * form warns about is what the calendar will show.
 *
 * Edit (`?bookingId=`): whole-value details replacement (BookingUpdate);
 * `status` rides only when CHANGED (the §3.2 matrix has no self-loops);
 * `cancelled` is terminal — the form shows a static badge (cancel/delete
 * live on booking detail, R-itin-26). Concurrency is collab-v1 LWW
 * (R-ib-18) — no version token, no improvised conflict UI.
 */
import {
  BookingCreateSchema,
  BookingUpdateSchema,
  CurrencyCodeSchema,
  deriveAutoItems,
  type BookingCategory,
  type BookingCreate,
  type BookingStatus,
  type BookingUpdate,
  type BookingWithItems,
  type ISODate,
  type ISOTime,
  type TripWithRole,
} from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Badge, Button, ErrorBanner, Input, SegmentedControl } from "@/components";
import { useCreateBooking, useScheduleBooking, useTripOffline, useUpdateBooking } from "@/data";
import { DeeplinkPanel } from "@/features/deeplinks";
import { DateField } from "@/features/trips";

import {
  buildDetails,
  CATEGORY_FIELDS,
  centsToMoneyText,
  CREATE_STATUS_OPTIONS,
  deeplinkInputFor,
  emptyFormState,
  kebab,
  parseMoneyToCents,
  stateFromDetails,
  statusOptionsFor,
  type DateTimeValue,
  type DetailsFormState,
} from "./form-model";
import { ConflictNotice } from "./ConflictNotice";
import { OptionChips } from "./OptionChips";
import { PlacePickerField } from "./PlacePickerField";
import { TimeField } from "./TimeField";
import { useFormConflicts } from "./useFormConflicts";

export interface BookingFormProps {
  trip: TripWithRole;
  category: BookingCategory;
  /** Present ⇒ edit mode (`?bookingId=`). */
  booking?: BookingWithItems;
  /** `?day=` prefill — the schedule fallback target (R-itin-19). */
  prefillDay?: ISODate;
  /** `?time=` prefill — with `prefillDay`, seeds the primary start (R-itin-14). */
  prefillTime?: ISOTime;
  /** R-itin-22 / R-ib-11: the return prompt's "add manually" landing. */
  deeplinkReturn?: boolean;
  onDirty(): void;
  /**
   * A write LANDED but the flow stays on screen (the create-succeeded /
   * schedule-failed partial state) — the host clears its dirty guard so the
   * discard dialog can't claim "nothing will be saved" about a booking that
   * now exists.
   */
  onWriteLanded(): void;
  onSaved(): void;
}

const STATUS_LABELS: Readonly<Record<BookingStatus, string>> = {
  idea: "Idea",
  planned: "Planned",
  booked: "Booked",
  cancelled: "Cancelled",
};

const useStyles = createStyles((t) =>
  StyleSheet.create({
    form: { gap: t.space[4] },
    row: { flexDirection: "row", gap: t.space[3] },
    rowItem: { flex: 1 },
    section: { gap: t.space[3] },
  }),
);

export function BookingForm({
  trip,
  category,
  booking,
  prefillDay,
  prefillTime,
  deeplinkReturn,
  onDirty,
  onWriteLanded,
  onSaved,
}: BookingFormProps) {
  const s = useStyles();
  const editing = booking !== undefined;
  // R-itin-29 (T-7.9): partner searches need the network as much as the API
  // does — offline, the panel's buttons go disabled with the offline hint.
  // Read here rather than threaded as a prop: both hosts of this form already
  // hand it the trip, and a prop would let one call site forget.
  const offline = useTripOffline(trip.id);

  const [title, setTitle] = useState(booking?.title ?? "");
  const [details, setDetails] = useState<DetailsFormState>(() =>
    booking !== undefined
      ? stateFromDetails(booking.details)
      : emptyFormState(category, { day: prefillDay, time: prefillTime }),
  );
  const [status, setStatus] = useState<BookingStatus>(booking?.status ?? "idea");
  const [priceText, setPriceText] = useState(
    booking !== undefined && booking.price_cents !== null
      ? // T-9.1 rider: minor-unit-aware prefill — the stored currency (falling
        // back to trip base, same as currencyText below) decides the shape.
        centsToMoneyText(booking.price_cents, booking.currency ?? trip.base_currency)
      : "",
  );
  const [currencyText, setCurrencyText] = useState(
    booking?.currency ?? trip.base_currency,
  );
  const [confirmation, setConfirmation] = useState(booking?.confirmation_code ?? "");
  const [place, setPlace] = useState<{ id: string; name: string } | null>(
    booking !== undefined && booking.place_id !== null
      ? // Edit prefill: the booking wire row carries no place NAME — a
        // generic label keeps the attach visible/clearable (flagged in the
        // PR; the maps-spine join is a later seam).
        { id: booking.place_id, name: "Attached place" }
      : null,
  );
  const [placeOpen, setPlaceOpen] = useState(
    booking !== undefined && booking.place_id !== null,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  /** Create+schedule chain: created but the day assignment failed (module doc). */
  const [savedToIdeas, setSavedToIdeas] = useState(false);

  const schedule = useScheduleBooking(trip.id, {
    onMutationSuccess: () => onSaved(),
    onMutationError: () => {
      // The booking EXISTS (create succeeded, only the day assignment
      // failed) — retire the dirty guard so the discard dialog stops
      // claiming nothing was saved.
      setSavedToIdeas(true);
      onWriteLanded();
    },
  });

  const create = useCreateBooking(trip.id, {
    onMutationSuccess: (created) => {
      // §2.4 save routing: a day-picked TIMELESS booking goes on to the
      // schedule endpoint; everything else is done (timed creates were
      // auto-scheduled server-side, I-2).
      //
      // Day only, never `prefillTime`: this arm is reachable ONLY when the
      // user cleared the seeded primary start, so passing the tapped time
      // would resurrect the exact value they just deleted — and schedule it
      // with no visible field explaining where it came from. Day-only
      // matches the empty-day-row fallback.
      if (created.starts_at === null && prefillDay !== undefined) {
        schedule.mutate({ bookingId: created.id, input: { day: prefillDay } });
        return;
      }
      onSaved();
    },
    onMutationError: () => setFormError("Couldn't save the booking. Try again."),
  });

  const update = useUpdateBooking(trip.id, {
    onMutationSuccess: () => onSaved(),
    onMutationError: () => setFormError("Couldn't save the changes. Try again."),
  });

  const pending = create.isPending || schedule.isPending || update.isPending;

  /**
   * R-itin-20: the placement(s) this booking WILL produce (R-ib-5 / §3.3
   * derivation, shared with the server). A half-filled datetime yields no
   * details and therefore no placement — the notice only ever describes a
   * placement the save would really make. A spanning lodging is excluded
   * exactly as it is on the calendar: it renders in the all-day lane, not as
   * a block, so it collides with nothing (conflicts.ts module doc).
   */
  const livePlacements = (() => {
    const built = buildDetails(category, details);
    if (built.details === null) return [];
    return deriveAutoItems(built.details).map((placement) => ({
      ...placement,
      spanning:
        category === "lodging" &&
        placement.end_day !== null &&
        placement.end_day > placement.day,
    }));
  })();
  const conflicts = useFormConflicts(trip.id, livePlacements, {
    bookingId: booking?.id ?? null,
  });

  const touch = <T,>(setter: (value: T) => void) => {
    return (value: T): void => {
      onDirty();
      setter(value);
    };
  };

  const setDetailField = (key: string, value: string | DateTimeValue): void => {
    onDirty();
    setDetails((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => (prev[key] !== undefined ? { ...prev, [key]: "" } : prev));
  };

  const save = (): void => {
    if (pending || savedToIdeas) return;
    const errors: Record<string, string> = {};

    const trimmedTitle = title.trim();
    if (trimmedTitle === "") errors["title"] = "Give it a name.";

    const built = buildDetails(category, details);
    Object.assign(errors, built.errors);

    // Law #2: money enters as a plain-text amount, parsed with integer
    // string math into cents; a price requires a currency (R-ib-12).
    // T-9.1 rider: the parse is ISO-4217 minor-unit aware — the currency
    // field decides the accepted decimal shape (JPY "1500" → 1500).
    let cents: number | undefined;
    let currency: string | undefined;
    if (priceText.trim() !== "") {
      const normalizedCurrency = currencyText.trim().toUpperCase();
      const parsed = parseMoneyToCents(priceText, normalizedCurrency);
      if (!parsed.ok) errors["price"] = parsed.error;
      else cents = parsed.cents;
      const currencyParsed = CurrencyCodeSchema.safeParse(normalizedCurrency);
      if (!currencyParsed.success) errors["currency"] = "3-letter code, like USD.";
      else currency = currencyParsed.data;
    }

    if (Object.values(errors).some((message) => message !== "") || built.details === null) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setFormError(null);

    if (!editing) {
      const candidate: BookingCreate = {
        category,
        title: trimmedTitle,
        details: built.details,
        // Create-mode status is always creatable (CREATE_STATUS_OPTIONS);
        // the conditional narrows the type (`cancelled` is unreachable).
        ...(status !== "cancelled" ? { status } : {}),
        ...(cents !== undefined ? { price_cents: cents } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(confirmation.trim() !== "" ? { confirmation_code: confirmation.trim() } : {}),
        ...(place !== null ? { place_id: place.id } : {}),
        ...(deeplinkReturn === true ? { source: "deeplink_return" as const } : {}),
      };
      const parsed = BookingCreateSchema.safeParse(candidate);
      if (!parsed.success) {
        setFormError("The booking details don't validate — check the fields.");
        return;
      }
      create.mutate(parsed.data);
      return;
    }

    const candidate: BookingUpdate = {
      title: trimmedTitle,
      details: built.details,
      // No §3.2 self-loops: status rides only when actually changed.
      ...(status !== booking.status ? { status } : {}),
      price_cents: cents ?? null,
      currency: currency ?? null,
      confirmation_code: confirmation.trim() !== "" ? confirmation.trim() : null,
      place_id: place !== null ? place.id : null,
    };
    const parsed = BookingUpdateSchema.safeParse(candidate);
    if (!parsed.success) {
      setFormError("The booking details don't validate — check the fields.");
      return;
    }
    update.mutate({ bookingId: booking.id, input: parsed.data });
  };

  const statusOptions = editing ? statusOptionsFor(booking.status) : CREATE_STATUS_OPTIONS;

  return (
    <View style={s.form}>
      {formError !== null ? (
        <ErrorBanner
          message={formError}
          onDismiss={() => setFormError(null)}
          testID="itinerary-item-new-error"
        />
      ) : null}
      {savedToIdeas ? (
        <ErrorBanner
          tone="warning"
          message="Saved to your Ideas — adding it to the day failed. Schedule it from the Ideas bucket."
          testID="itinerary-item-new-saved-to-ideas"
        />
      ) : null}

      {/* R-itin-20: inline, non-blocking — save is never gated on it. */}
      <ConflictNotice conflicts={conflicts} />

      <Input
        label="Name"
        value={title}
        onChangeText={touch(setTitle)}
        placeholder="e.g. Park Hyatt Tokyo"
        error={fieldErrors["title"] || undefined}
        testID="itinerary-item-new-input-title"
      />

      {statusOptions.length > 1 ? (
        <SegmentedControl
          segments={statusOptions.map((option) => ({
            key: option,
            label: STATUS_LABELS[option],
          }))}
          selectedKey={status}
          onChange={(key) => touch(setStatus)(key as BookingStatus)}
          testID="itinerary-item-new-segment-status"
        />
      ) : (
        <Badge label={STATUS_LABELS[booking?.status ?? "idea"]} tone="neutral" />
      )}

      <View style={s.section}>
        {CATEGORY_FIELDS[category].map((field) => {
          if (field.kind === "datetime") {
            const value = (details[field.key] as DateTimeValue | undefined) ?? {
              date: "",
              time: "",
            };
            const error = fieldErrors[field.key];
            return (
              <View key={field.key}>
                <View style={s.row}>
                  <View style={s.rowItem}>
                    <DateField
                      label={`${field.label} date`}
                      value={value.date}
                      onSelect={(date) => setDetailField(field.key, { ...value, date })}
                      testID={`itinerary-item-new-input-${kebab(field.key)}-date`}
                    />
                  </View>
                  <View style={s.rowItem}>
                    <TimeField
                      label={`${field.label} time`}
                      value={value.time}
                      onSelect={(time) => setDetailField(field.key, { ...value, time })}
                      onClear={() => setDetailField(field.key, { ...value, time: "" })}
                      testID={`itinerary-item-new-input-${kebab(field.key)}-time`}
                    />
                  </View>
                </View>
                {error !== undefined && error !== "" ? (
                  <AppText
                    role="caption"
                    accessibilityLiveRegion="polite"
                    testID={`itinerary-item-new-input-${kebab(field.key)}-error`}
                  >
                    {error}
                  </AppText>
                ) : null}
              </View>
            );
          }
          if (field.kind === "enum") {
            return (
              <OptionChips
                key={field.key}
                label={field.label}
                options={field.options}
                value={typeof details[field.key] === "string" ? (details[field.key] as string) : ""}
                onChange={(value) => setDetailField(field.key, value)}
                testID={`itinerary-item-new-input-${kebab(field.key)}`}
              />
            );
          }
          return (
            <Input
              key={field.key}
              label={field.label}
              value={typeof details[field.key] === "string" ? (details[field.key] as string) : ""}
              onChangeText={(value) => setDetailField(field.key, value)}
              multiline={field.kind === "text" && field.multiline === true}
              keyboardType={field.kind === "int" ? "number-pad" : field.kind === "url" ? "url" : "default"}
              error={fieldErrors[field.key] || undefined}
              testID={`itinerary-item-new-input-${kebab(field.key)}`}
            />
          );
        })}
      </View>

      <View style={s.row}>
        <View style={s.rowItem}>
          <Input
            label="Price"
            value={priceText}
            onChangeText={touch(setPriceText)}
            placeholder="89.99"
            keyboardType="decimal-pad"
            helper="Whole amount — stored as exact cents."
            error={fieldErrors["price"] || undefined}
            testID="itinerary-item-new-input-price"
          />
        </View>
        <View style={s.rowItem}>
          <Input
            label="Currency"
            value={currencyText}
            onChangeText={touch(setCurrencyText)}
            placeholder={trip.base_currency}
            error={fieldErrors["currency"] || undefined}
            testID="itinerary-item-new-input-currency"
          />
        </View>
      </View>

      <Input
        label="Confirmation code"
        value={confirmation}
        onChangeText={touch(setConfirmation)}
        error={fieldErrors["confirmation"] || undefined}
        testID="itinerary-item-new-input-confirmation"
      />

      {placeOpen ? (
        <PlacePickerField
          label="Place"
          selected={place}
          onSelect={(selected) => {
            onDirty();
            setPlace(selected !== null ? { id: selected.id, name: selected.name } : null);
          }}
          testID="itinerary-item-new-input-place"
        />
      ) : (
        <Button
          title="Attach a place"
          variant="ghost"
          onPress={() => setPlaceOpen(true)}
          testID="itinerary-item-new-button-place"
        />
      )}

      {/* R-itin-21: partner search — enablement/recording live in the panel
          (T-7.8's module, consumed as-is). */}
      <DeeplinkPanel
        tripId={trip.id}
        surface="form"
        input={deeplinkInputFor(category, details)}
        destinationName={trip.destination_name}
        offline={offline}
      />

      {savedToIdeas ? (
        <Button title="Done" onPress={onSaved} testID="itinerary-item-new-button-done" />
      ) : (
        <Button
          title={editing ? "Save changes" : "Save"}
          onPress={save}
          loading={pending}
          fullWidth
          testID="itinerary-item-new-button-save"
        />
      )}
    </View>
  );
}
