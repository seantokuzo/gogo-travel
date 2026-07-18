import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";
import { useTripId } from "@/navigation/trip-context";

/**
 * Today tab (§2.4) — live-trip what's-next timeline: next-event card with
 * countdown/leave-by, weather strip, quick actions. Content owned by the
 * notifications/today spec; active trips default here (R-nav-7, NAV-3).
 */
export default function TodayScreen() {
  const tripId = useTripId();
  return (
    <PlaceholderScreen
      screenId="today"
      title="Today"
      subtitle={`Trip ${tripId}`}
      icon="sunny-outline"
      note="Chronological timeline of today's items, next-event countdown, and quick actions land with the today-surface phase."
    />
  );
}
