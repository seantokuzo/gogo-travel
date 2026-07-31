/**
 * Invite join (T-6.6 route + T-6.8 accept; trips spec §2.4 `invite-join`) —
 * deep-link target for `/invite/[token]` (R-nav-11/14/16: cold/warm +
 * unauth stash-and-resume land here through the nav registry).
 *
 * §2.4 state matrix (R-tripui-9..12):
 * - loading            → skeleton preview card
 * - active             → preview + explicit Accept / Decline (decline = back
 *                        to the trip list, NO server call)
 * - active + member    → "already in this trip" notice + Open trip
 * - expired            → distinct copy naming the inviter
 * - revoked / maxed    → "no longer valid" card
 * - 404 unknown        → "Invite not found" (no oracle for token guessing)
 *
 * Accept (`POST /invites/:token/accept`) is NOT optimistic (§2.6 — spinner);
 * success invalidates `['trips']` (hook) and replace-navigates to
 * `/[tripId]`, where the layout applies the default-tab rules (R-nav-7/8).
 * "Open trip" re-uses accept: it is idempotent for members (R-trips-15) and
 * the preview deliberately withholds `trip_id` until acceptance.
 *
 * Error classes stay distinct (R-trips-16 vs transport): a 409 dead-token
 * reason or 404 is TERMINAL → the matching dead card; a transport failure
 * (network drop / 12s timeout, status 0) is RETRYABLE → banner + retry with
 * the preview intact.
 *
 * Token hygiene (T-4.4 R1): the token is a bearer credential — never
 * rendered; the preview fields are what the screen shows.
 */
import { createStyles } from "@gogo/tokens/react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AppText, Button, Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from "@/components";
import { useAcceptInvite, useInvitePreview } from "@/data";
import { inviteDeadStateFromError, memberActionErrorMessage } from "@/features/members";
import type { InviteDeadState } from "@/features/members";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: { flex: 1, padding: t.space[4], gap: t.space[4] },
    centered: { flex: 1, justifyContent: "center" },
    card: { gap: t.space[2] },
    actions: { gap: t.space[2] },
  }),
);

/** §2.4 dead-state copy — expired is DISTINCT from invalid (R-tripui-11). */
function deadCopy(state: InviteDeadState, inviterName?: string): { title: string; body: string } {
  switch (state) {
    case "expired":
      return {
        title: "This invite has expired",
        body: `Ask ${inviterName ?? "the sender"} for a new link.`,
      };
    case "revoked":
    case "max_uses_reached":
      return {
        title: "This invite is no longer valid",
        body: "Ask for a new invite link if you still want to join.",
      };
    case "not_found":
      return {
        title: "Invite not found",
        body: "This invite link is invalid — open it again from the invitation.",
      };
  }
}

export default function InviteJoinScreen() {
  const s = useStyles();
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const preview = useInvitePreview(token);
  const accept = useAcceptInvite();

  const declineToTrips = () => router.replace("/(trips)");
  const acceptInvite = () => {
    accept.mutate(token, {
      onSuccess: (result) => {
        // R-tripui-12/R-nav-12: into the trip; the [tripId] layout owns
        // default-tab resolution (same Href posture as TripSwitcher).
        router.replace(`/${result.trip_id}` as Href);
      },
    });
  };

  // Terminal verdicts: an accept 409/404 wins (fresher than the preview);
  // else a non-active preview state or a preview 404.
  const previewDead: InviteDeadState | null = preview.isError
    ? inviteDeadStateFromError(preview.error)
    : preview.data !== undefined && preview.data.state !== "active"
      ? preview.data.state
      : null;
  const dead = inviteDeadStateFromError(accept.error) ?? previewDead;

  let body;
  if (dead !== null) {
    const copy = deadCopy(dead, preview.data?.inviter.display_name);
    body = (
      <View style={[s.body, s.centered]}>
        <EmptyState
          icon="link-outline"
          title={copy.title}
          body={copy.body}
          action={{
            label: "Back to trips",
            onPress: declineToTrips,
            testID: "invite-join-button-back",
          }}
        />
      </View>
    );
  } else if (preview.isPending) {
    body = (
      <View style={s.body} testID="invite-join-loading">
        <Skeleton variant="text" lines={3} />
      </View>
    );
  } else if (preview.isError) {
    // Transport/5xx/429 — NOT a token verdict: retryable, with a way back.
    body = (
      <View style={[s.body, s.centered]}>
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load this invite"
          body="Check your connection and try again."
          action={{
            label: "Try again",
            onPress: () => void preview.refetch(),
            testID: "invite-join-retry",
          }}
        />
        <Button
          title="Back to trips"
          variant="ghost"
          onPress={declineToTrips}
          testID="invite-join-button-back"
        />
      </View>
    );
  } else {
    const { trip, inviter, role, already_member } = preview.data;
    const acceptFailedRetryably = accept.isError;
    body = (
      <View style={s.body}>
        <Card style={s.card}>
          <AppText role="heading">{trip.name}</AppText>
          <AppText color="secondary">{trip.destination_name}</AppText>
          {trip.start_date !== undefined && trip.end_date !== undefined ? (
            <AppText role="caption" color="muted">
              {trip.start_date} – {trip.end_date}
            </AppText>
          ) : null}
          <AppText role="caption" color="muted">
            {already_member
              ? "You're already in this trip."
              : `${inviter.display_name} invited you to join as ${role}.`}
          </AppText>
        </Card>
        {acceptFailedRetryably ? (
          <ErrorBanner
            message={memberActionErrorMessage(accept.error)}
            onRetry={acceptInvite}
            testID="invite-join-banner"
          />
        ) : null}
        {already_member ? (
          <View style={s.actions}>
            <Button
              title="Open trip"
              onPress={acceptInvite}
              loading={accept.isPending}
              fullWidth
              testID="invite-join-button-open-trip"
            />
          </View>
        ) : (
          <View style={s.actions}>
            <Button
              title={`Join as ${role}`}
              onPress={acceptInvite}
              loading={accept.isPending}
              fullWidth
              testID="invite-join-button-accept"
            />
            <Button
              title="Decline"
              variant="ghost"
              onPress={declineToTrips}
              disabled={accept.isPending}
              fullWidth
              testID="invite-join-button-decline"
            />
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={s.screen} testID="invite-join-screen">
      <PageHeader title="Join trip" leading="back" testID="invite-join-header" />
      {body}
    </View>
  );
}
