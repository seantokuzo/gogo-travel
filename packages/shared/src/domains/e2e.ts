/**
 * E2E session door (TEST-ONLY surface - .specs/testing/session-door.spec.md).
 *
 * Deliberately NOT exported from the `@gogo/shared` barrel: this descriptor
 * must have exactly two importers (`apps/server/src/auth/e2e-door.ts` and
 * `apps/mobile/src/features/dev/e2e-door/door.ts`), and that is a greppable
 * property. Import the subpath `@gogo/shared/domains/e2e`.
 *
 * The route is mounted only on a non-production server holding a >=32-char
 * `E2E_SESSION_DOOR_SECRET` and reachable only from a loopback/private
 * request host; every failure is the same uniform 401 an unauthenticated
 * request to an unknown path returns (no oracle - session-door spec §3.6).
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { DeviceInfoSchema, SignInResponseSchema } from "./auth.js";

/** ^[a-z0-9][a-z0-9-]{0,31}$ - the fixture-identity key; part of `apple_sub`. */
export const E2eUserKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "user_key must be 1-32 chars of [a-z0-9-]");
export type E2eUserKey = z.infer<typeof E2eUserKeySchema>;

export const E2eSessionRequestSchema = z.object({
  /** The rig secret, verbatim. min(32) mirrors the server gate; max is DoS headroom. */
  secret: z.string().min(32).max(512),
  user_key: E2eUserKeySchema,
  device: DeviceInfoSchema,
  /**
   * The value the response's `is_new_user` carries, decoupled from whether the
   * row was actually created - so a flow's onboarding branch is DETERMINISTIC
   * instead of "true on the first run after a DB reset". Default false.
   */
  first_run: z.boolean().optional(),
});
export type E2eSessionRequest = z.infer<typeof E2eSessionRequestSchema>;

export const e2eEndpoints = {
  /**
   * Public when mounted (added to the app's effective allowlist in `app.ts`).
   * 200 `SignInResponse`, or the uniform 401 for every failure. No 400, no 404,
   * no 429 - a distinguishable status would prove the route exists.
   */
  mintSession: {
    method: "POST",
    path: "/auth/e2e/session",
    body: E2eSessionRequestSchema,
    response: SignInResponseSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
