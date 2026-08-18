import {
  AGENT_OPERATIONS,
  AGENT_OPERATIONS_BY_ID,
  AGENT_WORKFLOW_CATALOG,
} from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import {
  dispatchAgentOperation,
  type AgentOperationInput,
} from "../dispatch";
import {
  AGENT_MAX_PARALLEL_READS,
  AGENT_MAX_RESULT_BYTES,
  utf8ByteLength,
} from "../limits";
import type { AgentPrincipal, AgentResource } from "../types";
import { createWorkflowResolver } from "../workflows/resolver-core";
import type {
  AgentWorkflowCard,
  AgentWorkflowOutputProjection,
  AgentWorkflowRequiredFact,
  AgentWorkflowStep,
} from "../workflows/types";
import { getAuthorizedOperation } from "./operations";

type JsonScalar = string | number | boolean | null;
type ProjectedValue = JsonScalar | JsonScalar[] | Record<string, JsonScalar> |
  Array<Record<string, JsonScalar>>;
type ProjectedStep = Record<string, ProjectedValue>;

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
      outputs: Record<string, ProjectedStep>;
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
  namespace: string;
  step: AgentWorkflowStep;
  operation: AgentOperationManifestEntry;
  input: AgentOperationInput;
};

const MAX_TEMPLATE_NODES = 1_000;
const MAX_TEMPLATE_DEPTH = 16;
const MAX_PROJECTION_SELECTORS = 24;
const MAX_PROJECTION_FIELDS = 32;
const MAX_PROJECTED_ITEMS = 100;
const MAX_ALIAS_LENGTH = 64;
const FORBIDDEN_POINTER_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "*",
  "-",
  ".",
  "..",
]);
const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

const resolveWorkflow = createWorkflowResolver({
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

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value);
}

function isSafeAlias(value: string): boolean {
  return value.length <= MAX_ALIAS_LENGTH && ALIAS_PATTERN.test(value) &&
    !FORBIDDEN_POINTER_SEGMENTS.has(value);
}

function parsePointer(pointer: string): string[] | null {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const segments: string[] = [];
  for (const encoded of pointer.slice(1).split("/")) {
    if (encoded === "" || /~(?:[^01]|$)/.test(encoded)) return null;
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      segment === "" ||
      FORBIDDEN_POINTER_SEGMENTS.has(segment) ||
      segment.includes("*") ||
      segment.startsWith("$") ||
      segment.startsWith("@")
    ) return null;
    segments.push(segment);
  }
  return segments;
}

function ownValue(container: unknown, segment: string): { found: true; value: unknown } | null {
  if (Array.isArray(container)) {
    if (!/^(0|[1-9][0-9]*)$/.test(segment)) return null;
    const index = Number(segment);
    if (!Number.isSafeInteger(index) || index >= container.length) return null;
    return { found: true, value: container[index] };
  }
  if (!isRecord(container)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(container, segment);
  if (!descriptor || !("value" in descriptor)) return null;
  return { found: true, value: descriptor.value };
}

function resolvePointer(root: unknown, pointer: string): { found: true; value: unknown } | null {
  const segments = parsePointer(pointer);
  if (!segments) return null;
  let value = root;
  for (const segment of segments) {
    const next = ownValue(value, segment);
    if (!next) return null;
    value = next.value;
  }
  return { found: true, value };
}

function cloneFixedJson(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): unknown | undefined {
  state.nodes += 1;
  if (state.nodes > MAX_TEMPLATE_NODES || depth > MAX_TEMPLATE_DEPTH) return undefined;
  if (isScalar(value)) return value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const cloned = cloneFixedJson(item, state, depth + 1);
      if (cloned === undefined) return undefined;
      output.push(cloned);
    }
    return output;
  }
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_POINTER_SEGMENTS.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const cloned = cloneFixedJson(descriptor.value, state, depth + 1);
    if (cloned === undefined) return undefined;
    output[key] = cloned;
  }
  return output;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function setExistingPointer(root: unknown, pointer: string, value: unknown): boolean {
  const segments = parsePointer(pointer);
  if (!segments || segments.length === 0) return false;
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    const next = ownValue(parent, segment);
    if (!next) return false;
    parent = next.value;
  }
  const last = segments.at(-1)!;
  if (!ownValue(parent, last)) return false;
  if (Array.isArray(parent)) {
    parent[Number(last)] = value;
    return true;
  }
  if (!isRecord(parent)) return false;
  parent[last] = value;
  return true;
}

function asOperationInput(value: unknown): AgentOperationInput | null {
  if (!isRecord(value)) return null;
  const allowedKeys = new Set(["path", "query", "body"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;

  const path = value.path;
  if (path !== undefined && (!isRecord(path) || Object.values(path).some((item) =>
    typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean"
  ))) return null;

  const query = value.query;
  if (query !== undefined && (!isRecord(query) || Object.values(query).some((item) =>
    Array.isArray(item) ? item.some((entry) => !isScalar(entry)) : !isScalar(item)
  ))) return null;

  return value as AgentOperationInput;
}

function fixedFactValue(fact: AgentWorkflowRequiredFact): unknown | undefined {
  if (Object.hasOwn(fact, "defaultValue")) {
    return cloneFixedJson(fact.defaultValue, { nodes: 0 });
  }
  if (fact.source.kind === "constant") {
    return cloneFixedJson(fact.source.value, { nodes: 0 });
  }
  return undefined;
}

function validateFacts(
  card: AgentWorkflowCard,
  selectedOperationIds: ReadonlySet<string>,
): Map<string, AgentWorkflowRequiredFact> | null {
  const facts = new Map<string, AgentWorkflowRequiredFact>();
  for (const fact of card.requiredFacts) {
    if (!fact.id || facts.has(fact.id) || fact.source.kind === "merchant") return null;
    if (fact.source.kind === "constant") {
      const constant = cloneFixedJson(fact.source.value, { nodes: 0 });
      if (constant === undefined) return null;
      if (Object.hasOwn(fact, "defaultValue") && !jsonEqual(constant, fact.defaultValue)) {
        return null;
      }
    }
    if (fact.source.kind === "operation") {
      const references = [fact.source, ...(fact.source.alternatives ?? [])];
      if (references.some((reference) =>
        !selectedOperationIds.has(reference.operationId) ||
        parsePointer(reference.responsePointer) === null
      )) return null;
    }
    facts.set(fact.id, fact);
  }
  return facts;
}

function materializeInput(
  step: AgentWorkflowStep,
  facts: ReadonlyMap<string, AgentWorkflowRequiredFact>,
): AgentOperationInput | null {
  const template = cloneFixedJson(step.input.template, { nodes: 0 });
  if (template === undefined) return null;

  for (const inputDefault of step.input.defaults) {
    const current = resolvePointer(template, inputDefault.templatePointer);
    const value = cloneFixedJson(inputDefault.value, { nodes: 0 });
    if (!current || value === undefined || !jsonEqual(current.value, value)) return null;
    if (!setExistingPointer(template, inputDefault.templatePointer, value)) return null;
  }

  for (const dependency of step.input.dependencies) {
    if (dependency.source.kind !== "fact") return null;
    const fact = facts.get(dependency.source.factId);
    if (!fact) return null;
    let value = fixedFactValue(fact);
    if (value === undefined) return null;
    if (dependency.source.factPointer !== undefined) {
      const selected = resolvePointer(value, dependency.source.factPointer);
      if (!selected) return null;
      value = cloneFixedJson(selected.value, { nodes: 0 });
      if (value === undefined) return null;
    }
    if (!setExistingPointer(template, dependency.templatePointer, value)) return null;
  }

  return asOperationInput(template);
}

function projectFields(
  value: unknown,
  fields: NonNullable<AgentWorkflowOutputProjection["selectors"][number]["fields"]>,
): Record<string, JsonScalar> | null {
  if (!isRecord(value) || fields.length === 0 || fields.length > MAX_PROJECTION_FIELDS) return null;
  const projected: Record<string, JsonScalar> = {};
  for (const field of fields) {
    if (!isSafeAlias(field.alias) || Object.hasOwn(projected, field.alias)) return null;
    const selected = resolvePointer(value, field.pointer);
    if (!selected || !isScalar(selected.value)) return null;
    projected[field.alias] = selected.value;
  }
  return projected;
}

function projectResponse(
  response: unknown,
  projection: AgentWorkflowOutputProjection,
): ProjectedStep | null {
  if (
    projection.selectors.length === 0 ||
    projection.selectors.length > MAX_PROJECTION_SELECTORS
  ) return null;
  const output: ProjectedStep = {};
  for (const selector of projection.selectors) {
    if (!isSafeAlias(selector.alias) || Object.hasOwn(output, selector.alias)) return null;
    const selected = resolvePointer(response, selector.pointer);
    if (!selected) return null;

    let value: ProjectedValue;
    if (selector.maxItems !== undefined) {
      if (
        !Array.isArray(selected.value) ||
        !Number.isSafeInteger(selector.maxItems) ||
        selector.maxItems < 1 ||
        selector.maxItems > MAX_PROJECTED_ITEMS
      ) return null;
      const items = selected.value.slice(0, selector.maxItems);
      if (selector.fields) {
        const projectedItems: Array<Record<string, JsonScalar>> = [];
        for (const item of items) {
          const projected = projectFields(item, selector.fields);
          if (!projected) return null;
          projectedItems.push(projected);
        }
        value = projectedItems;
      } else {
        if (items.some((item) => !isScalar(item))) return null;
        value = items as JsonScalar[];
      }
    } else if (selector.fields) {
      const projected = projectFields(selected.value, selector.fields);
      if (!projected) return null;
      value = projected;
    } else {
      if (!isScalar(selected.value)) return null;
      value = selected.value;
    }
    output[selector.alias] = value;
  }
  return output;
}

function sameOperationSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length && rightSet.size === right.length &&
    leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function selectDetailedReadCard(
  prompt: string,
  surface: AgentResource,
): { version: string; card: AgentWorkflowCard } | null {
  const resolution = resolveWorkflow({ prompt, surface });
  if (
    resolution.kind !== "plan" ||
    resolution.disposition !== "execute" ||
    resolution.plan.source !== "route" ||
    resolution.plan.kind !== "read" ||
    !resolution.plan.detail ||
    resolution.plan.routeIds.length !== 1 ||
    resolution.plan.workflowIds.length !== 1
  ) return null;

  const route = AGENT_WORKFLOW_CATALOG.routes.find((candidate) =>
    candidate.id === resolution.plan.routeIds[0]
  );
  const workflowId = resolution.plan.workflowIds[0]!;
  const cards = AGENT_WORKFLOW_CATALOG.cards.filter((candidate) => candidate.id === workflowId);
  if (
    !route ||
    route.surface !== surface ||
    route.kind !== "read" ||
    route.workflowId !== workflowId ||
    cards.length !== 1
  ) return null;
  const card = cards[0]!;
  const steps = card.phases.flatMap((phase) => phase.steps);
  if (
    card.surface !== surface ||
    steps.length === 0 ||
    !sameOperationSet(route.operationIds, resolution.plan.operationIds) ||
    !sameOperationSet(route.operationIds, [...new Set(steps.map((step) => step.operationId))])
  ) return null;
  return { version: resolution.version, card };
}

function prepareCard(
  card: AgentWorkflowCard,
  surface: AgentResource,
): { phases: PreparedStep[][]; uniqueOperationIds: string[] } | null {
  const steps = card.phases.flatMap((phase) => phase.steps);
  const selectedOperationIds = new Set(steps.map((step) => step.operationId));
  const facts = validateFacts(card, selectedOperationIds);
  if (!facts) return null;

  const phaseIds = new Set<string>();
  const namespaces = new Set<string>();
  const phases: PreparedStep[][] = [];
  for (const phase of card.phases) {
    if (
      phase.surface !== surface ||
      !phase.id ||
      phaseIds.has(phase.id) ||
      phase.dependsOn.some((dependency) => !phaseIds.has(dependency))
    ) return null;
    phaseIds.add(phase.id);
    const preparedPhase: PreparedStep[] = [];
    for (const step of phase.steps) {
      const namespace = `${phase.id}.${step.id}`;
      const operation = AGENT_OPERATIONS_BY_ID[step.operationId];
      if (
        !step.id ||
        namespaces.has(namespace) ||
        step.mutation !== "read" ||
        !step.output ||
        !operation ||
        operation.surface !== surface ||
        operation.risk !== "read" ||
        operation.openWorld ||
        operation.exposure !== "execute" && operation.exposure !== "continuation"
      ) return null;
      const input = materializeInput(step, facts);
      if (!input) return null;
      namespaces.add(namespace);
      preparedPhase.push({ namespace, step, operation, input });
    }
    phases.push(preparedPhase);
  }
  return { phases, uniqueOperationIds: [...selectedOperationIds] };
}

async function dispatchProjectedStep(
  prepared: PreparedStep,
  principal: AgentPrincipal,
  env: Env,
  ctx: ExecutionContext,
): Promise<ProjectedStep> {
  const result = await dispatchAgentOperation({
    operation: prepared.operation,
    input: prepared.input,
    principal,
    env,
    ctx,
  });
  if (
    !result.ok ||
    result.operationId !== prepared.operation.operationId ||
    result.artifact ||
    result.redacted ||
    result.oneTimeSecret ||
    result.sensitiveContinuation
  ) throw new Error("workflow_read_failed");
  const projected = projectResponse(result.data, prepared.step.output!);
  if (!projected) throw new Error("workflow_projection_failed");
  return projected;
}

async function executePreparedPhase(
  phase: readonly PreparedStep[],
  principal: AgentPrincipal,
  env: Env,
  ctx: ExecutionContext,
): Promise<Array<[string, ProjectedStep]>> {
  const results: Array<[string, ProjectedStep]> = [];
  let index = 0;
  while (index < phase.length) {
    const first = phase[index]!;
    const width = first.operation.batch === "parallel"
      ? Math.min(
          AGENT_MAX_PARALLEL_READS,
          phase.slice(index).findIndex((item) => item.operation.batch !== "parallel") === -1
            ? phase.length - index
            : phase.slice(index).findIndex((item) => item.operation.batch !== "parallel"),
        )
      : 1;
    const wave = phase.slice(index, index + Math.max(width, 1));
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
    const selected = selectDetailedReadCard(input.prompt, input.surface);
    if (!selected) return unavailable();
    const prepared = prepareCard(selected.card, input.surface);
    if (!prepared) return unavailable();

    const authorized = new Map<string, AgentOperationManifestEntry>();
    for (const operationId of prepared.uniqueOperationIds) {
      const operation = await getAuthorizedOperation(operationId, input.surface, input.principal);
      if (
        !operation ||
        operation.operationId !== operationId ||
        operation.surface !== input.surface ||
        operation.risk !== "read" ||
        operation.openWorld ||
        operation.exposure !== "execute" && operation.exposure !== "continuation"
      ) return unavailable();
      authorized.set(operationId, operation);
    }

    const outputs: Record<string, ProjectedStep> = {};
    for (const phase of prepared.phases) {
      const authorizedPhase = phase.map((step) => ({
        ...step,
        operation: authorized.get(step.operation.operationId)!,
      }));
      const phaseResults = await executePreparedPhase(
        authorizedPhase,
        input.principal,
        input.env,
        input.ctx,
      );
      for (const [namespace, projected] of phaseResults) outputs[namespace] = projected;
    }

    const result: AuthorizedWorkflowReadResult = {
      kind: "result",
      disposition: "execute",
      version: selected.version,
      workflowId: selected.card.id,
      outputs,
    };
    return utf8ByteLength(JSON.stringify(result)) < AGENT_MAX_RESULT_BYTES
      ? result
      : unavailable();
  } catch {
    return unavailable();
  }
}
