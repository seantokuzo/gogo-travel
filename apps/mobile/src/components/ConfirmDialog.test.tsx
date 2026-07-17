/**
 * ConfirmDialog — R-ds-18: onConfirm fires ONLY on the explicit confirm
 * button. Scrim and cancel are cancel paths. Children derive
 * `{testID}-confirm` / `{testID}-cancel`.
 */
import { fireEvent, screen } from "@testing-library/react-native";
import type { ComponentProps } from "react";

import { ConfirmDialog } from "@/components";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

function dialog(overrides: Partial<ComponentProps<typeof ConfirmDialog>> = {}) {
  return (
    <ConfirmDialog
      visible
      title="Delete photo?"
      body="Removes it for everyone."
      confirmLabel="Delete"
      destructive
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
      testID="dlg"
      {...overrides}
    />
  );
}

describe("ConfirmDialog", () => {
  it("renders nothing when not visible", async () => {
    await renderWithTheme(dialog({ visible: false }));
    expect(screen.queryByTestId("dlg")).toBeNull();
  });

  it("fires onConfirm only from the explicit confirm button (R-ds-18)", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await renderWithTheme(dialog({ onConfirm, onCancel }));

    // Neither rendering, nor cancel, nor scrim taps confirm anything.
    await fireEvent.press(screen.getByTestId("dlg-cancel"));
    await fireEvent.press(screen.getByTestId("dlg-scrim"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(2);

    await fireEvent.press(screen.getByTestId("dlg-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("derives child testIDs and labels from props", async () => {
    await renderWithTheme(dialog({ cancelLabel: "Keep it" }));
    expect(screen.getByTestId("dlg-confirm")).toHaveTextContent("Delete");
    expect(screen.getByTestId("dlg-cancel")).toHaveTextContent("Keep it");
    expect(screen.getByText("Delete photo?")).toBeOnTheScreen();
    expect(screen.getByText("Removes it for everyone.")).toBeOnTheScreen();
  });

  it("destructive=true styles confirm as the danger pair; plain uses primary", async () => {
    await renderWithTheme(dialog());
    expect(screen.getByTestId("dlg-confirm")).toHaveStyle({
      backgroundColor: lightTheme.color.status.danger.bg,
    });

    await renderWithTheme(dialog({ destructive: false, testID: "plain" }));
    expect(screen.getByTestId("plain-confirm")).toHaveStyle({
      backgroundColor: lightTheme.color.primary.solid,
    });
  });
});
