/**
 * Refresh-token secure-storage seam (T-5.7). Verifies the thin adapter over
 * expo-secure-store: the namespaced key, the device-bound keychain option, and
 * the get/set/clear round-trip. The P-5 invariant (refresh token in
 * expo-secure-store ONLY) is structural — this is the single module that ever
 * touches the SecureStore API for token material.
 */
import * as SecureStore from "expo-secure-store";

import { secureTokenStorage } from "./secure-storage";

jest.mock("expo-secure-store", () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlockThisDeviceOnly",
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;
const deleteItem = SecureStore.deleteItemAsync as jest.Mock;

const KEY = "gogo.refreshToken";

describe("secureTokenStorage", () => {
  beforeEach(() => {
    getItem.mockReset();
    setItem.mockReset().mockResolvedValue(undefined);
    deleteItem.mockReset().mockResolvedValue(undefined);
  });

  it("reads the refresh token under the namespaced key", async () => {
    getItem.mockResolvedValue("refresh-abc");
    await expect(secureTokenStorage.getRefreshToken()).resolves.toBe("refresh-abc");
    expect(getItem).toHaveBeenCalledWith(KEY, expect.any(Object));
  });

  it("returns null when nothing is stored", async () => {
    getItem.mockResolvedValue(null);
    await expect(secureTokenStorage.getRefreshToken()).resolves.toBeNull();
  });

  it("persists with a device-bound keychain accessibility option", async () => {
    await secureTokenStorage.setRefreshToken("refresh-xyz");
    expect(setItem).toHaveBeenCalledWith(KEY, "refresh-xyz", {
      keychainAccessible: "afterFirstUnlockThisDeviceOnly",
    });
  });

  it("clears the stored token", async () => {
    await secureTokenStorage.clearRefreshToken();
    expect(deleteItem).toHaveBeenCalledWith(KEY, expect.any(Object));
  });
});
