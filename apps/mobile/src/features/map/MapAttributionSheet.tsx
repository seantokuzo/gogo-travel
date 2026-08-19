/**
 * Attribution info sheet (T-8.2 / MAP-1 — R-map-6): the spine attribution
 * strings from the shared registry (places spec §3.2.4 `ATTRIBUTION`),
 * rendered verbatim, plus the basemap credit line. The Mapbox wordmark +
 * (i) control on the map itself are the SDK's own ornaments (MapView props,
 * screen-side) — this sheet is OUR surface for the open-data spine credits.
 *
 * testID: `map-sheet-attribution` (§2.7 grammar-derived; the inventory
 * names only the opener `map-button-attribution` — PR interpretation).
 */
import { ATTRIBUTION } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { AppText, Sheet } from "@/components";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[4] },
    entry: { gap: t.space[1] },
  }),
);

export interface MapAttributionSheetProps {
  visible: boolean;
  onDismiss(): void;
}

export function MapAttributionSheet({ visible, onDismiss }: MapAttributionSheetProps) {
  const s = useStyles();
  return (
    <Sheet visible={visible} onDismiss={onDismiss} title="Map data" testID="map-sheet-attribution">
      <View style={s.body}>
        <AppText role="caption" color="secondary">
          Basemap © Mapbox © OpenStreetMap contributors
        </AppText>
        {Object.entries(ATTRIBUTION).map(([source, attribution]) => (
          <View key={source} style={s.entry}>
            <AppText role="caption">{attribution.text}</AppText>
            <AppText role="caption" color="secondary">
              {attribution.url}
            </AppText>
          </View>
        ))}
      </View>
    </Sheet>
  );
}
