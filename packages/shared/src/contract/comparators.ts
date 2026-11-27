// The judge: each seal's compatibility rule, by snapshot path, on the snapshots' text. The seal
// tests read their rule from here, and `node scripts/contract-lock.mjs verify` loads this module
// and everything it imports from the latest release tag that carries a lock, so a branch is judged
// by the rules it was locked with, never by rules it weakened. Keep every module it reaches
// importing only relative modules of its own kind (and `typescript`): plain Node loads them.
import { manifestBreakingChanges, protocolBreakingChanges } from "../plugins/abi-compat";
import { sdkBreakingChanges } from "../plugins/abi-sdk-compat";
import { privateAnatomyBreakingChanges, saveReasonsBreakingChanges, themeContractBreakingChanges } from "../storefront-theme/compat-rules";
import { refusalCensusBreakingChanges } from "./census-compat";
import { representationsBreakingChanges, type RepresentationSnapshot } from "./events-compat";
import { readBoundsBreakingChanges } from "./read-bounds-compat";
import { stableBreakingChanges, type StableSnapshot } from "./stable-compat";

type Compare = (before: string, after: string) => string[];
const json = (rule: (before: unknown, after: unknown) => string[]): Compare => (before, after) => rule(JSON.parse(before), JSON.parse(after));

/** Any change at all is a break: what the private pages' compiler writes and decides (raise its versions, which save reasons seal too). */
const exact = (label: string): Compare => (before, after) => (before === after ? [] : [`${label}: the compiled output or a verdict changed.`]);

export const CONTRACT_COMPARATORS: Readonly<Record<string, Compare>> = {
  "packages/shared/src/plugins/abi.manifest.snapshot.json": json(manifestBreakingChanges),
  "packages/shared/src/plugins/abi.protocol.snapshot.json": json(protocolBreakingChanges),
  "packages/shared/src/plugins/abi.sdk.snapshot.txt": sdkBreakingChanges,
  "apps/api/src/openapi/stable-operations.snapshot.json": (before, after) => stableBreakingChanges(JSON.parse(before) as StableSnapshot, JSON.parse(after) as StableSnapshot),
  "packages/shared/src/events.representations.snapshot.json": (before, after) => representationsBreakingChanges(JSON.parse(before) as RepresentationSnapshot, JSON.parse(after) as RepresentationSnapshot),
  "packages/shared/src/storefront-theme/compat.snapshot.json": json(themeContractBreakingChanges),
  "packages/shared/src/storefront-theme/private-anatomy.snapshot.txt": privateAnatomyBreakingChanges,
  "packages/shared/src/storefront-theme/save-reasons.snapshot.json": json(saveReasonsBreakingChanges),
  "packages/shared/src/storefront-theme/read-bounds.snapshot.json": json(readBoundsBreakingChanges),
  "packages/shared/src/storefront-theme/private-compile.golden.json": exact("private compile golden"),
  "packages/shared/src/contract/refusal-census.snapshot.json": json(refusalCensusBreakingChanges),
};

/** The rule of one sealed snapshot. */
export function contractComparator(path: string): Compare {
  const compare = CONTRACT_COMPARATORS[path];
  if (!compare) throw new Error(`${path} has no comparator (contract/comparators.ts).`);
  return compare;
}
