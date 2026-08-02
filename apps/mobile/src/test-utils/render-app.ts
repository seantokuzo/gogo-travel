/**
 * Route-tree render helper (shared by every renderRouter suite). Wraps the
 * T-4.4 harness quirks so each suite doesn't re-derive them:
 *
 * 1. `renderRouter` treats RNTL's now-async `render` as sync — it returns the
 *    unresolved render promise with the router helpers assigned onto it.
 *    We await the commit and re-wrap the helpers (returning the thenable from
 *    an async fn would re-await it, unwrapping to the bare RenderResult).
 * 2. `renderRouter` installs jest fake timers and never restores them; we
 *    unmount the previous tree and hand real timers back before mounting.
 * 3. A test that PRESSES (navigates) leaves scheduled transition work that
 *    wedges any LATER mount in the same file — interactive flows must live
 *    in a single walkthrough test at the END of their file. Pure-URL renders
 *    sequence cleanly.
 */
import { cleanup, renderRouter } from "expo-router/testing-library";

import { seedSessionForUrl } from "./session-fixtures";

const APP_DIR = "src/app";

export async function renderApp(initialUrl: string, opts?: { seedSession?: boolean }) {
  // Quirk 2: reset the previous mount + clock before rendering fresh.
  await cleanup();
  jest.useRealTimers();
  // NAV-2: the root auth gate reads the real session store — seed it to match
  // the URL's auth reachability unless the suite manages the session itself.
  if (opts?.seedSession !== false) seedSessionForUrl(initialUrl);
  const result = renderRouter(APP_DIR, { initialUrl });
  // Quirk 1: await the async commit, then wrap.
  await result;
  return {
    getPathname: () => result.getPathname(),
    getSegments: () => result.getSegments(),
    // `getPathname()` EXCLUDES query params — a route asserted by pathname
    // alone leaves its search params (category/source prefills) unpinned.
    getSearchParams: () => result.getSearchParams(),
    getRouterState: () => result.getRouterState(),
  };
}
