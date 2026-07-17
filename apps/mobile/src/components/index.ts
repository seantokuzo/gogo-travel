/**
 * Design-system component library (T-4.3, spec §2.9) — primitives only;
 * feature components live with their features. All styling is tokens-only
 * via createStyles (R-ds-7); interactive components REQUIRE `testID`
 * (R-ds-20) and expose accessibilityRole/Label (R-ds-12).
 */
export { AppText } from "./Text";
export type { AppTextColor, AppTextProps } from "./Text";
export { Badge } from "./Badge";
export type { BadgeProps, BadgeSize, BadgeTone } from "./Badge";
export { Button } from "./Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button";
export { Card } from "./Card";
export type { CardProps, CardVariant } from "./Card";
export { ConfirmDialog } from "./ConfirmDialog";
export type { ConfirmDialogProps } from "./ConfirmDialog";
export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";
export { ErrorBanner } from "./ErrorBanner";
export type { ErrorBannerProps, ErrorBannerTone } from "./ErrorBanner";
export { Icon } from "./Icon";
export type { IconName, IconProps } from "./Icon";
export { Input } from "./Input";
export type { InputProps } from "./Input";
export { ListItem } from "./ListItem";
export type { ListItemProps } from "./ListItem";
export { PageHeader } from "./PageHeader";
export type { PageHeaderAction, PageHeaderProps } from "./PageHeader";
export { SegmentedControl } from "./SegmentedControl";
export type { SegmentedControlProps } from "./SegmentedControl";
export { Sheet } from "./Sheet";
export type { SheetProps } from "./Sheet";
export { Skeleton } from "./Skeleton";
export type { SkeletonProps, SkeletonVariant } from "./Skeleton";
export { TabNav } from "./TabNav";
export type { TabNavItem, TabNavProps } from "./TabNav";
export { useReduceMotion } from "./useReduceMotion";
