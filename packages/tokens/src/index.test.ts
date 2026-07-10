import { describe, expect, it } from "vitest";
import { TOKENS_PACKAGE_NAME } from "./index.js";

describe("@gogo/tokens scaffold", () => {
  it("exports the package name placeholder", () => {
    expect(TOKENS_PACKAGE_NAME).toBe("@gogo/tokens");
  });
});
