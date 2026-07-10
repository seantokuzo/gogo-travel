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
export * from "./config/entitlements.js";
export * from "./config/ai-pricing.js";
export * from "./domains/user.js";
export * from "./domains/auth.js";
export * from "./domains/entitlement.js";
export * from "./domains/trip.js";
export * from "./domains/member.js";
export * from "./domains/place.js";
export * from "./domains/booking.js";
export * from "./domains/itinerary.js";
export * from "./domains/money.js";
export * from "./domains/capture.js";
export * from "./domains/photo.js";
export * from "./domains/packing.js";
export * from "./domains/document.js";
export * from "./domains/weather.js";
export * from "./domains/notification.js";
export * from "./domains/offline.js";
