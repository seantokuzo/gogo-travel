import { useState } from "react";

import { SegmentedControl } from "@/components";
import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";
import { useTripId } from "@/navigation/trip-context";

/**
 * Money tab (§2.4) — segmented budget · expenses · balances (the client
 * money spec owns each segment's content; Law #2: all amounts are integer
 * cents). The segmented control is nav-owned structure (§2.9 flagged it).
 */
export default function MoneyScreen() {
  const tripId = useTripId();
  const [segment, setSegment] = useState("budget");
  return (
    <PlaceholderScreen
      screenId="money"
      title="Money"
      subtitle={`Trip ${tripId}`}
      icon="wallet-outline"
      note="Budget caps with AI estimates, the expense list, and who-owes-who balances land with the money phase."
    >
      <SegmentedControl
        segments={[
          { key: "budget", label: "Budget" },
          { key: "expenses", label: "Expenses" },
          { key: "balances", label: "Balances" },
        ]}
        selectedKey={segment}
        onChange={setSegment}
        testID="money-segment"
      />
    </PlaceholderScreen>
  );
}
