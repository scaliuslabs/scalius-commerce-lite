// Generated from apps/api/src/agent-access/workflows/resolver-core.ts.
// Do not edit by hand.

export type WorkflowResolverSurface = "dashboard" | "storefront";
export type WorkflowResolverIntentKind = "read" | "write" | "mixed";
export type WorkflowResolverDisposition = "execute" | "ask" | "unsupported" | "refuse";

export type WorkflowResolverOperation = {
  operationId: string;
  surface: string;
  exposure: string;
  risk: string;
  openWorld?: boolean;
  summary: string;
  description?: string;
  tags: string[];
  inputSchema: unknown;
};

export type WorkflowResolverRoute = {
  id: string;
  surface: WorkflowResolverSurface;
  kind: WorkflowResolverIntentKind;
  title: string;
  summary: string;
  examples: string[];
  tags: string[];
  workflowId?: string;
  operationIds: string[];
  requiresFacts: boolean;
  requiresConfirmation: boolean;
  requiresVerification: boolean;
  rules: string[];
};

export type WorkflowResolverControl = {
  id: string;
  surface: WorkflowResolverSurface | "any";
  title: string;
  summary: string;
  examples: string[];
  tags: string[];
  disposition: Exclude<WorkflowResolverDisposition, "execute">;
  reasonCode: string;
  trigger: { allOf: string[][]; ignoreWhenNegated: boolean };
  safeOperationIds: string[];
  forbiddenOperationIds: string[];
  requiresFacts: boolean;
  requiresConfirmation: boolean;
  requiresVerification: boolean;
  rules: string[];
};

export type WorkflowResolverMutation =
  | "read"
  | "create"
  | "partial"
  | "replace"
  | "command"
  | "lifecycle";

export type WorkflowResolverFactSource =
  | { kind: "merchant" }
  | {
      kind: "operation";
      operationId: string;
      responsePointer: string;
      alternatives?: readonly { operationId: string; responsePointer: string }[];
    }
  | { kind: "constant"; value: unknown };

export type WorkflowResolverDependencySource =
  | { kind: "fact"; factId: string; factPointer?: string }
  | { kind: "step"; phaseId: string; stepId: string; responsePointer: string };

export type WorkflowResolverOutputField = {
  pointer: string;
  alias: string;
};

export type WorkflowResolverOutputSelector = {
  pointer: string;
  alias: string;
  maxItems?: number;
  fields?: readonly WorkflowResolverOutputField[];
};

export type WorkflowResolverOutputProjection = {
  selectors: readonly WorkflowResolverOutputSelector[];
};

export type WorkflowResolverRepeat = {
  factId: string;
  orderPointer: string;
  itemMapPointer: string;
  minItems: number;
  maxItems: number;
  bindings: readonly { templatePointer: string; itemPointer: string }[];
  capture: { responsePointer: string; itemPointer: string };
};

export type WorkflowResolverInputFactPick = {
  factId: string;
  templatePointer: string;
  keys: readonly string[];
};

export type WorkflowResolverInputMaterialization = {
  factId: string;
  templatePointer: string;
  orderPointer: string;
  itemMapPointer: string;
  minItems: number;
  maxItems: number;
  keyField?: string;
  keys: readonly string[];
};

export type WorkflowResolverCard = {
  id: string;
  constructionRules?: Readonly<Record<string, string>>;
  requiredFacts: readonly {
    id: string;
    description: string;
    required: boolean;
    defaultValue?: unknown;
    source: WorkflowResolverFactSource;
    nonInferenceRule: string;
  }[];
  phases: readonly {
    id: string;
    surface: WorkflowResolverSurface;
    dependsOn?: readonly string[];
    stopConditions: readonly string[];
    steps: readonly {
      id: string;
      operationId: string;
      mutation: WorkflowResolverMutation;
      condition?: string;
      input: {
        template: unknown;
        dependencies: readonly {
          templatePointer: string;
          source: WorkflowResolverDependencySource;
        }[];
        defaults: readonly { templatePointer: string; value: unknown }[];
        picks?: readonly WorkflowResolverInputFactPick[];
        materializations?: readonly WorkflowResolverInputMaterialization[];
      };
      repeat?: WorkflowResolverRepeat;
      output?: WorkflowResolverOutputProjection;
      policies: {
        revision: "none" | "optional" | "required";
        idempotency: "none" | "supported" | "required";
        confirmation: "none" | "required";
        stopConditions: readonly string[];
        nonInferenceRules: readonly string[];
      };
    }[];
  }[];
  verification: readonly {
    id: string;
    surface: WorkflowResolverSurface;
    operationId: string;
    responsePointers: readonly string[];
    proves: readonly string[];
    bounds: { maxCalls: number; maxItems?: number; maxResponseBytes: number };
  }[];
};

export type WorkflowExecutionDetail = {
  constructionRules?: Record<string, string>;
  requiredFacts: Array<{
    id: string;
    description: string;
    required: boolean;
    defaultValue?: unknown;
    source: WorkflowResolverFactSource;
    nonInferenceRule: string;
  }>;
  phaseStopConditions: Record<string, string[]>;
  steps: Array<{
    phaseId: string;
    stepId: string;
    operationId: string;
    mutation: WorkflowResolverMutation;
    condition?: string;
    input: {
      template: unknown;
      dependencies: Array<{
        templatePointer: string;
        source: WorkflowResolverDependencySource;
      }>;
      defaults: Array<{ templatePointer: string; value: unknown }>;
      picks?: WorkflowResolverInputFactPick[];
      materializations?: WorkflowResolverInputMaterialization[];
    };
    repeat?: WorkflowResolverRepeat;
    policies: {
      revision: "none" | "optional" | "required";
      idempotency: "none" | "supported" | "required";
      confirmation: "none" | "required";
      stopConditions: string[];
      nonInferenceRules: string[];
    };
  }>;
  verification: Array<{
    id: string;
    surface: WorkflowResolverSurface;
    operationId: string;
    responsePointers: string[];
    proves: string[];
    bounds: { maxCalls: number; maxItems?: number; maxResponseBytes: number };
  }>;
};

export type WorkflowResolverCatalog = {
  version: string;
  cards?: readonly WorkflowResolverCard[];
  routes: WorkflowResolverRoute[];
  controls: WorkflowResolverControl[];
};

export type WorkflowResolverSources = {
  catalog: WorkflowResolverCatalog;
  operations: readonly WorkflowResolverOperation[];
};

export type WorkflowResolverInput = {
  prompt: string;
  surface: WorkflowResolverSurface;
};

export type ResolvedWorkflowPlan = {
  source: "route" | "composed-route" | "operation-fallback" | "control-evidence";
  routeIds: string[];
  workflowIds: string[];
  operationIds: string[];
  clauses: string[];
  title: string;
  summary: string;
  kind: WorkflowResolverIntentKind;
  score: number;
  confidence: number;
  requiresFacts: boolean;
  requiresConfirmation: boolean;
  requiresVerification: boolean;
  rules: string[];
  detail?: WorkflowExecutionDetail;
};

export type WorkflowResolverChoice = {
  id: string;
  source: "route" | "operation-fallback";
  title: string;
  summary: string;
  operationIds: string[];
  score: number;
  confidence: number;
};

export type WorkflowResolution =
  | {
      kind: "plan";
      disposition: "execute";
      version: string;
      plan: ResolvedWorkflowPlan;
      safetyNotes: string[];
    }
  | {
      kind: "choices";
      disposition: "ask";
      version: string;
      choices: WorkflowResolverChoice[];
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
      safePlan: ResolvedWorkflowPlan | null;
      forbiddenOperationIds: string[];
      safetyNotes: string[];
    }
  | {
      kind: "unsupported";
      disposition: "unsupported";
      version: string;
      classification: { code: string; reason: string };
      safetyNotes: string[];
    };

const MAX_PROMPT_CHARS = 4_000;
const MAX_CHOICES = 3;
const MAX_COMPOSED_ROUTES = 4;
const MAX_PLAN_OPERATIONS = 20;
const MAX_DETAILED_RESOLUTION_BYTES = 16 * 1024 - 64;
const MAX_STANDARD_DETAIL_RESOLUTION_BYTES = 12 * 1024 - 64;
const BM25_K1 = 1.25;
const BM25_B = 0.65;

const STOP_WORDS = new Set([
  "a", "an", "are", "as", "at", "be", "been", "by", "can", "did", "do",
  "does", "for", "from", "give", "how", "i", "in", "is", "it", "me",
  "my", "of", "on", "our", "please", "show", "tell", "that", "the", "this",
  "to", "was", "were", "what", "when", "where", "which", "who", "why", "with",
]);

const VOCABULARY_GROUPS: readonly (readonly string[])[] = [
  ["buyer", "buyers", "customer", "customers", "shopper", "shoppers"],
  ["sale", "sales", "sold", "revenue", "gmv"],
  ["delivery", "deliveries", "ship", "shipping", "shipment", "shipments", "courier", "couriers"],
  ["payment", "payments", "gateway", "gateways"],
  ["product", "products", "merchandise", "catalog"],
  ["inventory", "inventories", "stock"],
  ["fulfill", "fulfil", "fulfillment", "fulfilment", "unfulfilled"],
  ["setting", "settings", "configuration", "configured", "config"],
  ["create", "add", "new"],
  ["update", "change", "edit", "save"],
  ["read", "get", "find", "lookup", "list", "show"],
  ["delete", "remove"],
  ["publish", "published", "publication", "activate", "active"],
  ["deactivate", "inactive", "disable", "disabled"],
  ["variant", "variants", "sku", "skus"],
  ["refund", "refunds", "refunded"],
  ["return", "returns"],
  ["page", "pages", "content", "article", "articles"],
  ["navigation", "menu", "menus", "header"],
  ["store", "storefront", "website"],
  ["today", "daily", "day"],
  ["issue", "issues", "problem", "problems", "failure", "failed", "alert", "alerts"],
  ["ready", "readiness", "healthy", "health", "work", "working", "nobody"],
  ["checkout", "check"],
  ["exact", "specific", "identified"],
  ["preview", "probe", "verify", "verification"],
  ["secret", "credential", "credentials", "key", "token"],
  ["city", "cities"],
  ["zone", "zones"],
  ["method", "methods", "option", "options"],
];

const NORMALIZED_VOCABULARY = new Map<string, string>();
for (const group of VOCABULARY_GROUPS) {
  const canonical = group[0]!;
  for (const term of group) NORMALIZED_VOCABULARY.set(term, canonical);
}

const NEGATION_PATTERN = /\b(?:do not|don't|must not|never|no|not|without)\b/i;

type SearchCandidate = {
  id: string;
  source: "route" | "operation-fallback";
  surface: WorkflowResolverSurface;
  title: string;
  summary: string;
  operationIds: string[];
  route?: WorkflowResolverRoute;
  terms: ReadonlyMap<string, number>;
  anchorTerms: ReadonlySet<string>;
  length: number;
  normalizedPhrases: string[];
};

type SearchIndex = {
  candidates: readonly SearchCandidate[];
  operationsById: ReadonlyMap<string, WorkflowResolverOperation>;
  documentFrequency: ReadonlyMap<string, number>;
  averageLength: number;
};

type ScoredCandidate = {
  candidate: SearchCandidate;
  score: number;
  confidence: number;
  matchedTerms: number;
  queryTerms: number;
  exactPhrase: boolean;
};

function normalizeToken(token: string): string {
  const normalized = NORMALIZED_VOCABULARY.get(token);
  if (normalized) return normalized;
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map(normalizeToken)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? [];
}

function normalizedPhrase(value: string): string {
  return tokenize(value).join(" ");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function projectFactSource(source: WorkflowResolverFactSource): WorkflowResolverFactSource {
  if (source.kind === "merchant") return { kind: "merchant" };
  if (source.kind === "constant") return { kind: "constant", value: source.value };
  return {
    kind: "operation",
    operationId: source.operationId,
    responsePointer: source.responsePointer,
    ...(source.alternatives
      ? {
          alternatives: source.alternatives.map((alternative) => ({
            operationId: alternative.operationId,
            responsePointer: alternative.responsePointer,
          })),
        }
      : {}),
  };
}

function projectDependencySource(
  source: WorkflowResolverDependencySource,
): WorkflowResolverDependencySource {
  return source.kind === "fact"
    ? {
        kind: "fact",
        factId: source.factId,
        ...(source.factPointer !== undefined ? { factPointer: source.factPointer } : {}),
      }
    : {
        kind: "step",
        phaseId: source.phaseId,
        stepId: source.stepId,
        responsePointer: source.responsePointer,
      };
}

function projectRepeat(repeat: WorkflowResolverRepeat): WorkflowResolverRepeat {
  return {
    factId: repeat.factId,
    orderPointer: repeat.orderPointer,
    itemMapPointer: repeat.itemMapPointer,
    minItems: repeat.minItems,
    maxItems: repeat.maxItems,
    bindings: repeat.bindings.map((binding) => ({
      templatePointer: binding.templatePointer,
      itemPointer: binding.itemPointer,
    })),
    capture: {
      responsePointer: repeat.capture.responsePointer,
      itemPointer: repeat.capture.itemPointer,
    },
  };
}

function projectInputFactPick(
  pick: WorkflowResolverInputFactPick,
): WorkflowResolverInputFactPick {
  return {
    factId: pick.factId,
    templatePointer: pick.templatePointer,
    keys: [...pick.keys],
  };
}

function projectInputMaterialization(
  materialization: WorkflowResolverInputMaterialization,
): WorkflowResolverInputMaterialization {
  return {
    factId: materialization.factId,
    templatePointer: materialization.templatePointer,
    orderPointer: materialization.orderPointer,
    itemMapPointer: materialization.itemMapPointer,
    minItems: materialization.minItems,
    maxItems: materialization.maxItems,
    ...(materialization.keyField !== undefined
      ? { keyField: materialization.keyField }
      : {}),
    keys: [...materialization.keys],
  };
}

function projectWorkflowDetail(card: WorkflowResolverCard): WorkflowExecutionDetail {
  const constructionRules = card.constructionRules
    ? Object.fromEntries(
        Object.entries(card.constructionRules)
          .sort(([left], [right]) => left.localeCompare(right)),
      )
    : undefined;
  return {
    ...(constructionRules ? { constructionRules } : {}),
    requiredFacts: card.requiredFacts.map((fact) => ({
      id: fact.id,
      description: fact.description,
      required: fact.required,
      ...(Object.hasOwn(fact, "defaultValue") ? { defaultValue: fact.defaultValue } : {}),
      source: projectFactSource(fact.source),
      nonInferenceRule: fact.nonInferenceRule,
    })),
    phaseStopConditions: Object.fromEntries(card.phases.map((phase) => [
      phase.id,
      [...phase.stopConditions],
    ])),
    steps: card.phases.flatMap((phase) => phase.steps.map((step) => ({
      phaseId: phase.id,
      stepId: step.id,
      operationId: step.operationId,
      mutation: step.mutation,
      ...(step.condition !== undefined ? { condition: step.condition } : {}),
      input: {
        template: step.input.template,
        dependencies: step.input.dependencies.map((dependency) => ({
          templatePointer: dependency.templatePointer,
          source: projectDependencySource(dependency.source),
        })),
        defaults: step.input.defaults.map((inputDefault) => ({
          templatePointer: inputDefault.templatePointer,
          value: inputDefault.value,
        })),
        ...(step.input.picks !== undefined
          ? { picks: step.input.picks.map(projectInputFactPick) }
          : {}),
        ...(step.input.materializations !== undefined
          ? {
              materializations: step.input.materializations.map(
                projectInputMaterialization,
              ),
            }
          : {}),
      },
      ...(step.repeat !== undefined ? { repeat: projectRepeat(step.repeat) } : {}),
      policies: {
        revision: step.policies.revision,
        idempotency: step.policies.idempotency,
        confirmation: step.policies.confirmation,
        stopConditions: [...step.policies.stopConditions],
        nonInferenceRules: [...step.policies.nonInferenceRules],
      },
    }))),
    verification: card.verification.map((evidence) => ({
      id: evidence.id,
      surface: evidence.surface,
      operationId: evidence.operationId,
      responsePointers: [...evidence.responsePointers],
      proves: [...evidence.proves],
      bounds: {
        maxCalls: evidence.bounds.maxCalls,
        ...(evidence.bounds.maxItems !== undefined
          ? { maxItems: evidence.bounds.maxItems }
          : {}),
        maxResponseBytes: evidence.bounds.maxResponseBytes,
      },
    })),
  };
}

function buildWorkflowDetails(
  cards: readonly WorkflowResolverCard[] | undefined,
): ReadonlyMap<string, WorkflowExecutionDetail> {
  const details = new Map<string, WorkflowExecutionDetail>();
  for (const card of [...(cards ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
    details.set(card.id, projectWorkflowDetail(card));
  }
  return details;
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function addTerms(target: Map<string, number>, value: string | undefined, weight: number): number {
  if (!value) return 0;
  const tokens = tokenize(value);
  for (const token of tokens) target.set(token, (target.get(token) ?? 0) + weight);
  return tokens.length * weight;
}

function operationRequiresFacts(operation: WorkflowResolverOperation): boolean {
  const input = operation.inputSchema;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if (Array.isArray(record.parameters) && record.parameters.some((parameter) =>
    parameter !== null && typeof parameter === "object" &&
    (parameter as { required?: unknown }).required === true
  )) return true;
  return record.requestBody !== null && typeof record.requestBody === "object" &&
    (record.requestBody as { required?: unknown }).required === true;
}

function buildCandidate(
  base: Omit<SearchCandidate, "terms" | "anchorTerms" | "length" | "normalizedPhrases">,
  fields: Array<{ value?: string; weight: number }>,
  phrases: string[],
  anchors: string[],
): SearchCandidate {
  const terms = new Map<string, number>();
  let length = 0;
  for (const field of fields) length += addTerms(terms, field.value, field.weight);
  return {
    ...base,
    terms,
    anchorTerms: new Set(anchors.flatMap(tokenize)),
    length: Math.max(1, Math.min(length, 200)),
    normalizedPhrases: unique(phrases.map(normalizedPhrase).filter(Boolean)),
  };
}

function buildIndex(sources: WorkflowResolverSources): SearchIndex {
  const operationsById = new Map(
    sources.operations.map((operation) => [operation.operationId, operation] as const),
  );
  const candidates: SearchCandidate[] = [];
  for (const route of sources.catalog.routes) {
    const operationText = route.operationIds.flatMap((operationId) => {
      const operation = operationsById.get(operationId);
      return operation ? [operation.summary, operation.description ?? "", operation.tags.join(" ")] : [];
    }).join(" ");
    candidates.push(buildCandidate({
      id: route.id,
      source: "route",
      surface: route.surface,
      title: route.title,
      summary: route.summary,
      operationIds: route.operationIds,
      route,
    }, [
      { value: route.id, weight: 7 },
      { value: route.title, weight: 10 },
      { value: route.summary, weight: 7 },
      { value: route.examples.join(" "), weight: 3 },
      { value: route.tags.join(" "), weight: 7 },
      { value: route.rules.join(" "), weight: 1 },
      { value: operationText, weight: 0.15 },
    ], [route.id, route.title, ...route.examples], [route.title, route.tags.join(" ")]));
  }
  for (const operation of sources.operations) {
    if (
      !["dashboard", "storefront"].includes(operation.surface) ||
      !["execute", "continuation"].includes(operation.exposure)
    ) continue;
    candidates.push(buildCandidate({
      id: `operation.${operation.operationId}`,
      source: "operation-fallback",
      surface: operation.surface as WorkflowResolverSurface,
      title: operation.summary,
      summary: operation.description ?? operation.summary,
      operationIds: [operation.operationId],
    }, [
      { value: operation.operationId, weight: 8 },
      { value: operation.summary, weight: 9 },
      { value: operation.description, weight: 3 },
      { value: operation.tags.join(" "), weight: 2 },
    ], [operation.operationId, operation.summary], [
      operation.operationId,
      operation.summary,
      operation.tags.join(" "),
    ]));
  }
  candidates.sort((left, right) => left.id.localeCompare(right.id));
  const documentFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const term of candidate.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = candidates.reduce((sum, candidate) => sum + candidate.length, 0) /
    Math.max(candidates.length, 1);
  return { candidates, operationsById, documentFrequency, averageLength };
}

function allowedForSurface(
  surface: WorkflowResolverSurface,
  candidate: SearchCandidate,
  operationsById: ReadonlyMap<string, WorkflowResolverOperation>,
): boolean {
  return candidate.surface === surface ||
    (surface === "dashboard" &&
      candidate.source === "operation-fallback" &&
      candidate.surface === "storefront" &&
      candidate.operationIds.every((operationId) => operationsById.get(operationId)?.risk === "read"));
}

function scoreCandidates(
  prompt: string,
  surface: WorkflowResolverSurface,
  index: SearchIndex,
  source?: SearchCandidate["source"],
): ScoredCandidate[] {
  const queryTokens = unique(tokenize(prompt));
  if (queryTokens.length === 0) return [];
  const normalizedQuery = queryTokens.join(" ");
  const ranked = index.candidates.flatMap((candidate): ScoredCandidate[] => {
    if (
      !allowedForSurface(surface, candidate, index.operationsById) ||
      (source && candidate.source !== source)
    ) return [];
    let score = 0;
    let matchedTerms = 0;
    let anchorMatches = 0;
    for (const term of queryTokens) {
      const frequency = candidate.terms.get(term) ?? 0;
      if (frequency <= 0) continue;
      matchedTerms += 1;
      if (candidate.anchorTerms.has(term)) anchorMatches += 1;
      const documentFrequency = index.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (index.candidates.length - documentFrequency + 0.5) /
        (documentFrequency + 0.5));
      const denominator = frequency + BM25_K1 * (
        1 - BM25_B + BM25_B * candidate.length / index.averageLength
      );
      score += idf * frequency * (BM25_K1 + 1) / denominator;
    }
    const coverage = matchedTerms / queryTokens.length;
    const exactPhrase = candidate.normalizedPhrases.some((phrase) =>
      phrase === normalizedQuery || (normalizedQuery.length >= 12 && phrase.includes(normalizedQuery))
    );
    score = score * (0.55 + coverage) * (candidate.source === "route" ? 1.12 : 1) +
      anchorMatches * 2.5 +
      (exactPhrase ? 18 : 0);
    if (matchedTerms === 0) return [];
    const confidence = Math.min(0.999, (score / (score + 8)) * (0.65 + 0.35 * coverage));
    return [{
      candidate,
      score: round(score),
      confidence: round(confidence),
      matchedTerms,
      queryTerms: queryTokens.length,
      exactPhrase,
    }];
  });
  return ranked.sort((left, right) =>
    right.score - left.score || left.candidate.id.localeCompare(right.candidate.id)
  );
}

function matchedControlPhrase(prompt: string, phrase: string): { matched: boolean; negated: boolean } {
  const normalizedPrompt = normalizedPhrase(prompt);
  const normalizedNeedle = normalizedPhrase(phrase);
  if (!normalizedNeedle) return { matched: false, negated: false };
  const index = normalizedPrompt.indexOf(normalizedNeedle);
  if (index < 0) return { matched: false, negated: false };
  const prefix = normalizedPrompt.slice(Math.max(0, index - 64), index);
  return { matched: true, negated: NEGATION_PATTERN.test(prefix) };
}

function matchControl(
  prompt: string,
  surface: WorkflowResolverSurface,
  controls: readonly WorkflowResolverControl[],
): WorkflowResolverControl | null {
  return controls.find((control) => {
    if (control.surface !== "any" && control.surface !== surface) return false;
    let matchedNegatedPhrase = false;
    const matched = control.trigger.allOf.every((group) => group.some((phrase) => {
      const result = matchedControlPhrase(prompt, phrase);
      matchedNegatedPhrase ||= result.matched && result.negated;
      return result.matched;
    }));
    return matched && !(control.trigger.ignoreWhenNegated && matchedNegatedPhrase);
  }) ?? null;
}

function splitClauses(prompt: string): string[] {
  return unique(prompt
    .split(/(?:[;!?]+|\.(?:\s|$)|,(?:\s+and)?\s+|\b(?:and then|then|also|plus)\b)/i)
    .map((clause) => clause.trim())
    .filter((clause) => unique(tokenize(clause)).length >= 2))
    .slice(0, 8);
}

function strongRouteMatch(match: ScoredCandidate, second?: ScoredCandidate): boolean {
  if (match.candidate.source !== "route") return false;
  const coverage = match.matchedTerms / Math.max(match.queryTerms, 1);
  const margin = second ? match.score / Math.max(second.score, 0.001) : Number.POSITIVE_INFINITY;
  return match.exactPhrase || (
    match.matchedTerms >= 3 && coverage >= 0.3 && match.score >= 4.5 && margin >= 1.04
  );
}

function strongFallbackMatch(match: ScoredCandidate, second?: ScoredCandidate): boolean {
  if (match.candidate.source !== "operation-fallback") return false;
  const coverage = match.matchedTerms / Math.max(match.queryTerms, 1);
  const margin = second ? match.score / Math.max(second.score, 0.001) : Number.POSITIVE_INFINITY;
  return match.exactPhrase || (
    match.matchedTerms >= 2 && coverage >= 0.45 && match.score >= 4.5 && margin >= 1.16
  );
}

function combinedKind(routes: readonly WorkflowResolverRoute[]): WorkflowResolverIntentKind {
  if (routes.some((route) => route.kind === "mixed")) return "mixed";
  return routes.some((route) => route.kind === "write") ? "write" : "read";
}

function planFromRoutes(
  matches: readonly ScoredCandidate[],
  clauses: string[],
): ResolvedWorkflowPlan | null {
  const routes = matches.flatMap((match) => match.candidate.route ? [match.candidate.route] : []);
  const operationIds = unique(routes.flatMap((route) => route.operationIds));
  if (routes.length === 0 || operationIds.length > MAX_PLAN_OPERATIONS) return null;
  const score = matches.reduce((sum, match) => sum + match.score, 0);
  const confidence = Math.min(...matches.map((match) => match.confidence));
  return {
    source: routes.length === 1 ? "route" : "composed-route",
    routeIds: routes.map((route) => route.id),
    workflowIds: unique(routes.flatMap((route) => route.workflowId ? [route.workflowId] : [])),
    operationIds,
    clauses,
    title: routes.map((route) => route.title).join(" + "),
    summary: routes.map((route) => route.summary).join(" "),
    kind: combinedKind(routes),
    score: round(score),
    confidence: round(confidence),
    requiresFacts: routes.some((route) => route.requiresFacts),
    requiresConfirmation: routes.some((route) => route.requiresConfirmation),
    requiresVerification: routes.some((route) => route.requiresVerification),
    rules: unique(routes.flatMap((route) => route.rules)),
  };
}

function resolvedRoutePlan(
  version: string,
  plan: ResolvedWorkflowPlan,
  details: ReadonlyMap<string, WorkflowExecutionDetail>,
): WorkflowResolution {
  const base: WorkflowResolution = {
    kind: "plan",
    disposition: "execute",
    version,
    plan,
    safetyNotes: [],
  };
  if (
    !["route", "composed-route"].includes(plan.source) ||
    plan.workflowIds.length !== 1
  ) return base;
  const workflowId = plan.workflowIds[0]!;
  const detail = details.get(workflowId);
  if (!detail) return base;
  const detailOperationIds = new Set([
    ...detail.steps.map((step) => step.operationId),
    ...detail.verification.map((evidence) => evidence.operationId),
    ...detail.requiredFacts.flatMap((fact) => fact.source.kind === "operation"
      ? [
          fact.source.operationId,
          ...(fact.source.alternatives ?? []).map((alternative) => alternative.operationId),
        ]
      : []),
  ]);
  if ([...detailOperationIds].some((operationId) => !plan.operationIds.includes(operationId))) {
    return base;
  }
  const detailed: WorkflowResolution = {
    ...base,
    plan: { ...plan, detail },
  };
  const budget = detail.constructionRules
    ? MAX_DETAILED_RESOLUTION_BYTES
    : MAX_STANDARD_DETAIL_RESOLUTION_BYTES;
  return jsonBytes(detailed) <= budget ? detailed : base;
}

function planFromFallback(
  match: ScoredCandidate,
  index: SearchIndex,
  prompt: string,
): ResolvedWorkflowPlan {
  const operation = index.operationsById.get(match.candidate.operationIds[0]!)!;
  const mutation = operation.risk !== "read";
  return {
    source: "operation-fallback",
    routeIds: [match.candidate.id],
    workflowIds: [match.candidate.id],
    operationIds: [...match.candidate.operationIds],
    clauses: [prompt],
    title: match.candidate.title,
    summary: match.candidate.summary,
    kind: mutation ? "write" : "read",
    score: match.score,
    confidence: match.confidence,
    requiresFacts: operationRequiresFacts(operation),
    requiresConfirmation: mutation,
    requiresVerification: mutation,
    rules: mutation
      ? ["Confirm the mutation, honor live revision/idempotency policy, and verify with a bounded read."]
      : ["Treat missing or partial data as unknown; honor pagination and response bounds."],
  };
}

function planFromControl(
  control: WorkflowResolverControl,
  index: SearchIndex,
): ResolvedWorkflowPlan | null {
  if (control.safeOperationIds.length === 0) return null;
  const operations = control.safeOperationIds.flatMap((operationId) => {
    const operation = index.operationsById.get(operationId);
    return operation ? [operation] : [];
  });
  return {
    source: "control-evidence",
    routeIds: [control.id],
    workflowIds: [],
    operationIds: [...control.safeOperationIds],
    clauses: [...control.examples.slice(0, 1)],
    title: control.title,
    summary: control.summary,
    kind: operations.some((operation) => operation.risk !== "read") ? "mixed" : "read",
    score: 1,
    confidence: 1,
    requiresFacts: control.requiresFacts,
    requiresConfirmation: control.requiresConfirmation,
    requiresVerification: control.requiresVerification,
    rules: [...control.rules],
  };
}

function choicesFromRanked(ranked: readonly ScoredCandidate[]): WorkflowResolverChoice[] {
  const top = ranked[0]?.score ?? 0;
  return ranked
    .filter((match) =>
      match.score >= Math.max(1.5, top * 0.72) &&
      (match.queryTerms === 1 ||
        match.exactPhrase ||
        (match.matchedTerms >= 2 && match.matchedTerms / match.queryTerms >= 0.3))
    )
    .slice(0, MAX_CHOICES)
    .map((match) => ({
      id: match.candidate.id,
      source: match.candidate.source,
      title: match.candidate.title,
      summary: match.candidate.summary,
      operationIds: [...match.candidate.operationIds],
      score: match.score,
      confidence: match.confidence,
    }));
}

export function createWorkflowResolver(
  sources: WorkflowResolverSources,
): (input: WorkflowResolverInput) => WorkflowResolution {
  const index = buildIndex(sources);
  const details = buildWorkflowDetails(sources.catalog.cards);
  const controls = [...sources.catalog.controls].sort((left, right) =>
    right.trigger.allOf.length - left.trigger.allOf.length || left.id.localeCompare(right.id)
  );
  return ({ prompt, surface }) => {
    const boundedPrompt = prompt.trim().slice(0, MAX_PROMPT_CHARS);
    if (!boundedPrompt) {
      return {
        kind: "unsupported",
        disposition: "unsupported",
        version: sources.catalog.version,
        classification: {
          code: "empty_request",
          reason: "A merchant or buyer request is required before resolving a workflow.",
        },
        safetyNotes: [],
      };
    }

    const control = matchControl(boundedPrompt, surface, controls);
    if (control) {
      return {
        kind: "control",
        disposition: control.disposition,
        version: sources.catalog.version,
        classification: {
          controlId: control.id,
          code: control.reasonCode,
          reason: control.summary,
        },
        safePlan: planFromControl(control, index),
        forbiddenOperationIds: [...control.forbiddenOperationIds],
        safetyNotes: [...control.rules],
      };
    }

    const exactRoute = sources.catalog.routes.find((route) =>
      route.surface === surface && route.id === boundedPrompt
    );
    if (exactRoute) {
      const candidate = index.candidates.find((item) => item.id === exactRoute.id)!;
      const plan = planFromRoutes([{
        candidate,
        score: 100,
        confidence: 1,
        matchedTerms: 1,
        queryTerms: 1,
        exactPhrase: true,
      }], [boundedPrompt])!;
      return resolvedRoutePlan(sources.catalog.version, plan, details);
    }

    const exactOperation = index.operationsById.get(boundedPrompt);
    if (
      exactOperation &&
      ["execute", "continuation"].includes(exactOperation.exposure) &&
      (exactOperation.surface === surface ||
        (surface === "dashboard" &&
          exactOperation.surface === "storefront" &&
          exactOperation.risk === "read"))
    ) {
      const candidate = index.candidates.find((item) =>
        item.id === `operation.${exactOperation.operationId}`
      )!;
      return {
        kind: "plan",
        disposition: "execute",
        version: sources.catalog.version,
        plan: planFromFallback({
          candidate,
          score: 100,
          confidence: 1,
          matchedTerms: 1,
          queryTerms: 1,
          exactPhrase: true,
        }, index, boundedPrompt),
        safetyNotes: [],
      };
    }

    const routes = scoreCandidates(boundedPrompt, surface, index, "route");
    if (routes[0] && strongRouteMatch(routes[0], routes[1])) {
      const plan = planFromRoutes([routes[0]], [boundedPrompt]);
      if (plan) {
        return resolvedRoutePlan(sources.catalog.version, plan, details);
      }
    }

    const clauses = splitClauses(boundedPrompt);
    if (clauses.length > 1 && clauses.length <= MAX_COMPOSED_ROUTES) {
      const clauseMatches: ScoredCandidate[] = [];
      let complete = true;
      for (const clause of clauses) {
        const ranked = scoreCandidates(clause, surface, index, "route");
        if (!ranked[0] || !strongRouteMatch(ranked[0], ranked[1])) {
          complete = false;
          break;
        }
        clauseMatches.push(ranked[0]);
      }
      const uniqueMatches = unique(clauseMatches.map((match) => match.candidate.id))
        .map((id) => clauseMatches.find((match) => match.candidate.id === id)!);
      if (complete && uniqueMatches.length > 1) {
        const plan = planFromRoutes(uniqueMatches, clauses);
        if (plan) {
          return resolvedRoutePlan(sources.catalog.version, plan, details);
        }
      }
    }

    const fallbacks = scoreCandidates(boundedPrompt, surface, index, "operation-fallback");
    if (fallbacks[0] && strongFallbackMatch(fallbacks[0], fallbacks[1])) {
      return {
        kind: "plan",
        disposition: "execute",
        version: sources.catalog.version,
        plan: planFromFallback(fallbacks[0], index, boundedPrompt),
        safetyNotes: [],
      };
    }

    const choices = choicesFromRanked([...routes.slice(0, 3), ...fallbacks.slice(0, 3)]
      .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id)));
    if (choices.length > 0) {
      return {
        kind: "choices",
        disposition: "ask",
        version: sources.catalog.version,
        choices,
        safetyNotes: [],
      };
    }
    return {
      kind: "unsupported",
      disposition: "unsupported",
      version: sources.catalog.version,
      classification: {
        code: "no_supported_workflow",
        reason: "No reviewed workflow route or registered operation confidently matches this request.",
      },
      safetyNotes: [],
    };
  };
}

export type WorkflowReadInputPrimitive = string | number | boolean | null;

export type CompiledWorkflowReadOperationInput = {
  path?: Record<string, string | number | boolean>;
  query?: Record<string, WorkflowReadInputPrimitive | WorkflowReadInputPrimitive[]>;
  body?: unknown;
};

export type CompiledWorkflowReadStep = {
  namespace: string;
  operationId: string;
  input: CompiledWorkflowReadOperationInput;
  output: WorkflowResolverOutputProjection;
};

export type CompiledWorkflowReadPhase = {
  id: string;
  steps: CompiledWorkflowReadStep[];
};

export type CompiledWorkflowRead = {
  version: string;
  workflowId: string;
  rules: string[];
  phases: CompiledWorkflowReadPhase[];
};

export type ProjectedWorkflowReadScalar = string | number | boolean | null;
export type ProjectedWorkflowReadValue = ProjectedWorkflowReadScalar |
  ProjectedWorkflowReadScalar[] |
  Record<string, ProjectedWorkflowReadScalar> |
  Array<Record<string, ProjectedWorkflowReadScalar>>;
export type ProjectedWorkflowReadStep = Record<string, ProjectedWorkflowReadValue>;

const WORKFLOW_READ_MAX_TEMPLATE_NODES = 1_000;
const WORKFLOW_READ_MAX_TEMPLATE_DEPTH = 16;
const WORKFLOW_READ_MAX_PHASES = 8;
const WORKFLOW_READ_MAX_STEPS = 20;
const WORKFLOW_READ_MAX_SELECTORS = 24;
const WORKFLOW_READ_MAX_FIELDS = 32;
const WORKFLOW_READ_MAX_ITEMS = 100;
const WORKFLOW_READ_MAX_ALIAS_LENGTH = 64;
const WORKFLOW_READ_MAX_RULES = 6;
const WORKFLOW_READ_MAX_RULE_LENGTH = 300;
const WORKFLOW_READ_LOCAL_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WORKFLOW_READ_ALIAS = /^[A-Za-z][A-Za-z0-9_]*$/;
const WORKFLOW_READ_FORBIDDEN_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "*",
  "-",
  ".",
  "..",
]);

function workflowReadRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function workflowReadScalar(value: unknown): value is ProjectedWorkflowReadScalar {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value);
}

function workflowReadAlias(value: string): boolean {
  return value.length <= WORKFLOW_READ_MAX_ALIAS_LENGTH && WORKFLOW_READ_ALIAS.test(value) &&
    !WORKFLOW_READ_FORBIDDEN_SEGMENTS.has(value);
}

function copyWorkflowReadRules(rules: readonly string[]): string[] | null {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > WORKFLOW_READ_MAX_RULES) {
    return null;
  }
  const copied: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (
      typeof rule !== "string" ||
      rule.length > WORKFLOW_READ_MAX_RULE_LENGTH ||
      rule.trim() !== rule ||
      rule.length === 0 ||
      seen.has(rule)
    ) return null;
    seen.add(rule);
    copied.push(rule);
  }
  return copied;
}

function workflowReadRulesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((rule, index) => rule === right[index]);
}

function workflowReadPointer(pointer: string): string[] | null {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const segments: string[] = [];
  for (const encoded of pointer.slice(1).split("/")) {
    if (encoded === "" || /~(?:[^01]|$)/.test(encoded)) return null;
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      segment === "" ||
      WORKFLOW_READ_FORBIDDEN_SEGMENTS.has(segment) ||
      segment.includes("*") ||
      segment.startsWith("$") ||
      segment.startsWith("@")
    ) return null;
    segments.push(segment);
  }
  return segments;
}

function workflowReadOwnValue(
  container: unknown,
  segment: string,
): { value: unknown } | null {
  if (Array.isArray(container)) {
    if (!/^(0|[1-9][0-9]*)$/.test(segment)) return null;
    const index = Number(segment);
    if (!Number.isSafeInteger(index) || index >= container.length) return null;
    return { value: container[index] };
  }
  if (!workflowReadRecord(container)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(container, segment);
  return descriptor && "value" in descriptor ? { value: descriptor.value } : null;
}

function workflowReadResolvePointer(
  root: unknown,
  pointer: string,
): { value: unknown } | null {
  const segments = workflowReadPointer(pointer);
  if (!segments) return null;
  let value = root;
  for (const segment of segments) {
    const next = workflowReadOwnValue(value, segment);
    if (!next) return null;
    value = next.value;
  }
  return { value };
}

function cloneWorkflowReadJson(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): unknown | undefined {
  state.nodes += 1;
  if (
    state.nodes > WORKFLOW_READ_MAX_TEMPLATE_NODES ||
    depth > WORKFLOW_READ_MAX_TEMPLATE_DEPTH
  ) return undefined;
  if (workflowReadScalar(value)) return value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const cloned = cloneWorkflowReadJson(item, state, depth + 1);
      if (cloned === undefined) return undefined;
      output.push(cloned);
    }
    return output;
  }
  if (!workflowReadRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (WORKFLOW_READ_FORBIDDEN_SEGMENTS.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const cloned = cloneWorkflowReadJson(descriptor.value, state, depth + 1);
    if (cloned === undefined) return undefined;
    output[key] = cloned;
  }
  return output;
}

function workflowReadJsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function setWorkflowReadPointer(root: unknown, pointer: string, value: unknown): boolean {
  const segments = workflowReadPointer(pointer);
  if (!segments || segments.length === 0) return false;
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    const next = workflowReadOwnValue(parent, segment);
    if (!next) return false;
    parent = next.value;
  }
  const last = segments.at(-1)!;
  if (!workflowReadOwnValue(parent, last)) return false;
  if (Array.isArray(parent)) {
    parent[Number(last)] = value;
    return true;
  }
  if (!workflowReadRecord(parent)) return false;
  parent[last] = value;
  return true;
}

function workflowReadOperationInput(value: unknown): CompiledWorkflowReadOperationInput | null {
  if (!workflowReadRecord(value)) return null;
  if (Object.keys(value).some((key) => !["path", "query", "body"].includes(key))) return null;
  if (
    value.path !== undefined &&
    (!workflowReadRecord(value.path) || Object.values(value.path).some((item) =>
      typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean"
    ))
  ) return null;
  if (
    value.query !== undefined &&
    (!workflowReadRecord(value.query) || Object.values(value.query).some((item) =>
      Array.isArray(item)
        ? item.some((entry) => !workflowReadScalar(entry))
        : !workflowReadScalar(item)
    ))
  ) return null;
  return value as CompiledWorkflowReadOperationInput;
}

type WorkflowReadFact = WorkflowResolverCard["requiredFacts"][number];

function fixedWorkflowReadFact(fact: WorkflowReadFact): unknown | undefined {
  const value = Object.hasOwn(fact, "defaultValue")
    ? fact.defaultValue
    : fact.source.kind === "constant"
      ? fact.source.value
      : undefined;
  return cloneWorkflowReadJson(value, { nodes: 0 });
}

function workflowReadFacts(
  card: WorkflowResolverCard,
  operationIds: ReadonlySet<string>,
): Map<string, WorkflowReadFact> | null {
  const facts = new Map<string, WorkflowReadFact>();
  for (const fact of card.requiredFacts) {
    if (!fact.id || facts.has(fact.id) || fact.source.kind === "merchant") return null;
    if (fact.source.kind === "constant") {
      const constant = cloneWorkflowReadJson(fact.source.value, { nodes: 0 });
      if (constant === undefined) return null;
      if (Object.hasOwn(fact, "defaultValue") && !workflowReadJsonEqual(
        constant,
        fact.defaultValue,
      )) return null;
    }
    if (fact.source.kind === "operation") {
      const references = [fact.source, ...(fact.source.alternatives ?? [])];
      if (references.some((reference) =>
        !operationIds.has(reference.operationId) ||
        reference.responsePointer === "" ||
        workflowReadPointer(reference.responsePointer) === null
      )) return null;
    }
    facts.set(fact.id, fact);
  }
  return facts;
}

function materializeWorkflowReadInput(
  step: WorkflowResolverCard["phases"][number]["steps"][number],
  facts: ReadonlyMap<string, WorkflowReadFact>,
): CompiledWorkflowReadOperationInput | null {
  const template = cloneWorkflowReadJson(step.input.template, { nodes: 0 });
  if (template === undefined) return null;
  const defaultPointers = new Set<string>();
  for (const inputDefault of step.input.defaults) {
    const current = workflowReadResolvePointer(template, inputDefault.templatePointer);
    const value = cloneWorkflowReadJson(inputDefault.value, { nodes: 0 });
    if (
      defaultPointers.has(inputDefault.templatePointer) ||
      !current ||
      value === undefined ||
      !workflowReadJsonEqual(current.value, value) ||
      !setWorkflowReadPointer(template, inputDefault.templatePointer, value)
    ) return null;
    defaultPointers.add(inputDefault.templatePointer);
  }
  const dependencyPointers = new Set<string>();
  for (const dependency of step.input.dependencies) {
    if (
      dependencyPointers.has(dependency.templatePointer) ||
      dependency.source.kind !== "fact"
    ) return null;
    const fact = facts.get(dependency.source.factId);
    if (!fact) return null;
    let value = fixedWorkflowReadFact(fact);
    if (value === undefined) return null;
    if (dependency.source.factPointer !== undefined) {
      const selected = workflowReadResolvePointer(value, dependency.source.factPointer);
      if (!selected) return null;
      value = cloneWorkflowReadJson(selected.value, { nodes: 0 });
      if (value === undefined) return null;
    }
    if (!setWorkflowReadPointer(template, dependency.templatePointer, value)) return null;
    dependencyPointers.add(dependency.templatePointer);
  }
  return workflowReadOperationInput(template);
}

function copyWorkflowReadProjection(
  projection: WorkflowResolverOutputProjection | undefined,
): WorkflowResolverOutputProjection | null {
  if (
    !projection ||
    projection.selectors.length === 0 ||
    projection.selectors.length > WORKFLOW_READ_MAX_SELECTORS
  ) return null;
  const aliases = new Set<string>();
  const selectors: WorkflowResolverOutputSelector[] = [];
  for (const selector of projection.selectors) {
    if (
      !workflowReadAlias(selector.alias) ||
      aliases.has(selector.alias) ||
      selector.pointer === "" ||
      workflowReadPointer(selector.pointer) === null
    ) return null;
    aliases.add(selector.alias);
    if (
      selector.maxItems !== undefined &&
      (!Number.isSafeInteger(selector.maxItems) ||
        selector.maxItems < 1 ||
        selector.maxItems > WORKFLOW_READ_MAX_ITEMS)
    ) return null;
    let fields: WorkflowResolverOutputField[] | undefined;
    if (selector.fields !== undefined) {
      if (selector.fields.length === 0 || selector.fields.length > WORKFLOW_READ_MAX_FIELDS) {
        return null;
      }
      const fieldAliases = new Set<string>();
      fields = [];
      for (const field of selector.fields) {
        if (
          !workflowReadAlias(field.alias) ||
          fieldAliases.has(field.alias) ||
          field.pointer === "" ||
          workflowReadPointer(field.pointer) === null
        ) return null;
        fieldAliases.add(field.alias);
        fields.push({ pointer: field.pointer, alias: field.alias });
      }
    }
    selectors.push({
      pointer: selector.pointer,
      alias: selector.alias,
      ...(selector.maxItems !== undefined ? { maxItems: selector.maxItems } : {}),
      ...(fields ? { fields } : {}),
    });
  }
  return { selectors };
}

function workflowReadOperationSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length && rightSet.size === right.length &&
    leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

export function createWorkflowReadCompiler(
  sources: WorkflowResolverSources,
): (input: WorkflowResolverInput) => CompiledWorkflowRead | null {
  const resolveWorkflow = createWorkflowResolver(sources);
  const operations = new Map<string, WorkflowResolverOperation>();
  const duplicateOperationIds = new Set<string>();
  for (const operation of sources.operations) {
    if (operations.has(operation.operationId)) duplicateOperationIds.add(operation.operationId);
    operations.set(operation.operationId, operation);
  }

  return (input) => {
    const resolution = resolveWorkflow(input);
    if (
      resolution.kind !== "plan" ||
      resolution.disposition !== "execute" ||
      resolution.plan.source !== "route" ||
      resolution.plan.kind !== "read" ||
      !resolution.plan.detail ||
      resolution.plan.routeIds.length !== 1 ||
      resolution.plan.workflowIds.length !== 1
    ) return null;

    const routes = sources.catalog.routes.filter((route) =>
      route.id === resolution.plan.routeIds[0]
    );
    const workflowId = resolution.plan.workflowIds[0]!;
    const cards = (sources.catalog.cards ?? []).filter((card) => card.id === workflowId);
    if (routes.length !== 1 || cards.length !== 1) return null;
    const route = routes[0]!;
    const card = cards[0]!;
    const routeRules = copyWorkflowReadRules(route.rules);
    const resolvedRules = copyWorkflowReadRules(resolution.plan.rules);
    const cardSteps = card.phases.flatMap((phase) => phase.steps);
    const cardOperationIds = unique(cardSteps.map((step) => step.operationId));
    if (
      route.surface !== input.surface ||
      route.kind !== "read" ||
      route.workflowId !== workflowId ||
      card.phases.length === 0 ||
      card.phases.length > WORKFLOW_READ_MAX_PHASES ||
      cardSteps.length === 0 ||
      cardSteps.length > WORKFLOW_READ_MAX_STEPS ||
      !routeRules ||
      !resolvedRules ||
      !workflowReadRulesEqual(routeRules, resolvedRules) ||
      !workflowReadOperationSet(route.operationIds, resolution.plan.operationIds) ||
      !workflowReadOperationSet(route.operationIds, cardOperationIds)
    ) return null;

    for (const operationId of route.operationIds) {
      const operation = operations.get(operationId);
      if (
        !operation ||
        duplicateOperationIds.has(operationId) ||
        operation.surface !== input.surface ||
        operation.risk !== "read" ||
        operation.exposure !== "execute" ||
        operation.openWorld !== false
      ) return null;
    }

    const facts = workflowReadFacts(card, new Set(route.operationIds));
    if (!facts) return null;
    const phaseIds = new Set<string>();
    const namespaces = new Set<string>();
    const phases: CompiledWorkflowReadPhase[] = [];
    for (const phase of card.phases) {
      if (
        !WORKFLOW_READ_LOCAL_ID.test(phase.id) ||
        phaseIds.has(phase.id) ||
        phase.surface !== input.surface ||
        !phase.dependsOn ||
        phase.dependsOn.some((dependency) => !phaseIds.has(dependency))
      ) return null;
      phaseIds.add(phase.id);
      const steps: CompiledWorkflowReadStep[] = [];
      for (const step of phase.steps) {
        const namespace = `${phase.id}.${step.id}`;
        if (
          !WORKFLOW_READ_LOCAL_ID.test(step.id) ||
          namespaces.has(namespace) ||
          step.mutation !== "read" ||
          step.repeat !== undefined ||
          step.input.picks !== undefined ||
          step.input.materializations !== undefined
        ) return null;
        const operation = operations.get(step.operationId);
        if (
          !operation ||
          operation.surface !== input.surface ||
          operation.risk !== "read" ||
          operation.exposure !== "execute" ||
          operation.openWorld !== false
        ) return null;
        const materializedInput = materializeWorkflowReadInput(step, facts);
        const output = copyWorkflowReadProjection(step.output);
        if (!materializedInput || !output) return null;
        namespaces.add(namespace);
        steps.push({ namespace, operationId: step.operationId, input: materializedInput, output });
      }
      if (steps.length === 0) return null;
      phases.push({ id: phase.id, steps });
    }
    return { version: resolution.version, workflowId, rules: resolvedRules, phases };
  };
}

function projectWorkflowReadFields(
  value: unknown,
  fields: readonly WorkflowResolverOutputField[],
): Record<string, ProjectedWorkflowReadScalar> | null {
  if (!workflowReadRecord(value) || fields.length === 0 || fields.length > WORKFLOW_READ_MAX_FIELDS) {
    return null;
  }
  const output: Record<string, ProjectedWorkflowReadScalar> = {};
  for (const field of fields) {
    if (!workflowReadAlias(field.alias) || Object.hasOwn(output, field.alias)) return null;
    const selected = workflowReadResolvePointer(value, field.pointer);
    if (!selected || !workflowReadScalar(selected.value)) return null;
    output[field.alias] = selected.value;
  }
  return output;
}

export function projectWorkflowReadResponse(
  response: unknown,
  projection: WorkflowResolverOutputProjection,
): ProjectedWorkflowReadStep | null {
  const reviewed = copyWorkflowReadProjection(projection);
  if (!reviewed) return null;
  const output: ProjectedWorkflowReadStep = {};
  for (const selector of reviewed.selectors) {
    const selected = workflowReadResolvePointer(response, selector.pointer);
    if (!selected) return null;
    let value: ProjectedWorkflowReadValue;
    if (selector.maxItems !== undefined) {
      if (!Array.isArray(selected.value)) return null;
      const items = selected.value.slice(0, selector.maxItems);
      if (selector.fields) {
        const projectedItems: Array<Record<string, ProjectedWorkflowReadScalar>> = [];
        for (const item of items) {
          const projected = projectWorkflowReadFields(item, selector.fields);
          if (!projected) return null;
          projectedItems.push(projected);
        }
        value = projectedItems;
      } else {
        if (items.some((item) => !workflowReadScalar(item))) return null;
        value = items as ProjectedWorkflowReadScalar[];
      }
    } else if (selector.fields) {
      const projected = projectWorkflowReadFields(selected.value, selector.fields);
      if (!projected) return null;
      value = projected;
    } else {
      if (!workflowReadScalar(selected.value)) return null;
      value = selected.value;
    }
    output[selector.alias] = value;
  }
  return output;
}
