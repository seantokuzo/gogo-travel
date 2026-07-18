import { PlaceholderScreen } from "@/navigation/PlaceholderScreen";

/**
 * Add expense (§2.4, MODAL per §2.6) — amount (integer cents, Law #2),
 * currency, payer, split among members, optional booking link. Content
 * owned by the client money spec.
 */
export default function ExpenseNewScreen() {
  return (
    <PlaceholderScreen
      screenId="expense-new"
      title="Add expense"
      back
      icon="add-circle-outline"
      note="Amount, currency, payer, and member split land with the money phase. Presented modally (form flow, R-nav-21)."
    />
  );
}
