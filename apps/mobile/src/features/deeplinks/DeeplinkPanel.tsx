/**
 * Deeplink-out panel (T-7.8 / IT-8; R-itin-21/22/25/32) — the SELF-CONTAINED
 * partner-button surface both the add form (T-7.6) and booking detail
 * (T-7.9) mount. Consumers hand it `{ tripId, surface, input }` (+ the
 * trip's `destination_name` for the §2.7 location fallbacks) and nothing
 * else; the panel owns:
 *
 *  - URL construction via the pure §2.7 builders (url-builders.ts);
 *  - button ENABLEMENT (R-itin-21): ready → enabled, missing fields →
 *    visible-but-disabled with a "Needs …" hint, Eventbrite outside a US
 *    city → omitted;
 *  - the `adults` default = trip member count (R-itin-32, via the existing
 *    `useTripMembers` hook) + the inline per-search edit on the FORM
 *    surface (R-itin-32 scopes the edit to the add flow; the detail surface
 *    uses the default);
 *  - tap recording BEFORE `Linking.openURL` (R-itin-22, §2.8) — a failed
 *    open rolls the record back so a hop that never happened can't prompt;
 *  - the Trainline two-step URN flow (debounced lookup → results URL,
 *    degrade to the plain domain on lookup failure/no-match).
 *
 * testIDs per §2.9 grammar: `itinerary-item-new-button-search-{partner}` on
 * the form surface, `booking-detail-button-deeplink-{partner}` on detail;
 * the form adults field is `itinerary-item-new-input-adults`.
 *
 * Hook discipline: category-specific hooks (members for adults, Trainline
 * lookups) live in per-category SUBCOMPONENTS gated by rendering — never a
 * conditional hook call (mobile.md landmine).
 */
import type { BookingCategory } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import * as Linking from "expo-linking";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Button, ErrorBanner, Input } from "@/components";
import { useTripMembers } from "@/data/members";

import { clearDeeplinkOutRecord, recordDeeplinkOut } from "./return-prompt-store";
import { useTrainlineStationUrn } from "./trainline";
import {
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
  externalUrlHost,
  normalizeAdults,
  PARTNERS_BY_CATEGORY,
  TRAINLINE_HOME_URL,
  type CarRentalSearchFields,
  type DeeplinkBuild,
  type DeeplinkPartner,
  type DeeplinkPartnerId,
  type FlightSearchFields,
  type LodgingSearchFields,
} from "./url-builders";

// ---------------------------------------------------------------------------
// Public input types (the consumer seam)
// ---------------------------------------------------------------------------

/** Panel-level train fields — station TEXT; the panel resolves URNs (§2.7). */
export interface TrainSearchFields {
  originStation?: string;
  destinationStation?: string;
  /** ISO datetime of departure (`details.departs_at`). */
  outwardDate?: string;
}

export interface ExternalUrlFields {
  externalUrl?: string;
}

/**
 * Discriminated per-category field payloads. Categories with no v1 partners
 * (`moped_rental`, `restaurant` — §2.7 footnote) are accepted so consumers
 * can render the panel unconditionally; it renders nothing for them.
 */
export type DeeplinkSearchInput =
  | { category: "flight"; fields: FlightSearchFields }
  | { category: "lodging"; fields: LodgingSearchFields }
  | { category: "train"; fields: TrainSearchFields }
  | { category: "car_rental"; fields: CarRentalSearchFields }
  | { category: "activity"; fields: ExternalUrlFields }
  | { category: "other"; fields: ExternalUrlFields }
  | { category: "moped_rental" }
  | { category: "restaurant" };

/** Which screen mounts the panel — drives the §2.9 testID family. */
export type DeeplinkSurface = "form" | "detail";

export interface DeeplinkPanelProps {
  tripId: string;
  surface: DeeplinkSurface;
  input: DeeplinkSearchInput;
  /** `trips.destination_name` — the §2.7 lodging-location fallback + Eventbrite slug source. */
  destinationName?: string;
  /**
   * R-itin-29 (T-7.9): the trip's reads are failing at the transport layer.
   * Every partner button goes visibly disabled with an offline hint — a
   * partner hop needs the network as much as the API does, and an enabled
   * button that hands the user a browser tab which then fails to load is a
   * worse answer than saying so up front. Omitted ⇒ online (the T-7.8 shape).
   */
  offline?: boolean;
  /** Fires after the record is written AND the URL opened (analytics/consumer seam). */
  onUrlOpened?(partner: DeeplinkPartnerId, url: string): void;
}

/** §2.9: form buttons are `…-button-search-{partner}`, detail `…-button-deeplink-{partner}`. */
export function deeplinkButtonTestID(surface: DeeplinkSurface, partner: DeeplinkPartnerId): string {
  return surface === "form"
    ? `itinerary-item-new-button-search-${partner}`
    : `booking-detail-button-deeplink-${partner}`;
}

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

/** Builder verdicts plus the Trainline lookup's in-flight state. */
type PanelBuild = DeeplinkBuild | { status: "pending" };

const OPEN_ERROR_MESSAGE = "Couldn't open the link. Try again.";

/** R-itin-29's "offline hint" on a disabled deeplink-out button. */
export const DEEPLINK_OFFLINE_HINT = "You're offline — reconnect to search.";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    panel: { gap: t.space[3] },
    buttons: { gap: t.space[2] },
    partner: { gap: t.space[1] },
  }),
);

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

interface PartnerButtonProps {
  partner: DeeplinkPartner;
  build: PanelBuild;
  surface: DeeplinkSurface;
  category: BookingCategory;
  tripId: string;
  /** External-URL row shows "Open {host}" instead of "Search on …". */
  titleOverride?: string;
  /** Non-missing disabled states (Trainline lookup in flight). */
  hintOverride?: string;
  /** R-itin-29 — disables regardless of build status, with the offline hint. */
  offline?: boolean;
  onUrlOpened?(partner: DeeplinkPartnerId, url: string): void;
  onOpenError(message: string): void;
}

/**
 * One partner row: Button + disabled hint. The tap path is R-itin-22
 * verbatim — record `{ partner, category, tripId, timestamp }` FIRST, then
 * open externally; a rejected open clears the record (no phantom prompt)
 * and surfaces the panel's ErrorBanner.
 */
function PartnerButton({
  partner,
  build,
  surface,
  category,
  tripId,
  titleOverride,
  hintOverride,
  offline = false,
  onUrlOpened,
  onOpenError,
}: PartnerButtonProps) {
  const s = useStyles();
  // `omit` still wins over offline: Eventbrite outside a US city has no URL to
  // build at all (§2.7), so going offline must not materialize a button that
  // does not exist online.
  if (build.status === "omit") return null;

  const testID = deeplinkButtonTestID(surface, partner.id);
  // R-itin-29: offline disables the row whatever the builder said, and its
  // hint OUTRANKS the "Needs …" one — with no network, the missing field is
  // not the user's next problem.
  const ready = build.status === "ready" && !offline;
  const hint = offline
    ? DEEPLINK_OFFLINE_HINT
    : build.status === "missing"
      ? `Needs ${build.missing.join(", ")}`
      : build.status === "pending"
        ? (hintOverride ?? "Preparing…")
        : undefined;

  const openUrl = (url: string): void => {
    recordDeeplinkOut({ partner: partner.id, category, tripId, timestamp: Date.now() });
    Linking.openURL(url)
      .then(() => onUrlOpened?.(partner.id, url))
      .catch(() => {
        // The hop never happened — a lingering record would prompt "Did you
        // book it?" for nothing.
        clearDeeplinkOutRecord();
        onOpenError(OPEN_ERROR_MESSAGE);
      });
  };

  return (
    <View style={s.partner}>
      <Button
        title={titleOverride ?? `Search on ${partner.label}`}
        variant="secondary"
        disabled={!ready}
        onPress={() => {
          if (build.status === "ready") openUrl(build.url);
        }}
        testID={testID}
      />
      {hint !== undefined ? (
        <AppText role="caption" color="secondary" testID={`${testID}-hint`}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

/**
 * R-itin-32 state: default = the trip's LIVE member count (existing members
 * hook, read-only consumption), inline-editable per search. A cleared or
 * non-numeric edit falls back to the default; the effective value is
 * clamped to a positive integer for the URL.
 */
function useAdultsState(tripId: string): {
  adults: number;
  adultsText: string;
  setAdultsText(text: string): void;
} {
  const members = useTripMembers(tripId);
  const defaultAdults = members.data !== undefined ? members.data.items.length : 1;
  const [edited, setEdited] = useState<string | null>(null);
  const parsed = edited === null ? Number.NaN : Number.parseInt(edited, 10);
  const adults = normalizeAdults(Number.isFinite(parsed) ? parsed : defaultAdults);
  return {
    adults,
    adultsText: edited ?? String(defaultAdults),
    setAdultsText: setEdited,
  };
}

interface AdultsFieldProps {
  adultsText: string;
  onChangeText(text: string): void;
}

/** Form-surface inline adults edit (R-itin-32 scopes the edit to the add flow). */
function AdultsField({ adultsText, onChangeText }: AdultsFieldProps) {
  return (
    <Input
      label="Adults"
      value={adultsText}
      onChangeText={onChangeText}
      keyboardType="number-pad"
      helper="Defaults to your trip's member count"
      testID="itinerary-item-new-input-adults"
    />
  );
}

interface CategoryPanelProps<TFields> {
  tripId: string;
  surface: DeeplinkSurface;
  fields: TFields;
  destinationName?: string;
  /** R-itin-29 — forwarded verbatim to every PartnerButton. */
  offline?: boolean;
  onUrlOpened?(partner: DeeplinkPartnerId, url: string): void;
  onOpenError(message: string): void;
}

// ---------------------------------------------------------------------------
// Per-category subcomponents (hooks gated by rendering, not by conditionals)
// ---------------------------------------------------------------------------

function FlightPanel(props: CategoryPanelProps<FlightSearchFields>) {
  const s = useStyles();
  const { adults, adultsText, setAdultsText } = useAdultsState(props.tripId);
  const [kayak, skyscanner] = PARTNERS_BY_CATEGORY.flight;
  if (kayak === undefined || skyscanner === undefined) return null;
  const shared = {
    surface: props.surface,
    category: "flight" as const,
    tripId: props.tripId,
    offline: props.offline ?? false,
    ...(props.onUrlOpened !== undefined ? { onUrlOpened: props.onUrlOpened } : null),
    onOpenError: props.onOpenError,
  };
  return (
    <View style={s.buttons}>
      {props.surface === "form" ? (
        <AdultsField adultsText={adultsText} onChangeText={setAdultsText} />
      ) : null}
      <PartnerButton {...shared} partner={kayak} build={buildKayakFlightsUrl(props.fields)} />
      <PartnerButton
        {...shared}
        partner={skyscanner}
        build={buildSkyscannerUrl(props.fields, adults)}
      />
    </View>
  );
}

function LodgingPanel(props: CategoryPanelProps<LodgingSearchFields>) {
  const s = useStyles();
  const { adults, adultsText, setAdultsText } = useAdultsState(props.tripId);
  // §2.7: `location` = the place/address field, else `trips.destination_name`.
  const fields: LodgingSearchFields = {
    ...props.fields,
    ...(hasText(props.fields.location)
      ? null
      : hasText(props.destinationName)
        ? { location: props.destinationName }
        : null),
  };
  const builders: Partial<
    Record<DeeplinkPartnerId, (f: LodgingSearchFields, adults: number) => DeeplinkBuild>
  > = {
    airbnb: buildAirbnbUrl,
    booking: buildBookingComUrl,
    expedia: buildExpediaUrl,
    vrbo: buildVrboUrl,
  };
  return (
    <View style={s.buttons}>
      {props.surface === "form" ? (
        <AdultsField adultsText={adultsText} onChangeText={setAdultsText} />
      ) : null}
      {PARTNERS_BY_CATEGORY.lodging.map((partner) => {
        const build = builders[partner.id];
        if (build === undefined) return null;
        return (
          <PartnerButton
            key={partner.id}
            partner={partner}
            build={build(fields, adults)}
            surface={props.surface}
            category="lodging"
            tripId={props.tripId}
            offline={props.offline ?? false}
            {...(props.onUrlOpened !== undefined ? { onUrlOpened: props.onUrlOpened } : null)}
            onOpenError={props.onOpenError}
          />
        );
      })}
    </View>
  );
}

function TrainPanel(props: CategoryPanelProps<TrainSearchFields>) {
  const s = useStyles();
  const origin = useTrainlineStationUrn(props.fields.originStation);
  const destination = useTrainlineStationUrn(props.fields.destinationStation);
  const [trainline, omio, amtrak] = PARTNERS_BY_CATEGORY.train;
  if (trainline === undefined || omio === undefined || amtrak === undefined) return null;

  // §2.7 Trainline verdict ladder: missing text/date → disabled hint; lookup
  // failed or found nothing → DEGRADE to the plain domain (still a working
  // button, never an error state); both URNs in hand → the exact results URL;
  // otherwise the lookup is still in flight.
  const gaps: string[] = [];
  if (!hasText(props.fields.originStation)) gaps.push("origin station");
  if (!hasText(props.fields.destinationStation)) gaps.push("destination station");
  if (!hasText(props.fields.outwardDate)) gaps.push("departure time");

  let trainlineBuild: PanelBuild;
  if (gaps.length > 0) {
    trainlineBuild = { status: "missing", missing: gaps };
  } else if (
    origin.isError ||
    destination.isError ||
    (origin.isSuccess && origin.data === null) ||
    (destination.isSuccess && destination.data === null)
  ) {
    trainlineBuild = { status: "ready", url: TRAINLINE_HOME_URL };
  } else if (
    origin.isSuccess &&
    destination.isSuccess &&
    origin.data !== null &&
    destination.data !== null
  ) {
    trainlineBuild = buildTrainlineUrl({
      originUrn: origin.data,
      destinationUrn: destination.data,
      outwardDate: props.fields.outwardDate ?? "",
    });
  } else {
    trainlineBuild = { status: "pending" };
  }

  const shared = {
    surface: props.surface,
    category: "train" as const,
    tripId: props.tripId,
    offline: props.offline ?? false,
    ...(props.onUrlOpened !== undefined ? { onUrlOpened: props.onUrlOpened } : null),
    onOpenError: props.onOpenError,
  };
  return (
    <View style={s.buttons}>
      <PartnerButton
        {...shared}
        partner={trainline}
        build={trainlineBuild}
        hintOverride="Finding stations…"
      />
      <PartnerButton {...shared} partner={omio} build={buildOmioUrl()} />
      <PartnerButton {...shared} partner={amtrak} build={buildAmtrakUrl()} />
    </View>
  );
}

function CarRentalPanel(props: CategoryPanelProps<CarRentalSearchFields>) {
  const s = useStyles();
  const [kayakCars, turo] = PARTNERS_BY_CATEGORY.car_rental;
  if (kayakCars === undefined || turo === undefined) return null;
  const shared = {
    surface: props.surface,
    category: "car_rental" as const,
    tripId: props.tripId,
    offline: props.offline ?? false,
    ...(props.onUrlOpened !== undefined ? { onUrlOpened: props.onUrlOpened } : null),
    onOpenError: props.onOpenError,
  };
  return (
    <View style={s.buttons}>
      <PartnerButton {...shared} partner={kayakCars} build={buildKayakCarsUrl(props.fields)} />
      <PartnerButton {...shared} partner={turo} build={buildTuroUrl(props.fields)} />
    </View>
  );
}

function ExternalPanel(
  props: CategoryPanelProps<ExternalUrlFields> & { category: "activity" | "other" },
) {
  const s = useStyles();
  const partners = PARTNERS_BY_CATEGORY[props.category];
  const external = partners.find((p) => p.id === "external");
  const eventbrite = partners.find((p) => p.id === "eventbrite");
  const host = externalUrlHost(props.fields.externalUrl);
  const shared = {
    surface: props.surface,
    category: props.category,
    tripId: props.tripId,
    offline: props.offline ?? false,
    ...(props.onUrlOpened !== undefined ? { onUrlOpened: props.onUrlOpened } : null),
    onOpenError: props.onOpenError,
  };
  return (
    <View style={s.buttons}>
      {external !== undefined ? (
        <PartnerButton
          {...shared}
          partner={external}
          build={buildExternalUrl(props.fields.externalUrl)}
          {...(host !== null ? { titleOverride: `Open ${host}` } : null)}
        />
      ) : null}
      {eventbrite !== undefined ? (
        <PartnerButton
          {...shared}
          partner={eventbrite}
          build={buildEventbriteUrl(props.destinationName)}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function DeeplinkPanel({
  tripId,
  surface,
  input,
  destinationName,
  offline = false,
  onUrlOpened,
}: DeeplinkPanelProps) {
  const s = useStyles();
  const [openError, setOpenError] = useState<string | null>(null);

  // No v1 partners for these categories (§2.7 footnote) — render nothing.
  if (input.category === "moped_rental" || input.category === "restaurant") return null;

  const shared = {
    tripId,
    surface,
    offline,
    ...(destinationName !== undefined ? { destinationName } : null),
    ...(onUrlOpened !== undefined ? { onUrlOpened } : null),
    onOpenError: setOpenError,
  };

  return (
    <View style={s.panel}>
      {openError !== null ? (
        <ErrorBanner
          message={openError}
          onDismiss={() => setOpenError(null)}
          // §2.9 grammar: <screen>-<element>[-qualifier] — element "error",
          // qualifier "-deeplink" (R1 rename from the inverted `…-deeplink-error`).
          testID={`${surface === "form" ? "itinerary-item-new" : "booking-detail"}-error-deeplink`}
        />
      ) : null}
      {input.category === "flight" ? <FlightPanel {...shared} fields={input.fields} /> : null}
      {input.category === "lodging" ? <LodgingPanel {...shared} fields={input.fields} /> : null}
      {input.category === "train" ? <TrainPanel {...shared} fields={input.fields} /> : null}
      {input.category === "car_rental" ? (
        <CarRentalPanel {...shared} fields={input.fields} />
      ) : null}
      {input.category === "activity" || input.category === "other" ? (
        <ExternalPanel {...shared} fields={input.fields} category={input.category} />
      ) : null}
    </View>
  );
}
