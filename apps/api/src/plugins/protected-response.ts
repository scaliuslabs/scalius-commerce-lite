// An operation's response at the app edge, as an app receives it from
// `ctx.api.call`: exactly what the operation's output schema declares (a key
// the route answers without declaring it is left out, so no app can come to
// depend on it), with every field the schema marks `x-scalius-protected` set
// to null unless the app's grant reveals that category (COMMERCE-HOOKS H5).
// Projector and marked paths are derived once per operation from the
// generated contract; applying them is a walk of the response, never another
// read.

import {
  protectedPathsOf,
  redactProtectedData,
  type ProtectedCustomerData,
  type ProtectedPath,
} from "@scalius/shared/plugins/protected-data";
import { appOwnedPathsOf, projectAppOwnedData, type AppOwnedPath } from "@scalius/shared/plugins/app-owned-data";
import { schemaProjector, type SchemaProjector } from "@scalius/shared/schema-projection";
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

const projectorsByOperation = new Map<string, SchemaProjector>();

/** Copies a response keeping only the keys the operation's output schema declares. */
export function operationOutputProjector(operation: Pick<AgentOperationManifestEntry, "operationId" | "outputSchema">): SchemaProjector {
  let projector = projectorsByOperation.get(operation.operationId);
  if (!projector) {
    projector = schemaProjector(operation.outputSchema, componentSchema);
    projectorsByOperation.set(operation.operationId, projector);
  }
  return projector;
}

/** Paths already logged by this isolate, and the most it logs: a leak is a signal, never a flood. */
const loggedUndeclared = new Set<string>();
const MAX_UNDECLARED_LOG_LINES = 100;

/**
 * One log line per operation and undeclared path per isolate (operation and
 * path only, never a value), so a route answering a key its schema does not
 * declare shows up in production as well as in its tests.
 */
function logUndeclared(operationId: string, paths: () => string[]): void {
  if (loggedUndeclared.size >= MAX_UNDECLARED_LOG_LINES) return;
  const fresh = [...new Set(paths())].filter((path) => !loggedUndeclared.has(`${operationId} ${path}`)).slice(0, MAX_UNDECLARED_LOG_LINES - loggedUndeclared.size);
  if (fresh.length === 0) return;
  for (const path of fresh) loggedUndeclared.add(`${operationId} ${path}`);
  console.warn(JSON.stringify({ event: "app_api_undeclared_keys", operation: operationId, paths: fresh }));
}

const appOwnedPathsByOperation = new Map<string, readonly AppOwnedPath[]>();

/** The app-owned fields of an operation's response body (`x-scalius-app-owned`). */
export function operationAppOwnedPaths(operation: Pick<AgentOperationManifestEntry, "operationId" | "outputSchema">): readonly AppOwnedPath[] {
  let paths = appOwnedPathsByOperation.get(operation.operationId);
  if (!paths) {
    paths = appOwnedPathsOf(operation.outputSchema, componentSchema);
    appOwnedPathsByOperation.set(operation.operationId, paths);
  }
  return paths;
}

/**
 * The response body as one app may see it: only the keys the operation
 * declares (each undeclared key's path pushed onto `undeclared` when given),
 * contact fields the grant does not reveal read as null, and buyer answers
 * given to other apps (their checkout attributes and line inputs) are left
 * out (COMMERCE-HOOKS H13).
 */
export function projectOperationResponse<T>(
  operation: Pick<AgentOperationManifestEntry, "operationId" | "outputSchema">,
  body: T,
  granted: ReadonlySet<ProtectedCustomerData>,
  appId: string,
  undeclared?: string[],
): T {
  const project = operationOutputProjector(operation);
  let declared: T;
  if (undeclared) declared = project(body, undeclared);
  else {
    const counter = { count: 0 };
    declared = project(body, counter);
    if (counter.count > 0) logUndeclared(operation.operationId, () => {
      const paths: string[] = [];
      project(body, paths);
      return paths;
    });
  }
  const redacted = redactOperationResponse(operation, declared, granted);
  const paths = operationAppOwnedPaths(operation);
  return paths.length === 0 ? redacted : projectAppOwnedData(redacted, paths, appId);
}
