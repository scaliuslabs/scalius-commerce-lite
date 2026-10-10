// What a react-hook-form editor's save tells the others it changed (FormContainer).

/**
 * The form names of a react-hook-form `dirtyFields` tree (`price`,
 * `seo.title`, `variants.0.sku`): what a save tells the others it changed.
 */
export function changedFieldNames(dirty: unknown, prefix = ""): string[] {
  if (dirty === true) return prefix ? [prefix] : [];
  if (!dirty || typeof dirty !== "object") return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(dirty as Record<string, unknown>)) {
    names.push(...changedFieldNames(value, prefix ? `${prefix}.${key}` : key));
  }
  return names;
}
