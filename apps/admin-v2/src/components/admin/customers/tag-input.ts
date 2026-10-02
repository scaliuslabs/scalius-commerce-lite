import { normalizeCustomerTag } from "@scalius/shared/customer-marketing";

/**
 * Adds what was typed or pasted ("VIP, wholesale") to `current`: each part
 * normalised as stored (lower-case, single spaces, no commas), duplicates
 * skipped, at most `max` tags. `invalid` lists parts that are not a tag (too
 * long); `overflow` says some were left out because `max` was reached.
 */
export function addTypedTags(
  current: readonly string[],
  text: string,
  max: number,
): { tags: string[]; invalid: string[]; overflow: boolean } {
  const tags = [...current];
  const invalid: string[] = [];
  let overflow = false;
  for (const part of text.split(",")) {
    if (!part.trim()) continue;
    const tag = normalizeCustomerTag(part);
    if (tag === null) {
      invalid.push(part.trim());
      continue;
    }
    if (tags.includes(tag)) continue;
    if (tags.length >= max) {
      overflow = true;
      continue;
    }
    tags.push(tag);
  }
  return { tags, invalid, overflow };
}

/** Same tags in any order. */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}
