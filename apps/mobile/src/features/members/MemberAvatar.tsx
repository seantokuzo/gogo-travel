/**
 * MemberAvatar (T-6.8, trips spec §2.5) — compact 40pt row avatar for the
 * members list. Same display-only posture as the profile Avatar (P-12 owns
 * upload/read-URLs; `avatar_key` is null on the wire until then), sized for
 * ListItem `leading` slots instead of the profile hero.
 */
import { createStyles } from "@gogo/tokens/react";
import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components";
import { initialsOf } from "@/features/profile/Avatar";

export interface MemberAvatarProps {
  displayName: string;
  avatarKey: string | null;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    avatar: {
      width: 40,
      height: 40,
      borderRadius: t.radius.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.bg.inset,
      overflow: "hidden",
    },
    image: { width: 40, height: 40 },
  }),
);

export function MemberAvatar({ displayName, avatarKey }: MemberAvatarProps) {
  const s = useStyles();
  if (avatarKey !== null && avatarKey.length > 0) {
    return (
      <View style={s.avatar}>
        <Image
          source={avatarKey}
          style={s.image}
          contentFit="cover"
          accessibilityLabel={`${displayName} profile photo`}
        />
      </View>
    );
  }
  return (
    <View style={s.avatar} accessibilityLabel={`${displayName} avatar`}>
      <AppText role="caption">{initialsOf(displayName)}</AppText>
    </View>
  );
}
