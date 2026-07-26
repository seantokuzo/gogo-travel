/**
 * Auth runtime (T-5.7 / NAV-2) — session store, API client, secure-token
 * storage seam, and the Apple/Google sign-in flows. The DI seams (SessionDeps,
 * ApiClientConfig, SecureTokenStorage) let tests inject fakes; the singletons
 * (`useSessionStore`, `apiClient`, `secureTokenStorage`) are the app wiring.
 */
export { createApiClient, ApiRequestError, REQUEST_TIMEOUT_MS } from "./api-client";
export type { ApiClientBridge, ApiClientConfig, MobileApiClient, RequestOptions } from "./api-client";
export { resolveApiBaseUrl, googleClientIds, isGoogleConfigured, DEV_SERVER_PORT } from "./config";
export { secureTokenStorage } from "./secure-storage";
export type { SecureTokenStorage } from "./secure-storage";
export {
  useSessionStore,
  apiClient,
  createSessionSlice,
  type SessionState,
  type SessionDeps,
} from "./session-store";
export { signInWithApple, isAppleAuthAvailable } from "./apple";
export { useGoogleSignIn, buildGoogleSignInRequest } from "./google";
