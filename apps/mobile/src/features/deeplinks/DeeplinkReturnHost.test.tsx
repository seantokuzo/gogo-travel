/**
 * Return-prompt loop pins (T-7.8 / IT-8; §2.8, R-nav-18 rendering §2.9):
 * a recorded deeplink-out presents "Did you book it?" on foreground (and on
 * mount — the cold-start return) within 30 minutes, ONCE; stale records
 * expire silently; "add manually" lands the minimal create that carries
 * `source: 'deeplink_return'` ON THE WIRE (falsifiable: the request body is
 * re-parsed with BookingCreateSchema and the source pinned); the consumer
 * seam (`onAddManually`) overrides the built-in landing, gated to one
 * action per presented record (Sheet exit-animation landmine).
 *
 * AppState events use the collab.test spy pattern; MMKV is the in-memory
 * jest substitute (real adapter). RNTL v14: every boundary awaited.
 */
import { BookingCreateSchema, bookingEndpoints, type Booking } from "@gogo/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { AppState, type NativeEventSubscription } from "react-native";

import { apiClient } from "@/auth";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderWithProviders } from "@/test-utils/render";

import { DeeplinkReturnHost } from "./DeeplinkReturnHost";
import {
  clearDeeplinkOutRecord,
  readDeeplinkOutRecord,
  recordDeeplinkOut,
  RETURN_PROMPT_WINDOW_MS,
  type DeeplinkOutRecord,
} from "./return-prompt-store";

function makeRecord(overrides?: Partial<DeeplinkOutRecord>): DeeplinkOutRecord {
  return {
    partner: "airbnb",
    category: "lodging",
    tripId: TEST_TRIP_ID,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** collab.test pattern: capture the AppState listener, emit synthetically. */
function spyAppState(): { emit(status: string): Promise<void> } {
  const listeners: ((status: string) => void)[] = [];
  (jest.spyOn(AppState, "addEventListener") as unknown as jest.Mock).mockImplementation(
    (_type: string, handler: (status: string) => void) => {
      listeners.push(handler);
      return { remove: jest.fn() } as unknown as NativeEventSubscription;
    },
  );
  return {
    emit: async (status: string) => {
      await act(async () => {
        for (const listener of listeners) listener(status);
      });
    },
  };
}

afterEach(() => {
  clearDeeplinkOutRecord();
  jest.restoreAllMocks();
});

it("cold-start return: a fresh record presents the sheet on mount and is consumed (present once)", async () => {
  recordDeeplinkOut(makeRecord());
  await renderWithProviders(<DeeplinkReturnHost />);

  await waitFor(() => expect(screen.getByTestId("booking-return-sheet")).toBeOnTheScreen());
  expect(screen.getByTestId("booking-return-button-manual")).toBeOnTheScreen();
  // Consumed at present time — no re-prompt on a later foreground.
  expect(readDeeplinkOutRecord()).toBeNull();

  await fireEvent.press(screen.getByTestId("booking-return-button-dismiss"));
  await waitFor(() => expect(screen.queryByTestId("booking-return-sheet")).toBeNull());
});

it("foreground within the window presents; without a record nothing shows", async () => {
  const appState = spyAppState();
  await renderWithProviders(<DeeplinkReturnHost />);
  expect(screen.queryByTestId("booking-return-sheet")).toBeNull();

  // A foreground with nothing pending stays quiet.
  await appState.emit("active");
  expect(screen.queryByTestId("booking-return-sheet")).toBeNull();

  recordDeeplinkOut(makeRecord({ partner: "turo", category: "car_rental" }));
  await appState.emit("active");
  expect(screen.getByTestId("booking-return-sheet")).toBeOnTheScreen();
});

it("a stale (>30 min) record expires silently on foreground", async () => {
  const appState = spyAppState();
  await renderWithProviders(<DeeplinkReturnHost />);
  recordDeeplinkOut(makeRecord({ timestamp: Date.now() - RETURN_PROMPT_WINDOW_MS - 1000 }));
  await appState.emit("active");
  expect(screen.queryByTestId("booking-return-sheet")).toBeNull();
  // Expired AND cleared — it can never resurface.
  expect(readDeeplinkOutRecord()).toBeNull();
});

it("a foreground with nothing pending must NOT clobber the presented prompt (R1 guard arm)", async () => {
  const appState = spyAppState();
  await renderWithProviders(<DeeplinkReturnHost />);
  recordDeeplinkOut(makeRecord());
  await appState.emit("active");
  expect(screen.getByTestId("booking-return-sheet")).toBeOnTheScreen();

  // The slot is already consumed — a second foreground reads null and must
  // leave the sheet the user is currently looking at alone.
  await appState.emit("active");
  expect(screen.getByTestId("booking-return-sheet")).toBeOnTheScreen();
});

it("unmount before the mount check fires cancels WITHOUT consuming (R1 guard arm)", async () => {
  jest.useFakeTimers();
  try {
    recordDeeplinkOut(makeRecord());
    const view = await renderWithProviders(<DeeplinkReturnHost />);
    // Unmount before the scheduled mount check runs (fake timers hold it).
    await view.unmount();
    jest.advanceTimersByTime(60_000);
    // Cancelled, not consumed — the record survives for the next mount.
    expect(readDeeplinkOutRecord()).toMatchObject({
      partner: "airbnb",
      category: "lodging",
      tripId: TEST_TRIP_ID,
    });
  } finally {
    jest.useRealTimers();
  }
});

it("forward/share render disabled until the capture-spec seams are wired", async () => {
  recordDeeplinkOut(makeRecord());
  await renderWithProviders(<DeeplinkReturnHost />);
  await waitFor(() =>
    expect(screen.getByTestId("booking-return-button-forward")).toBeOnTheScreen(),
  );
  expect(screen.getByTestId("booking-return-button-forward")).toBeDisabled();
  expect(screen.getByTestId("booking-return-button-share")).toBeDisabled();
});

it("'add manually' lands the minimal create with source: 'deeplink_return' pinned on the wire", async () => {
  const requestSpy = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  requestSpy.mockResolvedValue({ id: "created" } as unknown as Booking);
  recordDeeplinkOut(makeRecord({ partner: "booking", category: "lodging" }));
  await renderWithProviders(<DeeplinkReturnHost />);

  await waitFor(() => expect(screen.getByTestId("booking-return-button-manual")).toBeOnTheScreen());
  await fireEvent.press(screen.getByTestId("booking-return-button-manual"));
  expect(screen.getByTestId("booking-manual-add-sheet")).toBeOnTheScreen();

  // Empty title → save disabled (BookingCreate title is min 1).
  expect(screen.getByTestId("booking-manual-add-button-save")).toBeDisabled();
  await fireEvent.changeText(
    screen.getByTestId("booking-manual-add-input-title"),
    "Park Hyatt Tokyo",
  );
  await fireEvent.press(screen.getByTestId("booking-manual-add-button-save"));

  await waitFor(() => expect(requestSpy).toHaveBeenCalledTimes(1));
  const [descriptor, input] = requestSpy.mock.calls[0] as [
    unknown,
    { params: { tripId: string }; body: unknown },
  ];
  expect(descriptor).toBe(bookingEndpoints.createBooking);
  expect(input.params).toEqual({ tripId: TEST_TRIP_ID });
  // The wire pin: the body IS a valid BookingCreate whose source is the
  // deeplink-return value (R-ib-11) — not just "some object we hoped".
  const body = BookingCreateSchema.parse(input.body);
  expect(body.source).toBe("deeplink_return");
  expect(body.category).toBe("lodging");
  expect(body.title).toBe("Park Hyatt Tokyo");

  // Success closes the landing sheet.
  await waitFor(() => expect(screen.queryByTestId("booking-manual-add-sheet")).toBeNull());

  // Drain the return sheet's ~200ms exit so setExiting(false) resolves in an
  // act window, not the test-end→cleanup gap (Sheet exit-window landmine).
  await waitFor(() => expect(screen.queryByTestId("booking-return-sheet")).toBeNull());
});

it("cancel on the manual-add sheet closes it WITHOUT landing a create (R1 pin)", async () => {
  const requestSpy = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  requestSpy.mockResolvedValue({ id: "unused" } as unknown as Booking);
  recordDeeplinkOut(makeRecord());
  await renderWithProviders(<DeeplinkReturnHost />);

  await waitFor(() => expect(screen.getByTestId("booking-return-button-manual")).toBeOnTheScreen());
  await fireEvent.press(screen.getByTestId("booking-return-button-manual"));
  expect(screen.getByTestId("booking-manual-add-sheet")).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId("booking-manual-add-button-cancel"));
  await waitFor(() => expect(screen.queryByTestId("booking-manual-add-sheet")).toBeNull());
  expect(requestSpy).not.toHaveBeenCalled();

  // Drain the return sheet's ~200ms exit so setExiting(false) resolves in an
  // act window, not the test-end→cleanup gap (Sheet exit-window landmine).
  await waitFor(() => expect(screen.queryByTestId("booking-return-sheet")).toBeNull());
});

it("a failed create surfaces the sheet's ErrorBanner via the hook-level seam and stays open", async () => {
  const requestSpy = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  requestSpy.mockRejectedValue(new Error("500"));
  recordDeeplinkOut(makeRecord());
  await renderWithProviders(<DeeplinkReturnHost />);

  await waitFor(() => expect(screen.getByTestId("booking-return-button-manual")).toBeOnTheScreen());
  await fireEvent.press(screen.getByTestId("booking-return-button-manual"));
  await fireEvent.changeText(screen.getByTestId("booking-manual-add-input-title"), "Somewhere");
  await fireEvent.press(screen.getByTestId("booking-manual-add-button-save"));

  await waitFor(() => expect(screen.getByTestId("booking-manual-add-error")).toBeOnTheScreen());
  expect(screen.getByTestId("booking-manual-add-sheet")).toBeOnTheScreen();

  // The return sheet exited when "add manually" was pressed; drain its ~200ms
  // exit so setExiting(false) resolves in an act window, not the cleanup gap
  // (Sheet exit-window landmine). The manual-add sheet legitimately stays open.
  await waitFor(() => expect(screen.queryByTestId("booking-return-sheet")).toBeNull());
});

it("onAddManually override routes out instead of the built-in sheet, ONCE per presented record", async () => {
  const onAddManually = jest.fn();
  const record = makeRecord({ partner: "kayak", category: "flight" });
  recordDeeplinkOut(record);
  await renderWithProviders(<DeeplinkReturnHost onAddManually={onAddManually} />);

  await waitFor(() => expect(screen.getByTestId("booking-return-button-manual")).toBeOnTheScreen());
  const manual = screen.getByTestId("booking-return-button-manual");
  await fireEvent.press(manual);
  // The sheet is exiting but still mounted/hit-testable (DS landmine) — a
  // late second tap must not double-fire the action.
  await fireEvent.press(manual);

  expect(onAddManually).toHaveBeenCalledTimes(1);
  expect(onAddManually).toHaveBeenCalledWith(record);
  expect(screen.queryByTestId("booking-manual-add-sheet")).toBeNull();

  // Drain the return sheet's ~200ms exit so setExiting(false) resolves in an
  // act window, not the test-end→cleanup gap (Sheet exit-window landmine).
  await waitFor(() => expect(screen.queryByTestId("booking-return-sheet")).toBeNull());
});
