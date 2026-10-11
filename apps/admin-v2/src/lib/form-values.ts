/** Compare drafts without treating object key order as an edit.
 * Arrays stay ordered. Null and empty strings differ from missing/undefined fields.
 */
export function sameFormValue(a: unknown, b: unknown): boolean {
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, index) => sameFormValue(value, b[index]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aPrototype = Object.getPrototypeOf(a);
  const bPrototype = Object.getPrototypeOf(b);
  if ((aPrototype !== Object.prototype && aPrototype !== null)
    || (bPrototype !== Object.prototype && bPrototype !== null)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .every((key) => sameFormValue(left[key], right[key]));
}

/** Use only for domain sets; ordered rows and payment methods must keep their order. */
export function sortedUniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
