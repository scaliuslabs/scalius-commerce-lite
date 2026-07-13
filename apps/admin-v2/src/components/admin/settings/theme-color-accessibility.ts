import { isSafeStorefrontThemeColorValue } from "@scalius/shared/storefront-theme";

export interface ThemeColorPairStatus {
  ratio: number | null;
  passes: boolean | null;
}

export function getThemeColorPairStatus(
  foreground: string,
  background: string,
): ThemeColorPairStatus {
  const foregroundLuminance = parseRelativeLuminance(foreground);
  const backgroundLuminance = parseRelativeLuminance(background);

  if (foregroundLuminance === null || backgroundLuminance === null) {
    return { ratio: null, passes: null };
  }

  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  const ratio = (lighter + 0.05) / (darker + 0.05);

  return {
    ratio: Math.round(ratio * 10) / 10,
    passes: ratio >= 4.5,
  };
}

export function getThemeColorError(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  return isSafeStorefrontThemeColorValue(normalized)
    ? null
    : "Use a supported CSS color value.";
}

export function getThemeColorPickerHex(value: string): string | null {
  const normalized = value.trim();
  const shorthand = /^#([\da-f])([\da-f])([\da-f])$/i.exec(normalized);
  if (shorthand) {
    return `#${shorthand[1]}${shorthand[1]}${shorthand[2]}${shorthand[2]}${shorthand[3]}${shorthand[3]}`.toLowerCase();
  }
  if (/^#[\da-f]{6}$/i.test(normalized)) return normalized.toLowerCase();

  const linear = parseOklchLinearRgb(normalized);
  if (!linear) return null;
  return `#${linear.map((channel) =>
    Math.round(toSrgbChannel(channel) * 255).toString(16).padStart(2, "0")
  ).join("")}`;
}

function parseRelativeLuminance(value: string): number | null {
  const normalized = value.trim();
  const shorthand = /^#([\da-f])([\da-f])([\da-f])$/i.exec(normalized);
  if (shorthand) {
    return relativeLuminance([
      Number.parseInt(`${shorthand[1]!}${shorthand[1]!}`, 16),
      Number.parseInt(`${shorthand[2]!}${shorthand[2]!}`, 16),
      Number.parseInt(`${shorthand[3]!}${shorthand[3]!}`, 16),
    ]);
  }

  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(normalized);
  if (full) {
    return relativeLuminance([
      Number.parseInt(full[1]!, 16),
      Number.parseInt(full[2]!, 16),
      Number.parseInt(full[3]!, 16),
    ]);
  }

  const linear = parseOklchLinearRgb(normalized);
  if (!linear) return null;
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function parseOklchLinearRgb(value: string): [number, number, number] | null {
  const oklch = /^oklch\(\s*([\d.]+)(%)?\s+([\d.]+)\s+([-+\d.]+)\s*\)$/i.exec(value);
  if (!oklch) return null;
  const lightness = Number.parseFloat(oklch[1]!) / (oklch[2] ? 100 : 1);
  const chroma = Number.parseFloat(oklch[3]!);
  const hue = (Number.parseFloat(oklch[4]!) * Math.PI) / 180;
  if (![lightness, chroma, hue].every(Number.isFinite)) return null;

  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const red = clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return [red, green, blue];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function relativeLuminance(rgb: [number, number, number]): number {
  const red = toLinearChannel(rgb[0]);
  const green = toLinearChannel(rgb[1]);
  const blue = toLinearChannel(rgb[2]);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function toLinearChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function toSrgbChannel(channel: number): number {
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055;
}
