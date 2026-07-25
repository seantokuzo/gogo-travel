/**
 * AppearanceSection (T-5.8) — appearance (system/light/dark) + accent theme
 * (goldenHour/deepWaters) via `useTheme()`. USER-level prefs persisted by the
 * token provider (R-ds-2/22) — a trip theme never re-skins the app.
 */
import type { AppearancePref } from "@gogo/tokens";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { SegmentedControl } from "@/components";

import { Section } from "./Section";

const APPEARANCE_SEGMENTS = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

const ACCENT_SEGMENTS = [
  { key: "goldenHour", label: "Golden Hour" },
  { key: "deepWaters", label: "Deep Waters" },
];

const useStyles = createStyles((t) =>
  StyleSheet.create({
    group: { gap: t.space[3] },
  }),
);

export function AppearanceSection() {
  const s = useStyles();
  const { appearancePref, setAppearancePref, accentName, setAccentName } = useTheme();

  return (
    <Section title="Appearance" testID="profile-section-appearance">
      <View style={s.group}>
        <SegmentedControl
          segments={APPEARANCE_SEGMENTS}
          selectedKey={appearancePref}
          onChange={(key) => setAppearancePref(key as AppearancePref)}
          testID="profile-appearance"
        />
        <SegmentedControl
          segments={ACCENT_SEGMENTS}
          selectedKey={accentName}
          onChange={setAccentName}
          testID="profile-accent"
        />
      </View>
    </Section>
  );
}
