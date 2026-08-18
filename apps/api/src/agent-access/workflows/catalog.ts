import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { CURATED_AGENT_WORKFLOW_CARDS } from "./cards";
import {
  AGENT_PRODUCT_CONSTRUCTION_RULES,
  AGENT_WORKFLOW_CATALOG_VERSION,
  type AgentWorkflowCard,
  type AgentWorkflowCatalog,
  type AgentWorkflowCoverageEntry,
  type AgentWorkflowMutationSemantics,
  type AgentWorkflowSurface,
} from "./types";

const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const LOCAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)+$/;
const RUNNABLE_EXPOSURES = new Set(["execute", "continuation"]);
const WORKFLOW_SURFACES = new Set<AgentWorkflowSurface>([
  "dashboard",
  "storefront",
]);
const MUTATION_METHODS: Readonly<
  Record<Exclude<AgentWorkflowMutationSemantics, "read">, ReadonlySet<string>>
> = {
  create: new Set(["POST"]),
  partial: new Set(["PATCH", "POST"]),
  replace: new Set(["PUT"]),
  command: new Set(["POST", "PATCH", "DELETE"]),
  lifecycle: new Set(["POST", "PATCH", "DELETE"]),
};

export type BuildAgentWorkflowCatalogOptions = {
  cards?: readonly AgentWorkflowCard[];
  requireCuratedCards?: boolean;
};

function assertLocalId(value: string, label: string): void {
  if (!LOCAL_ID_PATTERN.test(value)) {
    throw new Error(`${label} has an invalid local ID.`);
  }
}

function assertJsonPointer(value: string, label: string): void {
  const hasWildcardSegment = value
    .slice(1)
    .split("/")
    .some((segment) => decodePointerSegment(segment) === "*");
  if (!JSON_POINTER_PATTERN.test(value) || hasWildcardSegment) {
    throw new Error(`${label} has an invalid JSON pointer.`);
  }
}

function decodePointerSegment(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function templateHasPointer(template: unknown, pointer: string): boolean {
  assertJsonPointer(pointer, "Workflow input template");
  let value = template;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return false;
      const index = Number(segment);
      if (index >= value.length) return false;
      value = value[index];
      continue;
    }
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      return false;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return true;
}

function templateValueAtPointer(template: unknown, pointer: string): unknown {
  let value = template;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    value = Array.isArray(value)
      ? value[Number(segment)]
      : (value as Record<string, unknown>)[segment];
  }
  return value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function operationMap(
  manifest: readonly AgentOperationManifestEntry[],
): ReadonlyMap<string, AgentOperationManifestEntry> {
  const operations = new Map<string, AgentOperationManifestEntry>();
  for (const operation of manifest) {
    if (operations.has(operation.operationId)) {
      throw new Error(`Workflow validation found duplicate operation ${operation.operationId}.`);
    }
    operations.set(operation.operationId, operation);
  }
  return operations;
}

function referencedOperationIds(card: AgentWorkflowCard): string[] {
  return Array.from(new Set([
    ...card.requiredFacts.flatMap((fact) =>
      fact.source.kind === "operation"
        ? [
            fact.source.operationId,
            ...(fact.source.alternatives ?? []).map((source) => source.operationId),
          ]
        : []
    ),
    ...card.phases.flatMap((phase) =>
      phase.steps.map((step) => step.operationId)
    ),
    ...card.verification.map((evidence) => evidence.operationId),
  ])).sort();
}

function requireRunnableOperation(
  operations: ReadonlyMap<string, AgentOperationManifestEntry>,
  operationId: string,
  label: string,
): AgentOperationManifestEntry {
  const operation = operations.get(operationId);
  if (!operation) throw new Error(`${label} references unknown operation ${operationId}.`);
  if (!RUNNABLE_EXPOSURES.has(operation.exposure)) {
    throw new Error(`${label} references non-runnable operation ${operationId} (${operation.exposure}).`);
  }
  if (!WORKFLOW_SURFACES.has(operation.surface as AgentWorkflowSurface)) {
    throw new Error(`${label} references unsupported workflow surface ${operation.surface}.`);
  }
  return operation;
}

function assertMutationPolicy(
  operation: AgentOperationManifestEntry,
  mutation: AgentWorkflowMutationSemantics,
  label: string,
): void {
  if (mutation === "read") {
    if (operation.risk !== "read") {
      throw new Error(`${label} declares read semantics for non-read operation ${operation.operationId}.`);
    }
    return;
  }
  if (operation.risk === "read" || !MUTATION_METHODS[mutation].has(operation.method)) {
    throw new Error(
      `${label} declares ${mutation} semantics incompatible with ${operation.method} ${operation.operationId}.`,
    );
  }
}

export function validateAgentWorkflowCards(
  cards: readonly AgentWorkflowCard[],
  manifest: readonly AgentOperationManifestEntry[],
): void {
  const operations = operationMap(manifest);
  const cardIds = new Set<string>();

  for (const card of cards) {
    if (!WORKFLOW_ID_PATTERN.test(card.id)) {
      throw new Error(`Workflow card ${card.id} has an invalid stable ID.`);
    }
    if (cardIds.has(card.id)) throw new Error(`Duplicate workflow card ID ${card.id}.`);
    cardIds.add(card.id);
    if (!WORKFLOW_SURFACES.has(card.surface)) {
      throw new Error(`Workflow card ${card.id} has invalid surface ${card.surface}.`);
    }
    if (!card.title.trim() || !card.summary.trim() || card.examples.length === 0 || card.tags.length === 0) {
      throw new Error(`Workflow card ${card.id} requires title, summary, examples, and tags.`);
    }
    if (new Set(card.tags).size !== card.tags.length) {
      throw new Error(`Workflow card ${card.id} has duplicate tags.`);
    }
    if (
      card.constructionRules !== undefined &&
      !jsonEqual(card.constructionRules, AGENT_PRODUCT_CONSTRUCTION_RULES)
    ) {
      throw new Error(`Workflow card ${card.id} has invalid product construction rules.`);
    }

    const factIds = new Set<string>();
    for (const fact of card.requiredFacts) {
      assertLocalId(fact.id, `Workflow ${card.id} fact ${fact.id}`);
      if (factIds.has(fact.id)) throw new Error(`Workflow ${card.id} has duplicate fact ID ${fact.id}.`);
      factIds.add(fact.id);
      if (!fact.title.trim() || !fact.description.trim() || !fact.nonInferenceRule.trim()) {
        throw new Error(`Workflow ${card.id} fact ${fact.id} is incomplete.`);
      }
      if (fact.source.kind === "operation") {
        for (const source of [fact.source, ...(fact.source.alternatives ?? [])]) {
          const operation = requireRunnableOperation(
            operations,
            source.operationId,
            `Workflow ${card.id} fact ${fact.id}`,
          );
          if (operation.surface !== card.surface) {
            throw new Error(
              `Workflow ${card.id} fact ${fact.id} has wrong source surface ${operation.surface}.`,
            );
          }
          assertJsonPointer(source.responsePointer, `Workflow ${card.id} fact ${fact.id}`);
        }
      } else if (fact.source.kind === "constant") {
        if (
          !Object.hasOwn(fact, "defaultValue") ||
          !jsonEqual(fact.defaultValue, fact.source.value)
        ) {
          throw new Error(
            `Workflow ${card.id} fact ${fact.id} constant source must match its default.`,
          );
        }
      }
    }

    if (card.phases.length === 0 || card.phases[0]?.surface !== card.surface) {
      throw new Error(`Workflow ${card.id} must start on its declared surface.`);
    }
    const phaseIndexes = new Map<string, number>();
    const stepsByPhase = new Map<string, Set<string>>();
    for (const [phaseIndex, phase] of card.phases.entries()) {
      assertLocalId(phase.id, `Workflow ${card.id} phase ${phase.id}`);
      if (phaseIndexes.has(phase.id)) throw new Error(`Workflow ${card.id} has duplicate phase ID ${phase.id}.`);
      phaseIndexes.set(phase.id, phaseIndex);
      if (phase.steps.length === 0 || !phase.title.trim() || !phase.summary.trim() || phase.stopConditions.length === 0) {
        throw new Error(`Workflow ${card.id} phase ${phase.id} is incomplete.`);
      }
      for (const dependency of phase.dependsOn) {
        const dependencyIndex = phaseIndexes.get(dependency);
        if (dependencyIndex === undefined || dependencyIndex >= phaseIndex) {
          throw new Error(`Workflow ${card.id} phase ${phase.id} has invalid dependency ${dependency}.`);
        }
      }

      const stepIds = new Set<string>();
      stepsByPhase.set(phase.id, stepIds);
      for (const step of phase.steps) {
        assertLocalId(step.id, `Workflow ${card.id} step ${phase.id}.${step.id}`);
        if (stepIds.has(step.id)) {
          throw new Error(`Workflow ${card.id} phase ${phase.id} has duplicate step ID ${step.id}.`);
        }
        stepIds.add(step.id);
        const label = `Workflow ${card.id} step ${phase.id}.${step.id}`;
        const operation = requireRunnableOperation(operations, step.operationId, label);
        if (operation.surface !== phase.surface) {
          throw new Error(
            `${label} has wrong surface ${phase.surface}; ${step.operationId} is ${operation.surface}.`,
          );
        }
        assertMutationPolicy(operation, step.mutation, label);
        if (step.policies.revision !== operation.revision) {
          throw new Error(`${label} revision policy does not match ${step.operationId}.`);
        }
        if (step.policies.idempotency !== operation.idempotency) {
          throw new Error(`${label} idempotency policy does not match ${step.operationId}.`);
        }
        const expectedConfirmation = operation.risk === "read" ? "none" : "required";
        if (step.policies.confirmation !== expectedConfirmation) {
          throw new Error(`${label} confirmation policy does not match ${step.operationId}.`);
        }
        if (step.policies.stopConditions.length === 0 || step.policies.nonInferenceRules.length === 0) {
          throw new Error(`${label} requires stop and non-inference rules.`);
        }
        for (const dependency of step.input.dependencies) {
          if (!templateHasPointer(step.input.template, dependency.templatePointer)) {
            throw new Error(`${label} dependency pointer ${dependency.templatePointer} is absent from its template.`);
          }
          if (dependency.source.kind === "fact") {
            if (!factIds.has(dependency.source.factId)) {
              throw new Error(`${label} references unknown fact ${dependency.source.factId}.`);
            }
            if (dependency.source.factPointer) {
              assertJsonPointer(dependency.source.factPointer, label);
            }
          } else {
            const sourcePhaseIndex = phaseIndexes.get(dependency.source.phaseId);
            const sourceSteps = stepsByPhase.get(dependency.source.phaseId);
            if (
              sourcePhaseIndex === undefined ||
              sourcePhaseIndex > phaseIndex ||
              !sourceSteps?.has(dependency.source.stepId) ||
              (sourcePhaseIndex === phaseIndex && dependency.source.stepId === step.id)
            ) {
              throw new Error(
                `${label} has invalid step dependency ${dependency.source.phaseId}.${dependency.source.stepId}.`,
              );
            }
            assertJsonPointer(dependency.source.responsePointer, label);
          }
        }
        for (const defaultValue of step.input.defaults) {
          if (!templateHasPointer(step.input.template, defaultValue.templatePointer)) {
            throw new Error(`${label} default pointer ${defaultValue.templatePointer} is absent from its template.`);
          }
          if (!jsonEqual(
            templateValueAtPointer(step.input.template, defaultValue.templatePointer),
            defaultValue.value,
          )) {
            throw new Error(`${label} default does not match its template value.`);
          }
        }
      }
    }

    const evidenceIds = new Set<string>();
    for (const evidence of card.verification) {
      assertLocalId(evidence.id, `Workflow ${card.id} evidence ${evidence.id}`);
      if (evidenceIds.has(evidence.id)) {
        throw new Error(`Workflow ${card.id} has duplicate evidence ID ${evidence.id}.`);
      }
      evidenceIds.add(evidence.id);
      const label = `Workflow ${card.id} evidence ${evidence.id}`;
      const operation = requireRunnableOperation(operations, evidence.operationId, label);
      if (operation.surface !== evidence.surface) {
        throw new Error(`${label} has wrong surface for ${evidence.operationId}.`);
      }
      if (operation.risk !== "read") {
        throw new Error(`${label} must use a read operation.`);
      }
      if (
        !Number.isSafeInteger(evidence.bounds.maxCalls) || evidence.bounds.maxCalls < 1 ||
        !Number.isSafeInteger(evidence.bounds.maxResponseBytes) || evidence.bounds.maxResponseBytes < 1 ||
        evidence.bounds.maxResponseBytes > operation.maxResponseBytes ||
        (evidence.bounds.maxItems !== undefined &&
          (!Number.isSafeInteger(evidence.bounds.maxItems) || evidence.bounds.maxItems < 1))
      ) {
        throw new Error(`${label} has invalid verification bounds.`);
      }
      if (evidence.responsePointers.length === 0 || evidence.proves.length === 0) {
        throw new Error(`${label} requires response pointers and bounded evidence claims.`);
      }
      evidence.responsePointers.forEach((pointer) => assertJsonPointer(pointer, label));
    }
  }
}

function buildCoverage(
  cards: readonly AgentWorkflowCard[],
  manifest: readonly AgentOperationManifestEntry[],
): AgentWorkflowCoverageEntry[] {
  const workflowsByOperation = new Map<string, string[]>();
  for (const card of cards) {
    for (const operationId of referencedOperationIds(card)) {
      const workflowIds = workflowsByOperation.get(operationId) ?? [];
      workflowIds.push(card.id);
      workflowsByOperation.set(operationId, workflowIds);
    }
  }

  return manifest
    .filter((operation) =>
      WORKFLOW_SURFACES.has(operation.surface as AgentWorkflowSurface) &&
      RUNNABLE_EXPOSURES.has(operation.exposure)
    )
    .map((operation): AgentWorkflowCoverageEntry => {
      const curated = [...(workflowsByOperation.get(operation.operationId) ?? [])].sort();
      return {
        operationId: operation.operationId,
        surface: operation.surface as AgentWorkflowSurface,
        mode: curated.length > 0 ? "curated" : "operation-fallback",
        workflowIds: curated.length > 0
          ? curated
          : [`operation.${operation.operationId}`],
      };
    })
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
}

export function validateAgentWorkflowCoverage(
  coverage: readonly AgentWorkflowCoverageEntry[],
  cards: readonly AgentWorkflowCard[],
  manifest: readonly AgentOperationManifestEntry[],
): void {
  const expected = buildCoverage(cards, manifest);
  if (JSON.stringify(coverage) !== JSON.stringify(expected)) {
    throw new Error("Workflow coverage must exactly and deterministically represent every runnable dashboard/storefront operation.");
  }
}

function availableCuratedCards(
  manifest: readonly AgentOperationManifestEntry[],
): AgentWorkflowCard[] {
  const available = new Set(manifest.map((operation) => operation.operationId));
  return CURATED_AGENT_WORKFLOW_CARDS.filter((card) =>
    referencedOperationIds(card).every((operationId) => available.has(operationId))
  );
}

export function buildAgentWorkflowCatalog(
  manifest: readonly AgentOperationManifestEntry[],
  options: BuildAgentWorkflowCatalogOptions = {},
): AgentWorkflowCatalog {
  const cards = [...(
    options.cards ??
    (options.requireCuratedCards
      ? CURATED_AGENT_WORKFLOW_CARDS
      : availableCuratedCards(manifest))
  )].sort((left, right) => left.id.localeCompare(right.id));
  validateAgentWorkflowCards(cards, manifest);
  const coverage = buildCoverage(cards, manifest);
  validateAgentWorkflowCoverage(coverage, cards, manifest);

  return {
    version: AGENT_WORKFLOW_CATALOG_VERSION,
    cards,
    coverage: {
      policy: "curated-first-operation-fallback",
      fallback: {
        workflowIdTemplate: "operation.{operationId}",
        operationPointerTemplate: "#/paths/{jsonPointerEscapedPathTemplate}/{lowercaseMethod}",
        inputSchemaPointerTemplate: "#/paths/{jsonPointerEscapedPathTemplate}/{lowercaseMethod}/requestBody",
        policyPointers: {
          revision: "#/paths/{jsonPointerEscapedPathTemplate}/{lowercaseMethod}/x-scalius-agent/revision",
          idempotency: "#/paths/{jsonPointerEscapedPathTemplate}/{lowercaseMethod}/x-scalius-agent/idempotency",
          risk: "#/paths/{jsonPointerEscapedPathTemplate}/{lowercaseMethod}/x-scalius-agent/risk",
          confirmation: "#/paths/{jsonPointerEscapedPathTemplate}/{lowercaseMethod}/x-scalius-agent/risk",
        },
        rules: {
          confirmEveryMutation: true,
          stopOnConflict: true,
          stopOnAuthorizationFailure: true,
          neverInferRequiredInput: true,
          verifyMutationsWithBoundedRead: true,
        },
      },
      operations: coverage,
    },
  };
}

export function assertAgentWorkflowExtension(
  value: unknown,
  expected: AgentWorkflowCatalog,
): asserts value is AgentWorkflowCatalog {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("OpenAPI x-scalius-workflows is missing or stale for the finalized operation manifest.");
  }
}
