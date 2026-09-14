/**
 * Turn a REFUSED save into something the form can point at (B-26; closes the
 * B-8 SECONDARY, whose QUEUE row reads: the form "surfaces the server's
 * specific reason as the generic 'The booking details don't validate — check
 * the fields'").
 *
 * Two refusal routes, both of which used to throw the reason away:
 *
 *  1. **Client-side** — `BookingCreateSchema`/`BookingUpdateSchema`
 *     `safeParse` fails. `parsed.error` names the exact key and says why;
 *     `BookingForm` discarded it and set one fixed sentence
 *     (BookingForm.tsx:455 and :474 before this change).
 *  2. **Server-side** — the mutation rejects with an `ApiRequestError`
 *     carrying the server's own `message` (envelope.ts: "Human-readable,
 *     safe to display") and, for `VALIDATION_FAILED`, a `z.flattenError`
 *     `details` payload. `onMutationError` replaced all of it with
 *     "Couldn't save the booking. Try again." — so the one message that
 *     actually explains an inverted flight ("the category's primary end
 *     time precedes its start time") never reached the screen.
 *
 * The posture: every reason that maps to a rendered control becomes THAT
 * control's `{testID}-error` node — the `TZ_MISSING_ERROR` pattern, which
 * already put a zone message on the zone picker rather than in a banner.
 * Reasons with no control (cross-field refinements, service-level rules,
 * transport failures) are the banner's job, verbatim. When everything
 * mapped, the banner stops repeating the field text and just says where to
 * look, because the reasons are already on the fields.
 *
 * Pure and platform-free so the mapping is unit-testable without a render.
 */
import type { BookingCategory } from "@gogo/shared";

import { CATEGORY_FIELDS } from "./form-model";

/** Longest banner we will render — a server message is not length-bounded. */
const BANNER_MAX = 300;

/** Structural slice of a Zod issue (mobile has no `zod` dependency). */
export interface SaveIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export interface SaveFailure {
  /** Form-key → message, ready to merge into the form's `fieldErrors`. */
  fieldErrors: Record<string, string>;
  /** Banner copy. Never empty — a refused save always says something. */
  banner: string;
}

/**
 * Wire key → form key for the COMMON section. Detail keys need no entry:
 * they already ARE form keys (`CATEGORY_FIELDS[*].key` mirrors the wire
 * shape), except the `*_tz` siblings, which are handled by
 * `zonedFieldForTzKey` below.
 */
const WIRE_KEY_TO_FORM_KEY: Readonly<Record<string, string>> = {
  title: "title",
  price_cents: "price",
  currency: "currency",
  confirmation_code: "confirmation",
};

/** Labels for the common section — the detail labels come from the config. */
const COMMON_LABELS: Readonly<Record<string, string>> = {
  title: "Name",
  price: "Price",
  currency: "Currency",
  confirmation: "Confirmation code",
};

/**
 * `departs_tz` → `departs_at`. A zone rejection has no control of its own:
 * the zone picker renders under its datetime field and shares that field's
 * error slot (BookingForm's `zoneError` split), so the message has to land
 * on the datetime key or it lands nowhere.
 */
function zonedFieldForTzKey(category: BookingCategory, key: string): string | null {
  for (const field of CATEGORY_FIELDS[category]) {
    if (field.kind === "datetime" && field.tzKey === key) return field.key;
  }
  return null;
}

/** Human label for a form key, or `null` when nothing renders it. */
export function fieldLabelFor(category: BookingCategory, formKey: string): string | null {
  const common = COMMON_LABELS[formKey];
  if (common !== undefined) return common;
  const field = CATEGORY_FIELDS[category].find((candidate) => candidate.key === formKey);
  return field?.label ?? null;
}

/**
 * Wire path → the form key that renders it, or `null` when the reason
 * belongs to no single control (a cross-field refinement, an unknown key, a
 * whole-object rule).
 */
export function formKeyForPath(
  category: BookingCategory,
  path: readonly PropertyKey[],
): string | null {
  const head = path[0];
  if (typeof head !== "string") return null;
  if (head === "details") {
    const detailKey = path[1];
    if (typeof detailKey !== "string") return null;
    const rendered = CATEGORY_FIELDS[category].some((field) => field.key === detailKey);
    if (rendered) return detailKey;
    return zonedFieldForTzKey(category, detailKey);
  }
  const mapped = WIRE_KEY_TO_FORM_KEY[head];
  if (mapped === undefined) return null;
  // Only claim the key if something actually renders it.
  return fieldLabelFor(category, mapped) !== null ? mapped : null;
}

function clamp(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > BANNER_MAX ? `${trimmed.slice(0, BANNER_MAX - 1)}…` : trimmed;
}

/**
 * Compose the banner: unmapped reasons verbatim (they are the only place
 * those exist), else a pointer at the fields now carrying their own text.
 */
function bannerFor(
  category: BookingCategory,
  unmapped: readonly string[],
  mappedKeys: readonly string[],
  fallback: string,
): string {
  if (unmapped.length > 0) return clamp(unmapped.join(" · "));
  const labels = mappedKeys
    .map((key) => fieldLabelFor(category, key))
    .filter((label): label is string => label !== null);
  if (labels.length === 0) return fallback;
  return clamp(
    labels.length === 1
      ? `${labels[0] ?? ""} needs attention — see the message under it.`
      : `These fields need attention: ${labels.join(", ")}.`,
  );
}

/**
 * Banner for a refusal whose reasons are ALREADY on the fields — the
 * `buildDetails` / money-parse arm, which computed its own per-field
 * messages. It names where to look rather than restating them; with the
 * banner pinned at the top of the form and Save at the bottom, "which field"
 * is the part the user cannot see (B-26).
 */
export function bannerForFieldErrors(
  category: BookingCategory,
  errors: Readonly<Record<string, string>>,
): string {
  const keys = Object.keys(errors).filter((key) => (errors[key] ?? "") !== "");
  return bannerFor(category, [], keys, GENERIC_FIELD_ERRORS);
}

/** Only reachable when a field error exists whose key renders nothing. */
const GENERIC_FIELD_ERRORS = "Some fields need attention before this can be saved.";

/**
 * Zod issues (the client-side `safeParse` refusal) → field errors + banner.
 * The FIRST issue per field wins: Zod can report several on one key and a
 * single error slot should show the first, not a concatenation.
 */
export function failureFromIssues(
  category: BookingCategory,
  issues: readonly SaveIssue[],
  fallback: string,
): SaveFailure {
  const fieldErrors: Record<string, string> = {};
  const unmapped: string[] = [];
  const order: string[] = [];
  for (const issue of issues) {
    const message = issue.message.trim();
    if (message === "") continue;
    const key = formKeyForPath(category, issue.path);
    if (key === null) {
      if (!unmapped.includes(message)) unmapped.push(message);
      continue;
    }
    if (fieldErrors[key] === undefined) {
      fieldErrors[key] = message;
      order.push(key);
    }
  }
  if (order.length === 0 && unmapped.length === 0) return { fieldErrors, banner: fallback };
  return { fieldErrors, banner: bannerFor(category, unmapped, order, fallback) };
}

/**
 * Shape of `z.flattenError` as the server sends it for `VALIDATION_FAILED`
 * (`apps/server/src/http/validation.ts`). `fieldErrors` is keyed by the
 * TOP-LEVEL path segment only — a `details.departs_at` failure arrives
 * under `details`, so it stays a banner reason rather than being guessed
 * onto a field.
 */
interface FlattenedError {
  formErrors?: unknown;
  fieldErrors?: unknown;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

/** A rejected mutation, as far as this module needs to know it. */
export interface SaveApiError {
  /** HTTP status; `0` for a transport/network failure (ApiRequestError). */
  readonly status: number;
  readonly message: string;
  readonly details?: unknown;
}

/**
 * Server refusal → field errors + banner. The server's own `message` is the
 * banner unless the flattened payload gives per-field text, in which case
 * the fields carry it and the banner carries whatever was left over.
 */
export function failureFromApiError(
  category: BookingCategory,
  error: SaveApiError,
  fallback: string,
): SaveFailure {
  const issues: SaveIssue[] = [];
  const flattened = (error.details ?? null) as FlattenedError | null;
  if (flattened !== null && typeof flattened === "object") {
    for (const message of stringsOf(flattened.formErrors)) issues.push({ path: [], message });
    const byField = flattened.fieldErrors;
    if (byField !== null && typeof byField === "object") {
      for (const [key, value] of Object.entries(byField as Record<string, unknown>)) {
        for (const message of stringsOf(value)) issues.push({ path: [key], message });
      }
    }
  }
  const serverMessage = error.message.trim();
  const mapped = failureFromIssues(
    category,
    issues,
    serverMessage === "" ? fallback : serverMessage,
  );
  // Nothing structured came back (the common case — service-level rules
  // answer a bare message): the message IS the reason, verbatim.
  if (issues.length === 0) {
    return { fieldErrors: {}, banner: clamp(serverMessage === "" ? fallback : serverMessage) };
  }
  return mapped;
}
