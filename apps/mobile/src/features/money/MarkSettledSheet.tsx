/**
 * Mark-as-settled Sheet (T-9.7 — R-cmoney-20; §2.6 step 6). The
 * UNCONDITIONAL recording surface: works with zero handles, zero rails,
 * zero deeplinks (research red line — every deeplink is killable sugar).
 * Amount (prefilled, editable through the shared ISO-4217 parser — Law #2),
 * method picker (default `cash`), optional note; confirm hands the resolved
 * cents up — the OWNER posts (settle screen S1 / request screen S1 +
 * `request_id`) so this component stays wire-free and both screens share it.
 *
 * testIDs derive from the owning screen's base (`settle` /
 * `settle-request`, nav §2.7 rule 4); `{base}-picker-method` is the §2.8
 * inventory's `settle-picker-method` on the settle screen. Confirm is
 * pending-gated (loading Button blocks re-press — the double-submit
 * posture) and the sheet's dismissal stays ENABLED while posting fails
 * (R-cmoney-22 kin: never trap the user).
 */
import { SETTLEMENT_METHODS, parseMoneyToCents, type SettlementMethod } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button, ErrorBanner, Input, SegmentedControl, Sheet } from "@/components";

import { centsToAmountText } from "./settle-position";

const METHOD_LABELS: Readonly<Record<SettlementMethod, string>> = {
  venmo: "Venmo",
  cashapp: "Cash App",
  paypal: "PayPal",
  zelle: "Zelle",
  cash: "Cash",
};

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[2] },
  }),
);

export interface MarkSettledConfirm {
  amount_cents: number;
  method: SettlementMethod;
  note?: string;
}

export interface MarkSettledSheetProps {
  visible: boolean;
  /** Trip base currency (R-money-13). */
  currency: string;
  /** Prefill, integer minor units — the screen's displayed amount. */
  defaultAmountCents: number;
  pending: boolean;
  /** Post failure — rendered inline; the sheet stays usable. */
  errorMessage: string | null;
  onConfirm(input: MarkSettledConfirm): void;
  onDismiss(): void;
  /** Owning screen's testID base: `settle` | `settle-request` (§2.7 rule 4). */
  testIDBase: string;
}

export function MarkSettledSheet({
  visible,
  currency,
  defaultAmountCents,
  pending,
  errorMessage,
  onConfirm,
  onDismiss,
  testIDBase,
}: MarkSettledSheetProps) {
  const s = useStyles();
  // Prefill snapshots at MOUNT (R-cmoney-20 "amount (prefilled)", default
  // method `cash`): owners mount this sheet per presentation (the
  // ManualAddBookingSheet remount idiom), so each open starts clean
  // without a setState-in-effect.
  const [amountText, setAmountText] = useState(() =>
    defaultAmountCents > 0 ? centsToAmountText(defaultAmountCents, currency) : "",
  );
  const [method, setMethod] = useState<SettlementMethod>("cash");
  const [note, setNote] = useState("");

  const parsed = parseMoneyToCents(amountText, currency);
  const amountError = amountText.length > 0 && !parsed.ok ? parsed.error : undefined;
  const confirmable = parsed.ok && parsed.cents > 0 && !pending;

  const confirm = () => {
    if (!parsed.ok || parsed.cents <= 0 || pending) return;
    const trimmed = note.trim();
    onConfirm({
      amount_cents: parsed.cents,
      method,
      ...(trimmed.length > 0 ? { note: trimmed } : {}),
    });
  };

  return (
    <Sheet
      visible={visible}
      onDismiss={onDismiss}
      title="Mark as settled"
      testID={`${testIDBase}-sheet-mark-settled`}
    >
      <View style={s.body}>
        {errorMessage !== null ? (
          <ErrorBanner
            message={errorMessage}
            testID={`${testIDBase}-sheet-mark-settled-error`}
          />
        ) : null}
        <Input
          label={`Amount (${currency})`}
          value={amountText}
          onChangeText={setAmountText}
          keyboardType="decimal-pad"
          autoCorrect={false}
          {...(amountError === undefined ? {} : { error: amountError })}
          testID={`${testIDBase}-sheet-mark-settled-input-amount`}
        />
        <SegmentedControl
          segments={SETTLEMENT_METHODS.map((key) => ({ key, label: METHOD_LABELS[key] }))}
          selectedKey={method}
          onChange={(key) => {
            // Narrow via the canonical tuple — the DS control hands back a string.
            if ((SETTLEMENT_METHODS as readonly string[]).includes(key)) {
              setMethod(key as SettlementMethod);
            }
          }}
          testID={`${testIDBase}-picker-method`}
        />
        <Input
          label="Note (optional)"
          value={note}
          onChangeText={setNote}
          testID={`${testIDBase}-sheet-mark-settled-input-note`}
        />
        <Button
          title="Record settlement"
          onPress={confirm}
          loading={pending}
          disabled={!confirmable}
          fullWidth
          testID={`${testIDBase}-sheet-mark-settled-confirm`}
        />
      </View>
    </Sheet>
  );
}
