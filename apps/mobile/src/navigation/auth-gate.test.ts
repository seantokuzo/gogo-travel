/**
 * Redirect-gate decision logic (T-5.7 / NAV-2) — the pure `resolveGate`
 * covering every R-nav-1..4 branch without a router or store.
 */
import { resolveGate, type GateInput } from "./auth-gate";

const base: GateInput = {
  hydrated: true,
  authed: false,
  firstRun: false,
  resetting: false,
  inAuthGroup: false,
  onOnboarding: false,
  pathname: "/",
};

describe("resolveGate", () => {
  it("waits on the splash until hydration finishes (R-nav-3)", () => {
    expect(resolveGate({ ...base, hydrated: false })).toEqual({ type: "wait" });
  });

  it("redirects an unauthenticated user to sign-in, stashing the destination (R-nav-1)", () => {
    expect(resolveGate({ ...base, authed: false, pathname: "/trip-1/today" })).toEqual({
      type: "sign-in",
      stash: "/trip-1/today",
    });
  });

  it("does NOT stash during a sign-out reset (R-nav-4)", () => {
    expect(
      resolveGate({ ...base, authed: false, resetting: true, pathname: "/trip-1/today" }),
    ).toEqual({ type: "sign-in", stash: null });
  });

  it("does NOT stash the default landing or the auth screens", () => {
    expect(resolveGate({ ...base, authed: false, pathname: "/" })).toEqual({
      type: "sign-in",
      stash: null,
    });
    expect(
      resolveGate({
        ...base,
        authed: false,
        inAuthGroup: true,
        onOnboarding: true,
        pathname: "/onboarding",
      }),
    ).toEqual({ type: "sign-in", stash: null });
  });

  it("renders the sign-in screen for an unauthenticated user", () => {
    expect(
      resolveGate({ ...base, authed: false, inAuthGroup: true, pathname: "/sign-in" }),
    ).toEqual({ type: "render" });
  });

  it("routes a first-run user through onboarding (R-nav-2)", () => {
    expect(resolveGate({ ...base, authed: true, firstRun: true, pathname: "/" })).toEqual({
      type: "onboarding",
    });
  });

  it("lets a first-run user sit on the onboarding screen", () => {
    expect(
      resolveGate({
        ...base,
        authed: true,
        firstRun: true,
        inAuthGroup: true,
        onOnboarding: true,
        pathname: "/onboarding",
      }),
    ).toEqual({ type: "render" });
  });

  it("resumes an authenticated user out of the auth group (R-nav-2)", () => {
    expect(resolveGate({ ...base, authed: true, inAuthGroup: true, pathname: "/sign-in" })).toEqual(
      { type: "resume" },
    );
  });

  it("renders a normal route for an authenticated user", () => {
    expect(resolveGate({ ...base, authed: true, pathname: "/trip-1/today" })).toEqual({
      type: "render",
    });
  });
});
