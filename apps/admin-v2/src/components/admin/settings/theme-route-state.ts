export const THEME_WORKSPACE_SECTIONS = [
  {
    value: "system",
    label: "Design system",
    description: "Type, shape, spacing, and component treatment",
  },
  {
    value: "colors",
    label: "Colors",
    description: "Palettes, semantic pairs, and contrast",
  },
  {
    value: "review",
    label: "Review & publish",
    description: "Draft changes, coverage, and live route checks",
  },
] as const;

export type ThemeWorkspaceSection =
  (typeof THEME_WORKSPACE_SECTIONS)[number]["value"];

export const THEME_PREVIEW_DEVICES = ["full", "desktop", "mobile"] as const;
export type ThemePreviewDevice = (typeof THEME_PREVIEW_DEVICES)[number];

export function normalizeThemePreviewDevice(value: unknown): ThemePreviewDevice {
  return THEME_PREVIEW_DEVICES.includes(value as ThemePreviewDevice)
    ? (value as ThemePreviewDevice)
    : "desktop";
}

export function normalizeThemePreviewPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  if (path.includes("\\") || path.includes("?") || path.includes("#")) return "/";
  if (/%2f|%5c/i.test(path)) return "/";
  if (path === "/" || path === "/search") return path;

  const segments = path.slice(1).split("/");
  const safeSegment = (segment: string) =>
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment);
  if (
    segments.length === 2 &&
    ["products", "categories", "collections"].includes(segments[0] ?? "") &&
    safeSegment(segments[1] ?? "")
  ) {
    return path;
  }

  const reserved = new Set([
    "admin",
    "api",
    "cart",
    "checkout",
    "login",
    "orders",
    "payment-recovery",
    "products",
    "categories",
    "collections",
    "search",
    "theme-preview",
  ]);
  if (
    segments.length === 1 &&
    safeSegment(segments[0] ?? "") &&
    !reserved.has(segments[0] ?? "")
  ) {
    return path;
  }

  return "/";
}

export function normalizeThemeWorkspaceSection(
  value: unknown,
): ThemeWorkspaceSection {
  return THEME_WORKSPACE_SECTIONS.some((section) => section.value === value)
    ? (value as ThemeWorkspaceSection)
    : "system";
}
