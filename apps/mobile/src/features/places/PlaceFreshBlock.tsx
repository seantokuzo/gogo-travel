/**
 * Fresh premium-details block (T-8.4 / MAP-3 — map spec §2.3/§2.4,
 * R-map-9/10; wire shape `FreshPlaceDetails`, places spec §3.2).
 *
 * RENDER-ONLY props by contract: the payload arrives from `usePlaceFresh`
 * (staleTime/gcTime 0) and must never be forwarded into any store, storage,
 * analytics, or logging (§2.4 — guard-enforced,
 * `.github/scripts/check-place-fresh-persistence.mjs`). `fresh === null`
 * renders NOTHING (R-map-10: absence is silent — offline, upstream error,
 * no FSQ id, not entitled, and the whole of v1 where the seam is dormant).
 *
 * The Foursquare attribution row is REQUIRED whenever the block renders
 * (R-places-17: every fresh block carries it). FSQ photo URLs are present
 * on the wire but deliberately NOT rendered in this seam build: remote
 * premium imagery needs the post-MVP integration's display/licensing pass
 * (same deferral as the feature itself) — the field re-enters with it.
 *
 * testIDs are grammar-derived (§2.7): the inventory names the detail
 * screen's interactive elements only; this informational block roots at
 * `place-detail-fresh` with `-field-{key}` rows (the booking-detail
 * `-field-` family precedent).
 */
import type { FreshPlaceDetails } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components";

export interface PlaceFreshBlockProps {
  fresh: FreshPlaceDetails | null;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    block: { gap: t.space[2] },
    fieldRow: { gap: 2 },
    tip: { gap: 2 },
  }),
);

export interface FreshFieldRow {
  key: string;
  label: string;
  value: string;
}

/** Field rows in display order — pure so the mapping is directly testable. */
export function freshFieldRows(fresh: FreshPlaceDetails): FreshFieldRow[] {
  const { fields } = fresh;
  const rows: FreshFieldRow[] = [];
  if (fields.hours !== undefined) rows.push({ key: "hours", label: "Hours", value: fields.hours });
  if (fields.open_now !== undefined) {
    rows.push({
      key: "open-now",
      label: "Right now",
      value: fields.open_now ? "Open" : "Closed",
    });
  }
  if (fields.rating !== undefined) {
    // FSQ scale is 0–10 (wire doc) — say so instead of implying 5 stars.
    rows.push({ key: "rating", label: "Rating", value: `${fields.rating} / 10` });
  }
  if (fields.price_level !== undefined) {
    rows.push({ key: "price-level", label: "Price", value: "$".repeat(fields.price_level) });
  }
  if (fields.website !== undefined) {
    rows.push({ key: "website", label: "Website", value: fields.website });
  }
  if (fields.phone !== undefined) rows.push({ key: "phone", label: "Phone", value: fields.phone });
  return rows;
}

export function PlaceFreshBlock({ fresh }: PlaceFreshBlockProps) {
  const s = useStyles();
  if (fresh === null) return null;
  const rows = freshFieldRows(fresh);
  const tips = fresh.fields.tips ?? [];
  return (
    <View style={s.block} testID="place-detail-fresh">
      <AppText role="label" color="secondary">
        Details
      </AppText>
      {rows.map((row) => (
        <View key={row.key} style={s.fieldRow} testID={`place-detail-fresh-field-${row.key}`}>
          <AppText role="caption" color="secondary">
            {row.label}
          </AppText>
          <AppText>{row.value}</AppText>
        </View>
      ))}
      {tips.map((tip, index) => (
        // Tips carry no id on the wire; index keys a render-only, never
        // reordered list (the §2.8 "stable entity ids" rule is about PINS).
        <View key={index} style={s.tip} testID={`place-detail-fresh-tip-${index}`}>
          <AppText role="caption" color="secondary">
            Tip
          </AppText>
          <AppText>{tip.text}</AppText>
        </View>
      ))}
      {/* R-places-17: the Foursquare attribution rides EVERY fresh block. */}
      <AppText role="caption" color="secondary" testID="place-detail-fresh-attribution">
        {fresh.attribution.text}
      </AppText>
    </View>
  );
}
