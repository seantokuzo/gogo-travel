/**
 * Fixed status ramps — shared by every palette (spec §2.2 layer 1).
 * PURE DATA, generated at authoring time (OKLCH-derived from 100/500/700
 * seeds); status fg/bg pairings are validated by the R-ds-8 contrast matrix.
 */
import type { ColorRamp } from "./types.js";

export const successRamp: ColorRamp = {
  50: "#EDF9F3",
  100: "#D7F2E4",
  200: "#AEDEC5",
  300: "#85C9A7",
  400: "#58B589",
  500: "#16A06B",
  600: "#128D5D",
  700: "#0E7A4F",
  800: "#006842",
  900: "#005636",
  950: "#002C1A",
};

export const warningRamp: ColorRamp = {
  50: "#FEF7EB",
  100: "#FCEED3",
  200: "#F4D7AA",
  300: "#EDBF80",
  400: "#E8A654",
  500: "#E28B16",
  600: "#C17511",
  700: "#A05F0B",
  800: "#814A00",
  900: "#623700",
  950: "#331A00",
};

export const dangerRamp: ColorRamp = {
  50: "#FDF1F1",
  100: "#FBE1DF",
  200: "#F7BEB9",
  300: "#F19A92",
  400: "#E8756B",
  500: "#DC4B41",
  600: "#C23C33",
  700: "#A82E26",
  800: "#911C17",
  900: "#7A0506",
  950: "#410102",
};

export const infoRamp: ColorRamp = {
  50: "#EFF5FD",
  100: "#DCE9FB",
  200: "#B5CFF3",
  300: "#8EB6EA",
  400: "#669CE1",
  500: "#3B82D6",
  600: "#306DBF",
  700: "#2559A8",
  800: "#134692",
  900: "#00347C",
  950: "#001943",
};
