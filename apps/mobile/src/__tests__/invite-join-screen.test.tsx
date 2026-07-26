/**
 * Invite-join screen states (T-6.6 / NAV-5; R-nav-11) — component-level over
 * the real preview hook (only the network boundary mocked). Route-level
 * routing/plumbing is deep-link-flow.test.tsx; this pins the state matrix:
 * loading, active preview, and EVERY dead-token shape folding into the one
 * error surface with a path back to the trip list.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react-native";

import InviteJoinScreen from "@/app/(trips)/join/[token]";
import { apiClient, ApiRequestError } from "@/auth";
import { renderWithProviders } from "@/test-utils/render";
import { makeInvitePreview } from "@/test-utils/trip-fixtures";

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, back: jest.fn() }),
  useLocalSearchParams: () => ({ token: "tok-under-test" }),
}));

function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

afterEach(() => {
  jest.restoreAllMocks();
  mockReplace.mockClear();
});

it("holds a loading surface while the preview is in flight", async () => {
  spyRequest().mockReturnValue(new Promise(() => undefined)); // never settles
  await renderWithProviders(<InviteJoinScreen />);
  expect(screen.getByTestId("invite-join-screen")).toBeOnTheScreen();
  expect(screen.getByTestId("invite-join-loading")).toBeOnTheScreen();
});

it("renders the preview (trip, inviter, role) for an active token — never the token", async () => {
  spyRequest().mockResolvedValue(makeInvitePreview());
  await renderWithProviders(<InviteJoinScreen />);
  expect(await screen.findByText("Kyoto")).toBeOnTheScreen();
  expect(screen.getByText(/Test Traveler invited you to join as editor/)).toBeOnTheScreen();
  expect(screen.queryByText(/tok-under-test/)).toBeNull();
});

it.each(["expired", "revoked", "max_uses_reached"] as const)(
  "R-nav-11: a %s token folds into the one 'Invite not available' error state",
  async (state) => {
    spyRequest().mockResolvedValue(makeInvitePreview({ state }));
    await renderWithProviders(<InviteJoinScreen />);
    expect(await screen.findByText("Invite not available")).toBeOnTheScreen();
    expect(screen.getByTestId("invite-join-button-trips")).toBeOnTheScreen();
  },
);

it("R-nav-11: an unknown token (404) renders the same error state, and the action goes back to trips", async () => {
  spyRequest().mockRejectedValue(new ApiRequestError(404, "NOT_FOUND", "not found"));
  await renderWithProviders(<InviteJoinScreen />);
  expect(await screen.findByText("Invite not available")).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId("invite-join-button-trips"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/(trips)"));
});
