/**
 * v1 DORMANCY FLAG for the §2.4 fetch-fresh seam (T-8.4 / MAP-3). Premium
 * place details are MVP-deferred (places spec Gate-2 resolution: "`fresh`
 * never requested in v1") — `usePlaceFresh` folds this into its `enabled`
 * STRUCTURALLY (R1 review: caller discipline is not a guarantee; a bare
 * `usePlaceFresh(placeId)` call must issue nothing in v1). Flip when the
 * post-MVP Foursquare integration lands (ADR-005 entitlement seam).
 *
 * OWN MODULE, not a `places.ts` const: the flag-on test worlds
 * (place-detail-fresh.test.tsx, places-fresh.test.tsx) flip it by mocking
 * THIS module — a same-module const is unreachable through a partial module
 * mock (the hook would keep reading its local binding, not the mocked
 * export).
 */
export const PLACE_FRESH_ENABLED = false;
