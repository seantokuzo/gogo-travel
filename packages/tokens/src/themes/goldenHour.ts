/**
 * goldenHour — "Golden Hour" palette (DEFAULT theme). PURE DATA — zero logic (R-ds-5).
 *
 * Generated at authoring time from the approved seed table in
 * .specs/design-system/tokens.spec.md § Resolved (Gate 3). Seeds are exact;
 * in-between stops are OKLCH-interpolated; any derived value participating
 * in a contrast pairing was minimally adjusted to WCAG AA (see the R-ds-8
 * contrast matrix test — the validator for palette additions).
 */
import type { PaletteDef } from "../types.js";

export const goldenHour: PaletteDef = {
  name: "goldenHour",
  label: "Golden Hour",
  ramps: {
    neutral: {
      50: "#FBF6F0",
      100: "#EFEAE4",
      200: "#DFD9D3",
      300: "#C8C2BC",
      400: "#A9A29C",
      500: "#8B837D",
      600: "#6E6660",
      700: "#524A44",
      800: "#3C332D",
      900: "#2A211C",
      950: "#201915",
    },
    primary: {
      50: "#FDF2F0",
      100: "#FBE3DD",
      200: "#F8C5B9",
      300: "#F3A795",
      400: "#E67B65",
      500: "#D64933",
      600: "#BF3E2A",
      700: "#A83322",
      800: "#8A2A1A",
      900: "#6E2113",
      950: "#3A0D06",
    },
    accent: {
      50: "#FEF7EB",
      100: "#FDEED3",
      200: "#F7DCB1",
      300: "#F2CA8D",
      400: "#EDB768",
      500: "#E8A33D",
      600: "#C1842A",
      700: "#9C6716",
      800: "#774B00",
      900: "#523300",
      950: "#2A1800",
    },
  },
  semantics: {
    light: {
      bg: {
        screen: "#FBF6F0",
        surface: "#FFFFFF",
        surfaceRaised: "#FFFFFF",
        inset: "#EFEAE4",
        scrim: "#20191566",
      },
      text: {
        primary: "#2A211C",
        secondary: "#6E6660",
        muted: "#706862",
        inverse: "#FBF6F0",
        onPrimary: "#FFFFFF",
        onAccent: "#2A211C",
        accent: "#BD3D29",
      },
      border: {
        subtle: "#DFD9D3",
        default: "#C8C2BC",
        strong: "#8B837D",
        focus: "#BF3E2A",
      },
      primary: {
        solid: "#BF3E2A",
        solidPressed: "#A83322",
        subtleBg: "#FDF2F0",
        subtleBorder: "#F8C5B9",
        onSolid: "#FFFFFF",
      },
      accent: {
        solid: "#E8A33D",
        solidPressed: "#C1842A",
        subtleBg: "#FEF7EB",
        subtleBorder: "#F7DCB1",
        onSolid: "#2A211C",
      },
      status: {
        success: {
          fg: "#0E7A4F",
          bg: "#EDF9F3",
          border: "#AEDEC5",
        },
        warning: {
          fg: "#A05F0B",
          bg: "#FEF7EB",
          border: "#F4D7AA",
        },
        danger: {
          fg: "#A82E26",
          bg: "#FDF1F1",
          border: "#F7BEB9",
        },
        info: {
          fg: "#2559A8",
          bg: "#EFF5FD",
          border: "#B5CFF3",
        },
      },
      interactive: {
        pressedOverlay: "#20191514",
        disabledBg: "#DFD9D3",
        disabledText: "#A9A29C",
      },
    },
    dark: {
      bg: {
        screen: "#201915",
        surface: "#2B221D",
        surfaceRaised: "#372E28",
        inset: "#342A25",
        scrim: "#00000099",
      },
      text: {
        primary: "#F4EBE3",
        secondary: "#B9B0A9",
        muted: "#9E958F",
        inverse: "#201915",
        onPrimary: "#201915",
        onAccent: "#201915",
        accent: "#EC7E5E",
      },
      border: {
        subtle: "#433A34",
        default: "#524943",
        strong: "#7E756E",
        focus: "#E96A50",
      },
      primary: {
        solid: "#E96A50",
        solidPressed: "#EC7C5C",
        subtleBg: "#E96A5029",
        subtleBorder: "#E96A504D",
        onSolid: "#201915",
      },
      accent: {
        solid: "#EFB35B",
        solidPressed: "#F1B96F",
        subtleBg: "#EFB35B29",
        subtleBorder: "#EFB35B4D",
        onSolid: "#201915",
      },
      status: {
        success: {
          fg: "#85C9A7",
          bg: "#002C1A",
          border: "#006842",
        },
        warning: {
          fg: "#EDBF80",
          bg: "#331A00",
          border: "#814A00",
        },
        danger: {
          fg: "#F19A92",
          bg: "#410102",
          border: "#911C17",
        },
        info: {
          fg: "#8EB6EA",
          bg: "#001943",
          border: "#134692",
        },
      },
      interactive: {
        pressedOverlay: "#FFFFFF14",
        disabledBg: "#403631",
        disabledText: "#716863",
      },
    },
  },
};
