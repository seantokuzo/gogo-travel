/**
 * Tab-local Stack (§2.1) — per-tab navigation history (R-nav-10).
 * `item/new` is the add/edit form → router modal (R-nav-21); item and
 * booking details are pushes.
 *
 * DEEPLINK RETURN HOST (T-7.6, QUEUE assignment): mounted ONCE here — every
 * deeplink-out surface (the add form now; T-7.9's booking detail next)
 * lives in this stack, so the "Did you book it?" prompt fires where the
 * user returns. `onAddManually` routes to the REAL form modal with the
 * recorded category and `source=deeplink_return` (R-itin-22 / R-ib-11) —
 * the record carries its own tripId, so a cross-trip return still lands on
 * the right trip. T-7.8's built-in stopgap sheet stops mounting by
 * construction (the prop overrides it).
 */
import { Stack, useRouter } from "expo-router";

import { DeeplinkReturnHost } from "@/features/deeplinks";
import { useStackScreenOptions } from "@/navigation/stack-options";

/**
 * Own component (not inline in the layout body): the R-nav-21 modal audit
 * invokes layouts as PLAIN functions to capture their declared Stack config
 * — a hook in the layout body would blow up outside a render. The audit
 * only creates this element; the hook runs solely in real renders.
 */
function ItineraryReturnHost() {
  const router = useRouter();
  return (
    <DeeplinkReturnHost
      onAddManually={(record) => {
        router.push({
          pathname: "/[tripId]/itinerary/item/new",
          params: {
            tripId: record.tripId,
            category: record.category,
            source: "deeplink_return",
          },
        });
      }}
    />
  );
}

export default function ItineraryStackLayout() {
  return (
    <>
      {/* initialRouteName is explicit: declared Screen children register
          FIRST, and without it the stack would boot on the modal instead of
          the list. */}
      <Stack initialRouteName="index" screenOptions={useStackScreenOptions()}>
        <Stack.Screen name="item/new" options={{ presentation: "modal" }} />
      </Stack>
      <ItineraryReturnHost />
    </>
  );
}
