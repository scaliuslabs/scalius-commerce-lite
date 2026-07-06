export const CANONICAL_PATH_MAX_LENGTH = 2048;

export function normalizeCanonicalPathInput(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function isValidCanonicalPath(value: string): boolean {
  if (!value || value.length > CANONICAL_PATH_MAX_LENGTH) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || value.includes("?") || value.includes("#")) {
    return false;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return false;
  }

  try {
    const parsed = new URL(value, "https://store.example");
    return (
      parsed.origin === "https://store.example" &&
      parsed.pathname === value &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function normalizeCanonicalPath(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeCanonicalPathInput(value);
  if (!normalized) return null;
  return isValidCanonicalPath(normalized) ? normalized : null;
}
