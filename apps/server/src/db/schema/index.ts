/**
 * Drizzle schema barrel — one file per domain area mirroring `@gogo/shared`
 * domains (schema spec DB-1 checklist). This module is drizzle-kit's schema
 * entry point and the `schema` config passed to the drizzle clients.
 */
export * from "./enums.js";
export * from "./identity.js";
export * from "./auth.js";
export * from "./trips.js";
export * from "./places.js";
export * from "./bookings.js";
export * from "./itinerary.js";
export * from "./money.js";
export * from "./capture.js";
export * from "./photos.js";
export * from "./ai.js";
export * from "./utilities.js";
