/**
 * DeeplinkPanel pins (T-7.8 / IT-8; R-itin-21/22/25/32 + §2.9 testIDs):
 * per-partner buttons build their exact §2.7 URLs and disable (with the
 * missing-field hint) otherwise; adults defaults to the LIVE member count
 * and the inline edit flows into the constructed URL; every tap records
 * the return-prompt state BEFORE the external open (a failed open rolls it
 * back); the Trainline two-step flow resolves URNs or degrades to the
 * plain domain; Eventbrite omits outside US cities; no-partner categories
 * render nothing.
 *
 * Members are SEEDED into the test cache (deterministic adults default);
 * the apiClient spy answers the mount refetch with the same rows, so no
 * assertion ever races the query. RNTL v14: every render/fireEvent awaited.
 */
import { memberEndpoints, type MemberList } from "@gogo/shared";
import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as Linking from "expo-linking";

import { apiClient } from "@/auth";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";

import { DeeplinkPanel } from "./DeeplinkPanel";
import { clearDeeplinkOutRecord, readDeeplinkOutRecord } from "./return-prompt-store";

jest.mock("expo-linking", () => ({
  openURL: jest.fn(async () => true),
}));

const openURLMock = Linking.openURL as jest.Mock;

/** Three live members — the R-itin-32 default the suite pins. */
const MEMBER_LIST = { items: [{}, {}, {}] } as unknown as MemberList;

/** Seeded client + a spy answering the mount refetch with the same rows. */
function makeMembersClient(): QueryClient {
  const client = makeTestQueryClient();
  client.setQueryData(queryKeys.tripMembers(TEST_TRIP_ID), MEMBER_LIST);
  (jest.spyOn(apiClient, "request") as unknown as jest.Mock).mockImplementation(
    (descriptor: unknown) => {
      if (descriptor === memberEndpoints.listMembers) return Promise.resolve(MEMBER_LIST);
      return Promise.reject(new Error("unexpected request in DeeplinkPanel suite"));
    },
  );
  return client;
}

const LODGING_INPUT = {
  category: "lodging",
  fields: { location: "Tokyo, Japan", checkIn: "2026-09-10", checkOut: "2026-09-14" },
} as const;

afterEach(() => {
  clearDeeplinkOutRecord();
  jest.restoreAllMocks();
  openURLMock.mockClear();
  openURLMock.mockImplementation(async () => true);
});

describe("lodging — form surface", () => {
  it("renders all four partners; a tap records BEFORE opening the exact §2.7 URL with adults defaulted to the member count", async () => {
    let recordAtOpen: unknown = null;
    openURLMock.mockImplementation(async () => {
      recordAtOpen = readDeeplinkOutRecord();
      return true;
    });

    await renderWithProviders(
      <DeeplinkPanel tripId={TEST_TRIP_ID} surface="form" input={LODGING_INPUT} />,
      { queryClient: makeMembersClient() },
    );

    for (const partner of ["airbnb", "booking", "expedia", "vrbo"]) {
      expect(screen.getByTestId(`itinerary-item-new-button-search-${partner}`)).toBeOnTheScreen();
    }
    expect(screen.getByTestId("itinerary-item-new-input-adults").props.value).toBe("3");

    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-airbnb"));
    await waitFor(() => expect(openURLMock).toHaveBeenCalledTimes(1));
    expect(openURLMock).toHaveBeenCalledWith(
      "https://www.airbnb.com/s/Tokyo%2C%20Japan/homes?checkin=2026-09-10&checkout=2026-09-14&adults=3",
    );
    // R-itin-22: the record was already persisted when the URL opened.
    expect(recordAtOpen).toEqual({
      partner: "airbnb",
      category: "lodging",
      tripId: TEST_TRIP_ID,
      timestamp: expect.any(Number),
    });
    expect(readDeeplinkOutRecord()).not.toBeNull();
  });

  it("inline adults edit flows into the constructed URL (R-itin-32)", async () => {
    await renderWithProviders(
      <DeeplinkPanel tripId={TEST_TRIP_ID} surface="form" input={LODGING_INPUT} />,
      { queryClient: makeMembersClient() },
    );
    await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-adults"), "5");
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-booking"));
    await waitFor(() => expect(openURLMock).toHaveBeenCalledTimes(1));
    expect(openURLMock).toHaveBeenCalledWith(
      "https://www.booking.com/searchresults.html?ss=Tokyo%2C%20Japan&checkin=2026-09-10&checkout=2026-09-14&group_adults=5",
    );
  });

  it("missing fields disable the buttons with the hint; a press never opens (R-itin-21)", async () => {
    await renderWithProviders(
      <DeeplinkPanel
        tripId={TEST_TRIP_ID}
        surface="form"
        input={{ category: "lodging", fields: { location: "Tokyo" } }}
      />,
      { queryClient: makeMembersClient() },
    );
    const airbnb = screen.getByTestId("itinerary-item-new-button-search-airbnb");
    expect(airbnb).toBeDisabled();
    expect(screen.getByTestId("itinerary-item-new-button-search-airbnb-hint")).toHaveTextContent(
      "Needs check-in date, check-out date",
    );
    await fireEvent.press(airbnb);
    expect(openURLMock).not.toHaveBeenCalled();
    expect(readDeeplinkOutRecord()).toBeNull();
  });

  it("empty location falls back to the trip destination (§2.7 location rule)", async () => {
    await renderWithProviders(
      <DeeplinkPanel
        tripId={TEST_TRIP_ID}
        surface="form"
        destinationName="Kyoto, Japan"
        input={{ category: "lodging", fields: { checkIn: "2026-09-10", checkOut: "2026-09-14" } }}
      />,
      { queryClient: makeMembersClient() },
    );
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-vrbo"));
    await waitFor(() => expect(openURLMock).toHaveBeenCalledTimes(1));
    expect(openURLMock).toHaveBeenCalledWith(
      "https://www.vrbo.com/search?destination=Kyoto%2C%20Japan&startDate=2026-09-10&endDate=2026-09-14&adults=3",
    );
  });

  it("a failed open rolls the record back and surfaces the panel ErrorBanner", async () => {
    openURLMock.mockImplementation(async () => {
      throw new Error("no handler");
    });
    await renderWithProviders(
      <DeeplinkPanel tripId={TEST_TRIP_ID} surface="form" input={LODGING_INPUT} />,
      { queryClient: makeMembersClient() },
    );
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-airbnb"));
    await waitFor(() =>
      expect(screen.getByTestId("itinerary-item-new-deeplink-error")).toBeOnTheScreen(),
    );
    // No phantom "Did you book it?" for a hop that never happened.
    expect(readDeeplinkOutRecord()).toBeNull();
  });
});

describe("detail surface (R-itin-25)", () => {
  it("uses the booking-detail testID family and hides the adults edit (R-itin-32 is add-flow)", async () => {
    await renderWithProviders(
      <DeeplinkPanel tripId={TEST_TRIP_ID} surface="detail" input={LODGING_INPUT} />,
      { queryClient: makeMembersClient() },
    );
    expect(screen.getByTestId("booking-detail-button-deeplink-airbnb")).toBeOnTheScreen();
    expect(screen.queryByTestId("itinerary-item-new-button-search-airbnb")).toBeNull();
    expect(screen.queryByTestId("itinerary-item-new-input-adults")).toBeNull();
    // Construction + recording rules are the same — member-count default applies.
    await fireEvent.press(screen.getByTestId("booking-detail-button-deeplink-airbnb"));
    await waitFor(() =>
      expect(openURLMock).toHaveBeenCalledWith(
        "https://www.airbnb.com/s/Tokyo%2C%20Japan/homes?checkin=2026-09-10&checkout=2026-09-14&adults=3",
      ),
    );
    expect(readDeeplinkOutRecord()).toEqual({
      partner: "airbnb",
      category: "lodging",
      tripId: TEST_TRIP_ID,
      timestamp: expect.any(Number),
    });
  });
});

describe("flight", () => {
  it("Kayak needs no adults; Skyscanner carries the member-count default", async () => {
    await renderWithProviders(
      <DeeplinkPanel
        tripId={TEST_TRIP_ID}
        surface="form"
        input={{
          category: "flight",
          fields: { originIata: "SFO", destinationIata: "NRT", departDate: "2026-09-10" },
        }}
      />,
      { queryClient: makeMembersClient() },
    );
    expect(screen.getByTestId("itinerary-item-new-input-adults").props.value).toBe("3");
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-kayak"));
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-skyscanner"));
    await waitFor(() => expect(openURLMock).toHaveBeenCalledTimes(2));
    expect(openURLMock).toHaveBeenNthCalledWith(
      1,
      "https://www.kayak.com/flights/SFO-NRT/2026-09-10",
    );
    expect(openURLMock).toHaveBeenNthCalledWith(
      2,
      "https://www.skyscanner.net/transport/flights/sfo/nrt/260910/?adultsv2=3&cabinclass=economy&preferDirects=false",
    );
  });
});

describe("activity / other / no-partner categories", () => {
  it("external URL renders 'Open {host}'; Eventbrite omits for non-US destinations", async () => {
    await renderWithProviders(
      <DeeplinkPanel
        tripId={TEST_TRIP_ID}
        surface="form"
        destinationName="Tokyo, Japan"
        input={{ category: "activity", fields: { externalUrl: "https://www.getyourguide.com/x" } }}
      />,
    );
    const external = screen.getByTestId("itinerary-item-new-button-search-external");
    expect(external).toHaveTextContent("Open getyourguide.com");
    expect(screen.queryByTestId("itinerary-item-new-button-search-eventbrite")).toBeNull();
    await fireEvent.press(external);
    await waitFor(() => expect(openURLMock).toHaveBeenCalledWith("https://www.getyourguide.com/x"));
  });

  it("Eventbrite appears for a US city destination with the exact browse URL", async () => {
    await renderWithProviders(
      <DeeplinkPanel
        tripId={TEST_TRIP_ID}
        surface="form"
        destinationName="Austin, TX"
        input={{ category: "activity", fields: {} }}
      />,
    );
    // External URL button is present-but-disabled (no URL yet) — R-itin-21.
    expect(screen.getByTestId("itinerary-item-new-button-search-external")).toBeDisabled();
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-eventbrite"));
    await waitFor(() =>
      expect(openURLMock).toHaveBeenCalledWith("https://www.eventbrite.com/d/tx--austin/events/"),
    );
  });

  it("moped_rental and restaurant render no buttons (§2.7 footnote: manual entry v1)", async () => {
    await renderWithProviders(
      <DeeplinkPanel tripId={TEST_TRIP_ID} surface="form" input={{ category: "moped_rental" }} />,
    );
    expect(screen.toJSON()).toBeNull();
    await renderWithProviders(
      <DeeplinkPanel tripId={TEST_TRIP_ID} surface="form" input={{ category: "restaurant" }} />,
    );
    expect(screen.toJSON()).toBeNull();
  });
});

describe("train — Trainline two-step URN flow (§2.7)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const TRAIN_INPUT = {
    category: "train",
    fields: {
      originStation: "London Euston",
      destinationStation: "Manchester Piccadilly",
      outwardDate: "2026-09-10T09:00:00",
    },
  } as const;

  it("resolves URNs (debounced lookups) and opens the exact results URL; Omio/Amtrak are plain links", async () => {
    const urnByTerm: Record<string, string> = {
      "London Euston": "urn:trainline:generic:loc:182gb",
      "Manchester Piccadilly": "urn:trainline:generic:loc:1745gb",
    };
    globalThis.fetch = jest.fn(async (url: unknown) => {
      const term = decodeURIComponent(String(url).split("searchTerm=")[1] ?? "");
      const urn = urnByTerm[term];
      return {
        ok: true,
        status: 200,
        json: async () => ({ searchLocations: urn !== undefined ? [{ urn }] : [] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await renderWithProviders(
      <DeeplinkPanel tripId={TEST_TRIP_ID} surface="form" input={TRAIN_INPUT} />,
    );
    // In-flight lookup: disabled with the pending hint, not an error.
    expect(screen.getByTestId("itinerary-item-new-button-search-trainline")).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByTestId("itinerary-item-new-button-search-trainline")).not.toBeDisabled(),
    );

    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-trainline"));
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-omio"));
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-amtrak"));
    await waitFor(() => expect(openURLMock).toHaveBeenCalledTimes(3));
    expect(openURLMock).toHaveBeenNthCalledWith(
      1,
      "https://www.thetrainline.com/book/results?origin=urn%3Atrainline%3Ageneric%3Aloc%3A182gb&destination=urn%3Atrainline%3Ageneric%3Aloc%3A1745gb&outwardDate=2026-09-10T09%3A00%3A00",
    );
    expect(openURLMock).toHaveBeenNthCalledWith(2, "https://www.omio.com/");
    expect(openURLMock).toHaveBeenNthCalledWith(3, "https://www.amtrak.com/");
  });

  it("degrades to the plain domain when the lookup fails (§2.7 failure arm)", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await renderWithProviders(
      <DeeplinkPanel tripId={TEST_TRIP_ID} surface="form" input={TRAIN_INPUT} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("itinerary-item-new-button-search-trainline")).not.toBeDisabled(),
    );
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-search-trainline"));
    await waitFor(() => expect(openURLMock).toHaveBeenCalledWith("https://www.thetrainline.com/"));
  });

  it("missing station text/date disables with the hint before any lookup", async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch;
    await renderWithProviders(
      <DeeplinkPanel
        tripId={TEST_TRIP_ID}
        surface="form"
        input={{ category: "train", fields: { originStation: "London Euston" } }}
      />,
    );
    expect(screen.getByTestId("itinerary-item-new-button-search-trainline")).toBeDisabled();
    expect(screen.getByTestId("itinerary-item-new-button-search-trainline-hint")).toHaveTextContent(
      "Needs destination station, departure time",
    );
  });
});
