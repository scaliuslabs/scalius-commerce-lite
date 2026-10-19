// Protected customer data at the app edge (COMMERCE-HOOKS H5): an operation's
// response, as an app receives it from `ctx.api.call`, has every field its
// output schema marks `x-scalius-protected` set to null unless the app's
// grant reveals that category. The marked paths are derived once per
// operation from the generated contract; applying them is a walk of the
// response, never another read.

import {
  protectedPathsOf,
  redactProtectedData,
  type ProtectedCustomerData,
  type ProtectedPath,
} from "@scalius/shared/plugins/protected-data";
import { AGENT_COMPONENT_SCHEMAS } from "../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";

const COMPONENT_REF = "#/components/schemas/";

/** Derived from the deployed contract, so it is the same for every store this Worker serves. */
const pathsByOperation = new Map<string, readonly ProtectedPath[]>();

export function componentSchema(ref: string): unknown {
  return ref.startsWith(COMPONENT_REF)
    ? (AGENT_COMPONENT_SCHEMAS as Record<string, unknown>)[ref.slice(COMPONENT_REF.length)]
    : undefined;
}

/** The protected fields of an operation's response body. */
export function operationProtectedPaths(operation: Pick<AgentOperationManifestEntry, "operationId" | "outputSchema">): readonly ProtectedPath[] {
  let paths = pathsByOperation.get(operation.operationId);
  if (!paths) {
    paths = protectedPathsOf(operation.outputSchema, componentSchema);
    pathsByOperation.set(operation.operationId, paths);
  }
  return paths;
}

/** The response body with the contact fields the app may not see read as null. */
export function redactOperationResponse<T>(
  operation: Pick<AgentOperationManifestEntry, "operationId" | "outputSchema">,
  body: T,
  granted: ReadonlySet<ProtectedCustomerData>,
): T {
  const paths = operationProtectedPaths(operation);
  return paths.length === 0 ? body : redactProtectedData(body, paths, granted);
}
