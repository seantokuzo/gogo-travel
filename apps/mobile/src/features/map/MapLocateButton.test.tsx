/**
 * Locate button (T-8.3 / MAP-4 — R-map-16, §2.6 presentation). Load-bearing:
 *  - MOUNT IS SILENT (R-map-16 "no request on mount") — the negative's
 *    CONTROL is the tap cases below: the same spies DO observe calls when
 *    the flow runs, so a quiet mount is evidence, not a blind spy;
 *  - tap on undetermined raises the RATIONALE dialog first; Allow runs the
 *    ONE system prompt and (granted) lights the button;
 *  - tap on denied raises the SETTINGS dialog; confirm = the one-tap
 *    `Linking.openSettings()` hop; cancel changes nothing;
 *  - dialogs are dismissible every time — nothing auto-re-prompts.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react-native";

import { MapLocateButton } from "./MapLocateButton";
import { resetMapLocationForTests, useMapLocationStore } from "./location";
import { renderWithTheme } from "@/test-utils/render";

jest.mock("expo-linking", () => ({
  __esModule: true,
  openURL: jest.fn(async () => null),
  openSettings: jest.fn(async () => null),
}));

const { openSettings: mockOpenSettings } = jest.requireMock("expo-linking") as {
  openSettings: jest.Mock;
};

const locationMock = jest.requireMock("expo-location") as {
  __mock: {
    getForegroundPermissionsAsync: jest.Mock;
    requestForegroundPermissionsAsync: jest.Mock;
    getCurrentPositionAsync: jest.Mock;
  };
};

const permission = (status: "granted" | "undetermined" | "denied") => ({
  status,
  granted: status === "granted",
  canAskAgain: status !== "denied",
  expires: "never",
});

beforeEach(() => {
  jest.clearAllMocks();
  resetMapLocationForTests();
});

it("R-map-16: mounting requests NOTHING", async () => {
  await renderWithTheme(<MapLocateButton />);

  expect(screen.getByTestId("map-button-locate")).toBeTruthy();
  expect(locationMock.__mock.getForegroundPermissionsAsync).not.toHaveBeenCalled();
  expect(locationMock.__mock.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  expect(locationMock.__mock.getCurrentPositionAsync).not.toHaveBeenCalled();
});

it("undetermined tap → rationale dialog; Allow → system prompt → granted state", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValue(permission("undetermined"));
  locationMock.__mock.requestForegroundPermissionsAsync.mockResolvedValue(permission("granted"));
  await renderWithTheme(<MapLocateButton />);

  await fireEvent.press(screen.getByTestId("map-button-locate"));

  // CONTROL for the mount negative: the tap DID reach the permission API.
  expect(locationMock.__mock.getForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  // Rationale fronts the prompt — nothing system-side yet (R-map-16).
  expect(await screen.findByTestId("map-dialog-locate-rationale-confirm")).toBeOnTheScreen();
  expect(locationMock.__mock.requestForegroundPermissionsAsync).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByTestId("map-dialog-locate-rationale-confirm"));

  await waitFor(() =>
    expect(locationMock.__mock.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1),
  );
  await waitFor(() => expect(useMapLocationStore.getState().permission).toBe("granted"));
  expect(useMapLocationStore.getState().position).not.toBeNull();
});

it("rationale declined: dialog closes, no prompt, next tap can re-raise it", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValue(permission("undetermined"));
  await renderWithTheme(<MapLocateButton />);

  await fireEvent.press(screen.getByTestId("map-button-locate"));
  await fireEvent.press(await screen.findByTestId("map-dialog-locate-rationale-cancel"));

  expect(locationMock.__mock.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  expect(useMapLocationStore.getState().dialog).toBeNull();

  // Not a dead control: the user can reconsider (tap-initiated, no loop).
  await fireEvent.press(screen.getByTestId("map-button-locate"));
  expect(await screen.findByTestId("map-dialog-locate-rationale-confirm")).toBeOnTheScreen();
});

it("denied tap → Settings dialog; confirm is the one-tap openSettings hop", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValue(permission("denied"));
  await renderWithTheme(<MapLocateButton />);

  await fireEvent.press(screen.getByTestId("map-button-locate"));
  await fireEvent.press(await screen.findByTestId("map-dialog-locate-settings-confirm"));

  expect(mockOpenSettings).toHaveBeenCalledTimes(1);
  expect(useMapLocationStore.getState().dialog).toBeNull();
  // The system prompt was never an option here (denied never re-prompts).
  expect(locationMock.__mock.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
});

it("settings dialog cancel: nothing opens, nothing re-fires", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValue(permission("denied"));
  await renderWithTheme(<MapLocateButton />);

  await fireEvent.press(screen.getByTestId("map-button-locate"));
  await fireEvent.press(await screen.findByTestId("map-dialog-locate-settings-cancel"));

  expect(mockOpenSettings).not.toHaveBeenCalled();
  expect(useMapLocationStore.getState().dialog).toBeNull();
});

it("granted-but-read-fails → the UNAVAILABLE dialog with its own copy — never 'Location is off' (interp-17 closure)", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValue(permission("granted"));
  locationMock.__mock.getCurrentPositionAsync.mockRejectedValue(new Error("gps fault"));
  await renderWithTheme(<MapLocateButton />);

  await fireEvent.press(screen.getByTestId("map-button-locate"));

  // The DISTINCT arm presents…
  expect(await screen.findByTestId("map-dialog-locate-unavailable-confirm")).toBeOnTheScreen();
  expect(screen.getByText("Couldn't get your location")).toBeOnTheScreen();
  // …and the denied arm's copy is nowhere on it (the misleading claim the
  // rider removes — PR #24 interp 17).
  expect(screen.queryByText("Location is off")).toBeNull();

  // Settings stays the one actionable hop.
  await fireEvent.press(screen.getByTestId("map-dialog-locate-unavailable-confirm"));
  expect(mockOpenSettings).toHaveBeenCalledTimes(1);
  expect(useMapLocationStore.getState().dialog).toBeNull();
});

it("CONTROL: the denied arm still wears the settings dialog + its copy", async () => {
  locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValue(permission("denied"));
  await renderWithTheme(<MapLocateButton />);

  await fireEvent.press(screen.getByTestId("map-button-locate"));

  expect(await screen.findByTestId("map-dialog-locate-settings-confirm")).toBeOnTheScreen();
  expect(screen.getByText("Location is off")).toBeOnTheScreen();
  expect(screen.queryByText("Couldn't get your location")).toBeNull();
});
