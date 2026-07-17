/**
 * midnightExpress — "Midnight Express" palette. PURE DATA — zero logic (R-ds-5).
 *
 * Generated at authoring time from the approved seed table in
 * .specs/design-system/tokens.spec.md § Resolved (Gate 3). Seeds are exact;
 * in-between stops are OKLCH-interpolated; any derived value participating
 * in a contrast pairing was minimally adjusted to WCAG AA (see the R-ds-8
 * contrast matrix test — the validator for palette additions). Recipe,
 * interpolation params + full adjustment report: scripts/derive-ramps.mjs.
 */
import type { PaletteDef } from "../types.js";

export const midnightExpress: PaletteDef = {
  name: "midnightExpress",
  label: "Midnight Express",
  ramps: {
    neutral: {
      50: "#F7F4EC",
      100: "#EDE8E0",
      200: "#DFD7CF",
      300: "#CBBFB8",
      400: "#AF9E9C",
      500: "#927F84",
      600: "#73636E",
      700: "#524859",
      800: "#363447",
      900: "#1F2437",
      950: "#131729",
    },
    primary: {
      50: "#F0F2F9",
      100: "#DEE3F2",
      200: "#B8C3E0",
      300: "#93A3CE",
      400: "#5C6D99",
      500: "#2B3A67",
      600: "#25325A",
      700: "#1F2B4E",
      800: "#192340",
      900: "#131B33",
      950: "#060A18",
    },
    accent: {
      50: "#FAF4E9",
      100: "#F3E7CD",
      200: "#E8D4AD",
      300: "#DDC18E",
      400: "#D3AD6D",
      500: "#C9994B",
      600: "#A97F37",
      700: "#8A6524",
      800: "#6D4C09",
      900: "#503500",
      950: "#291900",
    },
  },
  semantics: {
    light: {
      bg: {
        screen: "#F7F4EC",
        surface: "#FFFFFF",
        surfaceRaised: "#FFFFFF",
        inset: "#EDE8E0",
        scrim: "#13172966",
      },
      text: {
        primary: "#1F2437",
        secondary: "#73636E",
        muted: "#756470",
        inverse: "#F7F4EC",
        onPrimary: "#FFFFFF",
        onAccent: "#1F2437",
        accent: "#25325A",
      },
      border: {
        subtle: "#DFD7CF",
        default: "#CBBFB8",
        strong: "#927F84",
        focus: "#25325A",
      },
      primary: {
        solid: "#25325A",
        solidPressed: "#1F2B4E",
        subtleBg: "#F0F2F9",
        subtleBorder: "#B8C3E0",
        onSolid: "#FFFFFF",
      },
      accent: {
        solid: "#C9994B",
        solidPressed: "#AF843B",
        subtleBg: "#FAF4E9",
        subtleBorder: "#E8D4AD",
        onSolid: "#1F2437",
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
        pressedOverlay: "#13172914",
        disabledBg: "#DFD7CF",
        disabledText: "#AF9E9C",
      },
    },
    dark: {
      bg: {
        screen: "#131729",
        surface: "#1C2138",
        surfaceRaised: "#282D44",
        inset: "#252A40",
        scrim: "#00000099",
      },
      text: {
        primary: "#EDEEF5",
        secondary: "#B0B2BD",
        muted: "#9294A2",
        inverse: "#131729",
        onPrimary: "#000000",
        onAccent: "#131729",
        accent: "#929FCF",
      },
      border: {
        subtle: "#353A50",
        default: "#44485E",
        strong: "#727688",
        focus: "#5D74B8",
      },
      primary: {
        solid: "#5D74B8",
        solidPressed: "#6E82C0",
        subtleBg: "#5D74B829",
        subtleBorder: "#5D74B84D",
        onSolid: "#000000",
      },
      accent: {
        solid: "#D4A95C",
        solidPressed: "#E5AA77",
        subtleBg: "#D4A95C29",
        subtleBorder: "#D4A95C4D",
        onSolid: "#131729",
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
        disabledBg: "#31364C",
        disabledText: "#656878",
      },
    },
  },
};
