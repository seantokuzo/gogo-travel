/**
 * App-wide error serializer + requestId middleware unit suite (AU-5,
 * §3.6.4 / R-shared-4 / R-authz-4). Verifies the one place every non-2xx flows
 * through: thrown `HttpError` → its envelope + fixed status; a bare `throw` →
 * `INTERNAL` 500 with NO stack/message on the wire and only the error `name`
 * logged; malformed JSON (`HTTPException` 400) → `VALIDATION_FAILED`. Every
 * body carries a `requestId` and never a token or stack.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createErrorHandler, requestIdMiddleware } from "./app-middleware.js";
import { HttpError, type RequestVars } from "./errors.js";

interface Envelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

function makeApp(logger?: { warn: (m: string) => void }) {
  const app = new Hono<RequestVars>();
  app.use("*", requestIdMiddleware);
  app.onError(createErrorHandler(logger ?? { warn: () => undefined }));

  app.get("/http-error", () => {
    throw new HttpError("FORBIDDEN", "nope", { why: "role" });
  });
  app.get("/boom", () => {
    // A secret that must never reach the wire nor the logs' message.
    throw new Error("SECRET-abc123 leaked into a message");
  });
  app.post("/validate", zValidator("json", z.object({ n: z.number() })), (c) =>
    c.json(c.req.valid("json")),
  );
  return app;
}

describe("createErrorHandler", () => {
  it("serializes a thrown HttpError to its envelope + fixed status + requestId", async () => {
    const res = await makeApp().request("/http-error");
    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("nope");
    expect(body.error.details).toEqual({ why: "role" });
    expect(body.error.requestId).toBeTruthy();
  });

  it("maps an unexpected throw to INTERNAL 500 — no stack, no message, only the error NAME logged", async () => {
    const warn = vi.fn();
    const res = await makeApp({ warn }).request("/boom");
    expect(res.status).toBe(500);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("internal error");
    // The thrown message (with its "secret") never reaches the client...
    expect(JSON.stringify(body)).not.toContain("SECRET-abc123");
    // ...nor the log line — only the error's NAME is logged.
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("SECRET-abc123");
    expect(logged).toContain("name=Error");
  });

  it("malformed JSON body surfaces as VALIDATION_FAILED (HTTPException 400 → envelope)", async () => {
    const res = await makeApp().request("/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.requestId).toBeTruthy();
  });

  it("requestId middleware echoes the id it minted as x-request-id", async () => {
    const res = await makeApp().request("/http-error");
    const header = res.headers.get("x-request-id");
    const body = (await res.json()) as Envelope;
    expect(header).toBe(body.error.requestId);
  });
});
