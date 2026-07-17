/**
 * Badge — synced tone mapping (DECIDED 2026-07-17): accent = accent.subtleBg
 * + subtleBorder + text.accent ink; status tones use their trio.
 */
import { screen } from "@testing-library/react-native";

import { Badge } from "@/components";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

describe("Badge", () => {
  it("accent tone ('Up next' chip surface) uses the synced accent mapping", async () => {
    await renderWithTheme(<Badge label="Up next" tone="accent" testID="chip" />);
    expect(screen.getByTestId("chip")).toHaveStyle({
      backgroundColor: lightTheme.color.accent.subtleBg,
      borderColor: lightTheme.color.accent.subtleBorder,
    });
    expect(screen.getByText("Up next")).toHaveStyle({ color: lightTheme.color.text.accent });
  });

  it("status tones use their status trio", async () => {
    await renderWithTheme(<Badge label="Booked" tone="success" testID="b" />);
    expect(screen.getByTestId("b")).toHaveStyle({
      backgroundColor: lightTheme.color.status.success.bg,
      borderColor: lightTheme.color.status.success.border,
    });
    expect(screen.getByText("Booked")).toHaveStyle({ color: lightTheme.color.status.success.fg });
  });

  it("neutral (default) uses inset/border/secondary and the label role", async () => {
    await renderWithTheme(<Badge label="Idea" testID="b" />);
    expect(screen.getByTestId("b")).toHaveStyle({
      backgroundColor: lightTheme.color.bg.inset,
      borderRadius: lightTheme.radius.full,
    });
    expect(screen.getByText("Idea")).toHaveStyle({
      color: lightTheme.color.text.secondary,
      textTransform: "uppercase",
      fontSize: lightTheme.type.label.fontSize,
    });
  });
});
