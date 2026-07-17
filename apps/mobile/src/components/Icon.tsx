/**
 * Icon seam (spec §2.10) — components reference `IconName`, never a concrete
 * icon package. Backing set: @expo/vector-icons Ionicons (SDK-pinned via
 * `expo install`; the lucide-react-native candidate would add a
 * react-native-svg native dep for no v1 gain). Swapping sets later means
 * changing THIS file only.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@gogo/tokens/react";

export type IconName = keyof typeof Ionicons.glyphMap;

export interface IconProps {
  name: IconName;
  /** pt — defaults to 20 (inline) — callers size explicitly for hero uses. */
  size?: number;
  /** Defaults to theme text.primary. Pass a semantic token value (R-ds-7). */
  color?: string;
  testID?: string;
}

export function Icon({ name, size = 20, color, testID }: IconProps) {
  const { theme } = useTheme();
  return (
    <Ionicons name={name} size={size} color={color ?? theme.color.text.primary} testID={testID} />
  );
}
