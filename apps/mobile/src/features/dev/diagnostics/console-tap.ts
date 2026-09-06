/**
 * Dev console tap (T-S3.5 leg 6, R-test-2) — reads B-6's dev surface BACK.
 *
 * B-6's fix keeps error causes alive in dev as `console.warn("[auth] …")` /
 * `console.warn("[api] …")` calls (sign-in.tsx, api-client.ts, google.ts).
 * That surface is write-only: on a device with no debugger attached the warn
 * scrolls away in Metro on the Mac — the wrong side (the B-5 lesson: device
 * facts must be readable ON the device). This tap keeps the LAST prefixed
 * warn in memory so the diagnostics panel can render it.
 *
 * Boundaries, stated honestly:
 * - Captures from install time onward. The route module installs it at import
 *   (expo-router evaluates route modules when the route tree loads), and the
 *   panel re-installs on mount (idempotent) as a belt-and-braces. QA flow for
 *   an error that predates the tap: open diagnostics once, reproduce the
 *   failure, come back — the module-level state survives navigation.
 * - `__DEV__`-only: in a release build `installConsoleTap` is a no-op and
 *   console.warn is NEVER patched (pinned on both arms).
 * - Call-through is unconditional: the original console.warn always runs, so
 *   Metro/debugger output is untouched and a capture failure can never eat a
 *   warning (the capture is fenced).
 */

/** The B-6 dev-surface prefixes worth keeping (sign-in / api-client / google). */
const TAP_PREFIXES = ["[auth]", "[api]"] as const;

/** How much captured text the panel keeps — evidence, not a log store. */
const MAX_CAPTURE_CHARS = 600;

export interface CapturedWarn {
  /** Epoch ms at capture. */
  at: number;
  /** Rendered message (truncated to MAX_CAPTURE_CHARS). */
  text: string;
}

export interface ConsoleTapSnapshot {
  installed: boolean;
  /** Epoch ms of install, null when never installed. */
  installedAt: number | null;
  /** Prefixed warns captured since install. */
  count: number;
  last: CapturedWarn | null;
}

type WarnFn = (...args: unknown[]) => void;

const state: {
  installed: boolean;
  installedAt: number | null;
  count: number;
  last: CapturedWarn | null;
  original: WarnFn | null;
} = { installed: false, installedAt: null, count: 0, last: null, original: null };

/** One arg → display string; Errors keep name/message/cause (the B-6 point). */
function renderArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) {
    const cause = (arg as { cause?: unknown }).cause;
    const causeText =
      cause instanceof Error
        ? ` (cause: ${cause.name}: ${cause.message})`
        : cause !== undefined
          ? ` (cause: ${String(cause)})`
          : "";
    return `${arg.name}: ${arg.message}${causeText}`;
  }
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

function capture(args: unknown[]): void {
  const first = args[0];
  if (typeof first !== "string") return;
  if (!TAP_PREFIXES.some((prefix) => first.startsWith(prefix))) return;
  const text = args.map(renderArg).join(" ").slice(0, MAX_CAPTURE_CHARS);
  state.count += 1;
  state.last = { at: Date.now(), text };
}

/**
 * Patch console.warn with a capturing call-through. Idempotent; a no-op in
 * release builds (`__DEV__` read at CALL time so both arms are pinnable).
 */
export function installConsoleTap(): void {
  if (!__DEV__) return;
  if (state.installed) return;
  const original: WarnFn = console.warn.bind(console);
  state.original = original;
  console.warn = (...args: unknown[]) => {
    try {
      capture(args);
    } catch {
      // The tap must never break the surface it observes.
    }
    original(...args);
  };
  state.installed = true;
  state.installedAt = Date.now();
}

/** Immutable snapshot for the panel leg. */
export function readConsoleTap(): ConsoleTapSnapshot {
  return {
    installed: state.installed,
    installedAt: state.installedAt,
    count: state.count,
    last: state.last === null ? null : { ...state.last },
  };
}

/** Test-only: unpatch and forget. Restores the warn captured at install. */
export function resetConsoleTapForTests(): void {
  if (state.installed && state.original !== null) {
    console.warn = state.original;
  }
  state.installed = false;
  state.installedAt = null;
  state.count = 0;
  state.last = null;
  state.original = null;
}
