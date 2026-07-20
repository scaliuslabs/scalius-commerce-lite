/**
 * Builds one compact location string without repeating structured city/zone
 * values already present in a merchant-entered street address.
 */
export function formatLocationParts(
  ...values: Array<string | null | undefined>
): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    for (const segment of value?.split(",") ?? []) {
      const display = segment.trim().replace(/\s+/g, " ");
      const identity = display.toLocaleLowerCase("en-US");
      if (!display || seen.has(identity)) continue;
      seen.add(identity);
      parts.push(display);
    }
  }

  return parts.join(", ");
}
