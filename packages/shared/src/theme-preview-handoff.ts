export const THEME_PREVIEW_HANDOFF_READY =
  "scalius:theme-preview:ready:v1" as const;
export const THEME_PREVIEW_HANDOFF_TOKEN =
  "scalius:theme-preview:token:v1" as const;
export const THEME_PREVIEW_HANDOFF_ACCEPTED =
  "scalius:theme-preview:accepted:v1" as const;
export const THEME_PREVIEW_HANDOFF_FAILED =
  "scalius:theme-preview:failed:v1" as const;

export type ThemePreviewHandoffMessageType =
  | typeof THEME_PREVIEW_HANDOFF_READY
  | typeof THEME_PREVIEW_HANDOFF_TOKEN
  | typeof THEME_PREVIEW_HANDOFF_ACCEPTED
  | typeof THEME_PREVIEW_HANDOFF_FAILED;

export function isThemePreviewToken(value: unknown): value is string {
  return typeof value === "string" && /^tpv_[A-Za-z0-9_-]{40,80}$/.test(value);
}

export function isThemePreviewHandoffMessage(
  value: unknown,
  type: ThemePreviewHandoffMessageType,
): value is { type: ThemePreviewHandoffMessageType; token?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === type
  );
}
