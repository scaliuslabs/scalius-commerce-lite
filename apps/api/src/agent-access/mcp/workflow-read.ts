import {
  AGENT_OPERATIONS,
  AGENT_WORKFLOW_CATALOG,
} from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { dispatchAgentOperation } from "../dispatch";
import {
  AGENT_MAX_PARALLEL_READS,
  AGENT_MAX_RESULT_BYTES,
  utf8ByteLength,
} from "../limits";
import type { AgentPrincipal, AgentResource } from "../types";
import {
  createWorkflowReadCompiler,
  projectWorkflowReadResponse,
  type CompiledWorkflowReadPhase,
  type CompiledWorkflowReadStep,
  type ProjectedWorkflowReadStep,
} from "../workflows/resolver-core";
import { getAuthorizedOperation } from "./operations";

export type ExecuteAuthorizedWorkflowReadInput = {
  prompt: string;
  surface: AgentResource;
  principal: AgentPrincipal;
  env: Env;
  ctx: ExecutionContext;
};

export type AuthorizedWorkflowReadResult =
  | {
      kind: "result";
      disposition: "execute";
      version: string;
      workflowId: string;
      outputs: Record<string, ProjectedWorkflowReadStep>;
    }
  | {
      kind: "unavailable";
      disposition: "unavailable";
      classification: {
        code: "workflow_read_unavailable";
        reason: "The requested workflow read is unavailable.";
      };
    };

type AuthorizedWorkflowReadStep = CompiledWorkflowReadStep & {
  operation: AgentOperationManifestEntry;
};

const compileWorkflowRead = createWorkflowReadCompiler({
  catalog: AGENT_WORKFLOW_CATALOG,
  operations: AGENT_OPERATIONS,
});

function unavailable(): AuthorizedWorkflowReadResult {
  return {
    kind: "unavailable",
    disposition: "unavailable",
    classification: {
      code: "workflow_read_unavailable",
      reason: "The requested workflow read is unavailable.",
    },
  };
}

function isAuthorizedClosedRead(
  operation: AgentOperationManifestEntry | null,
  operationId: string,
  surface: AgentResource,
): operation is AgentOperationManifestEntry {
  return operation !== null &&
    operation.operationId === operationId &&
    operation.surface === surface &&
    operation.risk === "read" &&
    operation.exposure === "execute" &&
    operation.openWorld === false;
}

async function authorizeWorkflowRead(
  phases: readonly CompiledWorkflowReadPhase[],
  surface: AgentResource,
  principal: AgentPrincipal,
): Promise<AuthorizedWorkflowReadStep[][] | null> {
  const authorized = new Map<string, AgentOperationManifestEntry>();
  const operationIds = [...new Set(
    phases.flatMap((phase) => phase.steps.map((step) => step.operationId)),
  )];
  for (const operationId of operationIds) {
    const operation = await getAuthorizedOperation(operationId, surface, principal);
    if (!isAuthorizedClosedRead(operation, operationId, surface)) return null;
    authorized.set(operationId, operation);
  }
  return phases.map((phase) => phase.steps.map((step) => ({
    ...step,
    operation: authorized.get(step.operationId)!,
  })));
}

async function dispatchProjectedStep(
  step: AuthorizedWorkflowReadStep,
  principal: AgentPrincipal,
  env: Env,
  ctx: ExecutionContext,
): Promise<ProjectedWorkflowReadStep> {
  const result = await dispatchAgentOperation({
    operation: step.operation,
    input: step.input,
    principal,
    env,
    ctx,
  });
  if (
    !result.ok ||
    result.operationId !== step.operationId ||
    result.artifact ||
    result.redacted ||
    result.oneTimeSecret ||
    result.sensitiveContinuation
  ) throw new Error("workflow_read_failed");
  const projected = projectWorkflowReadResponse(result.data, step.output);
  if (!projected) throw new Error("workflow_projection_failed");
  return projected;
}

async function executeReadPhase(
  phase: readonly AuthorizedWorkflowReadStep[],
  principal: AgentPrincipal,
  env: Env,
  ctx: ExecutionContext,
): Promise<Array<[string, ProjectedWorkflowReadStep]>> {
  const results: Array<[string, ProjectedWorkflowReadStep]> = [];
  let index = 0;
  while (index < phase.length) {
    const wave: AuthorizedWorkflowReadStep[] = [phase[index]!];
    if (wave[0]!.operation.batch === "parallel") {
      while (
        wave.length < AGENT_MAX_PARALLEL_READS &&
        phase[index + wave.length]?.operation.batch === "parallel"
      ) wave.push(phase[index + wave.length]!);
    }
    const projected = await Promise.all(wave.map((step) =>
      dispatchProjectedStep(step, principal, env, ctx)
    ));
    for (let offset = 0; offset < wave.length; offset += 1) {
      results.push([wave[offset]!.namespace, projected[offset]!]);
    }
    index += wave.length;
  }
  return results;
}

export async function executeAuthorizedWorkflowRead(
  input: ExecuteAuthorizedWorkflowReadInput,
): Promise<AuthorizedWorkflowReadResult> {
  try {
    if (input.principal.resource !== input.surface) return unavailable();
    const compiled = compileWorkflowRead({ prompt: input.prompt, surface: input.surface });
    if (!compiled) return unavailable();
    const phases = await authorizeWorkflowRead(
      compiled.phases,
      input.surface,
      input.principal,
    );
    if (!phases) return unavailable();

    const outputs: Record<string, ProjectedWorkflowReadStep> = {};
    for (const phase of phases) {
      const projected = await executeReadPhase(phase, input.principal, input.env, input.ctx);
      for (const [namespace, output] of projected) outputs[namespace] = output;
    }

    const result: AuthorizedWorkflowReadResult = {
      kind: "result",
      disposition: "execute",
      version: compiled.version,
      workflowId: compiled.workflowId,
      outputs,
    };
    return utf8ByteLength(JSON.stringify(result)) < AGENT_MAX_RESULT_BYTES
      ? result
      : unavailable();
  } catch {
    return unavailable();
  }
}
