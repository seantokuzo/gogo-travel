/**
 * Budget segment (T-9.5 / CMON-1 — R-cmoney-2/3/4/29/30; §2.2 "Budget").
 *
 * Composition: header Card — computed TOTAL spend beside the editable
 * overall trip cap (R-cmoney-2, resolved Gate 2 → `PUT /budgets/total`) ·
 * one row per `expense_category` straight off the G1 document (full
 * taxonomy server-synthesized, R-money-20 — never a local list,
 * R-cmoney-4) with progress vs cap, computed spend, the AI-estimate value
 * + `ai_estimated_at` when present, and an inline cap input (editor+) ·
 * footer "Estimate with AI".
 *
 * Progress thresholds (R-cmoney-2) are INTEGER comparisons — `spent×5 ≥
 * cap×4` (≥80%, warning) and `spent > cap` (over) — rendered via semantic
 * status tokens, never hardcoded colors (R-ds-7); the bar width percent is
 * BigInt-truncated so no float ever touches a money value (Law #2).
 *
 * AI-ESTIMATE CTA: a VISIBLE DISABLED stub (PLANNING § P-9 note — MON-7
 * needs the P-10 platform; T-10.5 wires the R-cmoney-3 state machine). No
 * handler exists by design; the pin asserts the disabled STATE, not a
 * press no-op (the vacuous-disabled-press landmine, mobile.md).
 *
 * States (R-cmoney-29): skeleton rows while the read settles · "Plan your
 * spending" EmptyState when untouched (no caps, no estimates — §2.9), whose
 * set-caps action reveals the row editor · ErrorBanner + retry on failure ·
 * offline = cached render + informational banner, no retry lie (R-itin-29
 * posture); cap-save failures surface visibly (mutations never fail silent).
 */
import type { ExpenseCategory, TripWithRole } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { AppText, Button, Card, EmptyState, ErrorBanner, Skeleton } from "@/components";
import { usePutBudget, useTripBudgets, useTripOffline } from "@/data";

import { CapInput } from "./CapInput";
import { moneyLabel } from "./money-format";

/** Display labels keyed off the SHARED enum — a new category is a compile error here. */
const CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = {
  lodging: "Lodging",
  transport: "Transport",
  food: "Food",
  activities: "Activities",
  shopping: "Shopping",
  other: "Other",
};

const useStyles = createStyles((t) =>
  StyleSheet.create({
    segment: { flex: 1 },
    container: { padding: t.space[4], gap: t.space[3] },
    skeleton: { padding: t.space[4], gap: t.space[3] },
    banner: { paddingHorizontal: t.space[4], paddingTop: t.space[2] },
    state: { flex: 1, justifyContent: "center" },
    totalRow: { gap: t.space[2] },
    totalHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    row: { borderRadius: t.radius.md, padding: t.space[3], gap: t.space[2] },
    rowHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    track: {
      height: 6,
      borderRadius: t.radius.full,
      backgroundColor: t.color.bg.inset,
      overflow: "hidden",
    },
    fill: { height: 6, borderRadius: t.radius.full },
    footer: { gap: t.space[2], paddingTop: t.space[2] },
  }),
);

/** ≥80% of cap (integer math — Law #2 applies to intermediates too). */
function isWarning(spent: number, cap: number | null): boolean {
  return cap !== null && cap > 0 && spent * 5 >= cap * 4;
}

function isOver(spent: number, cap: number | null): boolean {
  return cap !== null && spent > cap;
}

/** Bar width 0–100 — BigInt-truncated, no float division. */
function progressPercent(spent: number, cap: number | null): number | null {
  if (cap === null) return null;
  if (cap === 0) return spent > 0 ? 100 : 0;
  const pct = Number((BigInt(spent) * 100n) / BigInt(cap));
  return pct > 100 ? 100 : pct;
}

export interface BudgetSegmentProps {
  trip: TripWithRole;
}

export function BudgetSegment({ trip }: BudgetSegmentProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const budgets = useTripBudgets(trip.id);
  const offline = useTripOffline(trip.id);
  const [saveFailed, setSaveFailed] = useState(false);
  const putBudget = usePutBudget(trip.id, {
    // HOOK-level seam (T-6.8/T-6.9 landmine): fires for EVERY settled call.
    onMutationError: () => setSaveFailed(true),
    onMutationSuccess: () => setSaveFailed(false),
  });
  /** §2.9 "Plan your spending" reveal — editor tapped set-caps on the EmptyState. */
  const [planRevealed, setPlanRevealed] = useState(false);

  // R-cmoney-2 client half: cap editing is editor+ — viewers get read-only
  // rows (no guaranteed-403 inputs; server enforces regardless).
  const editor = trip.role !== "viewer";

  const settled = budgets.data !== undefined;
  const failed = budgets.isError;

  const aiCta = (
    <View style={s.footer}>
      {/* MON-7 stub (module doc): pinned disabled, no handler until T-10.5. */}
      <Button
        title="Estimate with AI"
        onPress={() => undefined}
        disabled
        variant="secondary"
        fullWidth
        testID="money-button-ai-estimate"
      />
      <AppText role="caption" color="muted">
        AI estimates arrive with the AI phase.
      </AppText>
    </View>
  );

  if (!settled) {
    if (failed) {
      return (
        <View style={s.banner}>
          <ErrorBanner
            message={
              offline
                ? "You're offline and this trip's budget isn't cached yet."
                : "Couldn't load the budget."
            }
            onRetry={() => void budgets.refetch()}
            testID="money-budget-error"
          />
        </View>
      );
    }
    return (
      <View style={s.skeleton} testID="money-budget-loading">
        <Skeleton variant="rect" height={72} />
        <Skeleton variant="rect" height={64} />
        <Skeleton variant="rect" height={64} />
        <Skeleton variant="rect" height={64} />
      </View>
    );
  }

  const doc = budgets.data;
  const base = trip.base_currency;
  // §2.9 "no caps, no estimates" — the untouched condition, spend-agnostic.
  const untouched =
    doc.total.cap_cents === null &&
    doc.items.every((item) => item.cap_cents === null && item.ai_estimate_cents === null);

  const banners = (
    <>
      {offline ? (
        <View style={s.banner}>
          {/* Offline is a STATE, not a fetch error (R-itin-29 posture): the
              data below is real, just not fresh — no retry lie. */}
          <ErrorBanner
            tone="warning"
            message="You're offline — showing your last synced budget."
            testID="money-banner-offline"
          />
        </View>
      ) : null}
      {failed && !offline ? (
        <View style={s.banner}>
          <ErrorBanner
            message="Couldn't refresh the budget."
            onRetry={() => void budgets.refetch()}
            testID="money-budget-refresh-error"
          />
        </View>
      ) : null}
      {saveFailed ? (
        <View style={s.banner}>
          <ErrorBanner
            message="Couldn't save the cap — your change wasn't applied."
            onDismiss={() => setSaveFailed(false)}
            testID="money-budget-save-error"
          />
        </View>
      ) : null}
    </>
  );

  if (untouched && !planRevealed) {
    return (
      <View style={s.segment}>
        {banners}
        <View style={s.state}>
          <EmptyState
            icon="pie-chart-outline"
            title="Plan your spending"
            body="Set a cap per category — or an overall trip cap — and watch spend against it."
            {...(editor
              ? {
                  action: {
                    label: "Set category caps",
                    onPress: () => setPlanRevealed(true),
                    testID: "money-budget-empty-set-caps",
                  },
                }
              : {})}
            testID="money-budget-empty"
          />
          {aiCta}
        </View>
      </View>
    );
  }

  return (
    <View style={s.segment}>
      {banners}
      <ScrollView contentContainerStyle={s.container}>
        {/* R-cmoney-2 (Gate 2): the overview header is the EDITABLE total cap
            with computed total spend beside it. */}
        <Card>
          <View style={s.totalRow}>
            <View style={s.totalHead}>
              <AppText role="heading">Total</AppText>
              <AppText role="bodyStrong">{`${moneyLabel(doc.total.spent_cents, base)} spent`}</AppText>
            </View>
            {editor ? (
              <CapInput
                label="Overall trip cap"
                currency={base}
                capCents={doc.total.cap_cents}
                pending={putBudget.isPending}
                testID="money-input-cap-total"
                onCommit={(cap_cents) => putBudget.mutate({ category: "total", cap_cents })}
              />
            ) : (
              <AppText color="secondary">
                {doc.total.cap_cents === null
                  ? "No overall cap"
                  : `Cap ${moneyLabel(doc.total.cap_cents, base)}`}
              </AppText>
            )}
          </View>
        </Card>

        {doc.items.map((item) => {
          const over = isOver(item.spent_cents, item.cap_cents);
          const warning = !over && isWarning(item.spent_cents, item.cap_cents);
          const pct = progressPercent(item.spent_cents, item.cap_cents);
          const fillColor = over
            ? theme.color.status.danger.fg
            : warning
              ? theme.color.status.warning.fg
              : theme.color.primary.solid;
          return (
            <View
              key={item.category}
              style={[
                s.row,
                {
                  backgroundColor: over
                    ? theme.color.status.danger.bg
                    : warning
                      ? theme.color.status.warning.bg
                      : theme.color.bg.surface,
                },
              ]}
              testID={`money-budget-list-item-${item.category}`}
            >
              <View style={s.rowHead}>
                <AppText role="subheading">{CATEGORY_LABELS[item.category]}</AppText>
                <AppText role="body" color="secondary">
                  {item.cap_cents === null
                    ? `${moneyLabel(item.spent_cents, item.currency)} spent`
                    : `${moneyLabel(item.spent_cents, item.currency)} of ${moneyLabel(item.cap_cents, item.currency)}`}
                </AppText>
              </View>
              {pct !== null ? (
                <View style={s.track}>
                  <View
                    style={[s.fill, { width: `${pct}%`, backgroundColor: fillColor }]}
                    testID={`money-budget-progress-${item.category}`}
                  />
                </View>
              ) : null}
              {item.ai_estimate_cents !== null && item.ai_estimated_at !== null ? (
                <AppText role="caption" color="muted">
                  {`AI est. ${moneyLabel(item.ai_estimate_cents, item.currency)} · ${new Date(item.ai_estimated_at).toLocaleDateString()}`}
                </AppText>
              ) : null}
              {editor ? (
                <CapInput
                  label="Cap"
                  currency={item.currency}
                  capCents={item.cap_cents}
                  pending={putBudget.isPending}
                  testID={`money-input-cap-${item.category}`}
                  onCommit={(cap_cents) => putBudget.mutate({ category: item.category, cap_cents })}
                />
              ) : null}
            </View>
          );
        })}

        {aiCta}
      </ScrollView>
    </View>
  );
}
