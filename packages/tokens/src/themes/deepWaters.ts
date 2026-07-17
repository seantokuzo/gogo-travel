/**
 * deepWaters — "Deep Waters" palette. PURE DATA — zero logic (R-ds-5).
 *
 * Generated at authoring time from the approved seed table in
 * .specs/design-system/tokens.spec.md § Resolved (Gate 3). Seeds are exact;
 * in-between stops are OKLCH-interpolated; any derived value participating
 * in a contrast pairing was minimally adjusted to WCAG AA (see the R-ds-8
 * contrast matrix test — the validator for palette additions). Recipe,
 * interpolation params + full adjustment report: scripts/derive-ramps.mjs.
 */
import type { PaletteDef } from "../types.js";

export const deepWaters: PaletteDef = {
  name: "deepWaters",
  label: "Deep Waters",
  ramps: {
    neutral: {
      50: "#F4F7F7",
      100: "#E7EBEB",
      200: "#D6DBDB",
      300: "#BEC4C5",
      400: "#9CA5A6",
      500: "#7C8788",
      600: "#5D6A6C",
      700: "#404E51",
      800: "#29383B",
      900: "#16262A",
      950: "#0E1618",
    },
    primary: {
      50: "#EEF6F6",
      100: "#D9ECEC",
      200: "#ACD7D6",
      300: "#7CC2BF",
      400: "#4B9794",
      500: "#0E6E6B",
      600: "#0C5E5C",
      700: "#0A4F4D",
      800: "#08403E",
      900: "#063230",
      950: "#021716",
    },
    accent: {
      50: "#FEF5EC",
      100: "#FDE8D4",
      200: "#FAD2AF",
      300: "#F6BC8A",
      400: "#F2A465",
      500: "#EE8B3A",
      600: "#CA7228",
      700: "#A85A14",
      800: "#864300",
      900: "#633000",
      950: "#341600",
    },
  },
  semantics: {
    light: {
      bg: {
        screen: "#F4F7F7",
        surface: "#FFFFFF",
        surfaceRaised: "#FFFFFF",
        inset: "#E7EBEB",
        scrim: "#0E161866",
      },
      text: {
        primary: "#16262A",
        secondary: "#5D6A6C",
        muted: "#5F6C6E",
        inverse: "#F4F7F7",
        onPrimary: "#FFFFFF",
        onAccent: "#16262A",
        accent: "#0C5E5C",
      },
      border: {
        subtle: "#D6DBDB",
        default: "#BEC4C5",
        strong: "#7C8788",
        focus: "#0C5E5C",
      },
      primary: {
        solid: "#0C5E5C",
        solidPressed: "#0A4F4D",
        subtleBg: "#EEF6F6",
        subtleBorder: "#ACD7D6",
        onSolid: "#FFFFFF",
      },
      accent: {
        solid: "#EE8B3A",
        solidPressed: "#CC7329",
        subtleBg: "#FEF5EC",
        subtleBorder: "#FAD2AF",
        onSolid: "#16262A",
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
        pressedOverlay: "#0E161814",
        disabledBg: "#D6DBDB",
        disabledText: "#9CA5A6",
      },
    },
    dark: {
      bg: {
        screen: "#0E1618",
        surface: "#162226",
        surfaceRaised: "#222E32",
        inset: "#1F2B2E",
        scrim: "#00000099",
      },
      text: {
        primary: "#E9F1F1",
        secondary: "#ABB4B4",
        muted: "#8D9697",
        inverse: "#0E1618",
        onPrimary: "#0E1618",
        onAccent: "#0E1618",
        accent: "#4AAFA9",
      },
      border: {
        subtle: "#2F3B3E",
        default: "#3E4A4D",
        strong: "#6C7779",
        focus: "#2FA8A0",
      },
      primary: {
        solid: "#2FA8A0",
        solidPressed: "#4FB1AA",
        subtleBg: "#2FA8A029",
        subtleBorder: "#2FA8A04D",
        onSolid: "#0E1618",
      },
      accent: {
        solid: "#F2A45E",
        solidPressed: "#E7B567",
        subtleBg: "#F2A45E29",
        subtleBorder: "#F2A45E4D",
        onSolid: "#0E1618",
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
        disabledBg: "#2B373B",
        disabledText: "#60686A",
      },
    },
  },
};
