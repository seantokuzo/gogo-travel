import { useLocalSearchParams } from "expo-router";

import { RequestContent } from "@/features/money/RequestContent";
import { useTripContext } from "@/navigation/trip-context";

/**
 * Settle-up request (§2.4) — recipient view of a settle-request link
 * (client money spec R-cmoney-26/27; deep-link target for
 * `/t/[tripId]/request/[requestId]`, R-nav-13). Membership is the
 * `[tripId]` layout guard's job (app + account required v1 — R-cmoney-27).
 * Content lives in features/money/RequestContent (concrete import — the
 * T-9.5 R1 barrel precedent; the features/money barrel is T-9.6's file).
 */
export default function SettleRequestScreen() {
  const trip = useTripContext();
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  return <RequestContent trip={trip} requestId={requestId ?? ""} />;
}
