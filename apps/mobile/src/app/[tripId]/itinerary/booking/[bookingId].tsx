import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Booking detail (§2.4, PUSH) — per-category booking detail with
 * confirmation code, schedule/"add to day", linked expenses. Routes ideas
 * too (client itinerary spec §2.1 — ideas have no itemId to route by).
 */
export default function BookingDetailScreen() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  return (
    <PlaceholderScreen
      screenId="booking-detail"
      title="Booking"
      subtitle={`Booking ${bookingId}`}
      back
      icon="bookmark-outline"
      note="Per-category details, confirmation code, scheduling, and linked expenses land with the bookings phase."
    />
  );
}
