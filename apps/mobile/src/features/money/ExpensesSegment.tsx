/**
 * Expenses segment — FROZEN W4 SEAM (T-9.5; the GridSurface precedent):
 * T-9.6 (CMON-2) fills the internals (newest-first list, member/category
 * filter Sheet, infinite scroll on the Paginated cursor) WITHOUT the money
 * screen's call site changing — navigation is owned here via the router,
 * so the seam's props stay `{ trip }`.
 *
 * What ships NOW: the §2.8 add-expense FAB — for EVERY member INCLUDING
 * viewers (R-cmoney-5; api R-money-26, resolved Gate 2: viewers log
 * expenses too) — routing to the `expense/new` modal stub, plus an honest
 * placeholder body. Deliberately NOT the "No expenses yet" EmptyState:
 * that copy claims data knowledge this segment doesn't fetch yet
 * (R-cmoney-29 binds it to the REAL list, T-9.6).
 */
import type { TripWithRole } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AppText, Icon } from "@/components";
import { Fab } from "@/features/trips";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    segment: { flex: 1 },
    placeholder: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: t.space[6],
      gap: t.space[3],
    },
    text: { textAlign: "center" },
  }),
);

export interface ExpensesSegmentProps {
  trip: TripWithRole;
}

export function ExpensesSegment({ trip }: ExpensesSegmentProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const router = useRouter();

  return (
    <View style={s.segment}>
      <View style={s.placeholder} testID="money-expenses-placeholder">
        <Icon name="receipt-outline" size={48} color={theme.color.text.muted} />
        <AppText color="secondary" style={s.text}>
          The expense list lands with the next money wave — logging already works from the add
          button.
        </AppText>
      </View>
      <Fab
        icon="add"
        label="Add expense"
        onPress={() =>
          router.push({
            pathname: "/[tripId]/money/expense/new",
            params: { tripId: trip.id },
          })
        }
        testID="money-fab-add-expense"
      />
    </View>
  );
}
