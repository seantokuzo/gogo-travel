/**
 * @/features/deeplinks — deeplink-out builders + return-prompt loop (T-7.8 /
 * IT-8; itinerary spec §2.7/§2.8). Consumer map:
 *  - T-7.6 add flows / T-7.9 booking detail: mount `DeeplinkPanel` with
 *    `{ tripId, surface, input, destinationName }` — enablement, adults
 *    default+edit, tap recording, and URL construction are all inside.
 *  - A layout (trip chrome or root): mount `DeeplinkReturnHost` ONCE for
 *    the "Did you book it?" loop; its props are the T-7.6/capture seams.
 *  - Pure builders + partner registry exported for direct use (tests,
 *    future surfaces).
 */
export { DeeplinkPanel, deeplinkButtonTestID } from "./DeeplinkPanel";
export type {
  DeeplinkPanelProps,
  DeeplinkSearchInput,
  DeeplinkSurface,
  ExternalUrlFields,
  TrainSearchFields,
} from "./DeeplinkPanel";
export { DeeplinkReturnHost } from "./DeeplinkReturnHost";
export type { DeeplinkReturnHostProps } from "./DeeplinkReturnHost";
export { ManualAddBookingSheet } from "./ManualAddBookingSheet";
export type { ManualAddBookingSheetProps } from "./ManualAddBookingSheet";
export { ReturnPromptSheet } from "./ReturnPromptSheet";
export type { ReturnPromptSheetProps } from "./ReturnPromptSheet";
export {
  clearDeeplinkOutRecord,
  consumePendingReturnPrompt,
  DEEPLINK_RETURN_KEY,
  readDeeplinkOutRecord,
  recordDeeplinkOut,
  RETURN_PROMPT_WINDOW_MS,
} from "./return-prompt-store";
export type { DeeplinkOutRecord } from "./return-prompt-store";
export { useDeeplinkReturnPrompt } from "./useDeeplinkReturnPrompt";
export type { DeeplinkReturnPrompt } from "./useDeeplinkReturnPrompt";
export {
  searchTrainlineUrn,
  trainlineLocationSearchUrl,
  useTrainlineStationUrn,
} from "./trainline";
export {
  buildAirbnbUrl,
  buildAmtrakUrl,
  buildBookingComUrl,
  buildEventbriteUrl,
  buildExpediaUrl,
  buildExternalUrl,
  buildKayakCarsUrl,
  buildKayakFlightsUrl,
  buildOmioUrl,
  buildSkyscannerUrl,
  buildTrainlineUrl,
  buildTuroUrl,
  buildVrboUrl,
  categoryUsesAdults,
  externalUrlHost,
  PARTNERS_BY_CATEGORY,
  partnerLabel,
} from "./url-builders";
export type {
  AffiliateParams,
  CarRentalSearchFields,
  DeeplinkBuild,
  DeeplinkPartner,
  DeeplinkPartnerId,
  FlightSearchFields,
  LodgingSearchFields,
  TrainlineUrlInput,
} from "./url-builders";
