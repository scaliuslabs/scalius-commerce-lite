const STOREFRONT_THEME_COLOR_KEYS = new Set([
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
]);

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION_RE =
  /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lch|lab)\(\s*[-+0-9.%\s,/]+\)$/i;
const STYLE_BREAKOUT_CHARS = new Set([";", "{", "}", "<", ">", "\\"]);
const UNSAFE_TOKEN_RE = /(?:\/\*|\*\/|@import|expression\s*\(|url\s*\(|javascript\s*:)/i;
const NAMED_COLORS = new Set(["transparent", "currentcolor", "black", "white"]);

export function isStorefrontThemeColorKey(key: string): boolean {
  return STOREFRONT_THEME_COLOR_KEYS.has(key);
}

export function isSafeStorefrontThemeColorValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) return false;
  if (hasControlOrStyleBreakoutChar(normalized)) return false;
  if (UNSAFE_TOKEN_RE.test(normalized)) return false;
  if (HEX_COLOR_RE.test(normalized)) return true;
  if (COLOR_FUNCTION_RE.test(normalized)) return true;
  if (NAMED_COLORS.has(normalized.toLowerCase())) return true;
  return isSafeStorefrontThemeVariableReference(normalized);
}

export function sanitizeStorefrontThemeColors(
  colors: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  if (!colors || typeof colors !== "object") return sanitized;

  for (const [key, value] of Object.entries(colors)) {
    if (!isStorefrontThemeColorKey(key)) continue;
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!isSafeStorefrontThemeColorValue(normalized)) continue;
    sanitized[key] = normalized;
  }

  return sanitized;
}

export function listInvalidStorefrontThemeColorEntries(
  colors: Record<string, unknown> | null | undefined,
): string[] {
  if (!colors || typeof colors !== "object") return [];

  const invalid: string[] = [];
  for (const [key, value] of Object.entries(colors)) {
    if (!isStorefrontThemeColorKey(key)) {
      invalid.push(key);
      continue;
    }
    if (typeof value !== "string" || !isSafeStorefrontThemeColorValue(value)) {
      invalid.push(key);
    }
  }
  return invalid;
}

function isSafeStorefrontThemeVariableReference(value: string): boolean {
  const match = /^var\(--([a-z0-9-]+)\)$/i.exec(value);
  return Boolean(match?.[1] && STOREFRONT_THEME_COLOR_KEYS.has(match[1]));
}

function hasControlOrStyleBreakoutChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127 || STYLE_BREAKOUT_CHARS.has(char)) {
      return true;
    }
  }
  return false;
}
