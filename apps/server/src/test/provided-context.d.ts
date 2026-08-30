/**
 * T-S3.3 (testing-overhaul spec §3.3, R-test-6) — typed `provide`/`inject`
 * contract between the shared-container global setup
 * (`src/test/global-setup.ts`) and every DB suite (via
 * `src/test/suite-db.ts`). Serializable values only — vitest ships them to
 * workers via structuredClone.
 */
declare module "vitest" {
  export interface ProvidedContext {
    /**
     * Docker probe outcome, decided ONCE per run in global setup. `false`
     * only ever happens locally (a Docker-less CI run hard-fails the whole
     * run in global setup instead — a skip is NOT a pass).
     */
    dbAvailable: boolean;
    /**
     * Connection URI of the ONE shared Postgres container's admin/default
     * database — `createSuiteDb` runs `CREATE DATABASE … TEMPLATE` through
     * it. Empty string when `dbAvailable` is false.
     */
    dbAdminUri: string;
    /**
     * Name of the migrated TEMPLATE database inside the shared container.
     * Empty string when `dbAvailable` is false.
     */
    dbTemplateName: string;
  }
}

export {};
