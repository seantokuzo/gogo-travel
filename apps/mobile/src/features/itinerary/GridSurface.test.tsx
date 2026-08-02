/**
 * GridSurface — placeholder-era pins ONLY. T-7.7 rewrites this suite with
 * the real grid (R-itin-13..17, R-itin-31 grid half). The one assertion
 * that must SURVIVE the rewrite: the root `itinerary-grid-surface` testID
 * (the screen test pins the seam, not the internals).
 */
import type { TripWithRole } from "@gogo/shared";
import { screen } from "@testing-library/react-native";

import { renderWithTheme } from "@/test-utils/render";

import { GridSurface } from "./GridSurface";

const trip = { id: "trip-1", role: "owner" } as TripWithRole;

const noopHandlers = {
  onAddAt: jest.fn(),
  onOpenBooking: jest.fn(),
  onOpenItem: jest.fn(),
};

describe("GridSurface (frozen W4 seam)", () => {
  it("renders the stable surface root and the T-7.4 placeholder content", async () => {
    await renderWithTheme(
      <GridSurface trip={trip} items={[]} bookingsById={new Map()} {...noopHandlers} />,
    );
    expect(screen.getByTestId("itinerary-grid-surface")).toBeTruthy();
    expect(screen.getByTestId("itinerary-grid-placeholder")).toBeTruthy();
    expect(screen.getByText("Calendar grid")).toBeTruthy();
  });
});
