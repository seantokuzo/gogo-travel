/**
 * Link-notice slot (T-6.6 / NAV-5; R-nav-17) — the "non-blocking notice" an
 * unknown/malformed link surfaces after landing on the default route. The
 * design system has no toast (ErrorBanner is the sanctioned inline surface,
 * R-ds-17), so the notice is a one-slot piece of client state the trip-list
 * screen renders as a dismissible warning banner.
 *
 * Zustand (client state per ADR-004): the writer is the deep-link layer
 * (+native-intent / +not-found — outside React), the reader is a screen.
 */
import { create } from "zustand";

export const LINK_NOTICE_MESSAGE = "That link couldn't be opened.";

interface LinkNoticeState {
  /** Notice to show on the landing surface; null = nothing pending. */
  message: string | null;
  show(message?: string): void;
  clear(): void;
}

export const useLinkNoticeStore = create<LinkNoticeState>()((set) => ({
  message: null,
  show: (message = LINK_NOTICE_MESSAGE) => set({ message }),
  clear: () => set({ message: null }),
}));

/** Imperative writer for the non-React deep-link layer. */
export function showLinkNotice(message?: string): void {
  useLinkNoticeStore.getState().show(message);
}
