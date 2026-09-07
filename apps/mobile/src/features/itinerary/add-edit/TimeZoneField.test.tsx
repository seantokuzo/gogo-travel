/**
 * Zone picker (B-9) — the always-visible field that shows what a wall time
 * is about to be stamped with.
 *
 * Two properties are load-bearing and neither is cosmetic: the label is
 * CITY-first (a bare offset can't tell Athens from Cairo in July, and
 * picking by offset re-introduces the uniform-offset corruption class), and
 * an unknown zone reads as explicitly UNSET rather than silently defaulting.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { renderWithTheme } from "@/test-utils/render";

import { TimeZoneField, zoneFieldLabel } from "./TimeZoneField";
import { referenceInstantFor } from "./zoned-time";

const TEST_ID = "itinerary-item-new-input-departs-at-tz";

async function renderField(overrides: Partial<React.ComponentProps<typeof TimeZoneField>> = {}) {
  const onSelect = jest.fn();
  await renderWithTheme(
    <TimeZoneField
      label="Departs time zone"
      value=""
      onSelect={onSelect}
      referenceDate="2027-07-04"
      testID={TEST_ID}
      {...overrides}
    />,
  );
  return { onSelect };
}

describe("zoneFieldLabel", () => {
  it("is CITY — GMT±N, never a bare offset", () => {
    expect(zoneFieldLabel("Asia/Tokyo", referenceInstantFor("2027-04-24"))).toBe("Tokyo — GMT+9");
    expect(zoneFieldLabel("Europe/Athens", referenceInstantFor("2027-07-04"))).toBe(
      "Athens — GMT+3",
    );
    // Same zone, winter: the label follows the reference date.
    expect(zoneFieldLabel("Europe/Athens", referenceInstantFor("2027-01-04"))).toBe(
      "Athens — GMT+2",
    );
    expect(zoneFieldLabel("UTC", referenceInstantFor("2027-04-24"))).toBe("UTC — GMT");
  });

  it("says UNSET rather than inventing a zone, and shows a stored-but-unresolvable id honestly", () => {
    expect(zoneFieldLabel("", Date.now())).toBe("Not set — choose a time zone");
    // A row stored with a zone this device's ICU can't resolve renders the
    // id itself — never a silent substitution the user can't see.
    expect(zoneFieldLabel("Mars/Olympus", Date.now())).toBe("Mars/Olympus");
  });
});

describe("the field", () => {
  it("renders its current zone and opens the search only on press", async () => {
    await renderField({ value: "Europe/Athens" });
    expect(screen.getByTestId(TEST_ID)).toHaveTextContent("Athens — GMT+3");
    expect(screen.queryByTestId(`${TEST_ID}-search`)).toBeNull();
    await fireEvent.press(screen.getByTestId(TEST_ID));
    expect(screen.getByTestId(`${TEST_ID}-search`)).toBeOnTheScreen();
  });

  it("searching then picking reports the IANA id and closes", async () => {
    const { onSelect } = await renderField();
    await fireEvent.press(screen.getByTestId(TEST_ID));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-search`), "kathmandu");
    const row = screen.getByTestId(`${TEST_ID}-result-asia-kathmandu`);
    // Sub-hour offsets are shown as such — "GMT+5:45", not a rounded hour.
    expect(row).toHaveTextContent(/Kathmandu — GMT\+5:45/);
    await fireEvent.press(row);
    expect(onSelect).toHaveBeenCalledWith("Asia/Kathmandu");
    expect(screen.queryByTestId(`${TEST_ID}-search`)).toBeNull();
  });

  it("a second press closes without selecting", async () => {
    const { onSelect } = await renderField({ value: "Asia/Tokyo" });
    await fireEvent.press(screen.getByTestId(TEST_ID));
    await fireEvent.press(screen.getByTestId(TEST_ID));
    expect(screen.queryByTestId(`${TEST_ID}-search`)).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("surfaces the save gate's error", async () => {
    await renderField({ error: "Pick the time zone for this time." });
    expect(screen.getByTestId(`${TEST_ID}-error`)).toHaveTextContent(
      "Pick the time zone for this time.",
    );
  });

  it("the accessibility label names the zone — a screen reader hears what is being stamped", async () => {
    await renderField({ value: "Asia/Tokyo", referenceDate: "2027-04-24" });
    expect(screen.getByTestId(TEST_ID).props.accessibilityLabel).toBe(
      "Departs time zone, Tokyo — GMT+9",
    );
  });
});
