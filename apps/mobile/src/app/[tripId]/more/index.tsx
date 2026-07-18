import { createStyles } from "@gogo/tokens/react";
import { useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { Card, Icon, ListItem, PageHeader } from "@/components";
import type { IconName } from "@/components";
import { useTripId } from "@/navigation/trip-context";

/**
 * More tab (§2.4) — the hub of ListItem rows. This screen has real skeleton
 * content (its rows ARE navigation), so it doesn't use PlaceholderScreen.
 * The capture row opens the trips-level queue (R-nav-24) — the per-trip
 * filter + needs-review badge are NAV-6 data wiring. Offline-pack status is
 * owned by the offline spec.
 *
 * Rows are a static bounded hub, not a data list — no FlatList needed
 * (virtualization landmine targets data-driven lists).
 */
type MoreTarget = "photos" | "packing" | "documents" | "members" | "settings" | "capture";

const ROWS: { key: MoreTarget; title: string; icon: IconName }[] = [
  { key: "photos", title: "Photos", icon: "images-outline" },
  { key: "packing", title: "Packing", icon: "briefcase-outline" },
  { key: "documents", title: "Documents", icon: "document-text-outline" },
  { key: "members", title: "Members", icon: "people-outline" },
  { key: "capture", title: "Capture inbox", icon: "file-tray-full-outline" },
  { key: "settings", title: "Trip settings", icon: "settings-outline" },
];

// Literal route patterns — typed-routes-safe (a template literal would decay
// to `/[tripId]/more/${string}` and miss the generated Href union).
const TAB_LOCAL_PATHS = {
  photos: "/[tripId]/more/photos",
  packing: "/[tripId]/more/packing",
  documents: "/[tripId]/more/documents",
  members: "/[tripId]/more/members",
  settings: "/[tripId]/more/settings",
} as const;

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: { padding: t.space[4] },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.color.border.subtle },
  }),
);

export default function MoreScreen() {
  const tripId = useTripId();
  const router = useRouter();
  const s = useStyles();

  const open = (target: MoreTarget) => {
    if (target === "capture") {
      // R-nav-24: the per-trip capture entry opens the TRIPS-LEVEL queue
      // (filtered to this trip once NAV-6 wires the data).
      router.push("/(trips)/capture");
      return;
    }
    router.push({ pathname: TAB_LOCAL_PATHS[target], params: { tripId } });
  };

  return (
    <View style={s.screen} testID="more-screen">
      <PageHeader title="More" subtitle={`Trip ${tripId}`} large testID="more-header" />
      <View style={s.body}>
        <Card padded={false}>
          {ROWS.map((row, i) => (
            <View key={row.key}>
              {i > 0 ? <View style={s.divider} /> : null}
              <ListItem
                title={row.title}
                leading={<Icon name={row.icon} size={22} />}
                trailing="chevron"
                onPress={() => open(row.key)}
                testID={`more-list-item-${row.key}`}
              />
            </View>
          ))}
        </Card>
      </View>
    </View>
  );
}
