/**
 * "Did you book it?" prompt (T-7.8 / IT-8; R-nav-18 owns the prompt's
 * contract, §2.8/§2.9 this rendering) — presented by DeeplinkReturnHost on
 * foreground-within-30-min of a deeplink-out. Four actions per R-nav-18:
 * forward-email instructions / share-screenshot / add-manually / dismiss.
 *
 * The forward + share actions route to the CAPTURE spec's surfaces, which
 * don't exist yet (capture bundle / NAV-6): the buttons render (their §2.9
 * testIDs are contract) but stay DISABLED until a consumer passes the
 * handlers — a silent no-op tap would be worse than an honest disabled
 * state. "Add manually" is THIS task's owned leg (§2.8(b)).
 */
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Button, Sheet } from "@/components";

import type { DeeplinkOutRecord } from "./return-prompt-store";
import { partnerLabel } from "./url-builders";

export interface ReturnPromptSheetProps {
  /** Non-null ⇒ visible. The record the user is returning from. */
  record: DeeplinkOutRecord | null;
  onAddManually(record: DeeplinkOutRecord): void;
  onDismiss(): void;
  /** Capture-spec seam (forward-email instructions) — absent ⇒ disabled. */
  onForwardEmail?(record: DeeplinkOutRecord): void;
  /** Capture-spec seam (share-screenshot tips) — absent ⇒ disabled. */
  onShareScreenshot?(record: DeeplinkOutRecord): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[2] },
    buttons: { gap: t.space[2] },
  }),
);

export function ReturnPromptSheet({
  record,
  onAddManually,
  onDismiss,
  onForwardEmail,
  onShareScreenshot,
}: ReturnPromptSheetProps) {
  const s = useStyles();
  // Keep the body rendered through the Sheet's exit animation (the Sheet
  // stays mounted while exiting — DS pattern): cache the last presented
  // record so the content doesn't pop blank mid-dismiss. Late taps on the
  // exiting sheet reach the HOST's one-action gate (P-6 Sheet landmine).
  const [lastRecord, setLastRecord] = useState(record);
  if (record !== null && record !== lastRecord) setLastRecord(record);
  const content = record ?? lastRecord;
  return (
    <Sheet
      visible={record !== null}
      onDismiss={onDismiss}
      title="Did you book it?"
      testID="booking-return-sheet"
    >
      {content !== null ? (
        <View style={s.body}>
          <AppText role="body" color="secondary">
            {`If you booked on ${partnerLabel(content.partner)}, add it to your trip so it lands on the calendar.`}
          </AppText>
          <View style={s.buttons}>
            <Button
              title="Add it manually"
              onPress={() => onAddManually(content)}
              testID="booking-return-button-manual"
            />
            <Button
              title="Forward the email"
              variant="secondary"
              disabled={onForwardEmail === undefined}
              onPress={() => onForwardEmail?.(content)}
              testID="booking-return-button-forward"
            />
            <Button
              title="Share a screenshot"
              variant="secondary"
              disabled={onShareScreenshot === undefined}
              onPress={() => onShareScreenshot?.(content)}
              testID="booking-return-button-share"
            />
            <Button
              title="Not yet"
              variant="ghost"
              onPress={onDismiss}
              testID="booking-return-button-dismiss"
            />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}
