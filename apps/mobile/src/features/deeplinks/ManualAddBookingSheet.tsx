/**
 * Minimal "add manually" landing (T-7.8 / IT-8; §2.8(b), API R-ib-11) —
 * STOPGAP until T-7.6's full add flow: the return prompt's manual action
 * must land somewhere that creates a booking carrying
 * `source: 'deeplink_return'` TODAY, and `item/new` doesn't exist yet.
 * One title field → `POST /trips/:tripId/bookings` with the recorded
 * category, `source: 'deeplink_return'` (status defaults to `idea`
 * server-side — a timeless idea lands in the bucket, R-ib-4/I-3).
 *
 * T-7.6 SEAM: when the real form modal lands, DeeplinkReturnHost's
 * `onAddManually` prop routes to `item/new?category={category}` with the
 * deeplink-return source instead, and this sheet stops mounting — nothing
 * else changes. testIDs here use the §2.9 grammar under a `booking-manual-
 * add` screen prefix (this surface is not in the §2.9 inventory — it is
 * the stopgap, flagged in the T-7.8 PR).
 *
 * Mutation discipline: side effects ride the HOOK-level seam on
 * `useCreateBooking` (T-6.8/T-6.9 superseded-call landmine); the save
 * button's `loading` press-block (R-ds-14) is the double-submit gate.
 */
import type { Booking, BookingCategory } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button, ErrorBanner, Input, Sheet } from "@/components";
import { useCreateBooking } from "@/data/bookings";

import type { DeeplinkOutRecord } from "./return-prompt-store";

const CATEGORY_LABELS: Readonly<Record<BookingCategory, string>> = {
  lodging: "lodging",
  flight: "flight",
  train: "train",
  car_rental: "car rental",
  moped_rental: "moped rental",
  activity: "activity",
  restaurant: "reservation",
  other: "booking",
};

export interface ManualAddBookingSheetProps {
  record: DeeplinkOutRecord;
  visible: boolean;
  onClose(): void;
  /** Fires after a successful create (host relays to its consumer seam). */
  onCreated?(booking: Booking): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[2] },
  }),
);

export function ManualAddBookingSheet({
  record,
  visible,
  onClose,
  onCreated,
}: ManualAddBookingSheetProps) {
  const s = useStyles();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useCreateBooking(record.tripId, {
    onMutationError: () => setError("Couldn't save the booking. Try again."),
    onMutationSuccess: (booking) => {
      onCreated?.(booking);
      onClose();
    },
  });

  const trimmed = title.trim();
  const save = (): void => {
    if (trimmed.length === 0 || create.isPending) return;
    setError(null);
    create.mutate({
      category: record.category,
      title: trimmed,
      source: "deeplink_return",
    });
  };

  return (
    <Sheet
      visible={visible}
      onDismiss={onClose}
      title={`Add your ${CATEGORY_LABELS[record.category]}`}
      testID="booking-manual-add-sheet"
    >
      <View style={s.body}>
        {error !== null ? (
          <ErrorBanner
            message={error}
            onDismiss={() => setError(null)}
            testID="booking-manual-add-error"
          />
        ) : null}
        <Input
          label="Name"
          value={title}
          onChangeText={setTitle}
          placeholder="e.g. Park Hyatt Tokyo"
          testID="booking-manual-add-input-title"
        />
        <Button
          title="Save to trip"
          onPress={save}
          loading={create.isPending}
          disabled={trimmed.length === 0}
          testID="booking-manual-add-button-save"
        />
        <Button
          title="Cancel"
          variant="ghost"
          onPress={onClose}
          testID="booking-manual-add-button-cancel"
        />
      </View>
    </Sheet>
  );
}
