import {
  AGENT_OPERATIONS,
  AGENT_OPERATIONS_BY_ID,
  AGENT_WORKFLOW_CATALOG,
} from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import type { AgentPrincipal, AgentResource } from "../types";
import {
  createWorkflowResolver,
  type ResolvedWorkflowPlan,
  type WorkflowExecutionDetail,
  type WorkflowResolution,
  type WorkflowResolverChoice,
} from "../workflows/resolver-core";
import { getAuthorizedOperation } from "./operations";

const MAX_PLAN_OPERATIONS = 20;
const MAX_CHOICE_OPERATIONS = 60;
const MAX_ROUTE_IDS = 4;
const MAX_WORKFLOW_IDS = 4;
const MAX_CHOICES = 3;
const MAX_RULES = 8;
const MAX_SAFETY_NOTES = 8;
const MAX_TITLE_CHARS = 160;
const MAX_SUMMARY_CHARS = 480;
const MAX_NOTE_CHARS = 320;

const resolveWorkflow = createWorkflowResolver({
  catalog: AGENT_WORKFLOW_CATALOG,
  operations: AGENT_OPERATIONS,
});

export type AuthorizedWorkflowPlan = {
  source: ResolvedWorkflowPlan["source"];
  routeIds: string[];
  workflowIds: string[];
  operationIds: string[];
  externalAudienceVerification: ExternalAudienceVerification[];
  title: string;
  summary: string;
  kind: ResolvedWorkflowPlan["kind"];
  confidence: number;
  requiresFacts: boolean;
  requiresConfirmation: boolean;
  requiresVerification: boolean;
  rules: string[];
  detail?: WorkflowExecutionDetail;
};

export type AuthorizedWorkflowChoice = {
  id: string;
  source: WorkflowResolverChoice["source"];
  title: string;
  summary: string;
  operationIds: string[];
  externalAudienceVerification: ExternalAudienceVerification[];
  confidence: number;
};

export type ExternalAudienceVerification = {
  operationId: string;
  surface: "storefront";
  risk: "read";
  separateAudienceRequired: true;
  requiredPrincipalResource: "storefront";
};

export type AuthorizedWorkflowResolution =
  | {
      kind: "plan";
      disposition: "execute";
      version: string;
      plan: AuthorizedWorkflowPlan;
      safetyNotes: string[];
    }
  | {
      kind: "choices";
      disposition: "ask";
      version: string;
      choices: AuthorizedWorkflowChoice[];
      safetyNotes: string[];
    }
  | {
      kind: "control";
      disposition: "ask" | "unsupported" | "refuse";
      version: string;
      classification: {
        controlId: string;
        code: string;
        reason: string;
      };
      safePlan: AuthorizedWorkflowPlan | null;
      safetyNotes: string[];
    }
  | {
      kind: "unsupported";
      disposition: "unsupported";
      version: string;
      classification: { code: string; reason: string };
      safetyNotes: string[];
    }
  | {
      kind: "unavailable";
      disposition: "unavailable";
      version: string;
      classification: {
        code: "workflow_unavailable";
        reason: "The requested workflow is unavailable.";
      };
    };

export type ResolveAuthorizedWorkflowInput = {
  prompt: string;
  surface: AgentResource;
  principal: AgentPrincipal;
};

function boundedText(value: string, maxChars: number): string {
  return value.slice(0, maxChars);
}

function boundedNotes(values: readonly string[], maxItems: number): string[] {
  return values
    .slice(0, maxItems)
    .map((value) => boundedText(value, MAX_NOTE_CHARS));
}

type PartitionedOperations = {
  sameSurfaceOperationIds: string[];
  externalAudienceVerification: ExternalAudienceVerification[];
};

function compactPlan(
  plan: ResolvedWorkflowPlan,
  operations: PartitionedOperations,
): AuthorizedWorkflowPlan {
  return {
    source: plan.source,
    routeIds: plan.routeIds.slice(0, MAX_ROUTE_IDS),
    workflowIds: plan.workflowIds.slice(0, MAX_WORKFLOW_IDS),
    operationIds: [...operations.sameSurfaceOperationIds],
    externalAudienceVerification: [...operations.externalAudienceVerification],
    title: boundedText(plan.title, MAX_TITLE_CHARS),
    summary: boundedText(plan.summary, MAX_SUMMARY_CHARS),
    kind: plan.kind,
    confidence: Number(plan.confidence.toFixed(4)),
    requiresFacts: plan.requiresFacts,
    requiresConfirmation: plan.requiresConfirmation,
    requiresVerification: plan.requiresVerification,
    rules: boundedNotes(plan.rules, MAX_RULES),
    ...(plan.detail ? { detail: plan.detail } : {}),
  };
}

function compactChoice(
  choice: WorkflowResolverChoice,
  operations: PartitionedOperations,
): AuthorizedWorkflowChoice {
  return {
    id: choice.id,
    source: choice.source,
    title: boundedText(choice.title, MAX_TITLE_CHARS),
    summary: boundedText(choice.summary, MAX_SUMMARY_CHARS),
    operationIds: [...operations.sameSurfaceOperationIds],
    externalAudienceVerification: [...operations.externalAudienceVerification],
    confidence: Number(choice.confidence.toFixed(4)),
  };
}

function partitionOperations(
  operationIds: readonly string[],
  requestedSurface: AgentResource,
  maxOperations: number,
): PartitionedOperations | null {
  const uniqueOperationIds = [...new Set(operationIds)];
  if (uniqueOperationIds.length > maxOperations) return null;

  const sameSurfaceOperationIds: string[] = [];
  const externalAudienceVerification: ExternalAudienceVerification[] = [];
  for (const operationId of uniqueOperationIds) {
    const operation: AgentOperationManifestEntry | undefined =
      AGENT_OPERATIONS_BY_ID[operationId];
    if (
      !operation ||
      operation.exposure !== "execute" && operation.exposure !== "continuation"
    ) {
      return null;
    }
    if (operation.surface === requestedSurface) {
      sameSurfaceOperationIds.push(operationId);
      continue;
    }
    if (
      requestedSurface === "dashboard" &&
      operation.surface === "storefront" &&
      operation.risk === "read"
    ) {
      externalAudienceVerification.push({
        operationId,
        surface: "storefront",
        risk: "read",
        separateAudienceRequired: true,
        requiredPrincipalResource: "storefront",
      });
      continue;
    }
    return null;
  }
  return { sameSurfaceOperationIds, externalAudienceVerification };
}

async function sameSurfaceOperationsAreAuthorized(
  operationIds: readonly string[],
  surface: AgentResource,
  principal: AgentPrincipal,
  maxOperations: number,
): Promise<boolean> {
  const uniqueOperationIds = [...new Set(operationIds)];
  if (uniqueOperationIds.length > maxOperations) return false;

  try {
    const authorized = await Promise.all(
      uniqueOperationIds.map(async (operationId) => {
        const declaredOperation = AGENT_OPERATIONS_BY_ID[operationId];
        if (
          !declaredOperation ||
          declaredOperation.surface !== surface ||
          declaredOperation.exposure !== "execute" &&
            declaredOperation.exposure !== "continuation"
        ) {
          return false;
        }
        const operation = await getAuthorizedOperation(
          operationId,
          surface,
          principal,
        );
        return operation?.operationId === operationId &&
          operation.surface === surface;
      }),
    );
    return authorized.every(Boolean);
  } catch {
    return false;
  }
}

function unavailable(version: string): AuthorizedWorkflowResolution {
  return {
    kind: "unavailable",
    disposition: "unavailable",
    version,
    classification: {
      code: "workflow_unavailable",
      reason: "The requested workflow is unavailable.",
    },
  };
}

function compactUnsupported(
  resolution: Extract<WorkflowResolution, { kind: "unsupported" }>,
): AuthorizedWorkflowResolution {
  return {
    kind: "unsupported",
    disposition: "unsupported",
    version: resolution.version,
    classification: {
      code: boundedText(resolution.classification.code, MAX_TITLE_CHARS),
      reason: boundedText(resolution.classification.reason, MAX_SUMMARY_CHARS),
    },
    safetyNotes: boundedNotes(resolution.safetyNotes, MAX_SAFETY_NOTES),
  };
}

/**
 * Resolves a reviewed workflow, authorizes every same-surface operation, and
 * labels storefront read verification that needs a separate audience. This
 * helper is read-only: it never dispatches an operation.
 */
export async function resolveAuthorizedWorkflow(
  input: ResolveAuthorizedWorkflowInput,
): Promise<AuthorizedWorkflowResolution> {
  const resolution = resolveWorkflow({
    prompt: input.prompt,
    surface: input.surface,
  });

  if (input.principal.resource !== input.surface) {
    return unavailable(resolution.version);
  }

  if (resolution.kind === "unsupported") return compactUnsupported(resolution);

  if (resolution.kind === "plan") {
    const operations = partitionOperations(
      resolution.plan.operationIds,
      input.surface,
      MAX_PLAN_OPERATIONS,
    );
    if (
      !operations ||
      !await sameSurfaceOperationsAreAuthorized(
        operations.sameSurfaceOperationIds,
        input.surface,
        input.principal,
        MAX_PLAN_OPERATIONS,
      )
    ) {
      return unavailable(resolution.version);
    }
    return {
      kind: "plan",
      disposition: "execute",
      version: resolution.version,
      plan: compactPlan(resolution.plan, operations),
      safetyNotes: boundedNotes(resolution.safetyNotes, MAX_SAFETY_NOTES),
    };
  }

  if (resolution.kind === "choices") {
    const choices = resolution.choices.slice(0, MAX_CHOICES);
    const partitions = choices.map((choice) =>
      partitionOperations(choice.operationIds, input.surface, MAX_PLAN_OPERATIONS)
    );
    const operationIds = partitions.flatMap((partition) =>
      partition?.sameSurfaceOperationIds ?? []
    );
    if (
      partitions.some((partition) => partition === null) ||
      !await sameSurfaceOperationsAreAuthorized(
        operationIds,
        input.surface,
        input.principal,
        MAX_CHOICE_OPERATIONS,
      )
    ) {
      return unavailable(resolution.version);
    }
    return {
      kind: "choices",
      disposition: "ask",
      version: resolution.version,
      choices: choices.map((choice, index) =>
        compactChoice(choice, partitions[index]!)
      ),
      safetyNotes: boundedNotes(resolution.safetyNotes, MAX_SAFETY_NOTES),
    };
  }

  const safePlanOperations = resolution.safePlan
    ? partitionOperations(
      resolution.safePlan.operationIds,
      input.surface,
      MAX_PLAN_OPERATIONS,
    )
    : null;
  const safePlanAuthorized = safePlanOperations !== null &&
    await sameSurfaceOperationsAreAuthorized(
      safePlanOperations.sameSurfaceOperationIds,
      input.surface,
      input.principal,
      MAX_PLAN_OPERATIONS,
    );
  return {
    kind: "control",
    disposition: resolution.disposition,
    version: resolution.version,
    classification: {
      controlId: boundedText(resolution.classification.controlId, MAX_TITLE_CHARS),
      code: boundedText(resolution.classification.code, MAX_TITLE_CHARS),
      reason: boundedText(resolution.classification.reason, MAX_SUMMARY_CHARS),
    },
    safePlan: safePlanAuthorized
      ? compactPlan(resolution.safePlan!, safePlanOperations)
      : null,
    safetyNotes: boundedNotes(resolution.safetyNotes, MAX_SAFETY_NOTES),
  };
}
