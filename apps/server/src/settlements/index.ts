/**
 * Settlements domain barrel (T-9.3 / MON-3, MON-4) — balances (B1) +
 * settlements (S1–S3). The router ships UNMOUNTED by design: the app.ts
 * mount rides T-9.4, the P-9 W3 wiring closer (QUEUE file-ownership split).
 * T-9.4 consumes `createSettlementsRouter` + `buildSettlementsDeps` from
 * here.
 */
export * from "./cursor.js";
export * from "./routes.js";
export * from "./serialize.js";
export * from "./service.js";
export * from "./wire.js";
