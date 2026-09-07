/**
 * Rail-button list (T-9.7 — R-cmoney-15..20/22/24). THE one rendering of
 * the rail machinery, consumed by both R-cmoney surfaces: the settle
 * screen's handoff Sheet (§2.6 step 3) and the request recipient screen
 * (R-cmoney-26 "the same rail machinery"). One button per rail present
 * (rails.ts output — no disabled stubs), Zelle as a copyable row
 * (R-cmoney-19), PayPal framed personal/F&F (R-cmoney-24), "Mark as
 * settled" ALWAYS last and never gated on rail state (R-cmoney-20), rail
 * failures inline + non-blocking (R-cmoney-22).
 */
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { AppText, Button, ErrorBanner } from "@/components";

import type { Rail } from "./rails";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    list: { gap: t.space[3] },
    zelleRow: {
      gap: t.space[1],
      borderRadius: t.radius.md,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
      padding: t.space[3],
    },
  }),
);

export type OpenableRail = Extract<Rail, { kind: "venmo" | "cashapp" | "paypal" }>;
export type ZelleRail = Extract<Rail, { kind: "zelle" }>;

export interface RailListProps {
  rails: Rail[];
  counterpartyName: string;
  /** Display amount label (shared formatter) — Zelle manual-entry adjacency. */
  amountLabel: string;
  /** Rail-open failure (R-cmoney-22) — non-blocking, list stays usable. */
  railError: string | null;
  /** Zelle handle landed on the clipboard (copy-confirmation state). */
  zelleCopied: boolean;
  onOpenRail(rail: OpenableRail): void;
  onCopyZelle(rail: ZelleRail): void;
  onMarkSettled(): void;
  /** Owning screen's testID base: `settle` | `settle-request` (§2.8). */
  testIDBase: string;
}

const RAIL_TITLES = {
  venmo: "Pay with Venmo",
  cashapp: "Pay with Cash App",
  // R-cmoney-24: personal-payment framing in the copy (ToS red line).
  paypal: "Pay with PayPal (Friends & Family)",
} as const;

const RAIL_TEST_IDS = { venmo: "venmo", cashapp: "cashapp", paypal: "paypal" } as const;

export function RailList({
  rails,
  counterpartyName,
  amountLabel,
  railError,
  zelleCopied,
  onOpenRail,
  onCopyZelle,
  onMarkSettled,
  testIDBase,
}: RailListProps) {
  const s = useStyles();
  const hasPayPal = rails.some((rail) => rail.kind === "paypal");

  return (
    <View style={s.list}>
      {railError !== null ? (
        <ErrorBanner message={railError} testID={`${testIDBase}-handoff-error`} />
      ) : null}
      {rails.length === 0 ? (
        // R-cmoney-15: zero handles → hint ABOVE the always-present
        // mark-as-settled action; no disabled stubs.
        <AppText role="body" color="secondary" testID={`${testIDBase}-handoff-no-handles`}>
          {counterpartyName} hasn&apos;t added payment handles.
        </AppText>
      ) : null}
      {rails.map((rail) =>
        rail.kind === "zelle" ? (
          // R-cmoney-19: no link exists — copyable handle beside the
          // display name and the amount for manual entry.
          <View key={rail.kind} style={s.zelleRow}>
            <AppText role="bodyStrong">Zelle · {rail.displayName}</AppText>
            <AppText role="caption" color="secondary">
              {rail.handle} · {amountLabel}
            </AppText>
            <Button
              title={zelleCopied ? "Copied" : "Copy Zelle handle"}
              variant="ghost"
              icon={zelleCopied ? "checkmark-circle-outline" : "copy-outline"}
              onPress={() => onCopyZelle(rail)}
              testID={`${testIDBase}-button-zelle-copy`}
            />
          </View>
        ) : (
          <Button
            key={rail.kind}
            title={RAIL_TITLES[rail.kind]}
            variant="secondary"
            icon="open-outline"
            fullWidth
            onPress={() => onOpenRail(rail)}
            testID={`${testIDBase}-button-${RAIL_TEST_IDS[rail.kind]}`}
          />
        ),
      )}
      {hasPayPal ? (
        <AppText role="caption" color="secondary">
          PayPal opens as a personal (Friends &amp; Family) payment.
        </AppText>
      ) : null}
      <Button
        title="Mark as settled"
        fullWidth
        onPress={onMarkSettled}
        testID={`${testIDBase}-button-mark-settled`}
      />
    </View>
  );
}
