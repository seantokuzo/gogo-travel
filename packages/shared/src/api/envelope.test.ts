import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorSchema,
  CursorQuerySchema,
  ERROR_CODES,
  ERROR_STATUS,
  ErrorCodeSchema,
  NoContentSchema,
  paginatedSchema,
} from "./envelope.js";

describe("ErrorCode set (contracts spec §3.5 — append-only)", () => {
  it("matches the spec's initial set exactly, in order", () => {
    expect([...ERROR_CODES]).toEqual([
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "VALIDATION_FAILED",
      "CONFLICT",
      "RATE_LIMITED",
      "AI_CAP_EXCEEDED",
      "AI_DISABLED",
      "PAYLOAD_TOO_LARGE",
      "INTERNAL",
      "AI_UPSTREAM",
    ]);
  });

  it("maps every code to the spec's fixed status", () => {
    expect(ERROR_STATUS).toEqual({
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      VALIDATION_FAILED: 400,
      CONFLICT: 409,
      RATE_LIMITED: 429,
      AI_CAP_EXCEEDED: 429,
      AI_DISABLED: 503,
      PAYLOAD_TOO_LARGE: 413,
      INTERNAL: 500,
      AI_UPSTREAM: 503,
    });
  });

  it("rejects bare-string codes outside the enum", () => {
    expect(ErrorCodeSchema.safeParse("SOMETHING_ELSE").success).toBe(false);
  });
});

describe("ApiError envelope", () => {
  it("parses a minimal error", () => {
    const parsed = ApiErrorSchema.parse({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
    expect(parsed.error.code).toBe("NOT_FOUND");
  });

  it("carries details + requestId when present", () => {
    const parsed = ApiErrorSchema.parse({
      error: {
        code: "VALIDATION_FAILED",
        message: "Invalid body",
        details: { fieldErrors: { name: ["Required"] } },
        requestId: "req_123",
      },
    });
    expect(parsed.error.requestId).toBe("req_123");
  });

  it("rejects ad-hoc shapes (bare string, missing code)", () => {
    expect(ApiErrorSchema.safeParse({ error: "boom" }).success).toBe(false);
    expect(ApiErrorSchema.safeParse({ error: { message: "boom" } }).success).toBe(false);
  });
});

describe("Paginated<T>", () => {
  const page = paginatedSchema(z.object({ id: z.string() }));

  it("parses items + cursor", () => {
    const parsed = page.parse({ items: [{ id: "a" }], nextCursor: "opaque" });
    expect(parsed.items).toHaveLength(1);
  });

  it("requires nextCursor to be explicit (null = last page)", () => {
    expect(page.parse({ items: [], nextCursor: null }).nextCursor).toBeNull();
    expect(page.safeParse({ items: [] }).success).toBe(false);
  });
});

describe("CursorQuery (?cursor= round-trip for Paginated<T> lists, §3.5)", () => {
  it("parses absent (first page) and present opaque cursors", () => {
    expect(CursorQuerySchema.parse({}).cursor).toBeUndefined();
    expect(CursorQuerySchema.parse({ cursor: "opaque" }).cursor).toBe("opaque");
  });

  it("strips unknown query params (R-shared-10)", () => {
    expect(CursorQuerySchema.parse({ cursor: "c", limit: "50", admin: "1" })).toEqual({
      cursor: "c",
    });
  });

  it("rejects non-string cursors", () => {
    for (const cursor of [1, null, true, ["a"], { gt: "x" }]) {
      expect(CursorQuerySchema.safeParse({ cursor }).success).toBe(false);
    }
  });
});

describe("NoContent (204 response schema)", () => {
  it("parses undefined — the no-body case — to undefined", () => {
    expect(NoContentSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects any actual body, including null and empty shapes", () => {
    for (const body of [null, "", {}, [], 0, false]) {
      expect(NoContentSchema.safeParse(body).success).toBe(false);
    }
  });
});
