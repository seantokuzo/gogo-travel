/**
 * Clipboard seam (T-7.9 / IT-9) — the ONE place an abstract "copy this text"
 * meets a concrete native clipboard, on the `haptics.ts` pattern. Callers say
 * `copyToClipboard(code)`; swapping the engine is a one-file change.
 *
 * ENGINE CHOICE (documented, deliberate): React Native core's `Clipboard`.
 * It is marked `@deprecated` — RN's own guidance is
 * `@react-native-clipboard/clipboard`, and the Expo-flavoured equivalent is
 * `expo-clipboard` — but BOTH are new dependencies, which is an escalation,
 * not a build decision (reported in the PR, not taken here). The core module
 * is still shipped and still native-backed in the pinned RN 0.86
 * (`React/CoreModules/RCTClipboard.mm`), so R-itin-24's copy affordance is
 * real today rather than a stub, and the migration is this file's export.
 *
 * Importing `Clipboard` off the `react-native` barrel trips a one-time dev
 * `warnOnce` about that deprecation. That is the intended cost of keeping the
 * import path honest: a deep import into `react-native/Libraries/…` would
 * silence the warning by reaching around RN's own public surface, which is
 * exactly how a future RN bump turns a loud warning into a crash.
 */
import { Clipboard } from "react-native";

/**
 * Put `text` on the system clipboard. Fire-and-forget and never throwing:
 * copying is an affordance, not a transaction — a failed copy must not take
 * down the screen that offered it. Empty input is a no-op (nothing sensible to
 * "copy" and it would silently clear the user's real clipboard).
 */
export function copyToClipboard(text: string): void {
  if (text === "") return;
  Clipboard.setString(text);
}
