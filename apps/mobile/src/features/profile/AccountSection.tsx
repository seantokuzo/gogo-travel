/**
 * AccountSection (T-5.8) — sign-out and account deletion.
 *
 * Sign-out (nav §2.2, R-nav-4): `signOut()` clears identity + tokens + query
 * cache; the root AuthGate then redirects to sign-in.
 *
 * Delete account (R-user-9; App Store requirement): hard-confirmed, then
 * `DELETE /users/me` → local `signOut()`. The server revokes every session and
 * scrubs PII; the client just tears down locally.
 */
import { userEndpoints } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { apiClient, useSessionStore } from "@/auth";
import { Button, ConfirmDialog, ErrorBanner } from "@/components";

import { Section } from "./Section";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    actions: { gap: t.space[3] },
  }),
);

export function AccountSection() {
  const s = useStyles();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const onSignOut = async () => {
    setSignOutOpen(false);
    setSigningOut(true);
    // The AuthGate unmounts this screen once user → null; leave `signingOut`
    // set so the button holds its spinner until then.
    await useSessionStore.getState().signOut();
  };

  const onDelete = async () => {
    setDeleteOpen(false);
    setDeleteError(null);
    setDeleting(true);
    try {
      await apiClient.request(userEndpoints.deleteMe, {});
      await useSessionStore.getState().signOut();
    } catch {
      setDeleting(false);
      setDeleteError("Couldn't delete your account. Please try again.");
    }
  };

  return (
    <Section title="Account" testID="profile-section-account">
      <View style={s.actions}>
        {deleteError !== null ? (
          <ErrorBanner
            message={deleteError}
            onDismiss={() => setDeleteError(null)}
            testID="profile-delete-error"
          />
        ) : null}
        <Button
          title="Sign out"
          variant="secondary"
          fullWidth
          onPress={() => setSignOutOpen(true)}
          loading={signingOut}
          testID="profile-button-signout"
        />
        <Button
          title="Delete account"
          variant="destructive"
          fullWidth
          onPress={() => setDeleteOpen(true)}
          loading={deleting}
          testID="profile-button-delete"
        />
      </View>

      <ConfirmDialog
        visible={signOutOpen}
        title="Sign out?"
        body="You'll need to sign in again to get back to your trips."
        confirmLabel="Sign out"
        onConfirm={() => void onSignOut()}
        onCancel={() => setSignOutOpen(false)}
        testID="profile-signout-dialog"
      />
      <ConfirmDialog
        visible={deleteOpen}
        title="Delete your account?"
        body="This permanently deletes your account. Trip history you shared stays visible to others as “Deleted user.” This can't be undone."
        confirmLabel="Delete account"
        destructive
        onConfirm={() => void onDelete()}
        onCancel={() => setDeleteOpen(false)}
        testID="profile-delete-dialog"
      />
    </Section>
  );
}
