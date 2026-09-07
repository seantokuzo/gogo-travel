/**
 * @/features/money — the money tab's segment components + models (T-9.5).
 * The screen (`app/[tripId]/money/index.tsx`) composes these; W4 fills
 * segment internals behind the frozen seams (module docs).
 */
export { BalancesSegment } from "./BalancesSegment";
export type { BalancesSegmentProps } from "./BalancesSegment";
export { BudgetSegment } from "./BudgetSegment";
export type { BudgetSegmentProps } from "./BudgetSegment";
export { CapInput } from "./CapInput";
export type { CapInputProps } from "./CapInput";
export { ExpensesSegment } from "./ExpensesSegment";
export type { ExpensesSegmentProps } from "./ExpensesSegment";
export { ExpenseForm } from "./expenses/ExpenseForm";
export type { ExpenseFormProps } from "./expenses/ExpenseForm";
export {
  bookingPrefill,
  bpToPercentText,
  deriveBaseAmountCents,
  editSeedFromExpense,
  emptySplitState,
  evaluateSplit,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_CATEGORY_OPTIONS,
  isEquallySplit,
  parsePercentToBp,
  sameShareSets,
  SPLIT_TYPE_LABELS,
  SPLIT_TYPES,
} from "./expenses/expense-form-model";
export type {
  BookingPrefill,
  BookingPrefillSource,
  ExpenseFormSeed,
  SplitEvaluation,
  SplitFormState,
  SplitType,
} from "./expenses/expense-form-model";
export { moneyLabel, signedMoneyLabel } from "./money-format";
export {
  isMoneySegment,
  MONEY_SEGMENTS,
  recallMoneySegment,
  rememberMoneySegment,
  resetMoneySegmentMemory,
} from "./segment-memory";
export type { MoneySegment } from "./segment-memory";
export { buildTransferRows } from "./transfers";
export type { TransferAnnotation, TransferRow, TransferView } from "./transfers";
