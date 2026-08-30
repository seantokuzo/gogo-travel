/**
 * T-S3.3 — shared coordinates for the two clone-isolation probes
 * (`suite-db-isolation-{a,b}.db.test.ts`). One module, imported by both, so
 * the probes can never drift apart: the entire point is that BOTH legs claim
 * the SAME suite-db name and insert the SAME primary key, and both succeed —
 * which is only possible on hard-isolated per-suite databases.
 */

/** Both legs pass this same name to `createSuiteDb` — the nonce keeps them apart. */
export const ISOLATION_PROBE_DB_NAME = "iso_probe";

/** Fixed v4-shape UUID both legs insert as the users PK. */
export const ISOLATION_PROBE_USER_ID = "11111111-1111-4111-8111-111111111111";

export const ISOLATION_PROBE_EMAIL = "isolation-probe@example.com";
export const ISOLATION_PROBE_DISPLAY_NAME = "Isolation Probe";

/**
 * `users_identity_or_scrubbed_ck` demands a provider identity; UNIQUE on
 * `google_sub` makes this a second collision surface on any shared database.
 */
export const ISOLATION_PROBE_GOOGLE_SUB = "isolation-probe-google-sub";
