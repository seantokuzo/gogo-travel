import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_NAME } from "./index.js";

describe("@gogo/shared scaffold", () => {
  it("exports the package name placeholder", () => {
    expect(SHARED_PACKAGE_NAME).toBe("@gogo/shared");
  });
});
