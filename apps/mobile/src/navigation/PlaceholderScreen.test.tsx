/**
 * PlaceholderScreen unit tests (T-4.4) — the scaffold contract every skeleton
 * route relies on: §2.7 rule-2 root testID, PageHeader derived `-back`,
 * EmptyState placeholder body, action + children slots.
 */
import { fireEvent, screen, within } from "@testing-library/react-native";
import { Text } from "react-native";

import { renderWithTheme } from "@/test-utils/render";

import { PlaceholderScreen } from "./PlaceholderScreen";

const mockBack = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockBack }),
}));

describe("PlaceholderScreen", () => {
  beforeEach(() => {
    mockBack.mockClear();
  });

  it("renders the §2.7 rule-2 root testID and the header title", async () => {
    await renderWithTheme(
      <PlaceholderScreen screenId="profile" title="Profile" note="Coming later." />,
    );
    expect(screen.getByTestId("profile-screen")).toBeOnTheScreen();
    // Title renders in the PageHeader AND as the EmptyState headline —
    // scope to the header for the chrome assertion.
    expect(within(screen.getByTestId("profile-header")).getByText("Profile")).toBeOnTheScreen();
    expect(screen.getByText("Coming later.")).toBeOnTheScreen();
    // No back affordance unless asked for (tab roots / landing screens).
    expect(screen.queryByTestId("profile-header-back")).toBeNull();
  });

  it("wires the PageHeader back affordance with its derived testID", async () => {
    await renderWithTheme(
      <PlaceholderScreen screenId="settle" title="Settle up" back note="Coming later." />,
    );
    fireEvent.press(screen.getByTestId("settle-header-back"));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("echoes the subtitle (dynamic routes surface their param there)", async () => {
    await renderWithTheme(
      <PlaceholderScreen screenId="invite-join" title="Join trip" subtitle="Invite tok-1" back />,
    );
    expect(screen.getByText("Invite tok-1")).toBeOnTheScreen();
  });

  it("renders the EmptyState action and children slots", async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <PlaceholderScreen
        screenId="trip-list"
        title="Trips"
        note="No trips yet."
        action={{ label: "Create a trip", onPress, testID: "trip-list-button-create" }}
      >
        <Text>extra scaffold content</Text>
      </PlaceholderScreen>,
    );
    fireEvent.press(screen.getByTestId("trip-list-button-create"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByText("extra scaffold content")).toBeOnTheScreen();
  });

  it("omits the EmptyState when no note is given (screens with real skeleton content)", async () => {
    await renderWithTheme(
      <PlaceholderScreen screenId="money" title="Money">
        <Text>segments</Text>
      </PlaceholderScreen>,
    );
    // EmptyState renders its icon block only when a note exists; the title
    // then appears once (header) instead of twice (header + EmptyState).
    expect(screen.getAllByText("Money")).toHaveLength(1);
    expect(screen.getByText("segments")).toBeOnTheScreen();
  });
});
