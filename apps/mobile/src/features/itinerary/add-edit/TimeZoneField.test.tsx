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

import { searchTimeZones, timeZoneCatalog } from "./time-zone-catalog";
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

  it("B-26: the options are a SCROLLABLE virtualized list, not a capped inline map", async () => {
    // The device-QA defect (Sean: "when it opens I can't manually scroll the
    // options"): the picker rendered at most 12 `.map()`ed rows into a plain
    // `View` with no scroller of its own, so ~406 of the 418 zones could not
    // be reached by scrolling at ALL, and scrolling the page just moved the
    // form. Two things have to hold, and the second is the one that broke:
    await renderField();
    await fireEvent.press(screen.getByTestId(TEST_ID));

    const list = screen.getByTestId(`${TEST_ID}-list`);
    // (1) it SCROLLS: the host node the list renders to is the native
    //     scroll view, not a `View`. The old inline container matched
    //     "View" here, which is the whole defect in one assertion.
    expect(list.type).toBe("RCTScrollView");
    expect(list.props.scrollEnabled).not.toBe(false);
    // (2) it VIRTUALIZES: the windowing plumbing is present, so 418 rows do
    //     not all mount (the `.claude/rules/mobile.md` long-list rule).
    expect(typeof list.props.getItemCount).toBe("function");
    // (3) it is handed the WHOLE catalog, not a 12-row slice. The cap is
    //     exactly what made the rest unreachable, so the count is the pin.
    expect(list.props.data).toHaveLength(timeZoneCatalog().length);
    expect(list.props.getItemCount(list.props.data)).toBe(timeZoneCatalog().length);
    expect(timeZoneCatalog().length).toBeGreaterThan(300);
  });

  it("B-26: a zone far outside the old 12-row cap is reachable and picks", async () => {
    // Auckland sits hundreds of rows into the catalog. Under the old cap it
    // was unreachable without guessing a matching query, and unreachable by
    // scrolling in any case.
    const { onSelect } = await renderField();
    await fireEvent.press(screen.getByTestId(TEST_ID));
    const catalogIds = timeZoneCatalog().map((entry) => entry.id);
    expect(catalogIds.indexOf("Pacific/Auckland")).toBeGreaterThan(12);

    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-search`), "auckland");
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-result-pacific-auckland`));
    expect(onSelect).toHaveBeenCalledWith("Pacific/Auckland");
  });

  it("B-26: the list keeps taps through the keyboard, so the first tap PICKS", async () => {
    // Without `keyboardShouldPersistTaps: "handled"` the first tap on a row
    // only dismisses the keyboard — with the search input right above the
    // list that is every single pick (MapSearch precedent).
    await renderField();
    await fireEvent.press(screen.getByTestId(TEST_ID));
    expect(screen.getByTestId(`${TEST_ID}-list`).props.keyboardShouldPersistTaps).toBe("handled");
  });

  it("B-26: presents in the shared picker card, closable without selecting", async () => {
    // The list had to leave the screen's own scroller: a same-orientation
    // VirtualizedList nested in a plain ScrollView is RN's
    // "VirtualizedLists should never be nested" error.
    const { onSelect } = await renderField({ value: "Asia/Tokyo" });
    await fireEvent.press(screen.getByTestId(TEST_ID));
    expect(screen.getByTestId(`${TEST_ID}-sheet`)).toBeOnTheScreen();
    // A zone commits on the row tap — there is no displayed value to
    // confirm, so the card's B-15a Done affordance must NOT render.
    expect(screen.queryByTestId(`${TEST_ID}-sheet-done`)).toBeNull();

    await fireEvent.press(screen.getByTestId(`${TEST_ID}-sheet-close`));
    expect(screen.queryByTestId(`${TEST_ID}-search`)).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("B-26: a query that matches nothing says so instead of an empty box", async () => {
    await renderField();
    await fireEvent.press(screen.getByTestId(TEST_ID));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-search`), "zzzznotazone");
    expect(searchTimeZones("zzzznotazone")).toEqual([]);
    expect(screen.getByTestId(`${TEST_ID}-empty`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`${TEST_ID}-list`)).toBeNull();
  });

  it("B-26: reopening starts from a CLEAR query — a stale filter hides the catalog", async () => {
    await renderField();
    await fireEvent.press(screen.getByTestId(TEST_ID));
    await fireEvent.changeText(screen.getByTestId(`${TEST_ID}-search`), "auckland");
    await fireEvent.press(screen.getByTestId(`${TEST_ID}-sheet-close`));
    await fireEvent.press(screen.getByTestId(TEST_ID));
    expect(screen.getByTestId(`${TEST_ID}-search`).props.value).toBe("");
    expect(screen.getByTestId(`${TEST_ID}-list`).props.data).toHaveLength(timeZoneCatalog().length);
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
