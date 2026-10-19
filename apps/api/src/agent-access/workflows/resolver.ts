import {
  AGENT_OPERATIONS,
  AGENT_WORKFLOW_CATALOG,
} from "../../generated/agent-operations.gen";
import {
  createWorkflowResolver,
  createWorkflowSearch,
  type WorkflowResolution,
  type WorkflowResolverInput,
  type WorkflowSearchInput,
  type WorkflowSearchResult,
} from "./resolver-core";

export {
  createWorkflowResolver,
  createWorkflowSearch,
  type ResolvedWorkflowPlan,
  type WorkflowResolution,
  type WorkflowResolverChoice,
  type WorkflowResolverInput,
  type WorkflowResolverSources,
  type WorkflowSearchHit,
  type WorkflowSearchInput,
  type WorkflowSearchResult,
} from "./resolver-core";

const sources = {
  catalog: AGENT_WORKFLOW_CATALOG,
  operations: AGENT_OPERATIONS,
};
const defaultResolver = createWorkflowResolver(sources);
const defaultSearch = createWorkflowSearch(sources);

export function resolveAgentWorkflow(
  input: WorkflowResolverInput,
): WorkflowResolution {
  return defaultResolver(input);
}

/** Ranked workflow and operation candidates for a merchant goal (MCP `scalius_search`). */
export function searchAgentWorkflows(input: WorkflowSearchInput): WorkflowSearchResult {
  return defaultSearch(input);
}
