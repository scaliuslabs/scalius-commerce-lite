// This file is generated from the finalized /api/v1 OpenAPI contract.
// Do not edit by hand.

import type { AgentOperationPolicy, AgentOperationPolicyData } from "../openapi/agent-operation-manifest";
import index from "./agent-operation-policies.gen.txt";

// The policy index (no prose, no schemas): a small Text module that plugin
// authority and admin agent checks parse instead of the full manifest.
const data = JSON.parse(index) as AgentOperationPolicyData;

export const AGENT_OPERATION_POLICIES: readonly AgentOperationPolicy[] = Object.freeze(
  data.operations.map((row) => Object.freeze({ ...data.defaults, ...row }) as AgentOperationPolicy),
);

export const AGENT_OPERATION_POLICIES_BY_ID: Readonly<Record<string, AgentOperationPolicy>> = Object.freeze(
  Object.fromEntries(AGENT_OPERATION_POLICIES.map((operation) => [operation.operationId, operation])),
);
