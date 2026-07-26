/**
 * Error-envelope → UX mapping for the member/invite family (T-6.8; trips
 * spec §2.4 dead states + the T-6.2 server `details.reason` vocabulary).
 * One home so the members screen, the join screen, and T-6.9's settings
 * surfaces (owner-leave rows) never re-derive the wire semantics.
 *
 * Two error CLASSES the accept flow must keep distinct (task contract):
 * - transport failure (status 0 — network drop OR the api-client's 12s
 *   timeout cap): RETRYABLE — the invite may be perfectly alive;
 * - 409 CONFLICT with a dead-state reason: TERMINAL — re-trying cannot heal
 *   an expired/revoked/maxed token.
 */
import { ApiRequestError } from "@/auth";

/** Transport failure (network drop / 12s timeout) — retryable, never terminal. */
export function isTransportFailure(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 0;
}

/** The `details.reason` of a 409 CONFLICT envelope, if present. */
export function conflictReason(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  if (typeof error.details !== "object" || error.details === null) return null;
  const reason = (error.details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/** Join-screen dead states (R-tripui-11): the R-trips-16 reasons + unknown token. */
export type InviteDeadState = "expired" | "revoked" | "max_uses_reached" | "not_found";

const DEAD_REASONS: readonly string[] = ["expired", "revoked", "max_uses_reached"];

/**
 * Map an accept/preview failure to its TERMINAL dead state, or null when the
 * error is not a token-death verdict (transport failures, 5xx, 429 → null:
 * those are retryable surfaces, not dead cards).
 */
export function inviteDeadStateFromError(error: unknown): InviteDeadState | null {
  if (error instanceof ApiRequestError && error.status === 404) return "not_found";
  const reason = conflictReason(error);
  if (reason !== null && DEAD_REASONS.includes(reason)) return reason as InviteDeadState;
  return null;
}

/**
 * Member/invite mutation failure → banner copy (R-tripui-14: a 403 renders
 * an ErrorBanner, never a crash). Reason strings are the server's exact
 * vocabulary (T-6.2 build): `owner_transfer_required` / `delete_trip_instead`
 * (the two owner-leave 409 paths, R-trips-11), `already_revoked`
 * (re-revocation), `ownership_changed` (concurrent transfer).
 */
export function memberActionErrorMessage(error: unknown): string {
  if (isTransportFailure(error)) {
    return "Network trouble — check your connection and try again.";
  }
  switch (conflictReason(error)) {
    case "owner_transfer_required":
      return "You own this trip — transfer ownership to someone else before leaving.";
    case "delete_trip_instead":
      return "You're the only member — to leave, delete the trip from its settings.";
    case "already_revoked":
      return "That invite was already revoked.";
    case "ownership_changed":
      return "Ownership just changed — try again.";
    default:
      break;
  }
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return "You don't have permission to do that.";
    if (error.status === 404) return "That's no longer in this trip — the list has been refreshed.";
  }
  return "Something went wrong — please try again.";
}
