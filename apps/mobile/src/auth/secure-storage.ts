/**
 * Refresh-token secure storage seam (auth-users spec §3.6.1 — the P-5 security
 * invariant).
 *
 * 🔴 The refresh token is a 30-day bearer credential and lives ONLY in
 * expo-secure-store (iOS Keychain / Android Keystore). NEVER AsyncStorage,
 * NEVER MMKV, NEVER the TanStack Query persist layer. This narrow interface IS
 * the enforcement: token material never reaches the raw SecureStore API except
 * through this one adapter (mirrors the theme DI-seam precedent in
 * `src/theme`). The access token is held in memory only (session store) — it
 * never touches this module (15-min TTL; persisting it buys nothing, widens
 * exposure).
 *
 * Under jest, tests mock `expo-secure-store` and exercise this real adapter.
 */
import * as SecureStore from "expo-secure-store";

export interface SecureTokenStorage {
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clearRefreshToken(): Promise<void>;
}

const REFRESH_TOKEN_KEY = "gogo.refreshToken";

// Available after first unlock (so a rotation can happen from a backgrounded
// app) but device-bound: never migrated to a restored backup or a new device.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureTokenStorage: SecureTokenStorage = {
  getRefreshToken: () => SecureStore.getItemAsync(REFRESH_TOKEN_KEY, OPTIONS),
  async setRefreshToken(token) {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, OPTIONS);
  },
  async clearRefreshToken() {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS);
  },
};
