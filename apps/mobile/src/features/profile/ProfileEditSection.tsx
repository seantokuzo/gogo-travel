/**
 * ProfileEditSection (T-5.8) — avatar (display only) + display-name edit via
 * `updateMe`. Email is read-only (not client-writable, R-user-2). Save is gated
 * on a valid, changed name; the shared `DisplayNameSchema` is the validator (no
 * local redefine).
 */
import { DisplayNameSchema, type User } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Button, ErrorBanner, Input } from "@/components";
import { useUpdateMe } from "@/data";

import { Avatar } from "./Avatar";
import { Section } from "./Section";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    identity: { flexDirection: "row", alignItems: "center", gap: t.space[3] },
    identityText: { flex: 1, gap: t.space[1] },
    form: { gap: t.space[3] },
  }),
);

export function ProfileEditSection({ user }: { user: User }) {
  const s = useStyles();
  const [name, setName] = useState(user.display_name);
  const updateMe = useUpdateMe();

  const valid = useMemo(() => DisplayNameSchema.safeParse(name).success, [name]);
  const dirty = name.trim() !== user.display_name;
  const validationError =
    name.trim().length > 0 && !valid ? "1–50 characters, no control characters." : undefined;

  const onSave = () => {
    updateMe.mutate({ display_name: name.trim() });
  };

  return (
    <Section title="Profile" testID="profile-section-edit">
      <View style={s.identity}>
        <Avatar displayName={user.display_name} avatarKey={user.avatar_key} />
        <View style={s.identityText}>
          <AppText role="subheading" numberOfLines={1}>
            {user.display_name}
          </AppText>
          <AppText role="caption" color="secondary" numberOfLines={1}>
            {user.email}
          </AppText>
        </View>
      </View>

      <View style={s.form}>
        {updateMe.isError ? (
          <ErrorBanner
            message="Couldn't save your name. Please try again."
            onDismiss={() => updateMe.reset()}
            testID="profile-edit-error"
          />
        ) : null}
        <Input
          label="Display name"
          value={name}
          onChangeText={setName}
          error={validationError}
          autoComplete="name"
          returnKeyType="done"
          testID="profile-input-name"
        />
        <Button
          title="Save"
          onPress={onSave}
          loading={updateMe.isPending}
          disabled={!dirty || !valid}
          testID="profile-button-save-name"
        />
      </View>
    </Section>
  );
}
