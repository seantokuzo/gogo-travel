/**
 * Travel-mode Sheet (T-7.5 / IT-3 — itinerary spec §2.2, R-itin-4/5/6):
 * every computed mode for one `(from, to)` pair plus the "Directions"
 * external handoff.
 *
 * Mode rows are INFORMATIONAL, not selectors. R-itin-4 says the sheet
 * "lists every computed mode"; R-itin-5 fixes which mode the chip shows.
 * Making rows selectable would let the chip contradict R-itin-5, so the
 * only interactive things here are Directions and the close button. The row
 * matching the chip is marked so the mapping is legible.
 *
 * Absent modes are simply missing (R-itin-5/R-ib-21: "transit rows may be
 * absent — degradation is silent"). With the Mapbox token parked this sheet
 * routinely shows ONE transit row, and that is a correct render, not a
 * degraded one — there is no placeholder, no "unavailable" row and no retry.
 *
 * No `dismissDisabled`: this sheet wraps no mutation, so there is no
 * uninterruptible operation to gate (contrast `ScheduleSheet`, which does).
 *
 * testIDs §2.9: `itinerary-leg-{fromItemId}-mode-{mode}` per row,
 * `itinerary-leg-{fromItemId}-directions` for the handoff; the sheet root is
 * `itinerary-leg-sheet` (new id — flagged for the §2.9 sync batch).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import * as Linking from "expo-linking";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Badge, Button, ErrorBanner, Icon, Sheet } from "@/components";
import { buildDirectionsUrl, directionsUrlFor } from "@/features/deeplinks";

import {
  formatLegDistance,
  formatLegDuration,
  TRAVEL_MODE_ICONS,
  TRAVEL_MODE_LABELS,
  type DayLeg,
} from "./legs-model";

const OPEN_ERROR_MESSAGE = "Couldn't open directions. Try again.";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[2] },
    modes: { gap: t.space[2] },
    modeRow: { flexDirection: "row", alignItems: "center", gap: t.space[3] },
    modeText: { flex: 1, gap: 2 },
    directions: { gap: t.space[1] },
  }),
);

export interface LegModeSheetProps {
  /** Non-null ⇒ presented for this pair. */
  leg: DayLeg | null;
  /** `trips.destination_name` — disambiguates bare titles in the maps query. */
  destinationName?: string;
  onDismiss(): void;
}

export function LegModeSheet({ leg, destinationName, onDismiss }: LegModeSheetProps) {
  const { theme } = useTheme();
  const s = useStyles();
  const [openError, setOpenError] = useState<string | null>(null);

  const dismiss = (): void => {
    setOpenError(null);
    onDismiss();
  };

  const directions =
    leg === null
      ? null
      : buildDirectionsUrl({
          origin: leg.fromQuery,
          destination: leg.toQuery,
          mode: leg.defaultMode,
          ...(destinationName !== undefined ? { context: destinationName } : null),
        });

  const directionsUrl = directions === null ? null : directionsUrlFor(directions);

  const openDirections = (url: string): void => {
    // Same handoff posture as the §2.7 partner buttons: open externally,
    // surface a banner if the platform refuses. NOT recorded for the return
    // prompt — a nav handoff books nothing (directions.ts module doc).
    Linking.openURL(url).catch(() => setOpenError(OPEN_ERROR_MESSAGE));
  };

  return (
    <Sheet
      visible={leg !== null}
      onDismiss={dismiss}
      {...(leg !== null ? { title: `To ${leg.toTitle}` } : null)}
      testID="itinerary-leg-sheet"
    >
      {leg !== null && directions !== null ? (
        <View style={s.body}>
          {openError !== null ? (
            <ErrorBanner
              message={openError}
              onDismiss={() => setOpenError(null)}
              testID="itinerary-leg-error"
            />
          ) : null}

          <View style={s.modes}>
            {leg.options.map((option) => (
              <View
                key={option.mode}
                style={s.modeRow}
                testID={`itinerary-leg-${leg.fromItemId}-mode-${option.mode}`}
              >
                <Icon
                  name={TRAVEL_MODE_ICONS[option.mode]}
                  size={20}
                  color={theme.color.text.secondary}
                />
                <View style={s.modeText}>
                  <AppText role="body">
                    {`${TRAVEL_MODE_LABELS[option.mode]} · ${formatLegDuration(option.durationSeconds)}`}
                  </AppText>
                  <AppText role="caption" color="secondary">
                    {`${formatLegDistance(option.distanceMeters)} · ${option.provider}`}
                  </AppText>
                </View>
                {option.mode === leg.defaultMode ? (
                  <Badge label="Shown" tone="accent" size="sm" />
                ) : null}
              </View>
            ))}
          </View>

          <View style={s.directions}>
            {/* ONE decision, `directionsUrlFor`, drives both the disabled
                state and the press. It lives in `directions.ts` and is
                unit-tested against every verdict shape, because the press
                path cannot pin it from here: RNTL won't dispatch onto a
                disabled element, so an in-component guard is un-pinnable
                through the UI by construction (T-7.6 precedent for
                documented un-pinnable guards). */}
            <Button
              title="Directions"
              variant="secondary"
              disabled={directionsUrl === null}
              onPress={() => {
                if (directionsUrl !== null) openDirections(directionsUrl);
              }}
              testID={`itinerary-leg-${leg.fromItemId}-directions`}
            />
            {directions.status === "missing" ? (
              <AppText
                role="caption"
                color="secondary"
                testID={`itinerary-leg-${leg.fromItemId}-directions-hint`}
              >
                {`Needs ${directions.missing.join(" and ")}`}
              </AppText>
            ) : null}
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}
