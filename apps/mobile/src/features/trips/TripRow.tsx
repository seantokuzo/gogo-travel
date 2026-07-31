/**
 * Trip-list row (T-6.7 / CT-1; R-tripui-2, §2.1) — pressable Card: name,
 * destination, date range, member count. Active trips visually lead with a
 * primary accent bar (§2.1 "section-relevant accent"). Tap → `/[tripId]`
 * where the nav default-tab rules apply (R-nav-7/8 — the [tripId] layout
 * resolves the tab; the row never guesses).
 */
import type { TripListItem } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { AppText, Card } from "@/components";

import { formatDateRange, formatMemberCount } from "./sections";

export interface TripRowProps {
  trip: TripListItem;
  onPress(): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    card: { marginHorizontal: t.space[4], marginBottom: t.space[3] },
    activeAccent: { borderLeftWidth: 3, borderLeftColor: t.color.primary.solid },
    meta: { flexDirection: "row", justifyContent: "space-between", marginTop: t.space[2] },
  }),
);

export function TripRow({ trip, onPress }: TripRowProps) {
  const s = useStyles();
  const range = formatDateRange(trip.start_date, trip.end_date);
  const members = formatMemberCount(trip.member_count);
  return (
    <Card
      onPress={onPress}
      style={[s.card, trip.status === "active" && s.activeAccent]}
      // §2.7: dynamic qualifiers are stable entity ids, never render indexes.
      testID={`trip-list-list-item-${trip.id}`}
      accessibilityLabel={`${trip.name}, ${trip.destination_name}, ${range}, ${members}`}
    >
      <AppText role="subheading" numberOfLines={1}>
        {trip.name}
      </AppText>
      <AppText color="secondary" numberOfLines={1}>
        {trip.destination_name}
      </AppText>
      <View style={s.meta}>
        <AppText role="caption" color="muted">
          {range}
        </AppText>
        <AppText role="caption" color="muted">
          {members}
        </AppText>
      </View>
    </Card>
  );
}
