// A key this build does not know, in a value another build of the platform
// sent or wrote (a later release's optional field), is left out on read: only
// a write is strict. The theme document's read repairs it among its other
// repairs (storefront-theme/read-repair.ts); a value with no other repair
// reads through `safeParseLeavingOutUnknownKeys`.
import type { z } from "zod";

/** The issue fields a key repair reads (a Zod issue). */
export interface UnknownKeyIssue {
  code: string;
  path: readonly PropertyKey[];
  keys?: readonly string[] | undefined;
}

/**
 * The issues as a key repair reads them: a union refused only for a key a
 * branch does not know is that branch's unknown keys, at their place, so a
 * later release's key inside a union is left out too.
 */
export function unionKeyIssues<T extends UnknownKeyIssue>(issues: readonly T[]): T[] {
  return issues.flatMap((issue) => {
    const branches = (issue as { errors?: unknown }).errors;
    if (issue.code !== "invalid_union" || !Array.isArray(branches)) return [issue];
    const keysOnly = branches.find((branch): branch is T[] => Array.isArray(branch) && branch.length > 0
      && branch.every((nested) => (nested as UnknownKeyIssue).code === "unrecognized_keys"));
    return keysOnly ? keysOnly.map((nested) => ({ ...nested, path: [...issue.path, ...nested.path] })) : [issue];
  });
}

const ROUNDS = 4;

/**
 * Parses `value`, leaving out every key the schema's strict objects do not
 * know; anything else the schema refuses still fails. The strict parse runs
 * first, so a value without such a key costs one parse.
 */
export function safeParseLeavingOutUnknownKeys<S extends z.ZodType>(schema: S, value: unknown): z.ZodSafeParseResult<z.output<S>> {
  let candidate = value;
  for (let round = 0; ; round += 1) {
    const result = schema.safeParse(candidate) as z.ZodSafeParseResult<z.output<S>>;
    if (result.success || round === ROUNDS) return result;
    const issues = unionKeyIssues(result.error.issues as UnknownKeyIssue[]);
    if (!issues.every((issue) => issue.code === "unrecognized_keys")) return result;
    candidate = structuredClone(candidate);
    for (const issue of issues) {
      let parent: unknown = candidate;
      for (const part of issue.path) parent = (parent as Record<PropertyKey, unknown> | null)?.[part];
      if (typeof parent !== "object" || parent === null) return result;
      for (const key of issue.keys ?? []) delete (parent as Record<string, unknown>)[key];
    }
  }
}
