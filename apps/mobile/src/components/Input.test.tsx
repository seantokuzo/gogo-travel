/**
 * Input — label ALWAYS visible; error replaces helper + danger border +
 * polite live region; testID lands on the TextInput (what E2E types into).
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { Input } from "@/components";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

describe("Input", () => {
  it("shows the label and forwards text changes", async () => {
    const onChangeText = jest.fn();
    await renderWithTheme(
      <Input label="Trip name" value="" onChangeText={onChangeText} testID="trip-name" />,
    );
    expect(screen.getByText("Trip name")).toBeOnTheScreen();
    const field = screen.getByTestId("trip-name");
    expect(field.props.accessibilityLabel).toBe("Trip name");
    await fireEvent.changeText(field, "Lisbon");
    expect(onChangeText).toHaveBeenCalledWith("Lisbon");
  });

  it("helper renders under the field when there is no error", async () => {
    await renderWithTheme(
      <Input
        label="Trip name"
        value=""
        onChangeText={() => undefined}
        helper="Shown on the trip card"
        testID="in"
      />,
    );
    expect(screen.getByText("Shown on the trip card")).toBeOnTheScreen();
    expect(screen.queryByTestId("in-error")).toBeNull();
  });

  it("error replaces helper, announces politely, and shows the message", async () => {
    await renderWithTheme(
      <Input
        label="Trip name"
        value=""
        onChangeText={() => undefined}
        helper="hidden while erroring"
        error="Trip name is required"
        testID="in"
      />,
    );
    const error = screen.getByTestId("in-error");
    expect(error).toHaveTextContent("Trip name is required");
    expect(error.props.accessibilityLiveRegion).toBe("polite");
    expect(screen.queryByText("hidden while erroring")).toBeNull();
  });

  it("passes through keyboard/secure/multiline props and muted placeholder color", async () => {
    await renderWithTheme(
      <Input
        label="Password"
        value=""
        onChangeText={() => undefined}
        placeholder="•••"
        secureTextEntry
        keyboardType="number-pad"
        returnKeyType="done"
        testID="in"
      />,
    );
    const field = screen.getByTestId("in");
    expect(field.props.secureTextEntry).toBe(true);
    expect(field.props.keyboardType).toBe("number-pad");
    expect(field.props.returnKeyType).toBe("done");
    expect(field.props.placeholderTextColor).toBe(lightTheme.color.text.muted);
  });
});
