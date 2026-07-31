/**
 * Error-envelope mapping (T-6.8) — pins the two error CLASSES the accept
 * flow keeps distinct (transport/timeout = retryable vs 409 reason =
 * terminal), the R-trips-16 dead-state set, and the T-6.2 server reason
 * vocabulary (owner-leave's TWO paths, already_revoked, ownership_changed).
 */
import { ApiRequestError } from "@/auth";

import {
  conflictReason,
  inviteDeadStateFromError,
  isTransportFailure,
  memberActionErrorMessage,
} from "./error-copy";

const conflict = (reason: string) => new ApiRequestError(409, "CONFLICT", "conflict", { reason });
const transport = () => new ApiRequestError(0, "NETWORK", "network request failed");

describe("isTransportFailure — the 12s-timeout/network class", () => {
  it("matches status 0 (network drop and the api-client timeout cap)", () => {
    expect(isTransportFailure(transport())).toBe(true);
  });

  it("does NOT match 409 conflicts or other HTTP failures", () => {
    expect(isTransportFailure(conflict("expired"))).toBe(false);
    expect(isTransportFailure(new ApiRequestError(500, "INTERNAL", "boom"))).toBe(false);
    expect(isTransportFailure(new Error("plain"))).toBe(false);
  });
});

describe("conflictReason", () => {
  it("extracts details.reason from a 409 envelope", () => {
    expect(conflictReason(conflict("owner_transfer_required"))).toBe("owner_transfer_required");
  });

  it("is null for non-409s, missing details, and non-string reasons", () => {
    expect(conflictReason(new ApiRequestError(403, "FORBIDDEN", "no"))).toBeNull();
    expect(conflictReason(new ApiRequestError(409, "CONFLICT", "bare"))).toBeNull();
    expect(conflictReason(new ApiRequestError(409, "CONFLICT", "x", { reason: 7 }))).toBeNull();
    expect(conflictReason("nope")).toBeNull();
  });
});

describe("inviteDeadStateFromError — terminal verdicts only (R-trips-16)", () => {
  it.each(["expired", "revoked", "max_uses_reached"] as const)(
    "maps a 409 %s reason to its dead state",
    (reason) => {
      expect(inviteDeadStateFromError(conflict(reason))).toBe(reason);
    },
  );

  it("maps 404 to not_found (no oracle beyond 'unknown token')", () => {
    expect(inviteDeadStateFromError(new ApiRequestError(404, "NOT_FOUND", "nf"))).toBe("not_found");
  });

  it("never treats retryable failures as token death", () => {
    expect(inviteDeadStateFromError(transport())).toBeNull();
    expect(inviteDeadStateFromError(new ApiRequestError(500, "INTERNAL", "boom"))).toBeNull();
    expect(inviteDeadStateFromError(new ApiRequestError(429, "RATE_LIMITED", "slow"))).toBeNull();
    expect(inviteDeadStateFromError(conflict("something_else"))).toBeNull();
  });
});

describe("memberActionErrorMessage — every 4xx the spec names", () => {
  it("owner leave, other members present → transfer-first path (R-trips-11)", () => {
    expect(memberActionErrorMessage(conflict("owner_transfer_required"))).toMatch(
      /transfer ownership/i,
    );
  });

  it("owner leave, sole member → delete-trip path (R-trips-11)", () => {
    expect(memberActionErrorMessage(conflict("delete_trip_instead"))).toMatch(/delete the trip/i);
  });

  it("re-revocation → already_revoked copy", () => {
    expect(memberActionErrorMessage(conflict("already_revoked"))).toMatch(/already revoked/i);
  });

  it("concurrent transfer → ownership_changed copy", () => {
    expect(memberActionErrorMessage(conflict("ownership_changed"))).toMatch(/ownership.*changed/i);
  });

  it("403 → permission copy (R-tripui-14: banner, never a crash)", () => {
    expect(memberActionErrorMessage(new ApiRequestError(403, "FORBIDDEN", "no"))).toMatch(
      /permission/i,
    );
  });

  it("404 → stale-list copy", () => {
    expect(memberActionErrorMessage(new ApiRequestError(404, "NOT_FOUND", "nf"))).toMatch(
      /no longer/i,
    );
  });

  it("transport → retryable network copy, distinct from any terminal reason", () => {
    expect(memberActionErrorMessage(transport())).toMatch(/network/i);
  });

  it("unknown shapes → generic fallback", () => {
    expect(memberActionErrorMessage(new Error("?"))).toMatch(/something went wrong/i);
  });
});
