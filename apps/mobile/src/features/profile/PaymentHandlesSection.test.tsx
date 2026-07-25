/**
 * PaymentHandlesSection (T-5.8) — the absent-vs-null wire rule (auth §3.4.2) and
 * the profile-side zelle-pair rule. `diffField` is unit-tested directly (tightest
 * proof that an emptied handle CLEARS via explicit `null` rather than silently
 * becoming untouched — the "user can never remove a handle" bug), plus the
 * integration path through the rendered section.
 */
import { userEndpoints, type User } from "@gogo/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";

import { apiClient } from "@/auth";
import { PaymentHandlesSection, diffField } from "@/features/profile";
import { renderWithProviders } from "@/test-utils/render";
import { TEST_USER } from "@/test-utils/session-fixtures";

const USER_WITH_HANDLES: User = {
  ...TEST_USER,
  venmo_username: "old",
  zelle_handle: "x@y.com",
  zelle_display_name: "Zed",
};

function spyRequest(): jest.Mock {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockResolvedValue({
    venmo_username: null,
    cashtag: null,
    paypalme_username: null,
    zelle_handle: null,
    zelle_display_name: null,
  });
  return request;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("diffField", () => {
  it("returns the trimmed value when non-empty", () => {
    expect(diffField("sean", null)).toBe("sean");
    expect(diffField("  sean  ", "old")).toBe("sean");
  });

  it("returns null when emptied but a value existed (clear it)", () => {
    expect(diffField("", "old")).toBeNull();
    expect(diffField("   ", "old")).toBeNull();
  });

  it("returns undefined when empty and was already empty (untouched)", () => {
    expect(diffField("", null)).toBeUndefined();
  });
});

describe("PaymentHandlesSection", () => {
  it("clearing existing handles PATCHes explicit nulls (venmo + zelle pair)", async () => {
    const request = spyRequest();
    await renderWithProviders(<PaymentHandlesSection user={USER_WITH_HANDLES} />);

    await fireEvent.changeText(screen.getByTestId("profile-input-venmo"), "");
    await fireEvent.changeText(screen.getByTestId("profile-input-zelle"), "");
    await fireEvent.press(screen.getByTestId("profile-button-save-handles"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(userEndpoints.updatePaymentHandles, {
        body: { venmo_username: null, zelle_handle: null, zelle_display_name: null },
      }),
    );
  });

  it("blocks save when a Zelle handle has no display name (profile-side rule)", async () => {
    const request = spyRequest();
    await renderWithProviders(<PaymentHandlesSection user={TEST_USER} />);

    await fireEvent.changeText(screen.getByTestId("profile-input-zelle"), "a@b.com");

    expect(screen.getByTestId("profile-button-save-handles")).toBeDisabled();
    expect(screen.getByTestId("profile-input-zelle-name-error")).toBeOnTheScreen();
    expect(request).not.toHaveBeenCalled();
  });
});
