// This file is generated from the finalized /api/v1 OpenAPI contract.
// Do not edit by hand.

import type { AgentOperationManifestData, AgentOperationManifestEntry } from "../openapi/agent-operation-manifest";
import manifest from "./agent-operations.gen.txt";

// A Text module (a string, not compiled at isolate start), parsed when an
// agent route first loads this module. Vitest hands over the same text.
const data = JSON.parse(manifest) as AgentOperationManifestData;

/** Shared schemas, referenced from operations as `#/components/schemas/<name>`. */
export const AGENT_COMPONENT_SCHEMAS = data.componentSchemas;

export const AGENT_OPERATIONS = data.operations;

export const AGENT_OPERATIONS_BY_ID: Readonly<Record<string, AgentOperationManifestEntry>> = Object.freeze(
  Object.fromEntries(AGENT_OPERATIONS.map((operation) => [operation.operationId, operation])),
);

export const AGENT_WORKFLOW_CATALOG = data.workflowCatalog;
