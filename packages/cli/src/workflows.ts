import { CliError } from "./errors.js";
import {
  createWorkflowReadCompiler,
  createWorkflowResolver,
  type CompiledWorkflowRead,
  type WorkflowResolution,
  type WorkflowResolverCard,
  type WorkflowResolverCatalog,
  type WorkflowResolverControl,
  type WorkflowResolverDependencySource,
  type WorkflowResolverFactSource,
  type WorkflowResolverInput,
  type WorkflowResolverOperation,
  type WorkflowResolverOutputField,
  type WorkflowResolverOutputProjection,
  type WorkflowResolverOutputSelector,
  type WorkflowResolverRoute,
  type WorkflowResolverSurface,
} from "./generated/workflow-resolver-core.gen.js";
import { indexOperations } from "./openapi.js";
import type { OpenApiDocument } from "./types.js";

export type {
  CompiledWorkflowRead,
  WorkflowResolution,
  WorkflowResolverInput,
} from "./generated/workflow-resolver-core.gen.js";

const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_RESOLUTION_BYTES = 16 * 1024;
const MAX_ROUTES = 200;
const MAX_CONTROLS = 50;
const MAX_CARDS = 100;
const MAX_COVERAGE_ENTRIES = 1_000;
const MAX_GENERIC_ARRAY_ITEMS = 1_000;
const MAX_GENERIC_STRING_CHARS = 32 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 50_000;
const MAX_OBJECT_KEYS = 200;
const STABLE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const OPERATION_ID = /^(?:dashboard|storefront)(?:\.[a-z][a-z0-9_]*){2,}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{2,79}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOCAL_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/;
const PROJECTION_ALIAS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
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
const FIXED_READ_WORKFLOW_IDS = new Set(["operations.daily-snapshot.v1"]);
const MAX_VERIFICATION_RESPONSE_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type ResolverOperation = WorkflowResolverOperation & { outputSchema?: unknown };

function invalidOpenApi(message: string): never {
  throw new CliError(8, "invalid_openapi", message);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) invalidOpenApi(`${label} must be an object.`);
  return value;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) invalidOpenApi(`${label} has unsupported key '${unknown}'.`);
}

function array(value: unknown, label: string, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    invalidOpenApi(`${label} must contain ${minimum}-${maximum} items.`);
  }
  return value;
}

function text(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    (pattern && !pattern.test(value))
  ) {
    invalidOpenApi(`${label} is invalid.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalidOpenApi(`${label} must be boolean.`);
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalidOpenApi(`${label} is invalid.`);
  }
  return value as T;
}

function textArray(
  value: unknown,
  label: string,
  options: { maximum: number; itemMaximum: number; minimum?: number; pattern?: RegExp },
): string[] {
  const values = array(value, label, options.maximum, options.minimum ?? 0)
    .map((item, index) => text(item, `${label}[${index}]`, options.itemMaximum, options.pattern));
  if (new Set(values).size !== values.length) invalidOpenApi(`${label} must contain unique values.`);
  return values;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    invalidOpenApi(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value as number;
}

function jsonPointer(value: unknown, label: string): string {
  const pointer = text(value, label, 500, JSON_POINTER);
  if (pointer.slice(1).split("/").some((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~") === "*")) {
    invalidOpenApi(`${label} cannot contain a wildcard segment.`);
  }
  return pointer;
}

function decodeJsonPointerSegment(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function projectionPointer(value: unknown, label: string): string {
  const pointer = jsonPointer(value, label);
  const invalidSegment = pointer
    .slice(1)
    .split("/")
    .map(decodeJsonPointerSegment)
    .find((segment) =>
      FORBIDDEN_PROJECTION_SEGMENTS.has(segment) ||
      segment.includes("*") ||
      segment.startsWith("$") ||
      segment.startsWith("@")
    );
  if (invalidSegment !== undefined) {
    invalidOpenApi(`${label} has a wildcard, pseudo, or prototype JSON pointer segment.`);
  }
  return pointer;
}

function projectionAlias(value: unknown, label: string): string {
  const alias = text(value, label, 64, PROJECTION_ALIAS);
  if (FORBIDDEN_PROJECTION_SEGMENTS.has(alias)) {
    invalidOpenApi(`${label} has an invalid or prototype projection alias.`);
  }
  return alias;
}

function templateHasPointer(template: unknown, pointer: string): boolean {
  let current = template;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return false;
      const index = Number(segment);
      if (index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function serializedBytes(value: unknown, label: string): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalidOpenApi(`${label} is not serializable JSON.`);
  }
  if (typeof serialized !== "string") invalidOpenApi(`${label} is not serializable JSON.`);
  return new TextEncoder().encode(serialized).byteLength;
}

function assertJsonBounds(
  value: unknown,
  label: string,
  depth = 0,
  state: { nodes: number } = { nodes: 0 },
): void {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    invalidOpenApi(`${label} exceeds structural bounds.`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidOpenApi(`${label} contains a non-finite number.`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_GENERIC_STRING_CHARS) invalidOpenApi(`${label} contains an oversized string.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_GENERIC_ARRAY_ITEMS) invalidOpenApi(`${label} contains an oversized array.`);
    value.forEach((item, index) => assertJsonBounds(item, `${label}[${index}]`, depth + 1, state));
    return;
  }
  if (!isRecord(value)) invalidOpenApi(`${label} contains a non-JSON value.`);
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) invalidOpenApi(`${label} contains too many object keys.`);
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 160) invalidOpenApi(`${label} contains an invalid object key.`);
    assertJsonBounds(item, `${label}.${key}`, depth + 1, state);
  }
}

function registerStableId(value: unknown, label: string, ids: Set<string>): string {
  const id = text(value, label, 160, STABLE_ID);
  if (ids.has(id)) invalidOpenApi(`Workflow catalog contains duplicate stable ID '${id}'.`);
  ids.add(id);
  return id;
}

function requireLiveOperation(
  value: unknown,
  label: string,
  operations: ReadonlyMap<string, ResolverOperation>,
): ResolverOperation {
  const operationId = text(value, label, 160, OPERATION_ID);
  const operation = operations.get(operationId);
  if (!operation || !["execute", "continuation"].includes(operation.exposure)) {
    invalidOpenApi(`${label} references operation '${operationId}' that is not live and runnable.`);
  }
  return operation;
}

function operationAllowedForSurface(
  surface: WorkflowResolverSurface,
  operation: WorkflowResolverOperation,
): boolean {
  return operation.surface === surface ||
    (surface === "dashboard" && operation.surface === "storefront" && operation.risk === "read");
}

function successOutputSchema(responses: unknown): unknown {
  if (!isRecord(responses)) return undefined;
  for (const status of Object.keys(responses).sort()) {
    if (!/^2\d\d$/.test(status)) continue;
    const response = responses[status];
    if (!isRecord(response) || !isRecord(response.content)) return undefined;
    const jsonContent = response.content["application/json"];
    if (!isRecord(jsonContent)) return undefined;
    return jsonContent.schema;
  }
  return undefined;
}

function resolverOperations(document: OpenApiDocument): ResolverOperation[] {
  return indexOperations(document).map((indexed): ResolverOperation => {
    const summary = indexed.operation.summary === undefined
      ? indexed.id
      : text(indexed.operation.summary, `Operation '${indexed.id}' summary`, 300);
    const description = indexed.operation.description === undefined
      ? undefined
      : text(indexed.operation.description, `Operation '${indexed.id}' description`, 2_000);
    const tags = indexed.operation.tags === undefined
      ? []
      : textArray(indexed.operation.tags, `Operation '${indexed.id}' tags`, {
          maximum: 20,
          itemMaximum: 60,
        });
    const surface = enumValue(indexed.agent.surface, `Operation '${indexed.id}' surface`, [
      "dashboard",
      "storefront",
      "system",
    ] as const);
    const exposure = enumValue(indexed.agent.exposure, `Operation '${indexed.id}' exposure`, [
      "execute",
      "continuation",
    ] as const);
    const risk = enumValue(indexed.agent.risk, `Operation '${indexed.id}' risk`, [
      "read",
      "write",
      "destructive",
      "financial",
      "security",
    ] as const);
    return {
      operationId: indexed.id,
      surface,
      exposure,
      risk,
      openWorld: boolean(indexed.agent.openWorld, `Operation '${indexed.id}' openWorld`),
      summary,
      ...(description ? { description } : {}),
      tags,
      inputSchema: {
        parameters: indexed.pathParameters.map((parameter) => ({ required: parameter.required === true })),
        ...(indexed.operation.requestBody
          ? { requestBody: { required: indexed.operation.requestBody.required === true } }
          : {}),
      },
      outputSchema: successOutputSchema(indexed.operation.responses),
    };
  });
}

function cloneJson(value: unknown, label: string): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return invalidOpenApi(`${label} is not valid JSON.`);
  }
}

function parseConstructionRules(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const rules = record(value, `${label} constructionRules`);
  if (Object.keys(rules).length > 32) invalidOpenApi(`${label} has too many construction rules.`);
  return Object.fromEntries(Object.entries(rules).map(([key, rule]) => [
    text(key, `${label} construction rule key`, 64, LOCAL_ID),
    text(rule, `${label} construction rule '${key}'`, 200),
  ]));
}

function parseFactSource(
  value: unknown,
  label: string,
  surface: WorkflowResolverSurface,
  operations: ReadonlyMap<string, ResolverOperation>,
): WorkflowResolverFactSource {
  const source = record(value, `${label} source`);
  const kind = enumValue(source.kind, `${label} source kind`, [
    "merchant",
    "operation",
    "constant",
  ] as const);
  if (kind === "merchant") return { kind };
  if (kind === "constant") {
    if (!Object.hasOwn(source, "value")) invalidOpenApi(`${label} constant source requires value.`);
    return { kind, value: cloneJson(source.value, `${label} constant value`) };
  }
  const operation = requireLiveOperation(source.operationId, `${label} source`, operations);
  if (!operationAllowedForSurface(surface, operation)) {
    invalidOpenApi(`${label} source has a wrong-surface operation.`);
  }
  const alternatives = source.alternatives === undefined
    ? undefined
    : array(source.alternatives, `${label} source alternatives`, 20).map((rawAlternative, index) => {
        const alternativeLabel = `${label} source alternatives[${index}]`;
        const alternative = record(rawAlternative, alternativeLabel);
        const alternativeOperation = requireLiveOperation(
          alternative.operationId,
          alternativeLabel,
          operations,
        );
        if (!operationAllowedForSurface(surface, alternativeOperation)) {
          invalidOpenApi(`${alternativeLabel} has a wrong-surface operation.`);
        }
        return {
          operationId: alternativeOperation.operationId,
          responsePointer: jsonPointer(alternative.responsePointer, `${alternativeLabel} responsePointer`),
        };
      });
  if (alternatives && new Set(alternatives.map((alternative) =>
    `${alternative.operationId}:${alternative.responsePointer}`
  )).size !== alternatives.length) {
    invalidOpenApi(`${label} source alternatives must be unique.`);
  }
  return {
    kind,
    operationId: operation.operationId,
    responsePointer: jsonPointer(source.responsePointer, `${label} source responsePointer`),
    ...(alternatives ? { alternatives } : {}),
  };
}

function parseDependencySource(
  value: unknown,
  label: string,
  factIds: ReadonlySet<string>,
  stepIdsByPhase: ReadonlyMap<string, ReadonlySet<string>>,
): WorkflowResolverDependencySource {
  const source = record(value, `${label} source`);
  const kind = enumValue(source.kind, `${label} source kind`, ["fact", "step"] as const);
  if (kind === "fact") {
    const factId = text(source.factId, `${label} source factId`, 64, LOCAL_ID);
    if (!factIds.has(factId)) invalidOpenApi(`${label} references unknown fact '${factId}'.`);
    return {
      kind,
      factId,
      ...(source.factPointer !== undefined
        ? { factPointer: jsonPointer(source.factPointer, `${label} source factPointer`) }
        : {}),
    };
  }
  const phaseId = text(source.phaseId, `${label} source phaseId`, 64, LOCAL_ID);
  const stepId = text(source.stepId, `${label} source stepId`, 64, LOCAL_ID);
  if (!stepIdsByPhase.get(phaseId)?.has(stepId)) {
    invalidOpenApi(`${label} references unknown step '${phaseId}.${stepId}'.`);
  }
  return {
    kind,
    phaseId,
    stepId,
    responsePointer: jsonPointer(source.responsePointer, `${label} source responsePointer`),
  };
}

function schemaVariants(
  schema: unknown,
  depth = 0,
  state: { nodes: number } = { nodes: 0 },
): JsonRecord[] {
  if (!isRecord(schema)) return [];
  state.nodes += 1;
  if (depth > 16 || state.nodes > 1_000) {
    invalidOpenApi("Workflow output schema exceeds structural bounds.");
  }
  const variants = [schema.oneOf, schema.anyOf, schema.allOf]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter(isRecord);
  return variants.length > 0
    ? variants.flatMap((variant) => schemaVariants(variant, depth + 1, state))
    : [schema];
}

function schemaNodesAtPointer(roots: readonly JsonRecord[], pointer: string): JsonRecord[] {
  let nodes = roots.flatMap((root) => schemaVariants(root));
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodeJsonPointerSegment(rawSegment);
    nodes = nodes.flatMap((node) =>
      schemaVariants(node).flatMap((variant) => {
        const properties = isRecord(variant.properties) ? variant.properties : undefined;
        const property = properties && Object.hasOwn(properties, segment)
          ? properties[segment]
          : undefined;
        return isRecord(property) ? schemaVariants(property) : [];
      })
    );
    if (nodes.length === 0) return [];
    if (nodes.length > 1_000) invalidOpenApi("Workflow output schema exceeds structural bounds.");
  }
  const variants = nodes.flatMap((node) => schemaVariants(node));
  if (variants.length > 1_000) invalidOpenApi("Workflow output schema exceeds structural bounds.");
  return variants;
}

type ProjectionSchemaShape = "scalar" | "object" | "array" | "ambiguous" | "unknown";

function schemaShape(nodes: readonly JsonRecord[]): ProjectionSchemaShape {
  const shapes = new Set<Exclude<ProjectionSchemaShape, "ambiguous" | "unknown">>();
  for (const node of nodes.flatMap((item) => schemaVariants(item))) {
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

function arrayItemSchemas(nodes: readonly JsonRecord[]): JsonRecord[] {
  return nodes.flatMap((node) => schemaVariants(node)).flatMap((node) =>
    isRecord(node.items) ? schemaVariants(node.items) : []
  );
}

function parseProjectionFields(
  value: unknown,
  schemaNodes: readonly JsonRecord[],
  label: string,
): WorkflowResolverOutputField[] {
  const aliases = new Set<string>();
  const pointers = new Set<string>();
  return array(value, `${label} fields`, MAX_PROJECTION_FIELDS, 1).map((rawField, index) => {
    const fieldLabel = `${label} fields[${index}]`;
    const field = record(rawField, fieldLabel);
    exactKeys(field, ["pointer", "alias"], fieldLabel);
    const pointer = projectionPointer(field.pointer, `${fieldLabel} pointer`);
    const alias = projectionAlias(field.alias, `${fieldLabel} alias`);
    if (aliases.has(alias)) invalidOpenApi(`${label} has duplicate field alias '${alias}'.`);
    if (pointers.has(pointer)) invalidOpenApi(`${label} has duplicate field pointer '${pointer}'.`);
    aliases.add(alias);
    pointers.add(pointer);
    const selected = schemaNodesAtPointer(schemaNodes, pointer);
    if (selected.length === 0) {
      invalidOpenApi(`${fieldLabel} references unknown output field '${pointer}'.`);
    }
    if (schemaShape(selected) !== "scalar") {
      invalidOpenApi(`${fieldLabel} must select one scalar output field.`);
    }
    return { pointer, alias };
  });
}

function parseProjectionSelector(
  value: unknown,
  outputSchema: JsonRecord,
  label: string,
): { selector: WorkflowResolverOutputSelector; fieldCount: number } {
  const rawSelector = record(value, label);
  exactKeys(rawSelector, ["pointer", "alias", "maxItems", "fields"], label);
  const pointer = projectionPointer(rawSelector.pointer, `${label} pointer`);
  const alias = projectionAlias(rawSelector.alias, `${label} alias`);
  const selected = schemaNodesAtPointer([outputSchema], pointer);
  if (selected.length === 0) {
    invalidOpenApi(`${label} references unknown output field '${pointer}'.`);
  }
  const shape = schemaShape(selected);
  const maxItems = rawSelector.maxItems === undefined
    ? undefined
    : positiveInteger(rawSelector.maxItems, `${label} maxItems`, MAX_PROJECTION_ITEMS);

  if (shape === "array") {
    if (maxItems === undefined) {
      invalidOpenApi(`${label} array requires bounded maxItems.`);
    }
    const schemaLimits = selected.flatMap((node) => schemaVariants(node)).flatMap((node) =>
      typeof node.maxItems === "number" && Number.isFinite(node.maxItems) ? [node.maxItems] : []
    );
    if (schemaLimits.length > 0 && maxItems > Math.min(...schemaLimits)) {
      invalidOpenApi(`${label} maxItems exceeds the operation output schema.`);
    }
    const itemSchemas = arrayItemSchemas(selected);
    if (itemSchemas.length === 0) invalidOpenApi(`${label} array has no declared item schema.`);
    const itemShape = schemaShape(itemSchemas);
    if (itemShape === "object") {
      const fields = parseProjectionFields(rawSelector.fields, itemSchemas, label);
      return { selector: { pointer, alias, maxItems, fields }, fieldCount: fields.length };
    }
    if (itemShape !== "scalar" || rawSelector.fields !== undefined) {
      invalidOpenApi(`${label} has invalid fields for its array item schema.`);
    }
    return { selector: { pointer, alias, maxItems }, fieldCount: 0 };
  }

  if (shape === "object") {
    if (maxItems !== undefined) invalidOpenApi(`${label} has maxItems for a non-array field.`);
    const fields = parseProjectionFields(rawSelector.fields, selected, label);
    return { selector: { pointer, alias, fields }, fieldCount: fields.length };
  }

  if (shape !== "scalar") {
    invalidOpenApi(`${label} has an unknown or ambiguous output schema.`);
  }
  if (maxItems !== undefined || rawSelector.fields !== undefined) {
    invalidOpenApi(`${label} scalar output cannot declare maxItems or fields.`);
  }
  return { selector: { pointer, alias }, fieldCount: 0 };
}

function parseOutputProjection(
  value: unknown,
  operation: ResolverOperation,
  label: string,
): WorkflowResolverOutputProjection {
  const projection = record(value, `${label} output`);
  exactKeys(projection, ["selectors"], `${label} output`);
  if (!isRecord(operation.outputSchema)) {
    invalidOpenApi(`${label} has no object output schema for projection validation.`);
  }
  const aliases = new Set<string>();
  const pointers = new Set<string>();
  let totalFields = 0;
  const selectors = array(
    projection.selectors,
    `${label} output selectors`,
    MAX_PROJECTION_SELECTORS,
    1,
  ).map((rawSelector, index) => {
    const parsed = parseProjectionSelector(
      rawSelector,
      operation.outputSchema as JsonRecord,
      `${label} output selectors[${index}]`,
    );
    if (aliases.has(parsed.selector.alias)) {
      invalidOpenApi(`${label} has duplicate output alias '${parsed.selector.alias}'.`);
    }
    if (pointers.has(parsed.selector.pointer)) {
      invalidOpenApi(`${label} has duplicate output pointer '${parsed.selector.pointer}'.`);
    }
    aliases.add(parsed.selector.alias);
    pointers.add(parsed.selector.pointer);
    totalFields += parsed.fieldCount;
    return parsed.selector;
  });
  if (totalFields > MAX_PROJECTION_TOTAL_FIELDS) {
    invalidOpenApi(`${label} has too many selected fields across its output projection.`);
  }
  return { selectors };
}

function parseCards(
  value: unknown,
  operations: ReadonlyMap<string, ResolverOperation>,
  ids: Set<string>,
): WorkflowResolverCard[] {
  if (value === undefined) return [];
  return array(value, "Workflow catalog cards", MAX_CARDS).map((rawCard, cardIndex) => {
    const label = `Workflow card[${cardIndex}]`;
    const card = record(rawCard, label);
    if (serializedBytes(card, label) > 16 * 1024) {
      invalidOpenApi(`${label} exceeds the 16 KiB card limit.`);
    }
    const id = registerStableId(card.id, `${label} id`, ids);
    const surface = enumValue(card.surface, `${label} surface`, ["dashboard", "storefront"] as const);
    text(card.title, `${label} title`, 120);
    text(card.summary, `${label} summary`, 500);
    textArray(card.examples, `${label} examples`, { maximum: 5, itemMaximum: 500, minimum: 1 });
    textArray(card.tags, `${label} tags`, { maximum: 12, itemMaximum: 60 });
    const constructionRules = parseConstructionRules(card.constructionRules, label);

    const factIds = new Set<string>();
    const requiredFacts = array(card.requiredFacts, `${label} requiredFacts`, 100).map(
      (rawFact, factIndex) => {
        const factLabel = `${label} requiredFacts[${factIndex}]`;
        const fact = record(rawFact, factLabel);
        const factId = text(fact.id, `${factLabel} id`, 64, LOCAL_ID);
        if (factIds.has(factId)) invalidOpenApi(`${label} duplicates fact '${factId}'.`);
        factIds.add(factId);
        return {
          id: factId,
          description: text(fact.description, `${factLabel} description`, 500),
          required: boolean(fact.required, `${factLabel} required`),
          ...(Object.hasOwn(fact, "defaultValue")
            ? { defaultValue: cloneJson(fact.defaultValue, `${factLabel} defaultValue`) }
            : {}),
          source: parseFactSource(fact.source, factLabel, surface, operations),
          nonInferenceRule: text(fact.nonInferenceRule, `${factLabel} nonInferenceRule`, 300),
        };
      },
    );

    const phaseIds = new Set<string>();
    const stepIdsByPhase = new Map<string, Set<string>>();
    const rawPhases = array(card.phases, `${label} phases`, 50, 1).map(
      (rawPhase, phaseIndex) => {
        const phaseLabel = `${label} phases[${phaseIndex}]`;
        const phase = record(rawPhase, phaseLabel);
        const phaseId = text(phase.id, `${phaseLabel} id`, 64, LOCAL_ID);
        if (phaseIds.has(phaseId)) invalidOpenApi(`${label} duplicates phase '${phaseId}'.`);
        phaseIds.add(phaseId);
        const dependsOn = textArray(phase.dependsOn, `${phaseLabel} dependsOn`, {
          maximum: 50,
          itemMaximum: 64,
          pattern: LOCAL_ID,
        });
        const stepIds = new Set<string>();
        const rawSteps = array(phase.steps, `${phaseLabel} steps`, 50, 1).map(
          (rawStep, stepIndex) => {
            const stepLabel = `${phaseLabel} steps[${stepIndex}]`;
            const step = record(rawStep, stepLabel);
            const stepId = text(step.id, `${stepLabel} id`, 64, LOCAL_ID);
            if (stepIds.has(stepId)) invalidOpenApi(`${phaseLabel} duplicates step '${stepId}'.`);
            stepIds.add(stepId);
            return { step, stepId, stepLabel };
          },
        );
        stepIdsByPhase.set(phaseId, stepIds);
        return {
          phase,
          phaseId,
          phaseLabel,
          surface: enumValue(phase.surface, `${phaseLabel} surface`, [
            "dashboard",
            "storefront",
          ] as const),
          dependsOn,
          rawSteps,
        };
      },
    );

    const completedPhaseIds = new Set<string>();
    const phases: WorkflowResolverCard["phases"] = rawPhases.map((phaseEntry) => {
      for (const dependency of phaseEntry.dependsOn) {
        if (!completedPhaseIds.has(dependency)) {
          invalidOpenApi(`${phaseEntry.phaseLabel} has invalid dependency '${dependency}'.`);
        }
      }
      completedPhaseIds.add(phaseEntry.phaseId);
      return {
        id: phaseEntry.phaseId,
        surface: phaseEntry.surface,
        dependsOn: phaseEntry.dependsOn,
        stopConditions: textArray(
          phaseEntry.phase.stopConditions,
          `${phaseEntry.phaseLabel} stopConditions`,
          { maximum: 8, itemMaximum: 300, minimum: 1 },
        ),
        steps: phaseEntry.rawSteps.map(({ step, stepId, stepLabel }) => {
        const operation = requireLiveOperation(step.operationId, stepLabel, operations);
        if (operation.surface !== phaseEntry.surface) {
          invalidOpenApi(`${stepLabel} has a wrong-surface operation.`);
        }
        const mutation = enumValue(step.mutation, `${stepLabel} mutation`, [
          "read",
          "create",
          "partial",
          "replace",
          "command",
          "lifecycle",
        ] as const);
        if ((mutation === "read") !== (operation.risk === "read")) {
          invalidOpenApi(`${stepLabel} mutation does not match its live operation risk.`);
        }
        if (step.output !== undefined && mutation !== "read") {
          invalidOpenApi(`${stepLabel} only read steps may declare an output projection.`);
        }
        if (FIXED_READ_WORKFLOW_IDS.has(id) && step.output === undefined) {
          invalidOpenApi(`${stepLabel} requires a reviewed output projection.`);
        }
        const output = step.output === undefined
          ? undefined
          : parseOutputProjection(step.output, operation, stepLabel);
        const input = record(step.input, `${stepLabel} input`);
        if (!Object.hasOwn(input, "template")) invalidOpenApi(`${stepLabel} input requires template.`);
        const template = cloneJson(record(input.template, `${stepLabel} input template`), `${stepLabel} input template`);
        const dependencyPointers = new Set<string>();
        const dependencies = array(
          input.dependencies,
          `${stepLabel} input dependencies`,
          100,
        ).map((rawDependency, dependencyIndex) => {
          const dependencyLabel = `${stepLabel} input dependencies[${dependencyIndex}]`;
          const dependency = record(rawDependency, dependencyLabel);
          const templatePointer = jsonPointer(
            dependency.templatePointer,
            `${dependencyLabel} templatePointer`,
          );
          if (!templateHasPointer(template, templatePointer)) {
            invalidOpenApi(`${dependencyLabel} points outside the input template.`);
          }
          if (dependencyPointers.has(templatePointer)) {
            invalidOpenApi(`${stepLabel} duplicates dependency pointer '${templatePointer}'.`);
          }
          dependencyPointers.add(templatePointer);
          return {
            templatePointer,
            source: parseDependencySource(
              dependency.source,
              dependencyLabel,
              factIds,
              stepIdsByPhase,
            ),
          };
        });
        const defaultPointers = new Set<string>();
        const defaults = array(input.defaults, `${stepLabel} input defaults`, 100).map(
          (rawDefault, defaultIndex) => {
            const defaultLabel = `${stepLabel} input defaults[${defaultIndex}]`;
            const inputDefault = record(rawDefault, defaultLabel);
            const templatePointer = jsonPointer(
              inputDefault.templatePointer,
              `${defaultLabel} templatePointer`,
            );
            if (!templateHasPointer(template, templatePointer)) {
              invalidOpenApi(`${defaultLabel} points outside the input template.`);
            }
            if (defaultPointers.has(templatePointer)) {
              invalidOpenApi(`${stepLabel} duplicates default pointer '${templatePointer}'.`);
            }
            if (!Object.hasOwn(inputDefault, "value")) {
              invalidOpenApi(`${defaultLabel} requires value.`);
            }
            defaultPointers.add(templatePointer);
            return {
              templatePointer,
              value: cloneJson(inputDefault.value, `${defaultLabel} value`),
            };
          },
        );
        const policies = record(step.policies, `${stepLabel} policies`);
        const confirmation = enumValue(policies.confirmation, `${stepLabel} confirmation`, [
          "none",
          "required",
        ] as const);
        if ((operation.risk === "read") !== (confirmation === "none")) {
          invalidOpenApi(`${stepLabel} confirmation does not match its live operation risk.`);
        }
        return {
          id: stepId,
          operationId: operation.operationId,
          mutation,
          ...(step.condition !== undefined
            ? { condition: text(step.condition, `${stepLabel} condition`, 500) }
            : {}),
          input: { template, dependencies, defaults },
          ...(output ? { output } : {}),
          policies: {
            revision: enumValue(policies.revision, `${stepLabel} revision`, [
              "none",
              "optional",
              "required",
            ] as const),
            idempotency: enumValue(policies.idempotency, `${stepLabel} idempotency`, [
              "none",
              "supported",
              "required",
            ] as const),
            confirmation,
            stopConditions: textArray(policies.stopConditions, `${stepLabel} stopConditions`, {
              maximum: 8,
              itemMaximum: 300,
              minimum: 1,
            }),
            nonInferenceRules: textArray(
              policies.nonInferenceRules,
              `${stepLabel} nonInferenceRules`,
              { maximum: 8, itemMaximum: 300, minimum: 1 },
            ),
          },
        };
        }),
      };
    });

    const evidenceIds = new Set<string>();
    const verification = array(card.verification, `${label} verification`, 50, 1).map(
      (rawEvidence, evidenceIndex) => {
        const evidenceLabel = `${label} verification[${evidenceIndex}]`;
        const evidence = record(rawEvidence, evidenceLabel);
        const evidenceId = text(evidence.id, `${evidenceLabel} id`, 64, LOCAL_ID);
        if (evidenceIds.has(evidenceId)) invalidOpenApi(`${label} duplicates evidence '${evidenceId}'.`);
        evidenceIds.add(evidenceId);
        const evidenceSurface = enumValue(evidence.surface, `${evidenceLabel} surface`, [
          "dashboard",
          "storefront",
        ] as const);
        const operation = requireLiveOperation(evidence.operationId, evidenceLabel, operations);
        if (operation.surface !== evidenceSurface || operation.risk !== "read") {
          invalidOpenApi(`${evidenceLabel} must reference a same-surface read operation.`);
        }
        const bounds = record(evidence.bounds, `${evidenceLabel} bounds`);
        return {
          id: evidenceId,
          surface: evidenceSurface,
          operationId: operation.operationId,
          responsePointers: textArray(
            evidence.responsePointers,
            `${evidenceLabel} responsePointers`,
            { maximum: 20, itemMaximum: 500, minimum: 1, pattern: JSON_POINTER },
          ).map((pointer, pointerIndex) =>
            jsonPointer(pointer, `${evidenceLabel} responsePointers[${pointerIndex}]`)
          ),
          proves: textArray(evidence.proves, `${evidenceLabel} proves`, {
            maximum: 10,
            itemMaximum: 300,
            minimum: 1,
          }),
          bounds: {
            maxCalls: positiveInteger(bounds.maxCalls, `${evidenceLabel} bounds maxCalls`, 100),
            ...(bounds.maxItems !== undefined
              ? { maxItems: positiveInteger(bounds.maxItems, `${evidenceLabel} bounds maxItems`, 10_000) }
              : {}),
            maxResponseBytes: positiveInteger(
              bounds.maxResponseBytes,
              `${evidenceLabel} bounds maxResponseBytes`,
              MAX_VERIFICATION_RESPONSE_BYTES,
            ),
          },
        };
      },
    );

    return {
      id,
      ...(constructionRules ? { constructionRules } : {}),
      requiredFacts,
      phases,
      verification,
    };
  });
}

function parseRoute(
  rawRoute: unknown,
  index: number,
  operations: ReadonlyMap<string, ResolverOperation>,
  cardIds: ReadonlySet<string>,
  ids: Set<string>,
): WorkflowResolverRoute {
  const label = `Workflow route[${index}]`;
  const route = record(rawRoute, label);
  const id = registerStableId(route.id, `${label} id`, ids);
  const surface = enumValue(route.surface, `${label} surface`, ["dashboard", "storefront"] as const);
  const kind = enumValue(route.kind, `${label} kind`, ["read", "write", "mixed"] as const);
  const operationIds = textArray(route.operationIds, `${label} operationIds`, {
    maximum: 20,
    itemMaximum: 160,
    minimum: 1,
    pattern: OPERATION_ID,
  });
  const referenced = operationIds.map((operationId) => {
    const operation = requireLiveOperation(operationId, `${label} operationIds`, operations);
    if (!operationAllowedForSurface(surface, operation)) {
      invalidOpenApi(`${label} references wrong-surface operation '${operationId}'.`);
    }
    return operation;
  });
  const hasMutation = referenced.some((operation) => operation.risk !== "read");
  const requiresConfirmation = boolean(route.requiresConfirmation, `${label} requiresConfirmation`);
  if ((kind === "read") === hasMutation || requiresConfirmation !== hasMutation) {
    invalidOpenApi(`${label} kind or confirmation policy does not match its live operations.`);
  }
  const workflowId = route.workflowId === undefined
    ? undefined
    : text(route.workflowId, `${label} workflowId`, 160, STABLE_ID);
  if (workflowId && !cardIds.has(workflowId)) {
    invalidOpenApi(`${label} references unknown workflow card '${workflowId}'.`);
  }
  const parsed: WorkflowResolverRoute = {
    id,
    surface,
    kind,
    title: text(route.title, `${label} title`, 120),
    summary: text(route.summary, `${label} summary`, 500),
    examples: textArray(route.examples, `${label} examples`, {
      maximum: 5,
      itemMaximum: 500,
      minimum: 1,
    }),
    tags: textArray(route.tags, `${label} tags`, { maximum: 12, itemMaximum: 60 }),
    ...(workflowId ? { workflowId } : {}),
    operationIds,
    requiresFacts: boolean(route.requiresFacts, `${label} requiresFacts`),
    requiresConfirmation,
    requiresVerification: boolean(route.requiresVerification, `${label} requiresVerification`),
    rules: textArray(route.rules, `${label} rules`, { maximum: 6, itemMaximum: 300 }),
  };
  if (serializedBytes(parsed, label) > 2 * 1024) {
    invalidOpenApi(`${label} exceeds the 2 KiB compact-route limit.`);
  }
  return parsed;
}

function parseControl(
  rawControl: unknown,
  index: number,
  operations: ReadonlyMap<string, ResolverOperation>,
  ids: Set<string>,
): WorkflowResolverControl {
  const label = `Workflow control[${index}]`;
  const control = record(rawControl, label);
  const id = registerStableId(control.id, `${label} id`, ids);
  const surface = enumValue(control.surface, `${label} surface`, [
    "dashboard",
    "storefront",
    "any",
  ] as const);
  const trigger = record(control.trigger, `${label} trigger`);
  const allOf = array(trigger.allOf, `${label} trigger allOf`, 8, 1).map((rawGroup, groupIndex) =>
    textArray(rawGroup, `${label} trigger allOf[${groupIndex}]`, {
      maximum: 8,
      itemMaximum: 80,
      minimum: 1,
    })
  );
  const safeOperationIds = textArray(control.safeOperationIds, `${label} safeOperationIds`, {
    maximum: 20,
    itemMaximum: 160,
    pattern: OPERATION_ID,
  });
  for (const operationId of safeOperationIds) {
    const operation = requireLiveOperation(operationId, `${label} safeOperationIds`, operations);
    if (surface !== "any" && !operationAllowedForSurface(surface, operation)) {
      invalidOpenApi(`${label} references wrong-surface safe operation '${operationId}'.`);
    }
  }
  const forbiddenOperationIds = textArray(
    control.forbiddenOperationIds,
    `${label} forbiddenOperationIds`,
    { maximum: 20, itemMaximum: 160, pattern: OPERATION_ID },
  );
  forbiddenOperationIds.forEach((operationId) =>
    requireLiveOperation(operationId, `${label} forbiddenOperationIds`, operations)
  );
  if (safeOperationIds.some((operationId) => forbiddenOperationIds.includes(operationId))) {
    invalidOpenApi(`${label} overlaps safe and forbidden operations.`);
  }
  const parsed: WorkflowResolverControl = {
    id,
    surface,
    title: text(control.title, `${label} title`, 120),
    summary: text(control.summary, `${label} summary`, 500),
    examples: textArray(control.examples, `${label} examples`, {
      maximum: 5,
      itemMaximum: 500,
      minimum: 1,
    }),
    tags: textArray(control.tags, `${label} tags`, { maximum: 12, itemMaximum: 60 }),
    disposition: enumValue(control.disposition, `${label} disposition`, [
      "ask",
      "unsupported",
      "refuse",
    ] as const),
    reasonCode: text(control.reasonCode, `${label} reasonCode`, 80, REASON_CODE),
    trigger: {
      allOf,
      ignoreWhenNegated: boolean(trigger.ignoreWhenNegated, `${label} trigger ignoreWhenNegated`),
    },
    safeOperationIds,
    forbiddenOperationIds,
    requiresFacts: boolean(control.requiresFacts, `${label} requiresFacts`),
    requiresConfirmation: boolean(control.requiresConfirmation, `${label} requiresConfirmation`),
    requiresVerification: boolean(control.requiresVerification, `${label} requiresVerification`),
    rules: textArray(control.rules, `${label} rules`, { maximum: 8, itemMaximum: 300 }),
  };
  if (serializedBytes(parsed, label) > 2 * 1024) {
    invalidOpenApi(`${label} exceeds the 2 KiB compact-control limit.`);
  }
  return parsed;
}

function inspectCoverage(
  value: unknown,
  operations: ReadonlyMap<string, ResolverOperation>,
): void {
  if (value === undefined) return;
  const coverage = record(value, "Workflow catalog coverage");
  const seen = new Set<string>();
  for (const [index, rawEntry] of array(
    coverage.operations,
    "Workflow catalog coverage operations",
    MAX_COVERAGE_ENTRIES,
  ).entries()) {
    const label = `Workflow coverage[${index}]`;
    const entry = record(rawEntry, label);
    const operation = requireLiveOperation(entry.operationId, label, operations);
    if (seen.has(operation.operationId)) invalidOpenApi(`Workflow coverage duplicates '${operation.operationId}'.`);
    seen.add(operation.operationId);
    const surface = enumValue(entry.surface, `${label} surface`, ["dashboard", "storefront"] as const);
    if (operation.surface !== surface) invalidOpenApi(`${label} has a wrong-surface operation.`);
    enumValue(entry.mode, `${label} mode`, ["curated", "operation-fallback"] as const);
    textArray(entry.workflowIds, `${label} workflowIds`, {
      maximum: 20,
      itemMaximum: 200,
      minimum: 1,
      pattern: STABLE_ID,
    });
  }
}

function parseCatalog(
  document: OpenApiDocument,
  operations: readonly ResolverOperation[],
): WorkflowResolverCatalog {
  const extension = document["x-scalius-workflows"];
  if (extension === undefined) invalidOpenApi("Server contract has no x-scalius-workflows extension.");
  const size = serializedBytes(extension, "x-scalius-workflows");
  if (size > MAX_CATALOG_BYTES) invalidOpenApi("x-scalius-workflows exceeds the 512 KiB limit.");
  assertJsonBounds(extension, "x-scalius-workflows");
  const catalog = record(extension, "x-scalius-workflows");
  const version = text(catalog.version, "Workflow catalog version", 64, VERSION);
  const operationsById = new Map(operations.map((operation) => [operation.operationId, operation] as const));
  const ids = new Set<string>();
  const cards = parseCards(catalog.cards, operationsById, ids);
  const cardIds = new Set(cards.map((card) => card.id));
  const routes = array(catalog.routes, "Workflow catalog routes", MAX_ROUTES)
    .map((route, index) => parseRoute(route, index, operationsById, cardIds, ids));
  const controls = array(catalog.controls, "Workflow catalog controls", MAX_CONTROLS)
    .map((control, index) => parseControl(control, index, operationsById, ids));
  inspectCoverage(catalog.coverage, operationsById);
  return { version, cards, routes, controls };
}

function workflowResolverSources(document: OpenApiDocument): {
  catalog: WorkflowResolverCatalog;
  operations: ResolverOperation[];
} {
  const operations = resolverOperations(document);
  return { catalog: parseCatalog(document, operations), operations };
}

export function resolveWorkflow(
  document: OpenApiDocument,
  input: WorkflowResolverInput,
): WorkflowResolution {
  const resolution = createWorkflowResolver(workflowResolverSources(document))(input);
  if (serializedBytes(resolution, "Workflow resolution") > MAX_RESOLUTION_BYTES) {
    invalidOpenApi("Workflow resolution exceeds the 16 KiB compact-output limit.");
  }
  return resolution;
}

export function prepareWorkflowRead(
  document: OpenApiDocument,
  input: WorkflowResolverInput,
): CompiledWorkflowRead | null {
  return createWorkflowReadCompiler(workflowResolverSources(document))(input);
}

export default resolveWorkflow;
