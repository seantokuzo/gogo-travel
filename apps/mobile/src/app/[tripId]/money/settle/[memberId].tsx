import { useLocalSearchParams } from "expo-router";

import { SettleContent } from "@/features/money/SettleContent";
import { useTripContext } from "@/navigation/trip-context";

/**
 * Settle (§2.4, PUSH — client money spec R-cmoney-14..24, §2.6): the
 * caller's pairwise position vs `memberId`, rail handoff, mark-as-settled,
 * return prompt, and the creditor-side send-the-bill entry. Content lives
 * in features/money/SettleContent (concrete import — the T-9.5 R1 barrel
 * precedent; the features/money barrel is T-9.6's file this wave).
 */
export default function SettleScreen() {
  const trip = useTripContext();
  const { memberId } = useLocalSearchParams<{ memberId: string }>();
  return <SettleContent trip={trip} memberId={memberId ?? ""} />;
}
