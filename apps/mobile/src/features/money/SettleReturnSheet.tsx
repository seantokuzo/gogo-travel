/**
 * "Did you complete the payment?" Sheet (T-9.7 — R-cmoney-21; §2.6 step 5).
 * Presents ONCE per rail deeplink-out returning within 30 minutes (the
 * store owns present-once; useSettleReturnPrompt owns foreground
 * detection). Confirm records the stashed settlement — method and amount
 * come from the STASH, not the screen, so a screen navigated elsewhere in
 * the meantime still records the right entry. Decline/dismiss just closes:
 * the slot was consumed on read (R-cmoney-21 "decline/dismiss clears").
 *
 * One action per presentation (the DeeplinkReturnHost exit-window posture):
 * the confirm is pending-gated, and a failure surfaces inline while the
 * sheet stays dismissible — a failed record must never trap the return.
 */
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { AppText, Button, ErrorBanner, Sheet } from "@/components";

import type { SettleReturnRecord } from "./settle-return-store";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[2] },
  }),
);

const METHOD_LABELS: Readonly<Record<SettleReturnRecord["method"], string>> = {
  venmo: "Venmo",
  cashapp: "Cash App",
  paypal: "PayPal",
  zelle: "Zelle",
  cash: "Cash",
};

export interface SettleReturnSheetProps {
  /** Non-null presents the sheet for this stashed deeplink-out. */
  record: SettleReturnRecord | null;
  /** Payee display name (roster lookup; "Former member" fallback upstream). */
  counterpartyName: string;
  /** Formatted stash amount (shared formatter — Law #2). */
  amountLabel: string;
  pending: boolean;
  errorMessage: string | null;
  onConfirm(record: SettleReturnRecord): void;
  onDismiss(): void;
  /** Owning screen's testID base: `settle` | `settle-request` (§2.8). */
  testIDBase: string;
}

export function SettleReturnSheet({
  record,
  counterpartyName,
  amountLabel,
  pending,
  errorMessage,
  onConfirm,
  onDismiss,
  testIDBase,
}: SettleReturnSheetProps) {
  const s = useStyles();
  return (
    <Sheet
      visible={record !== null}
      onDismiss={onDismiss}
      title="Did you complete the payment?"
      testID={`${testIDBase}-sheet-return`}
    >
      <View style={s.body}>
        {errorMessage !== null ? (
          <ErrorBanner message={errorMessage} testID={`${testIDBase}-sheet-return-error`} />
        ) : null}
        {record !== null ? (
          <AppText role="body" color="secondary">
            {METHOD_LABELS[record.method]} · {amountLabel} to {counterpartyName}
          </AppText>
        ) : null}
        <Button
          title="Yes, record it"
          fullWidth
          loading={pending}
          onPress={() => {
            if (record !== null && !pending) onConfirm(record);
          }}
          testID={`${testIDBase}-sheet-return-confirm`}
        />
        <Button
          title="Not yet"
          variant="ghost"
          fullWidth
          onPress={onDismiss}
          testID={`${testIDBase}-sheet-return-cancel`}
        />
      </View>
    </Sheet>
  );
}
