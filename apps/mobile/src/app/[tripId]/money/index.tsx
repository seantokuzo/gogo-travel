/**
 * Money tab (T-9.5 / CMON-1 — client money spec §2.1/§2.2; Law #2: every
 * amount is integer cents, rendered through the shared ISO-4217 helpers).
 *
 * Segments budget · expenses · balances (R-cmoney-1): DEFAULT budget; a
 * manual segment choice is kept per trip for the session only
 * (segment-memory — the R-nav-9 no-snap-back pattern; cold launch
 * re-defaults). SegmentedControl derives the §2.8 testIDs
 * (`money-segment-{key}`) from its base testID.
 *
 * The shell owns chrome ONLY. Each segment component owns its reads and
 * its R-cmoney-29/30 states (loading/error/empty/offline) — so the W4
 * tasks (T-9.6 expenses, T-9.7 settle/request flows) fill segment
 * internals behind frozen seams without this file changing.
 */
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { PageHeader, SegmentedControl } from "@/components";
import {
  BalancesSegment,
  BudgetSegment,
  ExpensesSegment,
  isMoneySegment,
  MONEY_SEGMENTS,
  recallMoneySegment,
  rememberMoneySegment,
  type MoneySegment,
} from "@/features/money";
import { useTripContext } from "@/navigation/trip-context";

/** Labels keyed off the canonical tuple — a new segment is a compile error here. */
const SEGMENT_LABELS: Readonly<Record<MoneySegment, string>> = {
  budget: "Budget",
  expenses: "Expenses",
  balances: "Balances",
};

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    segments: { paddingHorizontal: t.space[4], paddingBottom: t.space[2] },
    body: { flex: 1 },
  }),
);

export default function MoneyScreen() {
  const trip = useTripContext();
  const s = useStyles();
  const [segment, setSegment] = useState<MoneySegment>(
    () => recallMoneySegment(trip.id) ?? "budget",
  );

  const selectSegment = (key: MoneySegment) => {
    setSegment(key);
    rememberMoneySegment(trip.id, key);
  };

  return (
    <View style={s.screen} testID="money-screen">
      <PageHeader title="Money" subtitle={trip.name} large testID="money-header" />
      <View style={s.segments}>
        <SegmentedControl
          // Derived from the canonical tuple (R1: no cast, no parallel list) —
          // the DS control's string key narrows back through the type guard.
          segments={MONEY_SEGMENTS.map((key) => ({ key, label: SEGMENT_LABELS[key] }))}
          selectedKey={segment}
          onChange={(key) => {
            if (isMoneySegment(key)) selectSegment(key);
          }}
          testID="money-segment"
        />
      </View>
      <View style={s.body}>
        {segment === "budget" ? (
          <BudgetSegment trip={trip} />
        ) : segment === "expenses" ? (
          <ExpensesSegment trip={trip} />
        ) : (
          <BalancesSegment trip={trip} />
        )}
      </View>
    </View>
  );
}
