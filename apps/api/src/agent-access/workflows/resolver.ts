import {
  AGENT_OPERATIONS,
  AGENT_WORKFLOW_CATALOG,
} from "../../generated/agent-operations.gen";
import {
  createWorkflowResolver,
  type WorkflowResolution,
  type WorkflowResolverInput,
} from "./resolver-core";

export {
  createWorkflowResolver,
  type ResolvedWorkflowPlan,
  type WorkflowResolution,
  type WorkflowResolverChoice,
  type WorkflowResolverInput,
  type WorkflowResolverSources,
} from "./resolver-core";

let defaultResolver: ReturnType<typeof createWorkflowResolver> | undefined;

export function resolveAgentWorkflow(
  input: WorkflowResolverInput,
): WorkflowResolution {
  defaultResolver ??= createWorkflowResolver({
    catalog: AGENT_WORKFLOW_CATALOG,
    operations: AGENT_OPERATIONS,
  });
  return defaultResolver(input);
}
