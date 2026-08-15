/**
 * Day-filter chip strip (T-8.2 / MAP-1 — R-map-3, map spec §2.2).
 *
 * "All" + one chip per trip day, horizontally virtualized (DayJumpStrip
 * precedent — mobile rule: long lists never `ScrollView + .map()`). Chips
 * carry the SAME day-color mapping as the pins (§2.2): selected = filled
 * with the day color (count-badge ink), unselected = surface with the day
 * color as border + number ink. All colors arrive via props from
 * `mapColors`/`mapDayColors` — no literals (R-map-7).
 *
 * testIDs (§2.8): `map-day-filter`, `map-day-filter-chip-all`,
 * `map-day-filter-chip-{dayIndex}`.
 */
import { createStyles } from "@gogo/tokens/react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { AppText } from "@/components";
import { formatDayChip } from "@/features/itinerary";

import type { DayFilterChip, MapDayFilter } from "./day-filter";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    strip: { flexGrow: 0 },
    content: { paddingHorizontal: t.space[4], gap: t.space[2] },
    chip: {
      minWidth: 40,
      alignItems: "center",
      borderRadius: t.radius.full,
      borderWidth: 1.5,
      borderColor: t.color.border.subtle,
      backgroundColor: t.color.bg.surface,
      paddingVertical: t.space[1],
      paddingHorizontal: t.space[3],
    },
    allSelected: {
      backgroundColor: t.color.primary.solid,
      borderColor: t.color.primary.solid,
    },
  }),
);

export interface MapDayFilterStripProps {
  chips: DayFilterChip[];
  value: MapDayFilter;
  onChange(filter: MapDayFilter): void;
  /** Count-badge ink (`mapColors.clusterText`) — selected-chip number ink. */
  selectedInk: string;
}

type Row = { key: "all" } | { key: "day"; chip: DayFilterChip };

export function MapDayFilterStrip({ chips, value, onChange, selectedInk }: MapDayFilterStripProps) {
  const s = useStyles();
  const rows: Row[] = [{ key: "all" }, ...chips.map((chip) => ({ key: "day" as const, chip }))];
  return (
    <View testID="map-day-filter">
      <FlatList
        style={s.strip}
        contentContainerStyle={s.content}
        horizontal
        showsHorizontalScrollIndicator={false}
        data={rows}
        keyExtractor={(row) => (row.key === "all" ? "all" : String(row.chip.dayIndex))}
        renderItem={({ item: row }) => {
          if (row.key === "all") {
            const selected = value === "all";
            return (
              <Pressable
                onPress={() => onChange("all")}
                testID="map-day-filter-chip-all"
                accessibilityRole="button"
                accessibilityLabel="Show all days"
                accessibilityState={{ selected }}
              >
                <View style={[s.chip, selected ? s.allSelected : null]}>
                  <AppText role="caption" style={selected ? { color: selectedInk } : null}>
                    All
                  </AppText>
                </View>
              </Pressable>
            );
          }
          const { chip } = row;
          const selected = value === chip.dayIndex;
          return (
            <Pressable
              onPress={() => onChange(chip.dayIndex)}
              testID={`map-day-filter-chip-${chip.dayIndex}`}
              accessibilityRole="button"
              accessibilityLabel={`Show day ${chip.label} (${formatDayChip(chip.day)}) only`}
              accessibilityState={{ selected }}
            >
              <View
                style={[
                  s.chip,
                  { borderColor: chip.color },
                  selected ? { backgroundColor: chip.color } : null,
                ]}
              >
                <AppText role="caption" style={{ color: selected ? selectedInk : chip.color }}>
                  {chip.label}
                </AppText>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
