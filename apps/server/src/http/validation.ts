/**
 * Shared `zValidator` failure hook (R-authz-4 / R-shared-4): a body, param,
 * or query that fails its shared schema becomes the `VALIDATION_FAILED`
 * envelope — never zValidator's default 400 shape. Promoted from the AU-3
 * auth router at AU-6 so every domain router funnels through ONE hook.
 *
 * The single `c`-to-`Context<RequestVars>` cast lives here once: hook
 * contexts arrive typed with Hono's base `Env`, not our `RequestVars`
 * (`requestIdOf` mints the id if the requestId middleware hasn't run).
 */
import type { Context, Env } from "hono";
import { z } from "zod";
import { apiError, type RequestVars } from "./errors.js";

export function rejectInvalidBody<T>(c: Context<Env>, error: z.core.$ZodError<T>): Response {
  return apiError(
    c as unknown as Context<RequestVars>,
    "VALIDATION_FAILED",
    "request body failed validation",
    z.flattenError(error),
  );
}
