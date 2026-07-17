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

  it("Android hardware back cancels — never confirms (R-ds-18)", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await renderWithTheme(dialog({ onConfirm, onCancel }));

    // fireEvent walks ancestors for the handler — `requestClose` fired from
    // inside the modal reaches Modal's onRequestClose (UNSAFE_getByType is
    // gone in RNTL 14; the Modal host carries no testID).
    await fireEvent(screen.getByTestId("dlg"), "requestClose");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirm and cancel are individually reachable a11y elements (R-ds-12/18)", async () => {
    await renderWithTheme(dialog());

    // The card Pressable must NOT be an a11y element itself: RN 0.86 Pressable
    // defaults accessible:true, which flattens the whole card into ONE iOS
    // VoiceOver element (children unreachable). RNTL doesn't simulate that
    // flattening, so the non-element status is asserted via the host prop —
    // this line fails if the accessible={false} fix is reverted.
    expect(screen.getByTestId("dlg").props.accessible).toBe(false);

    // Both actions stay individually reachable, role-button a11y elements.
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    const ids = buttons.map((b) => b.props.testID);
    expect(ids).toEqual(expect.arrayContaining(["dlg-confirm", "dlg-cancel"]));
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
