export interface SelectivePurgePolicyInput {
  prefixes?: string[];
  bumpVersion?: boolean;
}

export function shouldBumpCacheVersionForSelectivePurge({
  prefixes = [],
  bumpVersion = false,
}: SelectivePurgePolicyInput): boolean {
  return bumpVersion || prefixes.length > 0;
}

export function shouldWarmCriticalCachesForSelectivePurge({
  bumpVersion = false,
}: SelectivePurgePolicyInput): boolean {
  return bumpVersion;
}
