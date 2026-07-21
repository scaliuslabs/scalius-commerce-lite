export const HEADER_LOGO_WIDTH_MIN = 80;
export const HEADER_LOGO_WIDTH_MAX = 240;
export const HEADER_LOGO_WIDTH_DEFAULT = 180;
export const HEADER_LOGO_WIDTH_STEP = 10;
export const HEADER_LOGO_MOBILE_WIDTH_MAX = 160;

export function normalizeHeaderLogoWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return HEADER_LOGO_WIDTH_DEFAULT;
  }

  const stepped = Math.round(value / HEADER_LOGO_WIDTH_STEP) * HEADER_LOGO_WIDTH_STEP;
  return Math.min(HEADER_LOGO_WIDTH_MAX, Math.max(HEADER_LOGO_WIDTH_MIN, stepped));
}

export function getMobileHeaderLogoWidth(value: unknown): number {
  return Math.min(normalizeHeaderLogoWidth(value), HEADER_LOGO_MOBILE_WIDTH_MAX);
}
