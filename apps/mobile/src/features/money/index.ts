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
export { moneyLabel, signedMoneyLabel } from "./money-format";
export {
  MONEY_SEGMENTS,
  recallMoneySegment,
  rememberMoneySegment,
  resetMoneySegmentMemory,
} from "./segment-memory";
export type { MoneySegment } from "./segment-memory";
export { buildTransferRows } from "./transfers";
export type { TransferAnnotation, TransferRow, TransferView } from "./transfers";
