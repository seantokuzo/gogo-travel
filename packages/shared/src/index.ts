/**
 * @gogo/shared — single source of truth for wire types (Zod schemas,
 * `z.infer` types). No React/RN, no I/O, no env access (R-shared-9).
 *
 * Prefer subpath imports (`@gogo/shared/enums`, `@gogo/shared/domains/money`,
 * …) for tree-shaking (R-shared-14); this barrel re-exports everything for
 * convenience. `ai/*` modules are re-exported as namespaces because each
 * exports its own `SCHEMA_VERSION` (contracts spec §3.7 rule 3).
 */
export * from "./enums.js";
export * from "./scalars.js";
export * from "./api/envelope.js";
export * from "./api/descriptor.js";
