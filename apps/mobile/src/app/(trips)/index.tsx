import { useRouter } from "expo-router";

import { Button, ErrorBanner } from "@/components";
import { useLinkNoticeStore } from "@/navigation/link-notice";
import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Trip list (§2.4) — the default landing route (R-nav-5). Header entries are
 * nav-owned: profile avatar → `(trips)/profile`, capture inbox →
 * `(trips)/capture` (R-nav-24; the needs-review count badge is NAV-6 data
 * wiring). List content (active/upcoming/past grouping) is owned by the
 * trips feature spec.
 *
 * Link notice (R-nav-17, T-6.6): an unknown/malformed deep link lands here
 * with a dismissible non-blocking banner — ErrorBanner is the DS's inline
 * notice surface (no toast exists, R-ds-17).
 */
export default function TripListScreen() {
  const router = useRouter();
  const linkNotice = useLinkNoticeStore((s) => s.message);
  return (
    <PlaceholderScreen
      screenId="trip-list"
      title="Trips"
      icon="airplane-outline"
      note="No trips yet. Trip cards with active/upcoming/past grouping land with the trips phase."
      action={{
        label: "Create a trip",
        onPress: () => router.push("/(trips)/new"),
        testID: "trip-list-button-create",
      }}
      headerActions={[
        {
          icon: "person-circle-outline",
          label: "Profile",
          onPress: () => router.push("/(trips)/profile"),
          testID: "trip-list-button-profile",
        },
        {
          icon: "file-tray-full-outline",
          label: "Capture inbox",
          onPress: () => router.push("/(trips)/capture"),
          testID: "trip-list-button-capture",
        },
      ]}
    >
      {linkNotice !== null ? (
        <ErrorBanner
          tone="warning"
          message={linkNotice}
          onDismiss={() => useLinkNoticeStore.getState().clear()}
          testID="trip-list-link-notice"
        />
      ) : null}
      {__DEV__ ? (
        // Dev-only entries: component gallery (DS-10 evidence surface, moved
        // here from the old home screen) + a sample-trip door. NOTE (T-6.6):
        // the `[tripId]` membership guard now runs on this path — without a
        // real server trip, the door renders the R-nav-15 no-access state,
        // which is itself useful device QA. T-6.7's real trip list retires it.
        <>
          <Button
            title="Component gallery"
            variant="ghost"
            onPress={() => router.push("/gallery")}
            testID="trip-list-button-gallery"
          />
          <Button
            title="Open sample trip (dev)"
            variant="ghost"
            onPress={() => router.push("/trip-1/itinerary")}
            testID="trip-list-button-sample-trip"
          />
        </>
      ) : null}
    </PlaceholderScreen>
  );
}
