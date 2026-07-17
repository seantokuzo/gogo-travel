/**
 * TabNav — spec-fixed `tab-bar-{key}` testIDs, selected a11y state,
 * `selection` haptic on ACTUAL switches only (§2.8), badges.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { fireEvent, screen, within } from "@testing-library/react-native";

import { TabNav } from "@/components";
import type { TabNavItem } from "@/components";
import { triggerHaptic } from "@/theme/haptics";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
const mockTriggerHaptic = triggerHaptic as jest.Mock;

const items: TabNavItem[] = [
  { key: "today", label: "Today", icon: "sunny-outline" },
  { key: "itinerary", label: "Itinerary", icon: "calendar-outline", badge: 3 },
  { key: "budget", label: "Budget", icon: "wallet-outline", badge: "dot" },
];

describe("TabNav", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders every item as a tab with the spec-fixed testID scheme", async () => {
    await renderWithTheme(
      <TabNav items={items} activeKey="today" onSelect={() => undefined} testID="tabs" />,
    );
    for (const { key, label } of items) {
      const tab = screen.getByTestId(`tab-bar-${key}`);
      expect(tab.props.accessibilityRole).toBe("tab");
      expect(tab.props.accessibilityLabel).toBe(label);
    }
    expect(screen.getByTestId("tab-bar-today").props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(screen.getByTestId("tab-bar-budget").props.accessibilityState).toMatchObject({
      selected: false,
    });
  });

  it("tints active label + icon primary.solid, inactive text.muted (DECIDED 2026-07-17)", async () => {
    await renderWithTheme(<TabNav items={items} activeKey="today" onSelect={() => undefined} />);

    expect(screen.getByText("Today")).toHaveStyle({ color: lightTheme.color.primary.solid });
    expect(screen.getByText("Itinerary")).toHaveStyle({ color: lightTheme.color.text.muted });

    // Ionicons renders its glyph as a Text carrying the color style — the only
    // ByType-free way to reach the icon in RNTL 14. Mirrors the icon set's own
    // glyph resolution (numeric codepoint or literal string).
    const glyph = (name: keyof typeof Ionicons.glyphMap) => {
      const value = Ionicons.glyphMap[name];
      return typeof value === "number" ? String.fromCodePoint(value) : value;
    };
    expect(
      within(screen.getByTestId("tab-bar-today")).getByText(glyph("sunny-outline")),
    ).toHaveStyle({ color: lightTheme.color.primary.solid });
    expect(
      within(screen.getByTestId("tab-bar-budget")).getByText(glyph("wallet-outline")),
    ).toHaveStyle({ color: lightTheme.color.text.muted });
  });

  it("selecting another tab fires onSelect + selection haptic", async () => {
    const onSelect = jest.fn();
    await renderWithTheme(<TabNav items={items} activeKey="today" onSelect={onSelect} />);
    await fireEvent.press(screen.getByTestId("tab-bar-budget"));
    expect(onSelect).toHaveBeenCalledWith("budget");
    expect(mockTriggerHaptic).toHaveBeenCalledWith("selection");
  });

  it("re-tapping the active tab is a no-op — no navigation, no haptic (§2.8)", async () => {
    const onSelect = jest.fn();
    await renderWithTheme(<TabNav items={items} activeKey="today" onSelect={onSelect} />);
    await fireEvent.press(screen.getByTestId("tab-bar-today"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(mockTriggerHaptic).not.toHaveBeenCalled();
  });

  it("renders count badges (99+ capped) and dot indicators", async () => {
    await renderWithTheme(
      <TabNav
        items={[...items, { key: "photos", label: "Photos", icon: "images-outline", badge: 120 }]}
        activeKey="today"
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByTestId("tab-bar-itinerary-badge")).toHaveTextContent("3");
    expect(screen.getByTestId("tab-bar-photos-badge")).toHaveTextContent("99+");
    expect(screen.getByTestId("tab-bar-budget-dot")).toBeOnTheScreen();
    expect(screen.queryByTestId("tab-bar-today-badge")).toBeNull();
  });
});
