# S-2 Research: Booking Deeplinks + Capture + Affiliate Landscape

> Evidence layer for P-2 booking specs. Researched 2026-07-09; 5 research
> agents + 3 adversarial verifiers — 21/21 load-bearing claims confirmed.

## 2026 headline shifts (all HIGH, verified 3/3)

1. **Amadeus Self-Service APIs are DEAD** — all keys deactivate 2026-07-17.
   Never build on it.
2. **TripIt public API closed** to new integrations — no piggybacking.
3. **Booking.com purged small affiliates** ("Bookinggeddon" 2025); new signups
   via CJ only, website required, session-based attribution (monetizes app
   deeplink-outs poorly).
4. **Kiwi.com Tequila closed** to new signups (invite-only).

## The universal indie pattern

**Deeplink-out with affiliate params + capture via forwarded email /
share-sheet.** Real booking APIs are either instant-approve (Viator,
Ticketmaster, Tiqets, Duffel) or permanently out of reach. One Travelpayouts
account covers Omio + 12Go + Rail Europe + DiscoverCars + BikesBooking in one
dashboard.

## One-page verdict

| Category | v1 (zero approvals) | v2 (monetize/deepen) |
|----------|--------------------|-----------------------|
| Flights | Kayak + Skyscanner deeplinks | Kayak affiliate, Travelpayouts; Duffel Links if in-app booking becomes a goal ($3/order + 1%) |
| Lodging | Airbnb/Booking/Expedia/Vrbo deeplinks | Expedia Travel Creator Program (open signup, 4% hotels/2% Vrbo, covers 3 brands), Trip.com (7%), Agoda |
| Trains | Trainline (open URN lookup API + deeplink), Omio links, plain Amtrak link (no API, SPA, no prefill) | Partnerize (Trainline) + Travelpayouts (Omio 6%, 12Go 50% rev — SE Asia trains/buses/ferries) |
| Cars/mopeds | Kayak cars + Turo deeplinks; manual moped entry | **DiscoverCars (70% of rental profit, 365-day cookie — best terms in report)**, BikesBooking (mopeds, 4%), Klook |
| Activities | **Viator Basic API + Ticketmaster Discovery API DAY ONE** (both instant-approve, real APIs) | Tiqets API (no minimums), GetYourGuide links (API needs 100k monthly visits), Viator Full Access |
| Import | Forward-address + share-sheet → schema.org-then-LLM pipeline | AwardWallet parsing API (contact-sales), OAuth inbox sync post-traction |

## Key deeplink formats

- **Kayak flights:** `kayak.com/flights/{ORIG}-{DEST}/{YYYY-MM-DD}[/{RET}]`
  (+`?fs=stops=0`); **cars:** `kayak.com/cars/{loc}/{date}/{date}` (verified).
- **Skyscanner (officially documented):**
  `skyscanner.net/transport/flights/{orig}/{dest}/{yymmdd}/[{yymmdd}/]` +
  `adultsv2`, `cabinclass`, `preferDirects`.
- **Google Flights:** unofficial NL query param only — can break; don't depend.
- **Airbnb:** `airbnb.com/s/{location}/homes?checkin=…&checkout=…&adults=N`
  (app honoring params after universal-link: UNTESTED — device-verify).
- **Booking:** `booking.com/searchresults.html?ss={q}&checkin=…&checkout=…&group_adults=N`
- **Expedia:** `expedia.com/Hotel-Search?destination=…&startDate=…&endDate=…&adults=N` (official docs)
- **Vrbo:** `vrbo.com/search?destination=…&startDate=…&endDate=…&adults=N`
- **Trainline:** station URNs via open
  `thetrainline.com/api/locations-search/v2/search?searchTerm=…` (verified
  live) → `/book/results?origin={urn}&destination={urn}&outwardDate=…`
- **Turo:** `turo.com/us/en/search?location=…&startDate=MM/DD/YYYY&…`
- **Eventbrite:** browse-only `eventbrite.com/d/{state--city}/events/`
  (discovery API dead since 2020).
- **Viator affiliate:** any viator.com URL + `?pid={P00X}&mcid={id}&medium=link`.

## Email/share-sheet capture pipeline (v1, buildable solo)

1. **Dedicated forward address** via CloudMailin (free 10k emails/mo,
   verified) or SES ($0.09/1k) → webhook to Hono.
2. **Parse: schema.org JSON-LD first** (FlightReservation etc. — Gmail spec;
   airline adoption inconsistent; Booking/Agoda provably DON'T embed it — KDE
   kitinerary ships custom extractors for them, study it for prior art),
   **LLM fallback** (~$0.005/email Haiku-class — 10–20x cheaper than any
   commercial parser). Failures → visible "needs review" queue.
3. **Share-sheet:** `expo-share-intent` v8 (July 2026, SDK 57, config plugin,
   dev client required) for PDFs/text/URLs. Reality: Apple Mail shares PDFs in
   3 taps; **Gmail iOS app can't share email bodies at all** → both paths
   needed regardless.
4. Donate parsed reservations to Siri/Calendar for free OS surface (read is
   closed, write/donate is open).
5. **Skip OAuth inbox scanning at MVP**: Gmail restricted scopes → CASA
   assessment ≈ $500–4,500/yr compliance tax + 24h latency + privacy friction.
6. Disclose third-party LLM processing in the privacy policy.

## Escalations for Sean

- CloudMailin (free tier) or SES account for the forward address — needed at
  the booking-capture phase.
- Affiliate program signups (v2): Travelpayouts, Expedia Creator, Kayak,
  DiscoverCars, Viator (Viator worth day-one — instant API).
- Privacy-policy LLM disclosure requirement noted for launch readiness.
