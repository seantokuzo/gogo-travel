/**
 * Unmatched-route sweeper (T-6.6 / NAV-5; R-nav-17). Any URL the router
 * cannot match — unknown deep links the registry passed through, stale paths
 * from old app versions, in-app typos — lands on the default route with the
 * non-blocking link notice instead of expo-router's built-in "Unmatched
 * Route" screen. Never a crash, never a blank screen.
 */
import { Redirect } from "expo-router";
import { useEffect } from "react";

import { showLinkNotice } from "@/navigation/link-notice";

export default function NotFoundScreen() {
  // Side effect off the render pass; the Redirect below replaces post-commit.
  useEffect(() => {
    showLinkNotice();
  }, []);
  return <Redirect href="/(trips)" />;
}
