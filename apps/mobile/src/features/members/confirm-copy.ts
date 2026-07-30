/**
 * Leave-trip ConfirmDialog copy (T-6.8 round-1) — authored with the member
 * data layer but SURFACED only on trip settings (trips spec §2.5 homes the
 * leave row there; the members screen enumerates no leave affordance).
 * T-6.9 (CT-5) consumes this alongside `useRemoveMember` and the owner-leave
 * 409 reason mappings in ./error-copy.
 */
export const LEAVE_TRIP_CONFIRM = {
  title: "Leave this trip?",
  body: "You'll lose access to the plan. Your expenses and balances remain for the group.",
  confirmLabel: "Leave",
  destructive: true,
} as const;
