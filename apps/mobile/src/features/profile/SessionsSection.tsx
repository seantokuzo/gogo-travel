/**
 * SessionsSection (T-5.8) — active sessions with revoke (R-auth-13). The
 * current session is marked and cannot be revoked from here (that's sign-out);
 * revoking any other session is confirmed first. Loading/error/empty states are
 * all handled.
 *
 * The list is a bounded `.map()` (a user's handful of sessions) rendered INSIDE
 * the profile ScrollView — a nested vertical FlatList would trip RN's
 * "VirtualizedLists should never be nested" warning, so mapping is correct here.
 */
import type { AuthSessionInfo } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  ListItem,
  Skeleton,
} from "@/components";
import { useRevokeSession, useSessions } from "@/data";

import { Section } from "./Section";

const PLATFORM_LABEL: Record<AuthSessionInfo["platform"], string> = {
  ios: "iOS",
  android: "Android",
};

function lastUsedLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "Recently active"
    : `Last used ${date.toLocaleDateString()}`;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    list: { gap: t.space[2] },
  }),
);

export function SessionsSection() {
  const s = useStyles();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const [revokeId, setRevokeId] = useState<string | null>(null);

  let body: ReactNode;
  if (sessions.isPending) {
    body = <Skeleton variant="text" lines={3} testID="profile-sessions-skeleton" />;
  } else if (sessions.isError) {
    body = (
      <ErrorBanner
        message="Couldn't load your sessions."
        onRetry={() => void sessions.refetch()}
        testID="profile-sessions-error"
      />
    );
  } else if (sessions.data.items.length === 0) {
    body = (
      <EmptyState
        icon="phone-portrait-outline"
        title="No other sessions"
        testID="profile-sessions-empty"
      />
    );
  } else {
    body = (
      <View style={s.list}>
        {sessions.data.items.map((session) => (
          <ListItem
            key={session.id}
            title={session.device_name ?? PLATFORM_LABEL[session.platform]}
            subtitle={lastUsedLabel(session.last_used_at)}
            testID={`profile-session-${session.id}`}
            trailing={
              session.current ? (
                <Badge label="This device" tone="accent" />
              ) : (
                <Button
                  title="Revoke"
                  variant="destructive"
                  size="sm"
                  onPress={() => setRevokeId(session.id)}
                  testID={`profile-revoke-${session.id}`}
                />
              )
            }
          />
        ))}
      </View>
    );
  }

  return (
    <Section title="Sessions" testID="profile-section-sessions">
      {body}
      <ConfirmDialog
        visible={revokeId !== null}
        title="Revoke this session?"
        body="The device using this session will be signed out."
        confirmLabel="Revoke"
        destructive
        onConfirm={() => {
          if (revokeId !== null) revoke.mutate(revokeId);
          setRevokeId(null);
        }}
        onCancel={() => setRevokeId(null)}
        testID="profile-revoke-dialog"
      />
    </Section>
  );
}
