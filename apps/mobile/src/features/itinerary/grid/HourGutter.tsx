/**
 * Shared hour gutter (T-7.7 / IT-6 — §2.5, R-itin-13): one vertical axis of
 * 24 one-hour labels beside the paged day columns. Lives INSIDE the shared
 * vertical scroller so labels and slots can never drift apart; it sits
 * OUTSIDE the horizontal pager so it stays put across day pages.
 */
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components";

import { GUTTER_WIDTH } from "./constants";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const useStyles = createStyles((t) =>
  StyleSheet.create({
    gutter: { width: GUTTER_WIDTH },
    hour: {
      position: "absolute",
      right: t.space[1],
      alignItems: "flex-end",
    },
  }),
);

export interface HourGutterProps {
  hourHeight: number;
}

export function HourGutter({ hourHeight }: HourGutterProps) {
  const s = useStyles();
  return (
    <View style={[s.gutter, { height: 24 * hourHeight }]} testID="itinerary-grid-hours">
      {HOURS.map((hour) => (
        <View key={hour} style={[s.hour, { top: hour * hourHeight }]}>
          <AppText role="caption" color="secondary">
            {`${String(hour).padStart(2, "0")}:00`}
          </AppText>
        </View>
      ))}
    </View>
  );
}
