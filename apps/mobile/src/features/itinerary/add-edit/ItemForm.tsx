/**
 * Place-visit / custom item form (T-7.6 / IT-7 — §2.4 table rows 9–10,
 * R-itin-23): place picker (spine search — the saved-places-first leg
 * awaits PL-3/PL-4, flagged) or title, plus day (required — the schema
 * requires every item to have a `day`), optional wall times, notes.
 *
 * Field legality mirrors the wire rules (R-ib-14 / PATCH §3.4): `title` is
 * custom-only, `place_id` is place_visit-only; the single-day time-order
 * rule reuses the SHARED `violatesSingleDayTimeOrder` — no local redefine.
 * Consumes the `?day=`/`?time=` prefills (grid gap-tap, R-itin-14; the
 * empty-day add row sends day only).
 *
 * R-itin-20 (T-7.5): the chosen day/times are checked against the trip's
 * existing items on every render and surfaced as a NON-BLOCKING inline
 * notice — overlaps are legal (R-ib-17) and save stays enabled.
 */
import {
  ItineraryItemCreateSchema,
  ItineraryItemUpdateSchema,
  violatesSingleDayTimeOrder,
  type ISODate,
  type ISOTime,
  type ItineraryItem,
  type ItineraryItemCreate,
  type ItineraryItemUpdate,
} from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button, ErrorBanner, Input } from "@/components";
import { useCreateItineraryItem, useUpdateItineraryItem } from "@/data";
import { DateField } from "@/features/trips";

import { ConflictNotice } from "./ConflictNotice";
import { PlacePickerField } from "./PlacePickerField";
import { TimeField } from "./TimeField";
import { useFormConflicts } from "./useFormConflicts";

export interface ItemFormProps {
  tripId: string;
  kind: "place_visit" | "custom";
  /** Present ⇒ edit mode (`?itemId=`). */
  item?: ItineraryItem;
  prefillDay?: ISODate;
  prefillTime?: ISOTime;
  /**
   * Place preselect for add mode (T-8.4 / R-map-12: the map's "Add to day"
   * opens this form prefilled `place_visit` + place). Ignored in edit mode —
   * the edited row's own `place_id` wins.
   */
  prefillPlace?: { id: string; name: string };
  /**
   * B-10b: seeds the Day picker when no day is set — the host passes the
   * trip's start date so an April-2027 trip doesn't open on today.
   */
  contextDay?: ISODate;
  onDirty(): void;
  onSaved(): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    form: { gap: t.space[4] },
    row: { flexDirection: "row", gap: t.space[3] },
    rowItem: { flex: 1 },
  }),
);

export function ItemForm({
  tripId,
  kind,
  item,
  prefillDay,
  prefillTime,
  prefillPlace,
  contextDay,
  onDirty,
  onSaved,
}: ItemFormProps) {
  const s = useStyles();
  const editing = item !== undefined;

  const [title, setTitle] = useState(item?.title ?? "");
  const [place, setPlace] = useState<{ id: string; name: string } | null>(
    item !== undefined && item.place_id !== null
      ? { id: item.place_id, name: "Selected place" }
      : (prefillPlace ?? null),
  );
  const [day, setDay] = useState<string>(item?.day ?? prefillDay ?? "");
  const [startTime, setStartTime] = useState<string>(
    item?.start_time ?? prefillTime ?? "",
  );
  const [endTime, setEndTime] = useState<string>(item?.end_time ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const create = useCreateItineraryItem(tripId, {
    onMutationSuccess: () => onSaved(),
    onMutationError: () => setFormError("Couldn't save the item. Try again."),
  });
  const update = useUpdateItineraryItem(tripId, {
    onMutationSuccess: () => onSaved(),
    onMutationError: () => setFormError("Couldn't save the changes. Try again."),
  });
  const pending = create.isPending || update.isPending;

  // R-itin-20: an untimed item occupies no span, so it can never conflict —
  // no day or no start time ⇒ no placement to check.
  const conflicts = useFormConflicts(
    tripId,
    day === "" || startTime === ""
      ? []
      : [
          {
            day,
            // Carried from the edited row, not hardcoded null: the form has no
            // end-day field, so an EXISTING spanning item would otherwise be
            // described as same-day and its real [start, midnight] clip would
            // shrink to a zero-length span, under-reporting the overlap the
            // save actually produces.
            end_day: item?.end_day ?? null,
            start_time: startTime,
            end_time: endTime === "" ? null : endTime,
            // `place_visit`/`custom` items are never the spanning-lodging
            // all-day case (that shape only comes from a lodging booking).
            spanning: false,
          },
        ],
    item !== undefined ? { itemIds: [item.id] } : {},
  );

  const touch = <T,>(setter: (value: T) => void) => {
    return (value: T): void => {
      onDirty();
      setter(value);
    };
  };

  const save = (): void => {
    if (pending) return;
    const errors: Record<string, string> = {};
    const trimmedTitle = title.trim();
    if (kind === "custom" && trimmedTitle === "") errors["title"] = "Give it a name.";
    if (kind === "place_visit" && place === null) {
      errors["place"] = "Search and pick a place.";
    }
    if (day === "") errors["day"] = "Pick a day.";
    if (
      violatesSingleDayTimeOrder({
        day,
        start_time: startTime === "" ? null : startTime,
        end_time: endTime === "" ? null : endTime,
      })
    ) {
      errors["end-time"] = "End time must be on or after the start time.";
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setFormError(null);

    if (!editing) {
      const candidate: ItineraryItemCreate = {
        kind,
        day,
        ...(kind === "custom" ? { title: trimmedTitle } : {}),
        ...(kind === "place_visit" && place !== null ? { place_id: place.id } : {}),
        ...(startTime !== "" ? { start_time: startTime } : {}),
        ...(endTime !== "" ? { end_time: endTime } : {}),
        ...(notes.trim() !== "" ? { notes: notes.trim() } : {}),
      };
      const parsed = ItineraryItemCreateSchema.safeParse(candidate);
      if (!parsed.success) {
        setFormError("The item doesn't validate — check the fields.");
        return;
      }
      create.mutate(parsed.data);
      return;
    }

    // PATCH field legality (§3.4): title custom-only, place_id
    // place_visit-only; nullable clears for times/notes (LWW post-state
    // reconciles the cache, R-ib-18).
    const candidate: ItineraryItemUpdate = {
      day,
      start_time: startTime === "" ? null : (startTime as ISOTime),
      end_time: endTime === "" ? null : (endTime as ISOTime),
      notes: notes.trim() !== "" ? notes.trim() : null,
      ...(kind === "custom" ? { title: trimmedTitle } : {}),
      ...(kind === "place_visit" && place !== null ? { place_id: place.id } : {}),
    };
    const parsed = ItineraryItemUpdateSchema.safeParse(candidate);
    if (!parsed.success) {
      setFormError("The item doesn't validate — check the fields.");
      return;
    }
    update.mutate({ itemId: item.id, input: parsed.data });
  };

  return (
    <View style={s.form}>
      {formError !== null ? (
        <ErrorBanner
          message={formError}
          onDismiss={() => setFormError(null)}
          testID="itinerary-item-new-error"
        />
      ) : null}

      {/* R-itin-20: inline, non-blocking — save is never gated on it. */}
      <ConflictNotice conflicts={conflicts} />

      {kind === "custom" ? (
        <Input
          label="Title"
          value={title}
          onChangeText={touch(setTitle)}
          placeholder="e.g. Walk Shibuya"
          error={fieldErrors["title"] || undefined}
          testID="itinerary-item-new-input-title"
        />
      ) : (
        <PlacePickerField
          label="Place"
          selected={place}
          onSelect={(selected) => {
            onDirty();
            setPlace(selected !== null ? { id: selected.id, name: selected.name } : null);
          }}
          error={fieldErrors["place"] || undefined}
          testID="itinerary-item-new-input-place"
        />
      )}

      <DateField
        label="Day"
        value={day}
        contextDate={contextDay}
        onSelect={touch(setDay)}
        error={fieldErrors["day"] || undefined}
        testID="itinerary-item-new-input-day"
      />

      <View style={s.row}>
        <View style={s.rowItem}>
          <TimeField
            label="Start time"
            value={startTime}
            onSelect={touch(setStartTime)}
            // Through `touch`: a clear-ONLY edit must arm the §2.6 dirty
            // guard too, or removing a time and swipe-dismissing loses the
            // change with no discard confirm.
            onClear={() => touch(setStartTime)("")}
            testID="itinerary-item-new-input-start-time"
          />
        </View>
        <View style={s.rowItem}>
          <TimeField
            label="End time"
            value={endTime}
            onSelect={touch(setEndTime)}
            onClear={() => touch(setEndTime)("")}
            error={fieldErrors["end-time"] || undefined}
            testID="itinerary-item-new-input-end-time"
          />
        </View>
      </View>

      <Input
        label="Notes"
        value={notes}
        onChangeText={touch(setNotes)}
        multiline
        testID="itinerary-item-new-input-notes"
      />

      <Button
        title={editing ? "Save changes" : "Save"}
        onPress={save}
        loading={pending}
        fullWidth
        testID="itinerary-item-new-button-save"
      />
    </View>
  );
}
