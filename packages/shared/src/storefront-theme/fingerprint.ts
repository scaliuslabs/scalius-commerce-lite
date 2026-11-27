// A short fingerprint of JSON: a cache key or a check that two stored values
// still belong together. Not a security boundary: anyone who can write the
// row can write a matching fingerprint.

/** A 53-bit FNV-1a-style fingerprint of `text` (two 32-bit lanes), base 36. */
export function storefrontFingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/** JSON with every object's keys sorted and undefined members left out: the same value always gives the same text. */
export function storefrontCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((each) => storefrontCanonicalJson(each === undefined ? null : each)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().flatMap((key) => {
      const entry = (value as Record<string, unknown>)[key];
      return entry === undefined ? [] : [`${JSON.stringify(key)}:${storefrontCanonicalJson(entry)}`];
    }).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
