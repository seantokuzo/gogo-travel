/**
 * Dev request log (2026-08-29). The behaviour under test is mostly a Law #1
 * property: the line must be a route TEMPLATE, never data. Invite tokens are
 * bearer credentials that ride in a path segment, so a raw path in a log file
 * is a credential in a log file.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { requestIdMiddleware } from "./app-middleware.js";
import {
  createDevRequestLog,
  redactPath,
  redactQuery,
  type LogSink,
} from "./dev-request-log.js";
import type { RequestVars } from "./errors.js";

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("redactPath", () => {
  it("collapses uuids", () => {
    expect(redactPath(`/api/trips/${UUID}/expenses/${UUID}`)).toBe("/api/trips/:id/expenses/:id");
  });

  it("collapses opaque credential-shaped segments (invite tokens)", () => {
    // The load-bearing case: this segment IS the credential.
    expect(redactPath("/api/invites/Zx9_kQ2mNpLr4TvW8yBc")).toBe("/api/invites/:token");
  });

  it("collapses bare numeric segments", () => {
    expect(redactPath("/api/things/42")).toBe("/api/things/:n");
  });

  it("leaves ordinary route words alone", () => {
    expect(redactPath("/api/auth/google")).toBe("/api/auth/google");
    expect(redactPath("/api/health")).toBe("/api/health");
  });
});

describe("redactQuery", () => {
  it("keeps key names and drops every value", () => {
    expect(redactQuery("?cursor=eyJpZCI6MX0&limit=20")).toBe("?cursor,limit");
  });

  it("is empty for no query", () => {
    expect(redactQuery("")).toBe("");
    expect(redactQuery("?")).toBe("");
  });
});

describe("createDevRequestLog", () => {
  const build = (sink: LogSink) => {
    const app = new Hono<RequestVars>();
    app.use("*", requestIdMiddleware);
    app.use("*", createDevRequestLog(sink));
    app.get("/api/health", (c) => c.json({ ok: true }));
    app.get("/api/invites/:token", (c) => c.json({ t: c.req.param("token") }));
    app.get("/api/boom", (c) =>
      c.json({ error: { code: "UNAUTHENTICATED", message: "nope" } }, 401),
    );
    return app;
  };

  it("logs method, template path, status and duration", async () => {
    const sink = { warn: vi.fn<(message: string) => void>() };
    await build(sink).request("/api/health");

    expect(sink.warn).toHaveBeenCalledTimes(1);
    const line = sink.warn.mock.calls[0]?.[0] as string;
    expect(line).toContain("[req] GET /api/health -> 200");
    expect(line).toMatch(/requestId=[0-9a-f-]{36}/);
  });

  it("appends the envelope error code on a non-2xx", async () => {
    const sink = { warn: vi.fn<(message: string) => void>() };
    await build(sink).request("/api/boom");
    expect(sink.warn.mock.calls[0]?.[0]).toContain("-> 401 UNAUTHENTICATED");
  });

  it("never writes a capability token into the log", async () => {
    const sink = { warn: vi.fn<(message: string) => void>() };
    const token = "Zx9_kQ2mNpLr4TvW8yBc";
    await build(sink).request(`/api/invites/${token}?ref=email`);

    const line = sink.warn.mock.calls[0]?.[0] as string;
    expect(line).not.toContain(token); // the assertion that matters
    expect(line).toContain("/api/invites/:token");
    expect(line).toContain("?ref");
    expect(line).not.toContain("email"); // query VALUES are data too
  });

  it("leaves the response body intact for the client (clone, not consume)", async () => {
    const sink = { warn: vi.fn<(message: string) => void>() };
    const res = await build(sink).request("/api/boom");
    await expect(res.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "nope" },
    });
  });
});
