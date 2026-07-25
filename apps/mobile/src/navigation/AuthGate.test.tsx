/**
 * AuthGate component wiring (T-5.7 / NAV-2). Drives the pure `resolveGate`
 * against a mocked router + the real session store: splash-hold (R-nav-3),
 * sign-in redirect + stash (R-nav-1), first-run onboarding (R-nav-2), resume
 * (R-nav-2), and the sign-out reset release (R-nav-4). Uses a mocked router
 * (not the full route tree) so the branches are asserted deterministically.
 */
import { screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { useSessionStore } from "@/auth";
import { renderWithTheme } from "@/test-utils/render";

import { AuthGate } from "./AuthGate";

let mockSegments: string[] = [];
let mockPathname = "/";
const mockReplace = jest.fn();

jest.mock("expo-router", () => ({
  __esModule: true,
  SplashScreen: {
    preventAutoHideAsync: jest.fn().mockResolvedValue(undefined),
    hideAsync: jest.fn().mockResolvedValue(undefined),
  },
  useRouter: () => ({ replace: mockReplace }),
  useSegments: () => mockSegments,
  usePathname: () => mockPathname,
}));

// Never touch the Keychain in a component test — the store's hydrate is
// overridden per-test anyway.
jest.mock("expo-secure-store", () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlock",
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const Child = () => <Text testID="protected">protected</Text>;
const noopHydrate = async () => undefined;

function seed(state: Partial<ReturnType<typeof useSessionStore.getState>>) {
  useSessionStore.setState({
    hydrated: true,
    user: null,
    accessToken: null,
    firstRun: false,
    pendingDestination: null,
    resetting: false,
    hydrate: noopHydrate,
    ...state,
  });
}

beforeEach(() => {
  mockReplace.mockClear();
  mockSegments = [];
  mockPathname = "/";
});

describe("AuthGate", () => {
  it("holds the splash and renders no route until hydration finishes (R-nav-3)", async () => {
    seed({ hydrated: false });
    await renderWithTheme(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    expect(screen.getByTestId("sign-in-splash")).toBeOnTheScreen();
    expect(screen.queryByTestId("protected")).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("redirects an unauthenticated user to sign-in and stashes the destination (R-nav-1)", async () => {
    mockPathname = "/trip-1/today";
    seed({ hydrated: true, user: null });
    await renderWithTheme(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    expect(mockReplace).toHaveBeenCalledWith("/(auth)/sign-in");
    expect(useSessionStore.getState().pendingDestination).toBe("/trip-1/today");
  });

  it("routes a first-run user to onboarding (R-nav-2)", async () => {
    seed({ hydrated: true, user: {} as never, firstRun: true });
    await renderWithTheme(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    expect(mockReplace).toHaveBeenCalledWith("/(auth)/onboarding");
  });

  it("resumes an authenticated user to the stashed destination (R-nav-2)", async () => {
    mockSegments = ["(auth)", "sign-in"];
    mockPathname = "/sign-in";
    seed({ hydrated: true, user: {} as never, pendingDestination: "/trip-1/money" });
    await renderWithTheme(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    expect(mockReplace).toHaveBeenCalledWith("/trip-1/money");
    expect(useSessionStore.getState().pendingDestination).toBeNull();
  });

  it("releases the reset guard once it lands back on sign-in (R-nav-4)", async () => {
    mockSegments = ["(auth)", "sign-in"];
    mockPathname = "/sign-in";
    seed({ hydrated: true, user: null, resetting: true });
    await renderWithTheme(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    expect(mockReplace).not.toHaveBeenCalled();
    expect(useSessionStore.getState().resetting).toBe(false);
  });

  it("renders the requested route for an authenticated user without redirecting", async () => {
    mockSegments = ["(trips)"];
    mockPathname = "/";
    seed({ hydrated: true, user: {} as never });
    await renderWithTheme(
      <AuthGate>
        <Child />
      </AuthGate>,
    );
    expect(screen.getByTestId("protected")).toBeOnTheScreen();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
