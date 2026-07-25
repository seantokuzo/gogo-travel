/**
 * Profile & app settings (navigation.spec §2.4 / § Resolved questions Gate 2;
 * pushed from the trip-list header avatar). Sections: profile edit
 * (name + avatar DISPLAY), payment handles, appearance/accent, sessions +
 * revoke, read-only entitlements, and account (sign-out + delete).
 *
 * The screen owns the `GET /users/me` read (loading/error states); each section
 * owns its own writes/reads. Avatar UPLOAD is DEFERRED to P-12.
 */
import { createStyles } from "@gogo/tokens/react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";

import { ErrorBanner, PageHeader, Skeleton } from "@/components";
import { useMe } from "@/data";
import {
  AccountSection,
  AppearanceSection,
  EntitlementsSection,
  PaymentHandlesSection,
  ProfileEditSection,
  SessionsSection,
} from "@/features/profile";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    flex: { flex: 1 },
    content: { paddingBottom: t.space[8] },
    state: { padding: t.space[4], gap: t.space[3] },
  }),
);

export default function ProfileScreen() {
  const s = useStyles();
  const me = useMe();

  return (
    <View style={s.screen} testID="profile-screen">
      <PageHeader title="Profile" leading="back" testID="profile-header" />
      {me.isPending ? (
        <View style={s.state}>
          <Skeleton variant="text" lines={4} testID="profile-skeleton" />
        </View>
      ) : me.isError ? (
        <View style={s.state}>
          <ErrorBanner
            message="Couldn't load your profile."
            onRetry={() => void me.refetch()}
            testID="profile-error"
          />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={s.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
            <ProfileEditSection user={me.data} />
            <PaymentHandlesSection user={me.data} />
            <AppearanceSection />
            <SessionsSection />
            <EntitlementsSection />
            <AccountSection />
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
