/**
 * PlaceholderScreen (T-4.4 / NAV-1) — the scaffold body every skeleton route
 * renders until its feature phase lands real content. Spec-correct structure
 * only: root testID `<screen>-screen` (§2.7 rule 2), PageHeader chrome with
 * derived `-back` (§2.7 rule 4), EmptyState placeholder body (R-ds-16 — never
 * a blank region). NOT a design-system primitive — it lives with the
 * navigation scaffolding and dies screen-by-screen as feature specs build out.
 */
import { createStyles } from "@gogo/tokens/react";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, EmptyState, PageHeader } from "@/components";
import type { IconName, PageHeaderAction } from "@/components";

export interface PlaceholderScreenProps {
  /** §2.7 screen prefix (route basename in kebab) — drives every testID. */
  screenId: string;
  title: string;
  /** Rendered under the title — dynamic routes echo their param here. */
  subtitle?: string;
  /** Pushed/modal screens get the PageHeader back affordance. */
  back?: boolean;
  icon?: IconName;
  /** Placeholder copy: which spec/task delivers the real screen. Omitting it skips the EmptyState. */
  note?: string;
  /** Optional EmptyState CTA (testID per §2.7 grammar). */
  action?: { label: string; onPress(): void; testID: string };
  /** PageHeader trailing actions (max 2 — PageHeader contract). */
  headerActions?: PageHeaderAction[];
  /** Extra scaffold content below the placeholder (nav entries, controls). */
  children?: ReactNode;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: {
      flex: 1,
      justifyContent: "center",
      padding: t.space[4],
      gap: t.space[4],
    },
    scaffoldTag: { textAlign: "center" },
  }),
);

export function PlaceholderScreen({
  screenId,
  title,
  subtitle,
  back = false,
  icon = "construct-outline",
  note,
  action,
  headerActions,
  children,
}: PlaceholderScreenProps) {
  const s = useStyles();
  return (
    <View style={s.screen} testID={`${screenId}-screen`}>
      <PageHeader
        title={title}
        subtitle={subtitle}
        large={!back}
        leading={back ? "back" : undefined}
        trailing={headerActions}
        testID={`${screenId}-header`}
      />
      <View style={s.body}>
        {note !== undefined ? (
          <EmptyState icon={icon} title={title} body={note} action={action} />
        ) : null}
        {children}
        <AppText role="caption" color="muted" style={s.scaffoldTag}>
          Scaffold screen (T-4.4) — structure and testIDs are final; content arrives with its
          feature spec.
        </AppText>
      </View>
    </View>
  );
}
