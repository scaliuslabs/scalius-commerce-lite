export interface SelectivePurgePolicyInput {
  prefixes?: string[];
  exactKeys?: string[];
  htmlPaths?: string[];
  bumpVersion?: boolean;
}

function hasExactTargets({
  exactKeys = [],
  htmlPaths = [],
}: Pick<SelectivePurgePolicyInput, "exactKeys" | "htmlPaths">): boolean {
  return exactKeys.length > 0 || htmlPaths.length > 0;
}

export function shouldBumpCacheVersionForSelectivePurge({
  prefixes = [],
  exactKeys = [],
  htmlPaths = [],
  bumpVersion = false,
}: SelectivePurgePolicyInput): boolean {
  return bumpVersion || (prefixes.length > 0 && !hasExactTargets({ exactKeys, htmlPaths }));
}

export function shouldWarmCriticalCachesForSelectivePurge({
  prefixes = [],
  exactKeys = [],
  htmlPaths = [],
  bumpVersion = false,
}: SelectivePurgePolicyInput): boolean {
  return bumpVersion || (prefixes.length > 0 && !hasExactTargets({ exactKeys, htmlPaths }));
}
