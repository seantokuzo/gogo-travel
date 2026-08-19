/**
 * Locate-me button (T-8.3 / MAP-4 — R-map-16/17, §2.6). Presentation over
 * the `location.ts` state machine: every tap routes through
 * `handleLocatePress` (the LAZY permission entry — nothing runs on mount),
 * and the two dialogs the machine can raise render here:
 *
 *  - rationale (§2.6 "rationale copy first") — fronts the ONE system
 *    prompt; declining changes nothing.
 *  - settings (R-map-16 denied path) — the one-tap `Linking.openSettings()`
 *    hop. Tap-initiated and dismissible each time, so it is non-blocking
 *    and there is no automatic re-prompt loop (the "once per session" hint
 *    posture: WE never surface it unprompted — it exists only behind the
 *    user's own tap).
 *
 * PLACEMENT — bottom-right, stacked ABOVE the attribution (i) button
 * (PR interpretation, continuing PR #23 interp #18's composition contract):
 * the (i) sits at `bottom: space[4]` right-aligned; this button offsets by
 * the (i)'s hit size + a gap so the SDK ornaments bottom-left AND the (i)
 * stay unobscured (R-map-6). Same surface/border recipe as the (i) so the
 * corner reads as one control stack; 44 pt hit target (R-ds-9).
 *
 * Icon state: filled `locate` once granted (the puck-adjacent affordance),
 * outline otherwise. `busy` renders the pressed-state opacity but taps stay
 * enabled — the store's busy gate is the single-flight guard, and a
 * disabled Pressable would be RNTL-unfalsifiable anyway (mobile.md).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import * as Linking from "expo-linking";
import { Pressable, StyleSheet, View } from "react-native";

import { ConfirmDialog, Icon } from "@/components";

import {
  confirmLocateRationale,
  dismissLocateDialog,
  handleLocatePress,
  useMapLocationStore,
} from "./location";

/** The (i) button's box (`map-button-attribution`, screen-side) — 36 pt. */
const ATTRIBUTION_BUTTON_SIZE = 36;
/** R-ds-9 minimum hit target. */
const LOCATE_BUTTON_SIZE = 44;

const useStyles = createStyles((t) =>
  StyleSheet.create({
    button: {
      position: "absolute",
      right: t.space[4],
      bottom: t.space[4] + ATTRIBUTION_BUTTON_SIZE + t.space[2],
      width: LOCATE_BUTTON_SIZE,
      height: LOCATE_BUTTON_SIZE,
      borderRadius: t.radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.bg.surface,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
    },
    pressed: { opacity: 0.7 },
  }),
);

export function MapLocateButton() {
  const s = useStyles();
  const { theme } = useTheme();
  const permission = useMapLocationStore((state) => state.permission);
  const dialog = useMapLocationStore((state) => state.dialog);

  return (
    <View pointerEvents="box-none">
      <Pressable
        style={({ pressed }) => [s.button, pressed ? s.pressed : null]}
        onPress={() => void handleLocatePress()}
        accessibilityRole="button"
        accessibilityLabel="Show my location"
        testID="map-button-locate"
      >
        <Icon
          name={permission === "granted" ? "locate" : "locate-outline"}
          size={20}
          color={
            permission === "granted" ? theme.color.primary.solid : theme.color.text.secondary
          }
        />
      </Pressable>

      <ConfirmDialog
        visible={dialog === "rationale"}
        title="Show your location?"
        body="GoGo uses your location to show where you are on the trip map. It stays on your device."
        confirmLabel="Allow"
        cancelLabel="Not now"
        onConfirm={() => void confirmLocateRationale()}
        onCancel={dismissLocateDialog}
        testID="map-dialog-locate-rationale"
      />
      <ConfirmDialog
        visible={dialog === "settings"}
        title="Location is off"
        body="Turn on location for GoGo in Settings to see where you are on the map."
        confirmLabel="Open Settings"
        onConfirm={() => {
          dismissLocateDialog();
          void Linking.openSettings();
        }}
        onCancel={dismissLocateDialog}
        testID="map-dialog-locate-settings"
      />
    </View>
  );
}
