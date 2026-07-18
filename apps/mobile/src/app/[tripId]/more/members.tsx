import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";
import { useTripId } from "@/navigation/trip-context";

/**
 * Members (§2.4, pushed from the More hub) — member list with roles, invite
 * entry (share sheet with invite link), owner-only role change/remove.
 * Content owned by the trips/collab spec.
 */
export default function MembersScreen() {
  const tripId = useTripId();
  return (
    <PlaceholderScreen
      screenId="members"
      title="Members"
      subtitle={`Trip ${tripId}`}
      back
      icon="people-outline"
      note="The member list with roles and the invite flow land with the collaboration phase."
    />
  );
}
