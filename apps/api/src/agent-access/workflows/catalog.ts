import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { CURATED_AGENT_WORKFLOW_CARDS } from "./cards";
import { AGENT_WORKFLOW_CONTROLS } from "./controls";
import { DASHBOARD_AGENT_WORKFLOW_ROUTES } from "./routes-dashboard";
import { AGENT_STOREFRONT_INTENT_ROUTES } from "./routes-storefront";
import {
  AGENT_PRODUCT_CONSTRUCTION_RULES,
  AGENT_WORKFLOW_CATALOG_VERSION,
  type AgentWorkflowCard,
  type AgentWorkflowCatalog,
  type AgentWorkflowControl,
  type AgentWorkflowCoverageEntry,
  type AgentWorkflowIntentRoute,
  type AgentWorkflowMutationSemantics,
  type AgentWorkflowOutputField,
  type AgentWorkflowOutputProjection,
  type AgentWorkflowOutputSelector,
  type AgentWorkflowRepeat,
  type AgentWorkflowRequiredFact,
  type AgentWorkflowSurface,
} from "./types";

const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const LOCAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const JSON_POINTER_PATTERN = /^(?:\/(?:[^~/]|~[01])*)+$/;
const PROJECTION_ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_PROJECTION_SEGMENTS = new Set([
  "",
  "-",
  ".",
  "..",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "constructor",
  "toLocaleString",
  "toString",
  "valueOf",
]);
const MAX_PROJECTION_SELECTORS = 12;
const MAX_PROJECTION_FIELDS = 16;
const MAX_PROJECTION_TOTAL_FIELDS = 24;
const MAX_PROJECTION_ITEMS = 100;
const DAILY_WORKFLOW_ID = "operations.daily-snapshot.v1";
const DAILY_WORKFLOW_HARD_MAX_BYTES = 12 * 1024;
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
  routes?: readonly AgentWorkflowIntentRoute[];
  controls?: readonly AgentWorkflowControl[];
  requireCuratedCards?: boolean;
};

function assertLocalId(value: string, label: string): void {
  if (!LOCAL_ID_PATTERN.test(value)) {
    throw new Error(`${label} has an invalid local ID.`);
  }
}

function assertJsonPointer(value: string, label: string): void {
  const invalidSegment = value
    .slice(1)
    .split("/")
    .map(decodePointerSegment)
    .find((segment) =>
      FORBIDDEN_PROJECTION_SEGMENTS.has(segment) ||
      segment.includes("*") ||
      segment.includes("{") ||
      segment.includes("}") ||
      segment.startsWith("$") ||
      segment.startsWith("@")
    );
  if (!JSON_POINTER_PATTERN.test(value) || invalidSegment !== undefined) {
    throw new Error(`${label} has an invalid JSON pointer.`);
  }
}

function decodePointerSegment(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: object,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} has unsupported declarative key ${unknown}.`);
}

function assertProjectionPointer(value: string, label: string): void {
  assertJsonPointer(value, label);
  const invalidSegment = value
    .slice(1)
    .split("/")
    .map(decodePointerSegment)
    .find((segment) =>
      FORBIDDEN_PROJECTION_SEGMENTS.has(segment) ||
      segment.includes("*") ||
      segment.startsWith("$") ||
      segment.startsWith("@")
    );
  if (invalidSegment !== undefined) {
    throw new Error(`${label} has a wildcard, pseudo, or prototype JSON pointer segment.`);
  }
}

function assertProjectionAlias(value: string, label: string): void {
  if (
    !PROJECTION_ALIAS_PATTERN.test(value) ||
    FORBIDDEN_PROJECTION_SEGMENTS.has(value)
  ) {
    throw new Error(`${label} has an invalid or prototype projection alias.`);
  }
}

function schemaVariants(schema: unknown): Record<string, unknown>[] {
  if (!isRecord(schema)) return [];
  const variants = [schema.oneOf, schema.anyOf, schema.allOf]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter(isRecord);
  return variants.length > 0 ? variants.flatMap(schemaVariants) : [schema];
}

function schemaNodesAtPointer(
  roots: readonly Record<string, unknown>[],
  pointer: string,
): Record<string, unknown>[] {
  let nodes = roots.flatMap(schemaVariants);
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    nodes = nodes.flatMap((node) =>
      schemaVariants(node).flatMap((variant) => {
        const properties = isRecord(variant.properties) ? variant.properties : null;
        const property = properties && Object.hasOwn(properties, segment)
          ? properties[segment]
          : null;
        return isRecord(property) ? schemaVariants(property) : [];
      })
    );
    if (nodes.length === 0) return [];
  }
  return nodes.flatMap(schemaVariants);
}

type ProjectionSchemaShape = "scalar" | "object" | "array" | "ambiguous" | "unknown";

function schemaShape(nodes: readonly Record<string, unknown>[]): ProjectionSchemaShape {
  const shapes = new Set<Exclude<ProjectionSchemaShape, "ambiguous" | "unknown">>();
  for (const node of nodes.flatMap(schemaVariants)) {
    const types = typeof node.type === "string"
      ? [node.type]
      : Array.isArray(node.type)
        ? node.type.filter((value): value is string => typeof value === "string")
        : [];
    if (types.length === 0) {
      if (isRecord(node.properties)) shapes.add("object");
      else if (isRecord(node.items)) shapes.add("array");
      else if (node.enum !== undefined || node.const !== undefined) shapes.add("scalar");
      continue;
    }
    for (const type of types) {
      if (type === "object") shapes.add("object");
      else if (type === "array") shapes.add("array");
      else if (type !== "null") shapes.add("scalar");
    }
  }
  if (shapes.size === 0) return "unknown";
  if (shapes.size > 1) return "ambiguous";
  return [...shapes][0]!;
}

function arrayItemSchemas(nodes: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return nodes.flatMap(schemaVariants).flatMap((node) =>
    isRecord(node.items) ? schemaVariants(node.items) : []
  );
}

function assertProjectionFields(
  fields: readonly AgentWorkflowOutputField[] | undefined,
  schemaNodes: readonly Record<string, unknown>[],
  label: string,
): number {
  if (!fields || fields.length < 1) {
    throw new Error(`${label} requires selected scalar fields.`);
  }
  if (fields.length > MAX_PROJECTION_FIELDS) {
    throw new Error(`${label} has too many selected fields.`);
  }
  const aliases = new Set<string>();
  const pointers = new Set<string>();
  for (const [index, field] of fields.entries()) {
    const fieldLabel = `${label} field[${index}]`;
    assertExactKeys(
      field,
      new Set(["pointer", "alias"]),
      fieldLabel,
    );
    assertProjectionPointer(field.pointer, fieldLabel);
    assertProjectionAlias(field.alias, fieldLabel);
    if (aliases.has(field.alias)) {
      throw new Error(`${label} has duplicate projection alias ${field.alias}.`);
    }
    if (pointers.has(field.pointer)) {
      throw new Error(`${label} has duplicate projection pointer ${field.pointer}.`);
    }
    aliases.add(field.alias);
    pointers.add(field.pointer);
    const selected = schemaNodesAtPointer(schemaNodes, field.pointer);
    if (selected.length === 0) {
      throw new Error(`${fieldLabel} references unknown output field ${field.pointer}.`);
    }
    if (schemaShape(selected) !== "scalar") {
      throw new Error(`${fieldLabel} must select one scalar output field.`);
    }
  }
  return fields.length;
}

function assertProjectionSelector(
  selector: AgentWorkflowOutputSelector,
  outputSchema: Record<string, unknown>,
  label: string,
): number {
  assertExactKeys(
    selector,
    new Set(["pointer", "alias", "maxItems", "fields"]),
    label,
  );
  assertProjectionPointer(selector.pointer, label);
  assertProjectionAlias(selector.alias, label);
  const selected = schemaNodesAtPointer([outputSchema], selector.pointer);
  if (selected.length === 0) {
    throw new Error(`${label} references unknown output field ${selector.pointer}.`);
  }
  const shape = schemaShape(selected);
  if (shape === "array") {
    if (
      !Number.isSafeInteger(selector.maxItems) ||
      selector.maxItems! < 1 ||
      selector.maxItems! > MAX_PROJECTION_ITEMS
    ) {
      throw new Error(`${label} array requires bounded maxItems of 1-${MAX_PROJECTION_ITEMS}.`);
    }
    const schemaLimits = selected.flatMap(schemaVariants).flatMap((schema) =>
      typeof schema.maxItems === "number" ? [schema.maxItems] : []
    );
    if (
      schemaLimits.length > 0 &&
      selector.maxItems! > Math.min(...schemaLimits)
    ) {
      throw new Error(`${label} maxItems exceeds the operation output schema.`);
    }
    const items = arrayItemSchemas(selected);
    if (items.length === 0) throw new Error(`${label} array has no declared item schema.`);
    const itemShape = schemaShape(items);
    if (itemShape === "object") {
      return assertProjectionFields(selector.fields, items, label);
    }
    if (itemShape !== "scalar" || selector.fields !== undefined) {
      throw new Error(`${label} has invalid selected fields for its array item schema.`);
    }
    return 0;
  }
  if (shape === "object") {
    if (selector.maxItems !== undefined) {
      throw new Error(`${label} has maxItems for a non-array output field.`);
    }
    return assertProjectionFields(selector.fields, selected, label);
  }
  if (shape !== "scalar") {
    throw new Error(`${label} has an unknown or ambiguous output schema.`);
  }
  if (selector.maxItems !== undefined || selector.fields !== undefined) {
    throw new Error(`${label} scalar output cannot declare maxItems or selected fields.`);
  }
  return 0;
}

function assertOutputProjection(
  projection: AgentWorkflowOutputProjection,
  operation: AgentOperationManifestEntry,
  label: string,
): void {
  assertExactKeys(
    projection,
    new Set(["selectors"]),
    `${label} output projection`,
  );
  if (
    projection.selectors.length < 1 ||
    projection.selectors.length > MAX_PROJECTION_SELECTORS
  ) {
    throw new Error(`${label} has too many output selectors or no selectors.`);
  }
  if (!isRecord(operation.outputSchema)) {
    throw new Error(`${label} has no object output schema for projection validation.`);
  }
  const aliases = new Set<string>();
  const pointers = new Set<string>();
  let totalFields = 0;
  for (const [index, selector] of projection.selectors.entries()) {
    const selectorLabel = `${label} output selector[${index}]`;
    if (aliases.has(selector.alias)) {
      throw new Error(`${label} has duplicate projection alias ${selector.alias}.`);
    }
    if (pointers.has(selector.pointer)) {
      throw new Error(`${label} has duplicate projection pointer ${selector.pointer}.`);
    }
    aliases.add(selector.alias);
    pointers.add(selector.pointer);
    totalFields += assertProjectionSelector(selector, operation.outputSchema, selectorLabel);
  }
  if (totalFields > MAX_PROJECTION_TOTAL_FIELDS) {
    throw new Error(`${label} has too many selected fields across its output projection.`);
  }
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

function assertStepRepeat(
  repeat: AgentWorkflowRepeat,
  template: unknown,
  occupiedTemplatePointers: ReadonlySet<string>,
  facts: ReadonlyMap<string, AgentWorkflowRequiredFact>,
  operation: AgentOperationManifestEntry,
  label: string,
): void {
  if (!isRecord(repeat)) throw new Error(`${label} repeat must be an object.`);
  assertExactKeys(
    repeat,
    new Set([
      "factId",
      "orderPointer",
      "itemMapPointer",
      "minItems",
      "maxItems",
      "bindings",
      "capture",
    ]),
    `${label} repeat`,
  );
  const fact = facts.get(repeat.factId);
  if (!fact) throw new Error(`${label} repeat references unknown fact ${repeat.factId}.`);
  if (fact.source.kind !== "merchant") {
    throw new Error(`${label} repeat fact ${repeat.factId} must be merchant-authoritative.`);
  }
  assertProjectionPointer(repeat.orderPointer, `${label} repeat orderPointer`);
  assertProjectionPointer(repeat.itemMapPointer, `${label} repeat itemMapPointer`);
  if (repeat.orderPointer === repeat.itemMapPointer) {
    throw new Error(`${label} repeat order and item-map pointers must differ.`);
  }
  if (
    !Number.isSafeInteger(repeat.minItems) ||
    !Number.isSafeInteger(repeat.maxItems) ||
    repeat.minItems < 1 ||
    repeat.minItems > repeat.maxItems ||
    repeat.maxItems > 250
  ) {
    throw new Error(`${label} repeat bounds must satisfy 1 <= minItems <= maxItems <= 250.`);
  }
  if (!Array.isArray(repeat.bindings) || repeat.bindings.length < 1 || repeat.bindings.length > 16) {
    throw new Error(`${label} repeat requires 1-16 bindings.`);
  }
  const templatePointers = new Set<string>();
  const itemPointers = new Set<string>();
  for (const [index, binding] of repeat.bindings.entries()) {
    const bindingLabel = `${label} repeat binding[${index}]`;
    if (!isRecord(binding)) throw new Error(`${bindingLabel} must be an object.`);
    assertExactKeys(binding, new Set(["templatePointer", "itemPointer"]), bindingLabel);
    assertProjectionPointer(binding.templatePointer, `${bindingLabel} templatePointer`);
    assertProjectionPointer(binding.itemPointer, `${bindingLabel} itemPointer`);
    if (!templateHasPointer(template, binding.templatePointer)) {
      throw new Error(`${bindingLabel} pointer ${binding.templatePointer} is absent from its template.`);
    }
    if (
      templatePointers.has(binding.templatePointer) ||
      itemPointers.has(binding.itemPointer)
    ) {
      throw new Error(`${label} repeat has duplicate binding pointers.`);
    }
    if (occupiedTemplatePointers.has(binding.templatePointer)) {
      throw new Error(`${bindingLabel} conflicts with a dependency or default pointer.`);
    }
    templatePointers.add(binding.templatePointer);
    itemPointers.add(binding.itemPointer);
  }
  if (!isRecord(repeat.capture)) throw new Error(`${label} repeat capture must be an object.`);
  assertExactKeys(
    repeat.capture,
    new Set(["responsePointer", "itemPointer"]),
    `${label} repeat capture`,
  );
  assertProjectionPointer(repeat.capture.responsePointer, `${label} repeat capture responsePointer`);
  assertProjectionPointer(repeat.capture.itemPointer, `${label} repeat capture itemPointer`);
  if (itemPointers.has(repeat.capture.itemPointer)) {
    throw new Error(`${label} repeat capture conflicts with a binding item pointer.`);
  }
  if (!isRecord(operation.outputSchema)) {
    throw new Error(`${label} repeat operation has no object output schema.`);
  }
  const selected = schemaNodesAtPointer(
    [operation.outputSchema],
    repeat.capture.responsePointer,
  );
  if (selected.length === 0) {
    throw new Error(
      `${label} repeat capture references unknown output field ${repeat.capture.responsePointer}.`,
    );
  }
  if (schemaShape(selected) !== "scalar") {
    throw new Error(`${label} repeat capture must select one scalar output field.`);
  }
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

function assertCompactText(value: string, label: string, maxLength = 500): void {
  if (!value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be non-empty and at most ${maxLength} characters.`);
  }
}

function assertCompactTextList(
  values: readonly string[],
  label: string,
  options: { min?: number; max?: number; itemMax?: number } = {},
): void {
  const min = options.min ?? 1;
  const max = options.max ?? 20;
  const itemMax = options.itemMax ?? 500;
  if (values.length < min || values.length > max || new Set(values).size !== values.length) {
    throw new Error(`${label} must contain ${min}-${max} unique entries.`);
  }
  values.forEach((value, index) => assertCompactText(value, `${label}[${index}]`, itemMax));
}

function operationAllowedForRoute(
  surface: AgentWorkflowSurface,
  operation: AgentOperationManifestEntry,
): boolean {
  return operation.surface === surface ||
    (surface === "dashboard" && operation.surface === "storefront" && operation.risk === "read");
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
    const factsById = new Map<string, AgentWorkflowRequiredFact>();
    for (const fact of card.requiredFacts) {
      assertLocalId(fact.id, `Workflow ${card.id} fact ${fact.id}`);
      if (factIds.has(fact.id)) throw new Error(`Workflow ${card.id} has duplicate fact ID ${fact.id}.`);
      factIds.add(fact.id);
      factsById.set(fact.id, fact);
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
        if (card.id === DAILY_WORKFLOW_ID && step.output === undefined) {
          throw new Error(`${label} requires a reviewed output projection.`);
        }
        if (step.output !== undefined) {
          if (step.mutation !== "read") {
            throw new Error(`${label} only read steps may declare an output projection.`);
          }
          assertOutputProjection(step.output, operation, label);
        }
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
        const occupiedTemplatePointers = new Set<string>();
        for (const dependency of step.input.dependencies) {
          if (!templateHasPointer(step.input.template, dependency.templatePointer)) {
            throw new Error(`${label} dependency pointer ${dependency.templatePointer} is absent from its template.`);
          }
          if (occupiedTemplatePointers.has(dependency.templatePointer)) {
            throw new Error(`${label} has duplicate dependency pointer ${dependency.templatePointer}.`);
          }
          occupiedTemplatePointers.add(dependency.templatePointer);
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
          occupiedTemplatePointers.add(defaultValue.templatePointer);
        }
        if (step.repeat !== undefined) {
          assertStepRepeat(
            step.repeat,
            step.input.template,
            occupiedTemplatePointers,
            factsById,
            operation,
            label,
          );
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
    if (
      card.id === DAILY_WORKFLOW_ID &&
      new TextEncoder().encode(JSON.stringify(card)).byteLength > DAILY_WORKFLOW_HARD_MAX_BYTES
    ) {
      throw new Error(`Workflow ${card.id} exceeds the 12 KiB card limit.`);
    }
  }
}

export function validateAgentWorkflowRoutes(
  routes: readonly AgentWorkflowIntentRoute[],
  cards: readonly AgentWorkflowCard[],
  manifest: readonly AgentOperationManifestEntry[],
): void {
  const operations = operationMap(manifest);
  const cardsById = new Map(cards.map((card) => [card.id, card] as const));
  const routeIds = new Set<string>();

  for (const route of routes) {
    if (!WORKFLOW_ID_PATTERN.test(route.id)) {
      throw new Error(`Workflow route ${route.id} has an invalid stable ID.`);
    }
    if (routeIds.has(route.id)) throw new Error(`Duplicate workflow route ID ${route.id}.`);
    routeIds.add(route.id);
    if (!WORKFLOW_SURFACES.has(route.surface)) {
      throw new Error(`Workflow route ${route.id} has invalid surface ${route.surface}.`);
    }
    assertCompactText(route.title, `Workflow route ${route.id} title`, 120);
    assertCompactText(route.summary, `Workflow route ${route.id} summary`, 500);
    assertCompactTextList(route.examples, `Workflow route ${route.id} examples`, {
      max: 5,
      itemMax: 500,
    });
    assertCompactTextList(route.tags, `Workflow route ${route.id} tags`, {
      max: 12,
      itemMax: 60,
    });
    assertCompactTextList(route.rules, `Workflow route ${route.id} rules`, {
      max: 6,
      itemMax: 300,
    });
    if (
      route.operationIds.length < 1 ||
      route.operationIds.length > 20 ||
      new Set(route.operationIds).size !== route.operationIds.length
    ) {
      throw new Error(`Workflow route ${route.id} requires 1-20 unique operations.`);
    }

    const referenced = route.operationIds.map((operationId) => {
      const operation = requireRunnableOperation(
        operations,
        operationId,
        `Workflow route ${route.id}`,
      );
      if (!operationAllowedForRoute(route.surface, operation)) {
        throw new Error(
          `Workflow route ${route.id} has wrong-surface operation ${operationId}.`,
        );
      }
      return operation;
    });
    const hasMutation = referenced.some((operation) => operation.risk !== "read");
    if ((route.kind === "read") === hasMutation) {
      throw new Error(`Workflow route ${route.id} kind does not match its operation risks.`);
    }
    if (route.requiresConfirmation !== hasMutation) {
      throw new Error(`Workflow route ${route.id} confirmation does not match its operation risks.`);
    }

    if (route.workflowId) {
      const card = cardsById.get(route.workflowId);
      if (!card) {
        throw new Error(`Workflow route ${route.id} references unknown card ${route.workflowId}.`);
      }
      if (card.surface !== route.surface) {
        throw new Error(`Workflow route ${route.id} references wrong-surface card ${route.workflowId}.`);
      }
      const cardOperations = new Set(referencedOperationIds(card));
      for (const operationId of route.operationIds) {
        if (!cardOperations.has(operationId)) {
          throw new Error(
            `Workflow route ${route.id} operation ${operationId} is absent from card ${route.workflowId}.`,
          );
        }
      }
    }
    if (new TextEncoder().encode(JSON.stringify(route)).byteLength > 2 * 1024) {
      throw new Error(`Workflow route ${route.id} exceeds the 2 KiB compact-route limit.`);
    }
  }
}

export function validateAgentWorkflowControls(
  controls: readonly AgentWorkflowControl[],
  manifest: readonly AgentOperationManifestEntry[],
): void {
  const operations = operationMap(manifest);
  const controlIds = new Set<string>();

  for (const control of controls) {
    if (!WORKFLOW_ID_PATTERN.test(control.id)) {
      throw new Error(`Workflow control ${control.id} has an invalid stable ID.`);
    }
    if (controlIds.has(control.id)) throw new Error(`Duplicate workflow control ID ${control.id}.`);
    controlIds.add(control.id);
    if (control.surface !== "any" && !WORKFLOW_SURFACES.has(control.surface)) {
      throw new Error(`Workflow control ${control.id} has invalid surface ${control.surface}.`);
    }
    assertCompactText(control.title, `Workflow control ${control.id} title`, 120);
    assertCompactText(control.summary, `Workflow control ${control.id} summary`, 500);
    assertCompactTextList(control.examples, `Workflow control ${control.id} examples`, {
      max: 5,
      itemMax: 500,
    });
    assertCompactTextList(control.tags, `Workflow control ${control.id} tags`, {
      max: 12,
      itemMax: 60,
    });
    assertCompactTextList(control.rules, `Workflow control ${control.id} rules`, {
      max: 8,
      itemMax: 300,
    });
    if (!/^[a-z][a-z0-9_]{2,79}$/.test(control.reasonCode)) {
      throw new Error(`Workflow control ${control.id} has invalid reasonCode.`);
    }
    if (control.trigger.allOf.length < 1 || control.trigger.allOf.length > 8) {
      throw new Error(`Workflow control ${control.id} has invalid trigger groups.`);
    }
    for (const [groupIndex, group] of control.trigger.allOf.entries()) {
      assertCompactTextList(group, `Workflow control ${control.id} trigger[${groupIndex}]`, {
        max: 8,
        itemMax: 80,
      });
    }
    for (const [label, operationIds] of [
      ["safe", control.safeOperationIds],
      ["forbidden", control.forbiddenOperationIds],
    ] as const) {
      if (operationIds.length > 20 || new Set(operationIds).size !== operationIds.length) {
        throw new Error(`Workflow control ${control.id} has invalid ${label} operations.`);
      }
      for (const operationId of operationIds) {
        const operation = requireRunnableOperation(
          operations,
          operationId,
          `Workflow control ${control.id}`,
        );
        if (
          label === "safe" &&
          control.surface !== "any" &&
          !operationAllowedForRoute(control.surface, operation)
        ) {
          throw new Error(
            `Workflow control ${control.id} has wrong-surface safe operation ${operationId}.`,
          );
        }
      }
    }
    if (control.safeOperationIds.some((operationId) =>
      control.forbiddenOperationIds.includes(operationId)
    )) {
      throw new Error(`Workflow control ${control.id} has overlapping safe and forbidden operations.`);
    }
    if (new TextEncoder().encode(JSON.stringify(control)).byteLength > 2 * 1024) {
      throw new Error(`Workflow control ${control.id} exceeds the 2 KiB compact-control limit.`);
    }
  }
}

function buildCoverage(
  cards: readonly AgentWorkflowCard[],
  routes: readonly AgentWorkflowIntentRoute[],
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
  for (const route of routes) {
    for (const operationId of route.operationIds) {
      const workflowIds = workflowsByOperation.get(operationId) ?? [];
      workflowIds.push(route.id);
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
  routes: readonly AgentWorkflowIntentRoute[],
  manifest: readonly AgentOperationManifestEntry[],
): void {
  const expected = buildCoverage(cards, routes, manifest);
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

const CURATED_AGENT_WORKFLOW_ROUTES: readonly AgentWorkflowIntentRoute[] = [
  ...DASHBOARD_AGENT_WORKFLOW_ROUTES,
  ...AGENT_STOREFRONT_INTENT_ROUTES,
];

function availableCuratedRoutes(
  manifest: readonly AgentOperationManifestEntry[],
  cards: readonly AgentWorkflowCard[],
): AgentWorkflowIntentRoute[] {
  const availableOperations = new Set(manifest.map((operation) => operation.operationId));
  const availableCards = new Set(cards.map((card) => card.id));
  return CURATED_AGENT_WORKFLOW_ROUTES.filter((route) =>
    route.operationIds.every((operationId) => availableOperations.has(operationId)) &&
    (!route.workflowId || availableCards.has(route.workflowId))
  );
}

function availableWorkflowControls(
  manifest: readonly AgentOperationManifestEntry[],
): AgentWorkflowControl[] {
  const available = new Set(manifest.map((operation) => operation.operationId));
  return AGENT_WORKFLOW_CONTROLS.filter((control) =>
    [...control.safeOperationIds, ...control.forbiddenOperationIds]
      .every((operationId) => available.has(operationId))
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
  const routes = [...(
    options.routes ??
    (options.requireCuratedCards
      ? CURATED_AGENT_WORKFLOW_ROUTES
      : availableCuratedRoutes(manifest, cards))
  )].sort((left, right) => left.id.localeCompare(right.id));
  const controls = [...(
    options.controls ??
    (options.requireCuratedCards
      ? AGENT_WORKFLOW_CONTROLS
      : availableWorkflowControls(manifest))
  )].sort((left, right) => left.id.localeCompare(right.id));
  validateAgentWorkflowRoutes(routes, cards, manifest);
  validateAgentWorkflowControls(controls, manifest);
  const coverage = buildCoverage(cards, routes, manifest);
  validateAgentWorkflowCoverage(coverage, cards, routes, manifest);

  return {
    version: AGENT_WORKFLOW_CATALOG_VERSION,
    cards,
    routes,
    controls,
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
