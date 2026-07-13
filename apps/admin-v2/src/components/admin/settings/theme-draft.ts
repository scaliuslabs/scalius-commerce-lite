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
