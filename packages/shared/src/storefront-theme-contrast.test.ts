import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME_COLORS,
  STOREFRONT_THEME_COLOR_PALETTES,
} from "./storefront-theme";

/** sRGB channel (0–1) from a `#rrggbb` or `oklch(L C H)` preset value. */
function toSrgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/.*)?\)$/i.exec(value.trim());
  if (!oklch) throw new Error(`Unsupported preset colour: ${value}`);
  const [l, c, h] = oklch.slice(1).map(Number) as [number, number, number];
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((channel) => Math.min(1, Math.max(0, channel)));
  return linear.map((channel) =>
    channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055,
  ) as [number, number, number];
}

function luminance(value: string): number {
  const [r, g, b] = toSrgb(value).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Text/background token pairs the storefront renders (WCAG 1.4.3 AA: 4.5:1). */
const TEXT_PAIRS: Array<[string, string]> = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["primary", "background"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "card"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["destructive", "background"],
];

describe("storefront theme presets", () => {
  it.each(Object.entries(STOREFRONT_THEME_COLOR_PALETTES))(
    "%s keeps every text pair at WCAG AA contrast",
    (_name, palette) => {
      const colors = { ...DEFAULT_STOREFRONT_THEME_COLORS, ...palette.colors };
      const failures = TEXT_PAIRS
        .map(([text, surface]) => ({
          pair: `${text} on ${surface}`,
          ratio: Number(contrast(colors[text]!, colors[surface]!).toFixed(2)),
        }))
        .filter(({ ratio }) => ratio < 4.5);
      expect(failures).toEqual([]);
    },
  );
});
