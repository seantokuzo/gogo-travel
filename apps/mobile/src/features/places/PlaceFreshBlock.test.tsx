/**
 * Fresh-block pins (T-8.4 / MAP-3 — R-map-9/10, R-places-17).
 * The block is render-only; `null` renders NOTHING (absence is silent), and
 * whenever it renders, the Foursquare attribution rides along.
 */
import type { FreshPlaceDetails } from "@gogo/shared";
import { screen } from "@testing-library/react-native";

import { renderWithTheme } from "@/test-utils/render";

import { freshFieldRows, PlaceFreshBlock } from "./PlaceFreshBlock";

const FRESH: FreshPlaceDetails = {
  fetched_at: "2026-08-18T00:00:00.000Z",
  attribution: {
    text: "Powered by Foursquare",
    logo_required: false,
    url: "https://foursquare.com",
  },
  fields: {
    hours: "Mon–Fri 9:00–17:00",
    open_now: false,
    rating: 8.7,
    price_level: 3,
    website: "https://example.com",
    phone: "+81 75-000-0000",
    tips: [{ text: "Go at dawn", created_at: "2026-08-01T00:00:00.000Z" }],
  },
};

it("renders NOTHING for null (R-map-10 — dormant seam, offline, error, no FSQ id: all silent)", async () => {
  await renderWithTheme(<PlaceFreshBlock fresh={null} />);
  expect(screen.queryByTestId("place-detail-fresh")).toBeNull();
});

it("renders the field rows, tips, and the REQUIRED Foursquare attribution (R-places-17)", async () => {
  await renderWithTheme(<PlaceFreshBlock fresh={FRESH} />);
  expect(screen.getByTestId("place-detail-fresh")).toBeTruthy();
  expect(screen.getByTestId("place-detail-fresh-field-hours")).toHaveTextContent(
    /Mon–Fri 9:00–17:00/,
  );
  expect(screen.getByTestId("place-detail-fresh-field-open-now")).toHaveTextContent(/Closed/);
  expect(screen.getByTestId("place-detail-fresh-field-rating")).toHaveTextContent(/8\.7 \/ 10/);
  expect(screen.getByTestId("place-detail-fresh-field-price-level")).toHaveTextContent(/\$\$\$/);
  expect(screen.getByTestId("place-detail-fresh-tip-0")).toHaveTextContent(/Go at dawn/);
  expect(screen.getByTestId("place-detail-fresh-attribution")).toHaveTextContent(
    /Powered by Foursquare/,
  );
});

it("freshFieldRows maps only present fields, in display order", () => {
  expect(freshFieldRows(FRESH).map((row) => row.key)).toEqual([
    "hours",
    "open-now",
    "rating",
    "price-level",
    "website",
    "phone",
  ]);
  // CONTROL: an empty fields object yields no rows — the block would render
  // just the attribution, and absence of a field is never an error.
  expect(freshFieldRows({ ...FRESH, fields: {} })).toEqual([]);
  expect(freshFieldRows({ ...FRESH, fields: { open_now: true } }).map((row) => row.value)).toEqual([
    "Open",
  ]);
});
