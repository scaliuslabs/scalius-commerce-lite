import { shouldUseExactCacheGeneration } from "./cache-generations";

export interface SelectivePurgePolicyInput {
  groups?: string[];
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

function isCheckoutOnlyPurge(groups: readonly string[]): boolean {
  return groups.length > 0 && groups.every((group) => group === "checkout");
}

function hasOnlyGenerationScopedPrefixes(prefixes: readonly string[]): boolean {
  return prefixes.length > 0 && prefixes.every(shouldUseExactCacheGeneration);
}

function shouldKeepPrefixPurgeGenerationScoped({
  groups = [],
  prefixes = [],
  exactKeys = [],
  htmlPaths = [],
  bumpVersion = false,
}: SelectivePurgePolicyInput): boolean {
  return (
    !bumpVersion &&
    prefixes.length > 0 &&
    !hasExactTargets({ exactKeys, htmlPaths }) &&
    isCheckoutOnlyPurge(groups) &&
    hasOnlyGenerationScopedPrefixes(prefixes)
  );
}

export function shouldBumpCacheVersionForSelectivePurge({
  groups = [],
  prefixes = [],
  exactKeys = [],
  htmlPaths = [],
  bumpVersion = false,
}: SelectivePurgePolicyInput): boolean {
  return (
    bumpVersion ||
    (
      prefixes.length > 0 &&
      !hasExactTargets({ exactKeys, htmlPaths }) &&
      !shouldKeepPrefixPurgeGenerationScoped({
        groups,
        prefixes,
        exactKeys,
        htmlPaths,
        bumpVersion,
      })
    )
  );
}

export function shouldWarmCriticalCachesForSelectivePurge({
  groups = [],
  prefixes = [],
  exactKeys = [],
  htmlPaths = [],
  bumpVersion = false,
}: SelectivePurgePolicyInput): boolean {
  return shouldBumpCacheVersionForSelectivePurge({
    groups,
    prefixes,
    exactKeys,
    htmlPaths,
    bumpVersion,
  });
}
