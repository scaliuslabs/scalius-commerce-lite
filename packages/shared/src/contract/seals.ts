// Every seal of the theme and app contract, as data: its snapshot, the ledger that acknowledges its
// changes (and the name that ledger gives it), and the one test that seals it. Import-free: the lock
// script and the contract judge (scripts/contract-lock.mjs) load it with plain Node, and the seal
// meta-test (seals.test.ts) holds every test file to it. Each seal's rule is in comparators.ts.

export interface ContractSeal {
  /** The snapshot, from the repository root: the lock's key for it. */
  path: string;
  /** Its break ledger, from the repository root. */
  ledger: string;
  /** The name the ledger's entries give the snapshot. */
  snapshot: string;
  /** The test file that seals it with `sealCompatibly` or `openContractBreaks`. */
  test: string;
  /** Before the lock, a reviewed `-u` accepts a change (the lock then holds it to its ledger like every seal). */
  beforeLock: "ledger" | "review";
}

const ABI = "packages/shared/src/plugins/abi.breaks.json";
const CONTRACT = "packages/shared/src/contract/contract.breaks.json";

export const CONTRACT_SEALS: readonly ContractSeal[] = [
  { path: "packages/shared/src/plugins/abi.manifest.snapshot.json", ledger: ABI, snapshot: "./abi.manifest.snapshot.json", test: "packages/shared/src/plugins/abi.snapshot.test.ts", beforeLock: "ledger" },
  { path: "packages/shared/src/plugins/abi.protocol.snapshot.json", ledger: ABI, snapshot: "./abi.protocol.snapshot.json", test: "packages/shared/src/plugins/abi.snapshot.test.ts", beforeLock: "ledger" },
  { path: "packages/shared/src/plugins/abi.sdk.snapshot.txt", ledger: ABI, snapshot: "./abi.sdk.snapshot.txt", test: "packages/shared/src/plugins/abi.snapshot.test.ts", beforeLock: "ledger" },
  { path: "apps/api/src/openapi/stable-operations.snapshot.json", ledger: "apps/api/src/openapi/stable-operations.breaks.json", snapshot: "stable-operations.snapshot.json", test: "apps/api/src/openapi/stable-operations.test.ts", beforeLock: "ledger" },
  { path: "packages/shared/src/events.representations.snapshot.json", ledger: "packages/shared/src/events.representations.breaks.json", snapshot: "events.representations.snapshot.json", test: "apps/api/src/events/representations.contract.test.ts", beforeLock: "ledger" },
  { path: "packages/shared/src/storefront-theme/compat.snapshot.json", ledger: CONTRACT, snapshot: "storefront-theme/compat.snapshot.json", test: "packages/shared/src/storefront-theme/compat.test.ts", beforeLock: "review" },
  { path: "packages/shared/src/storefront-theme/private-anatomy.snapshot.txt", ledger: CONTRACT, snapshot: "storefront-theme/private-anatomy.snapshot.txt", test: "packages/shared/src/storefront-theme/private-layout.test.ts", beforeLock: "review" },
  { path: "packages/shared/src/storefront-theme/save-reasons.snapshot.json", ledger: CONTRACT, snapshot: "storefront-theme/save-reasons.snapshot.json", test: "packages/shared/src/storefront-theme/save-reasons.test.ts", beforeLock: "review" },
  { path: "packages/shared/src/storefront-theme/read-bounds.snapshot.json", ledger: CONTRACT, snapshot: "storefront-theme/read-bounds.snapshot.json", test: "packages/shared/src/storefront-theme/read-bounds.test.ts", beforeLock: "ledger" },
  { path: "packages/shared/src/storefront-theme/private-compile.golden.json", ledger: CONTRACT, snapshot: "storefront-theme/private-compile.golden.json", test: "packages/shared/src/storefront-theme/private-compile-golden.test.ts", beforeLock: "review" },
  { path: "packages/shared/src/plugins/buyer-chrome-css.verdicts.json", ledger: CONTRACT, snapshot: "plugins/buyer-chrome-css.verdicts.json", test: "packages/shared/src/plugins/buyer-chrome-verdicts.test.ts", beforeLock: "review" },
  { path: "packages/shared/src/plugins/buyer-chrome-css.version.json", ledger: CONTRACT, snapshot: "plugins/buyer-chrome-css.version.json", test: "packages/shared/src/plugins/buyer-chrome-verdicts.test.ts", beforeLock: "review" },
  { path: "packages/shared/src/contract/refusal-census.snapshot.json", ledger: CONTRACT, snapshot: "contract/refusal-census.snapshot.json", test: "packages/shared/src/contract/refusal-census.test.ts", beforeLock: "review" },
];

/**
 * What the `contract` step of `pnpm ci:local` runs (it is in `--quick`): every seal test, the
 * tests of the lock and its rules, then the judge (`node scripts/contract-lock.mjs verify`).
 */
export const CONTRACT_TESTS: readonly string[] = [
  ...new Set(CONTRACT_SEALS.map((seal) => seal.test)),
  "packages/shared/src/contract/lock.test.ts",
  "packages/shared/src/contract/seals.test.ts",
  "packages/shared/src/contract/review-probes.test.ts",
  "packages/shared/src/contract/patterns.test.ts",
  "tests/replay/replay-compat.test.ts",
  "packages/shared/src/storefront-theme/compat-rules.test.ts",
  "packages/shared/src/plugins/contract-tables.test.ts",
  "packages/shared/src/plugins/abi-compat.test.ts",
  "packages/shared/src/plugins/abi-sdk-compat.test.ts",
  "scripts/contract-lock.test.mjs",
];

/** The break ledgers, once each. */
export const CONTRACT_LEDGERS: readonly string[] = [...new Set(CONTRACT_SEALS.map((seal) => seal.ledger))];

/** The modules the judge runs (contract-lock.mjs verify loads them from the latest locked release tag): every comparator and what it imports. */
export const CONTRACT_JUDGE = "packages/shared/src/contract/comparators.ts";

export function contractSeal(path: string): ContractSeal {
  const seal = CONTRACT_SEALS.find((entry) => entry.path === path);
  if (!seal) throw new Error(`${path} is not a contract seal (contract/seals.ts).`);
  return seal;
}
