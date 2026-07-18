/**
 * Trip tab registry (navigation.spec §2.1) — order is the spec's:
 * today · itinerary · map · money · more. Keys double as the tab route
 * names inside `[tripId]/` AND the fixed testIDs `tab-bar-{key}` that
 * TabNav derives (§2.7 rule 3 — trip-agnostic so E2E flows never need a
 * tripId to switch tabs).
 */
import type { TabNavItem } from "@/components";

export const TRIP_TAB_ITEMS: TabNavItem[] = [
  { key: "today", label: "Today", icon: "sunny-outline" },
  { key: "itinerary", label: "Itinerary", icon: "calendar-outline" },
  { key: "map", label: "Map", icon: "map-outline" },
  { key: "money", label: "Money", icon: "wallet-outline" },
  { key: "more", label: "More", icon: "ellipsis-horizontal" },
];
