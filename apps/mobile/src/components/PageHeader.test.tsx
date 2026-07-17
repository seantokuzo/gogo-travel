/**
 * PageHeader — header role on the title, back auto-wires the router, max 2
 * trailing actions, each with its own required testID.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { PageHeader } from "@/components";
import { renderWithTheme } from "@/test-utils/render";

jest.mock("expo-router", () => {
  const back = jest.fn();
  return { useRouter: () => ({ back }), __back: back };
});

const { __back: mockBack } = jest.requireMock("expo-router") as { __back: jest.Mock };

describe("PageHeader", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders title (header role) and subtitle", async () => {
    await renderWithTheme(<PageHeader title="Trip" subtitle="Jul 20 – Aug 2" />);
    const title = screen.getByText("Trip");
    expect(title.props.accessibilityRole).toBe("header");
    expect(screen.getByText("Jul 20 – Aug 2")).toBeOnTheScreen();
  });

  it("leading='back' wires router.back with an accessible 44pt control", async () => {
    await renderWithTheme(<PageHeader title="Trip" leading="back" testID="hdr" />);
    const back = screen.getByTestId("hdr-back");
    expect(back.props.accessibilityRole).toBe("button");
    expect(back.props.accessibilityLabel).toBe("Back");
    await fireEvent.press(back);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("has NO default testID — screens must pass their own (nav §2.7 grammar)", async () => {
    await renderWithTheme(<PageHeader title="Trip" leading="back" />);
    // The removed "page-header" fallback must not resurface, and the derived
    // back id must not degrade to "undefined-back".
    expect(screen.queryByTestId("page-header")).toBeNull();
    expect(screen.queryByTestId("page-header-back")).toBeNull();
    expect(screen.queryByTestId("undefined-back")).toBeNull();
    expect(screen.getByLabelText("Back")).toBeOnTheScreen();
  });

  it("renders trailing actions and fires their handlers", async () => {
    const onAdd = jest.fn();
    await renderWithTheme(
      <PageHeader
        title="Trip"
        trailing={[{ icon: "add", label: "Add stop", onPress: onAdd, testID: "hdr-add" }]}
      />,
    );
    const action = screen.getByTestId("hdr-add");
    expect(action.props.accessibilityLabel).toBe("Add stop");
    await fireEvent.press(action);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("caps trailing actions at 2 (spec §2.9)", async () => {
    const noop = () => undefined;
    await renderWithTheme(
      <PageHeader
        title="Trip"
        trailing={[
          { icon: "add", label: "One", onPress: noop, testID: "a1" },
          { icon: "search", label: "Two", onPress: noop, testID: "a2" },
          { icon: "close", label: "Three", onPress: noop, testID: "a3" },
        ]}
      />,
    );
    expect(screen.getByTestId("a1")).toBeOnTheScreen();
    expect(screen.getByTestId("a2")).toBeOnTheScreen();
    expect(screen.queryByTestId("a3")).toBeNull();
  });
});
