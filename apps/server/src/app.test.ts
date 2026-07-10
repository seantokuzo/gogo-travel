import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { app } from "./app.js";

// Same createRequire pattern app.ts uses — the test asserts against the real manifest.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

describe("GET /api/health", () => {
  it("returns ok:true and the package version", async () => {
    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(pkg.version);
  });
});
