import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Settle (§2.4, PUSH) — "You owe X" with one button per payment handle
 * (Venmo/CashApp/PayPal deeplink, Zelle copy) + unconditional mark-as-settled
 * via the payment-handle handoff Sheet. Content owned by the money spec.
 */
export default function SettleScreen() {
  const { memberId } = useLocalSearchParams<{ memberId: string }>();
  return (
    <PlaceholderScreen
      screenId="settle"
      title="Settle up"
      subtitle={`Member ${memberId}`}
      back
      icon="swap-horizontal"
      note="Payment-handle deeplinks and mark-as-settled land with the money phase."
    />
  );
}
