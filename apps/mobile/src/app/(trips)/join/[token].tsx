/**
 * Invite accept (T-6.6 / NAV-5; §2.4 `invite-join`) — deep-link target for
 * `/invite/[token]` (R-nav-11). This ticket ships the ROUTE half: preview
 * fetch (`GET /invites/:token`), the dead-token error state with a path back
 * to the trip list, and the token-hygiene posture. Accept/decline actions +
 * post-accept landing (R-nav-12) are T-6.8's.
 *
 * Dead tokens fold into ONE error surface: a 404 (unknown token) and a
 * non-`active` preview state (expired / revoked / max-uses) are the same
 * user-facing fact — this invite can't be used.
 *
 * Token hygiene (security review, T-4.4 R1): invite tokens are bearer
 * credentials — the token is never rendered; the preview (trip name, inviter,
 * role) is what the screen shows.
 */
import { createStyles } from "@gogo/tokens/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AppText, Card, EmptyState, PageHeader, Skeleton } from "@/components";
import { useInvitePreview } from "@/data";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: { flex: 1, padding: t.space[4], gap: t.space[4] },
    centered: { flex: 1, justifyContent: "center" },
    card: { gap: t.space[2] },
  }),
);

export default function InviteJoinScreen() {
  const s = useStyles();
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const preview = useInvitePreview(token);

  let body;
  if (preview.isPending) {
    body = (
      <View style={s.body} testID="invite-join-loading">
        <Skeleton variant="text" lines={3} />
      </View>
    );
  } else if (preview.isError || preview.data.state !== "active") {
    // R-nav-11: invalid/expired token → in-screen error + a way back.
    body = (
      <View style={[s.body, s.centered]}>
        <EmptyState
          icon="link-outline"
          title="Invite not available"
          body="This invite link is invalid, expired, or no longer active."
          action={{
            label: "Back to trips",
            onPress: () => router.replace("/(trips)"),
            testID: "invite-join-button-trips",
          }}
        />
      </View>
    );
  } else {
    const { trip, inviter, role, already_member } = preview.data;
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
            {inviter.display_name} invited you to join as {role}
            {already_member ? " — you're already a member" : ""}.
          </AppText>
        </Card>
        <AppText role="caption" color="muted">
          Accept and decline land with the invite flow (T-6.8) — this preview proves the deep-link
          registry + token plumbing.
        </AppText>
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
