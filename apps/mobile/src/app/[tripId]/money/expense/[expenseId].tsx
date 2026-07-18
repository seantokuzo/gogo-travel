import { useLocalSearchParams } from "expo-router";

import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Expense detail (§2.4, PUSH) — shares breakdown, edit/delete (Confirm),
 * source booking link. Content owned by the client money spec.
 */
export default function ExpenseDetailScreen() {
  const { expenseId } = useLocalSearchParams<{ expenseId: string }>();
  return (
    <PlaceholderScreen
      screenId="expense-detail"
      title="Expense"
      subtitle={`Expense ${expenseId}`}
      back
      icon="receipt-outline"
      note="Shares breakdown, edit/delete, and the source booking link land with the money phase."
    />
  );
}
