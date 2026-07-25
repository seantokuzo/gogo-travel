/**
 * EntitlementsSection (T-5.8) — read-only plan + effective caps
 * (`getMyEntitlements`). Values are DISPLAY-ONLY (R-ent-2); the server enforces.
 * No write surface exists (R-ent-3).
 */
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { AppText, ErrorBanner, ListItem, Skeleton } from "@/components";
import { useEntitlements } from "@/data";

import { Section } from "./Section";

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    rows: { gap: t.space[1] },
  }),
);

function ValueRow({ label, value, testID }: { label: string; value: string; testID: string }) {
  return (
    <ListItem
      title={label}
      trailing={<AppText color="secondary">{value}</AppText>}
      testID={testID}
    />
  );
}

export function EntitlementsSection() {
  const s = useStyles();
  const entitlements = useEntitlements();

  return (
    <Section title="Plan" testID="profile-section-entitlements">
      {entitlements.isPending ? (
        <Skeleton variant="text" lines={2} testID="profile-entitlements-skeleton" />
      ) : entitlements.isError ? (
        <ErrorBanner
          message="Couldn't load your plan."
          onRetry={() => void entitlements.refetch()}
          testID="profile-entitlements-error"
        />
      ) : (
        <View style={s.rows}>
          <ValueRow
            label="Plan"
            value={titleCase(entitlements.data.plan)}
            testID="profile-entitlement-plan"
          />
          <ValueRow
            label="AI requests / day"
            value={String(entitlements.data.ai_calls_per_day)}
            testID="profile-entitlement-ai"
          />
          <ValueRow
            label="Trip alerts"
            value={entitlements.data.alerts_enabled ? "On" : "Off"}
            testID="profile-entitlement-alerts"
          />
          <ValueRow
            label="Premium place details"
            value={entitlements.data.premium_place_details ? "On" : "Off"}
            testID="profile-entitlement-premium"
          />
        </View>
      )}
    </Section>
  );
}
