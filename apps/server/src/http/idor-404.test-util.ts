/**
 * F-038 IDOR harness — THE reusable 404-indistinguishability fixture
 * (trips spec §1 membership gate / R-trips-1; auth-users §3.6.4; Law #3).
 *
 * Contract it proves: for any gated resource route, the response a caller
 * gets for "exists but not yours" is BYTE-IDENTICAL to "does not exist" —
 * same status, same envelope (code/message/absent details), same controlled
 * headers, same content-length — modulo only the per-request correlation id
 * (whose fixed UUID length keeps content-length equal too). No probe can
 * learn that a resource exists.
 *
 * Usage (any domain's *.db.test.ts):
 *
 *   await expectIndistinguishable404s([
 *     await request(realId, strangerToken),        // exists, not yours
 *     await request(NONEXISTENT_UUID, anyToken),   // does not exist
 *     await request("not-a-uuid", anyToken),       // malformed id, same door
 *   ]);
 *
 * Naming: `*.test-util.ts` is excluded from `tsconfig.build.json` (never
 * ships in dist — it imports vitest) and NOT matched by vitest's
 * `*.test.ts` include (never collected as an empty suite).
 */
import { expect } from "vitest";

/** A valid v4-shaped UUID that no `gen_random_uuid()` row will ever collide with. */
export const NONEXISTENT_UUID = "99999999-9999-4999-8999-999999999999";

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/** The envelope minus the per-request correlation id — the byte-identity unit. */
export function withoutRequestId(body: ErrorEnvelope): Omit<ErrorEnvelope["error"], "requestId"> {
  const { requestId: _omit, ...rest } = body.error;
  return rest;
}

/**
 * Assert every response is the SAME indistinguishable 404:
 *
 *  1. status 404 with the canonical `NOT_FOUND` / `"not found"` envelope and
 *     NO `details` (a details field is an oracle vector);
 *  2. pairwise-identical bodies modulo `requestId`;
 *  3. identical controlled headers (`content-type`) and identical
 *     `content-length` — TRUE byte-identity, since the requestId is a
 *     fixed-length UUID;
 *  4. a `requestId` present in each (correlation still works).
 *
 * Callers pass ≥ 2 responses covering at least "exists, not yours" and
 * "does not exist"; adding malformed-id probes is encouraged.
 */
export async function expectIndistinguishable404s(
  responses: readonly Response[],
): Promise<void> {
  expect(responses.length).toBeGreaterThanOrEqual(2);

  const canonical = { code: "NOT_FOUND", message: "not found" };
  let baseline: {
    body: ReturnType<typeof withoutRequestId>;
    contentType: string | null;
    byteLength: number;
  } | null = null;

  for (const response of responses) {
    expect(response.status).toBe(404);

    const text = await response.clone().text();
    const raw = JSON.parse(text) as ErrorEnvelope;
    // Correlation id present — indistinguishability never costs debuggability.
    expect(raw.error.requestId).toBeTruthy();

    const body = withoutRequestId(raw);
    expect(body).toEqual(canonical);
    expect((body as { details?: unknown }).details).toBeUndefined();

    const contentType = response.headers.get("content-type");
    // Fixed-length requestId ⇒ equal byte length across all probes — TRUE
    // byte-identity, measured on the serialized body itself rather than a
    // content-length header (Hono may stream without one).
    const byteLength = Buffer.byteLength(text, "utf8");

    if (baseline === null) {
      baseline = { body, contentType, byteLength };
    } else {
      expect(body).toEqual(baseline.body);
      expect(contentType).toBe(baseline.contentType);
      expect(byteLength).toBe(baseline.byteLength);
    }
  }
}
