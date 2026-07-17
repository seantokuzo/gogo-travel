/**
 * Theme runtime adapters (spec §2.1) — the ONLY place platform modules meet
 * the @gogo/tokens/react DI seams. Import the provider wiring from here.
 */
export { systemAppearance } from "./appearance";
export { themeStorage } from "./storage";
