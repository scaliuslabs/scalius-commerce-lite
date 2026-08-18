import { CliError } from "./errors.js";
import {
  type CompiledWorkflowRead,
  type CompiledWorkflowReadStep,
  type ProjectedWorkflowReadStep,
  projectWorkflowReadResponse,
} from "./generated/workflow-resolver-core.gen.js";
import { indexOperations } from "./openapi.js";
import { executeOperation } from "./operations.js";
import type {
  IndexedOperation,
  OpenApiDocument,
  ResolvedProfile,
  Runtime,
} from "./types.js";
import { prepareWorkflowRead, type WorkflowResolverInput } from "./workflows.js";

const MAX_WORKFLOW_READ_PHASES = 8;
const MAX_WORKFLOW_READ_STEPS = 20;
const MAX_PARALLEL_READS = 2;
const MAX_WORKFLOW_READ_RESULT_BYTES = 64 * 1024;

export type WorkflowReadExecutionResult =
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

type PreparedStep = {
  compiled: CompiledWorkflowReadStep;
  operation: IndexedOperation;
};

export function workflowReadUnavailable(): WorkflowReadExecutionResult {
  return {
    kind: "unavailable",
    disposition: "unavailable",
    classification: {
      code: "workflow_read_unavailable",
      reason: "The requested workflow read is unavailable.",
    },
  };
}

function prepareExecution(
  document: OpenApiDocument,
  compiled: CompiledWorkflowRead,
  surface: "dashboard" | "storefront",
): PreparedStep[][] | null {
  if (
    compiled.phases.length < 1 ||
    compiled.phases.length > MAX_WORKFLOW_READ_PHASES
  ) return null;
  const operations = new Map(indexOperations(document).map((operation) => [operation.id, operation]));
  const namespaces = new Set<string>();
  let stepCount = 0;
  const phases: PreparedStep[][] = [];
  for (const phase of compiled.phases) {
    if (phase.steps.length < 1) return null;
    const steps: PreparedStep[] = [];
    for (const step of phase.steps) {
      stepCount += 1;
      const operation = operations.get(step.operationId);
      if (
        stepCount > MAX_WORKFLOW_READ_STEPS ||
        namespaces.has(step.namespace) ||
        !operation ||
        operation.agent.surface !== surface ||
        operation.agent.exposure !== "execute" ||
        operation.agent.risk !== "read" ||
        operation.agent.openWorld !== false ||
        operation.agent.artifactOutput !== undefined ||
        operation.agent.sensitiveOutput === true ||
        operation.agent.oneTimeSecretOutput === true ||
        operation.agent.requiredClientAction !== undefined
      ) return null;
      namespaces.add(step.namespace);
      steps.push({ compiled: step, operation });
    }
    phases.push(steps);
  }
  return phases;
}

async function executeProjectedStep(
  runtime: Runtime,
  profile: ResolvedProfile,
  document: OpenApiDocument,
  prepared: PreparedStep,
): Promise<ProjectedWorkflowReadStep> {
  const result = await executeOperation(runtime, profile, document, prepared.operation, {
    input: prepared.compiled.input,
    files: [],
    yes: false,
    overwrite: false,
  });
  if (result.operationId !== prepared.operation.id || result.savedTo || result.data === undefined) {
    throw new CliError(8, "workflow_read_failed", "Reviewed workflow read failed.");
  }
  const projected = projectWorkflowReadResponse(result.data, prepared.compiled.output);
  if (!projected) {
    throw new CliError(8, "workflow_projection_failed", "Reviewed workflow response no longer matches its projection.");
  }
  return projected;
}

async function executePhase(
  runtime: Runtime,
  profile: ResolvedProfile,
  document: OpenApiDocument,
  phase: readonly PreparedStep[],
): Promise<Array<[string, ProjectedWorkflowReadStep]>> {
  const results: Array<[string, ProjectedWorkflowReadStep]> = [];
  let index = 0;
  while (index < phase.length) {
    const width = phase[index]!.operation.agent.batch === "parallel"
      ? Math.min(
          MAX_PARALLEL_READS,
          phase.slice(index).findIndex((step) => step.operation.agent.batch !== "parallel") === -1
            ? phase.length - index
            : phase.slice(index).findIndex((step) => step.operation.agent.batch !== "parallel"),
        )
      : 1;
    const wave = phase.slice(index, index + Math.max(1, width));
    const projected = await Promise.all(wave.map((step) =>
      executeProjectedStep(runtime, profile, document, step)
    ));
    for (let offset = 0; offset < wave.length; offset += 1) {
      results.push([wave[offset]!.compiled.namespace, projected[offset]!]);
    }
    index += wave.length;
  }
  return results;
}

export async function executeCompiledWorkflowRead(
  runtime: Runtime,
  profile: ResolvedProfile,
  document: OpenApiDocument,
  surface: "dashboard" | "storefront",
  compiled: CompiledWorkflowRead,
): Promise<WorkflowReadExecutionResult> {
  const phases = prepareExecution(document, compiled, surface);
  if (!phases) return workflowReadUnavailable();

  const outputs: Record<string, ProjectedWorkflowReadStep> = {};
  for (const phase of phases) {
    const results = await executePhase(runtime, profile, document, phase);
    for (const [namespace, projected] of results) outputs[namespace] = projected;
  }
  const result: WorkflowReadExecutionResult = {
    kind: "result",
    disposition: "execute",
    version: compiled.version,
    workflowId: compiled.workflowId,
    outputs,
  };
  return Buffer.byteLength(JSON.stringify(result)) < MAX_WORKFLOW_READ_RESULT_BYTES
    ? result
    : workflowReadUnavailable();
}

export async function readWorkflow(
  runtime: Runtime,
  profile: ResolvedProfile,
  document: OpenApiDocument,
  input: WorkflowResolverInput,
): Promise<WorkflowReadExecutionResult> {
  const compiled = prepareWorkflowRead(document, input);
  return compiled
    ? executeCompiledWorkflowRead(runtime, profile, document, input.surface, compiled)
    : workflowReadUnavailable();
}
