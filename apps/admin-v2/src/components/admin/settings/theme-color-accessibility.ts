import { isSafeStorefrontThemeColorValue } from "@scalius/shared/storefront-theme";

export interface ThemeColorPairStatus {
  ratio: number | null;
  passes: boolean | null;
}

export function getThemeColorPairStatus(
  foreground: string,
  background: string,
): ThemeColorPairStatus {
  const foregroundRgb = parseOpaqueHex(foreground);
  const backgroundRgb = parseOpaqueHex(background);

  if (!foregroundRgb || !backgroundRgb) {
    return { ratio: null, passes: null };
  }

  const foregroundLuminance = relativeLuminance(foregroundRgb);
  const backgroundLuminance = relativeLuminance(backgroundRgb);
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

function parseOpaqueHex(value: string): [number, number, number] | null {
  const normalized = value.trim();
  const shorthand = /^#([\da-f])([\da-f])([\da-f])$/i.exec(normalized);
  if (shorthand) {
    return [
      Number.parseInt(`${shorthand[1]!}${shorthand[1]!}`, 16),
      Number.parseInt(`${shorthand[2]!}${shorthand[2]!}`, 16),
      Number.parseInt(`${shorthand[3]!}${shorthand[3]!}`, 16),
    ];
  }

  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(normalized);
  if (!full) return null;
  return [
    Number.parseInt(full[1]!, 16),
    Number.parseInt(full[2]!, 16),
    Number.parseInt(full[3]!, 16),
  ];
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
