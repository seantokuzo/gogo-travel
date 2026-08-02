/**
 * Calendar-grid surface (IT-6, §2.5–§2.6) — the W4 FROZEN SEAM.
 *
 * T-7.7 fills THIS file (plus new modules under `./grid/`) with the real
 * hour-axis grid; until then it renders the T-7.4 placeholder unchanged.
 * The props below are the frozen contract with the screen — T-7.6 owns
 * `app/[tripId]/itinerary/index.tsx` this wave, so the grid task never
 * touches the screen (dormant-surface precedent: T-6.3 emitter, T-7.1
 * dirty-day seam).
 *
 * Frozen contract (extend internals, never the boundary):
 * - Root View keeps `testID="itinerary-grid-surface"` — the screen test
 *   pins it; grid internals get their own §2.9 ids.
 * - `onAddAt(day, time?)` → §2.5 gap-tap prefill. The screen routes it to
 *   `item/new` with `day` + rounded `HH:mm`; the form CONSUMING `time` is
 *   T-7.6's half.
 * - `onOpenBooking` / `onOpenItem` → identical routing to the day list
 *   (R-itin-27); spanning-lodging lanes carry the bookingId.
 * - Viewer gating (R-ib-24): render NO add affordance when
 *   `trip.role === "viewer"` — gap-tap is a write affordance.
 */
import type { Booking, ItineraryItem, TripWithRole } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components";

export interface GridSurfaceProps {
  trip: TripWithRole;
  /** Scheduled items from the R-ib-13 composite read (ideas never render here). */
  items: ItineraryItem[];
  /** Booking enrichment by id — the same map the day list's rows are built from. */
  bookingsById: Map<string, Booking>;
  /** §2.5 gap-tap prefill: day (YYYY-MM-DD) + rounded HH:mm when an hour slot is tapped. */
  onAddAt: (day: string, time?: string) => void;
  /** R-itin-27 routing — same targets as the day list rows. */
  onOpenBooking: (bookingId: string) => void;
  onOpenItem: (itemId: string) => void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    shell: { flex: 1 },
    placeholder: { flex: 1, alignItems: "center", justifyContent: "center", gap: t.space[2] },
  }),
);

export function GridSurface(_props: GridSurfaceProps) {
  const s = useStyles();
  return (
    <View style={s.shell} testID="itinerary-grid-surface">
      <View style={s.placeholder} testID="itinerary-grid-placeholder">
        <AppText role="subheading">Calendar grid</AppText>
        <AppText role="caption" color="secondary">
          The hour-by-hour view is on its way.
        </AppText>
      </View>
    </View>
  );
}
