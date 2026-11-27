// The stable app API's breaking-change rule (apps/api/src/openapi/stable-operations.test.ts seals
// `stable-operations.snapshot.json` with it): no stable operation disappears, moves, changes its
// success statuses, loses a scope or pair of scopes that covered it or tightens its idempotency or
// revision rule; no request or response schema changes in a breaking way (schema-compat.ts); no
// schema name of the stable contract disappears. Imports only its siblings, so the contract lock's
// judge (scripts/contract-lock.mjs verify) can load it from a release tag with plain Node.
import { inputBreakingChanges, schemaBreakingChanges } from "../schema-compat";

export interface StableOperationSnapshot {
  method: string;
  path: string;
  statuses: number[];
  idempotency: string;
  revision: string;
  scopes: string[];
  scopeSets?: string[][];
  input: unknown;
  output: unknown;
}

export interface StableSnapshot {
  operations: Record<string, StableOperationSnapshot>;
  components: Record<string, unknown>;
}

const TIGHTER: Record<string, readonly string[]> = {
  idempotency: ["none", "supported", "required"],
  revision: ["none", "optional", "required"],
};

/** Every breaking difference from `before` to `after`, one line each. */
export function stableBreakingChanges(before: StableSnapshot, after: StableSnapshot): string[] {
  const problems: string[] = [];
  const components = { before: before.components, after: after.components };
  for (const [operationId, was] of Object.entries(before.operations)) {
    const now = after.operations[operationId];
    if (!now) {
      problems.push(`${operationId}: removed from the stable app API.`);
      continue;
    }
    if (was.method !== now.method || was.path !== now.path) problems.push(`${operationId}: moved from ${was.method} ${was.path} to ${now.method} ${now.path}.`);
    if (was.statuses.join(" ") !== now.statuses.join(" ")) problems.push(`${operationId}: answers ${now.statuses.join(" or ")} where it answered ${was.statuses.join(" or ")}.`);
    for (const scope of was.scopes) {
      if (!now.scopes.includes(scope)) problems.push(`${operationId}: the ${scope} scope no longer covers it.`);
    }
    // A pair still covers it when the pair is still listed or one of its scopes now covers it alone.
    for (const set of was.scopeSets ?? []) {
      const still = set.some((scope) => now.scopes.includes(scope))
        || (now.scopeSets ?? []).some((candidate) => candidate.join(" ") === set.join(" "));
      if (!still) problems.push(`${operationId}: the scopes ${set.join(" + ")} no longer cover it.`);
    }
    for (const field of ["idempotency", "revision"] as const) {
      const order = TIGHTER[field]!;
      if (order.indexOf(now[field]) > order.indexOf(was[field]) && now[field] === "required") {
        problems.push(`${operationId}: ${field} is now required.`);
      }
    }
    problems.push(...inputBreakingChanges(was.input, now.input, components).map((line) => `${operationId} input ${line}`));
    problems.push(...schemaBreakingChanges(was.output, now.output, "response", components).map((line) => `${operationId} output ${line}`));
  }
  // A component's name is contract too: the SDK's `stableContract.components` and `sample("OrderResource")` name it.
  for (const name of Object.keys(before.components)) {
    if (!(name in after.components)) problems.push(`components.${name}: the schema name was removed (an app's sample("${name}") names it).`);
  }
  return problems;
}
