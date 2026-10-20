// The app operation table: every operation an app may name in
// `ctx.api.call`, by its app name (`orders.get`), resolved to the internal
// operation. The naming rule lives in `@scalius/shared/plugins/app-operations`;
// the stable part of the table is sealed in
// `openapi/stable-operations.snapshot.json`.

import { appOperationNames } from "@scalius/shared/plugins/app-operations";
import { AGENT_OPERATIONS } from "../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";

const BY_ID = new Map(AGENT_OPERATIONS.map((operation) => [operation.operationId, operation]));
const NAMES = appOperationNames(BY_ID.keys());
const NAME_OF = new Map([...NAMES].map(([name, operationId]) => [operationId, name]));

/** The operation an app name resolves to, or null when no app can name it. */
export function resolveAppOperation(name: string): AgentOperationManifestEntry | null {
  const operationId = NAMES.get(name);
  return operationId ? (BY_ID.get(operationId) ?? null) : null;
}

/** An operation's app name, or null when no app can name it. */
export function appOperationName(operationId: string): string | null {
  return NAME_OF.get(operationId) ?? null;
}
