/**
 * Avatar (T-5.8) — DISPLAY ONLY. Renders `avatar_key` via expo-image when
 * present, else an initials placeholder. Avatar UPLOAD (picker + presign + PUT)
 * is DEFERRED to P-12 (object storage) — there is no upload affordance here.
 *
 * NOTE: until P-12 wires the object-storage read URL, `avatar_key` is always
 * null on the wire, so the initials placeholder is what actually renders today.
 * The image branch is kept so the P-12 read-URL swap is a one-line change.
 */
import { createStyles } from "@gogo/tokens/react";
import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components";

export interface AvatarProps {
  displayName: string;
  avatarKey: string | null;
}

function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join("").toUpperCase();
  return ([...parts[0]][0] + [...parts[parts.length - 1]][0]).toUpperCase();
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    avatar: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.bg.inset,
      overflow: "hidden",
    },
    image: { width: 72, height: 72 },
  }),
);

export function Avatar({ displayName, avatarKey }: AvatarProps) {
  const s = useStyles();
  if (avatarKey !== null && avatarKey.length > 0) {
    return (
      <View style={s.avatar}>
        <Image
          source={avatarKey}
          style={s.image}
          contentFit="cover"
          testID="profile-avatar-image"
          accessibilityLabel={`${displayName} profile photo`}
        />
      </View>
    );
  }
  return (
    <View
      style={s.avatar}
      testID="profile-avatar-placeholder"
      accessibilityLabel="No profile photo"
    >
      <AppText role="title">{initialsOf(displayName)}</AppText>
    </View>
  );
}
