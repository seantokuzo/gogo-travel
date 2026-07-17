/**
 * TabNav — spec-fixed `tab-bar-{key}` testIDs, selected a11y state,
 * `selection` haptic on ACTUAL switches only (§2.8), badges.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { TabNav } from "@/components";
import type { TabNavItem } from "@/components";
import { triggerHaptic } from "@/theme/haptics";
import { renderWithTheme } from "@/test-utils/render";

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
