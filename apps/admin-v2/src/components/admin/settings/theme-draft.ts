import {
  sanitizeStorefrontThemeSettings,
  type StorefrontThemeSettings,
} from "@scalius/shared/storefront-theme";

export function normalizeThemeColors(
  colors: Record<string, string>,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(colors)) {
    const trimmed = value.trim();
    if (trimmed) normalized[key] = trimmed;
  }

  return normalized;
}

export function themeColorRecordsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const normalizedLeft = normalizeThemeColors(left);
  const normalizedRight = normalizeThemeColors(right);
  const keys = new Set([
    ...Object.keys(normalizedLeft),
    ...Object.keys(normalizedRight),
  ]);

  for (const key of keys) {
    if (normalizedLeft[key] !== normalizedRight[key]) return false;
  }

  return true;
}

/**
 * Replays only this tab's changes on top of the latest published document.
 * Keys changed by the other editor are preserved unless this tab also changed
 * that exact key. Clearing an override remains an explicit local change.
 */
export function rebaseThemeColorDraft({
  base,
  local,
  latest,
}: {
  base: Record<string, string>;
  local: Record<string, string>;
  latest: Record<string, string>;
}): Record<string, string> {
  const normalizedBase = normalizeThemeColors(base);
  const normalizedLocal = normalizeThemeColors(local);
  const rebased = { ...normalizeThemeColors(latest) };
  const localKeys = new Set([
    ...Object.keys(normalizedBase),
    ...Object.keys(normalizedLocal),
  ]);

  for (const key of localKeys) {
    if (normalizedBase[key] === normalizedLocal[key]) continue;

    if (normalizedLocal[key] === undefined) {
      delete rebased[key];
    } else {
      rebased[key] = normalizedLocal[key];
    }
  }

  return rebased;
}

export function normalizeThemeSettingsDraft(
  theme: StorefrontThemeSettings,
): StorefrontThemeSettings {
  return sanitizeStorefrontThemeSettings({
    ...theme,
    colors: normalizeThemeColors(theme.colors),
  });
}

export function themeSettingsDraftsEqual(
  left: StorefrontThemeSettings,
  right: StorefrontThemeSettings,
): boolean {
  return JSON.stringify(normalizeThemeSettingsDraft(left)) ===
    JSON.stringify(normalizeThemeSettingsDraft(right));
}

/** Replays only locally changed semantic leaves onto the latest revision. */
export function rebaseThemeSettingsDraft({
  base,
  local,
  latest,
}: {
  base: StorefrontThemeSettings;
  local: StorefrontThemeSettings;
  latest: StorefrontThemeSettings;
}): StorefrontThemeSettings {
  const normalizedBase = normalizeThemeSettingsDraft(base);
  const normalizedLocal = normalizeThemeSettingsDraft(local);
  const normalizedLatest = normalizeThemeSettingsDraft(latest);

  return normalizeThemeSettingsDraft({
    colors: rebaseThemeColorDraft({
      base: normalizedBase.colors,
      local: normalizedLocal.colors,
      latest: normalizedLatest.colors,
    }),
    typography: {
      heading: changed(normalizedBase.typography.heading, normalizedLocal.typography.heading)
        ? normalizedLocal.typography.heading
        : normalizedLatest.typography.heading,
      body: changed(normalizedBase.typography.body, normalizedLocal.typography.body)
        ? normalizedLocal.typography.body
        : normalizedLatest.typography.body,
      scale: changed(normalizedBase.typography.scale, normalizedLocal.typography.scale)
        ? normalizedLocal.typography.scale
        : normalizedLatest.typography.scale,
    },
    cornerStyle: changed(normalizedBase.cornerStyle, normalizedLocal.cornerStyle)
      ? normalizedLocal.cornerStyle
      : normalizedLatest.cornerStyle,
    density: changed(normalizedBase.density, normalizedLocal.density)
      ? normalizedLocal.density
      : normalizedLatest.density,
    containerWidth: changed(normalizedBase.containerWidth, normalizedLocal.containerWidth)
      ? normalizedLocal.containerWidth
      : normalizedLatest.containerWidth,
    components: {
      buttons: changed(normalizedBase.components.buttons, normalizedLocal.components.buttons)
        ? normalizedLocal.components.buttons
        : normalizedLatest.components.buttons,
      inputs: changed(normalizedBase.components.inputs, normalizedLocal.components.inputs)
        ? normalizedLocal.components.inputs
        : normalizedLatest.components.inputs,
      cards: changed(normalizedBase.components.cards, normalizedLocal.components.cards)
        ? normalizedLocal.components.cards
        : normalizedLatest.components.cards,
    },
  });
}

function changed(left: string, right: string): boolean {
  return left !== right;
}
