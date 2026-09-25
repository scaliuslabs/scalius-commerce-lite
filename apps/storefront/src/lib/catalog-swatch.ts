// Colour swatches for facet values: shared by the server-rendered filter
// form and the rows "See more" adds in the browser (so it stays tiny).
import type { ProductFacetValue } from "@/lib/api";

/**
 * Colour words merchants use as values, with the swatch they paint. An
 * option axis shows swatches only when every value is one of them, so a
 * swatch never guesses: "Rose Gold" or a Bangla name keeps the checkbox list.
 * A typed swatch attribute paints from the merchant's colour and falls back
 * to this table only for a value without one.
 */
const SWATCH_COLOURS: Record<string, string> = {
  black: "#111111",
  white: "#ffffff",
  "off white": "#f4f1e8",
  cream: "#f3e9d2",
  ivory: "#fffff0",
  beige: "#d9c7a7",
  grey: "#8a8a8a",
  gray: "#8a8a8a",
  silver: "#c0c0c0",
  gold: "#c9a227",
  red: "#c62828",
  maroon: "#6d1a1f",
  pink: "#e88fb0",
  orange: "#ef7d22",
  yellow: "#f2c511",
  green: "#2e7d32",
  olive: "#6b6b2a",
  teal: "#0f7c7c",
  blue: "#1e5bc6",
  "sky blue": "#79b8e8",
  navy: "#1b2a4a",
  purple: "#6a3fa0",
  brown: "#6f4a2f",
  multicolor: "conic-gradient(#c62828, #f2c511, #2e7d32, #1e5bc6, #6a3fa0, #c62828)",
  multicolour: "conic-gradient(#c62828, #f2c511, #2e7d32, #1e5bc6, #6a3fa0, #c62828)",
};

const colourKey = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** A merchant swatch lands in a `style` attribute: only a plain hex colour paints. */
const HEX_SWATCH = /^#[0-9a-f]{6}$/i;

export type FacetDisplayValue = Pick<ProductFacetValue, "value" | "label" | "swatch">;

/** The paint of a swatch value: the merchant's hex, else a known colour word, else none. */
export const catalogSwatchPaint = ({ value, label, swatch }: FacetDisplayValue): string | undefined =>
  (swatch && HEX_SWATCH.test(swatch) ? swatch : undefined) ??
  SWATCH_COLOURS[colourKey(label)] ??
  SWATCH_COLOURS[colourKey(value)];
