/**
 * In-session tab memory unit tests (T-6.6 / NAV-3; R-nav-9). Session = module
 * lifetime; resetTabMemory stands in for a cold relaunch and runs on
 * sign-out (R-nav-4).
 */
import { recallTab, rememberTab, resetTabMemory } from "./tab-memory";

afterEach(() => {
  resetTabMemory();
});

describe("tab memory (R-nav-9)", () => {
  it("recalls a manual choice per trip", () => {
    rememberTab("trip-a", "map");
    rememberTab("trip-b", "money");
    expect(recallTab("trip-a")).toBe("map");
    expect(recallTab("trip-b")).toBe("money");
  });

  it("returns undefined for a trip with no manual choice", () => {
    expect(recallTab("trip-a")).toBeUndefined();
  });

  it("last manual choice wins within the session", () => {
    rememberTab("trip-a", "map");
    rememberTab("trip-a", "more");
    expect(recallTab("trip-a")).toBe("more");
  });

  it("reset (relaunch / sign-out) clears every slot — defaults re-apply", () => {
    rememberTab("trip-a", "map");
    resetTabMemory();
    expect(recallTab("trip-a")).toBeUndefined();
  });
});
