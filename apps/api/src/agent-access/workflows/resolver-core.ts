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
  fixedCalendarDays?: number;
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
  trigger: {
    allOf: string[][];
    anyOf?: Array<{ allOf: string[][] }>;
    ignoreWhenNegated: boolean;
    noneOf?: string[];
  };
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
  exactItems?: number;
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
const MAX_MEANINGFUL_CLAUSES = 8;
const MAX_PLAN_OPERATIONS = 20;
const MAX_DETAILED_RESOLUTION_BYTES = 16 * 1024 - 64;
const MAX_STANDARD_DETAIL_RESOLUTION_BYTES = 12 * 1024 - 64;
const NON_EXACT_COMPOUND_ROUTE_CONFIDENCE = 0.8;
const BM25_K1 = 1.25;
const BM25_B = 0.65;

const STOP_WORDS = new Set([
  "a", "an", "are", "as", "at", "be", "been", "by", "can", "did", "do",
  "does", "for", "from", "give", "how", "i", "in", "is", "it", "me",
  "my", "of", "on", "our", "per", "please", "show", "tell", "that", "the", "their", "this",
  "to", "was", "were", "what", "when", "where", "which", "who", "why", "with",
]);

const VOCABULARY_GROUPS: readonly (readonly string[])[] = [
  ["buyer", "buyers", "customer", "customers", "shopper", "shoppers"],
  ["address", "addresses"],
  ["sale", "sales", "sold", "revenue", "gmv", "gross", "turnover", "booking", "bookings"],
  ["delivery", "deliveries", "ship", "shipping", "shipment", "shipments", "courier", "couriers"],
  ["payment", "payments", "gateway", "gateways"],
  ["order", "orders", "purchase", "purchases"],
  ["product", "products", "merchandise", "catalog"],
  ["inventory", "inventories", "stock"],
  ["low", "depleted", "exhausted", "scant", "scarce", "shortage", "shortages"],
  ["count", "counts", "tally", "tallies", "volume", "volumes", "case", "cases"],
  ["currency", "denomination", "monetary", "money"],
  ["symbol", "glyph", "mark", "sign"],
  ["code", "identifier"],
  ["format", "formatting"],
  ["fulfill", "fulfil", "fulfillment", "fulfilment", "unfulfilled"],
  ["setting", "settings", "configuration", "configured", "config"],
  ["create", "add", "new"],
  ["update", "change", "edit", "replace", "rotate", "save"],
  ["read", "get", "find", "lookup", "list", "show"],
  ["delete", "remove"],
  ["publish", "published", "publication", "activate", "active"],
  ["enable", "enabled", "deactivate", "inactive", "disable", "disabled"],
  ["variant", "variants", "sku", "skus"],
  ["unique", "uniqueness", "uniquely"],
  ["image", "images", "media", "asset", "assets"],
  ["refund", "refunds", "refunded"],
  ["return", "returns"],
  ["page", "pages", "content", "article", "articles"],
  ["navigation", "menu", "menus", "header"],
  ["store", "shop", "storefront", "website"],
  ["today", "daily", "day"],
  ["issue", "issues", "problem", "problems", "failure", "failed", "alert", "alerts"],
  ["ready", "readiness", "healthy", "health", "work", "working", "nobody"],
  ["need", "action", "actionable", "needed", "needs", "needing"],
  ["log", "logs"],
  ["checkout", "check", "cart", "carts", "basket", "baskets"],
  ["abandoned", "deserted", "uncompleted", "unfinished"],
  ["recovery", "recoveries", "recoverable"],
  ["exact", "specific", "identified"],
  ["preview", "probe", "verify", "verification"],
  ["secret", "credential", "credentials", "key", "password", "sid", "token"],
  ["city", "cities"],
  ["zone", "zones"],
  ["method", "methods", "option", "options"],
];

const NORMALIZED_VOCABULARY = new Map<string, string>();
for (const group of VOCABULARY_GROUPS) {
  const canonical = group[0]!;
  for (const term of group) NORMALIZED_VOCABULARY.set(term, canonical);
}

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
  supportTerms: ReadonlySet<string>;
  actionTerms: ReadonlySet<string>;
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

const OPERATIONAL_AGE_ENTITY =
  /\b(?:payment(?:\s+|-)recover(?:y|ies)|orders?|checkouts?|payments?|recover(?:y|ies)|fulfillments?)\b/gi;
const OPERATIONAL_AGE_MARKER =
  /\b(?:for|over|older(?:\s+than)?|aged|aging|open|outstanding|overdue|pending|stuck|unresolved|abandoned|failed|recoverable|needs(?:\s+|-)attention)\b/i;
const GENERIC_LOCAL_AGE_CONTEXT =
  /\b[a-z][a-z0-9-]*(?:\s+(?:objects?|records?|items?|cases?))?\s+(?:(?:(?:that\s+)?(?:have|has)\s+)?(?:(?:remain(?:ed|s|ing)?|been)\s+)?(?:open|outstanding|unresolved|pending|stuck|aged|aging|overdue)\s+(?:for|over)|older\s+than)\s*$/i;
const REPORT_WINDOW_ENTITY =
  /\b(?:operations?|reports?|briefs?|briefings?|snapshots?|summaries?|activity)\b/gi;
const DURATION_EXPRESSION =
  /\b(?:\d+(?:\.\d+)?|[a-z]+)[\s-]+(?:days?|weeks?)\b/gi;

type TextRange = { start: number; end: number };

function lastMatchIndex(value: string, pattern: RegExp): number {
  let index = -1;
  for (const match of value.matchAll(new RegExp(pattern.source, pattern.flags))) {
    index = match.index ?? index;
  }
  return index;
}

function operationalAgeRanges(value: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const duration of value.matchAll(new RegExp(
    DURATION_EXPRESSION.source,
    DURATION_EXPRESSION.flags,
  ))) {
    const durationStart = duration.index ?? 0;
    const hardBoundary = Math.max(
      value.lastIndexOf(";", durationStart),
      value.lastIndexOf(".", durationStart),
      value.lastIndexOf("!", durationStart),
      value.lastIndexOf("?", durationStart),
      value.lastIndexOf("\n", durationStart),
      value.lastIndexOf("/", durationStart),
    );
    const start = Math.max(hardBoundary + 1, durationStart - 112);
    const context = value.slice(start, durationStart);
    const genericAge = context.match(GENERIC_LOCAL_AGE_CONTEXT);
    const entityIndex = Math.max(
      lastMatchIndex(context, OPERATIONAL_AGE_ENTITY),
      genericAge?.index ?? -1,
    );
    const reportIndex = lastMatchIndex(context, REPORT_WINDOW_ENTITY);
    if (
      entityIndex < 0 ||
      reportIndex > entityIndex ||
      (!genericAge && !OPERATIONAL_AGE_MARKER.test(context.slice(entityIndex)))
    ) continue;
    ranges.push({ start: start + entityIndex, end: durationStart + duration[0].length });
  }
  return ranges;
}

function annotateOperationalAges(value: string): string {
  let annotated = value;
  for (const range of operationalAgeRanges(value).reverse()) {
    annotated = `${annotated.slice(0, range.end)} aging count${annotated.slice(range.end)}`;
  }
  return annotated;
}

function normalizeSemanticPhrases(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  return annotateOperationalAges(normalized)
    .replace(/\b(?:last|past|previous|rolling|current)[\s-]+30[\s-]+(?:calendar[\s-]+)?days?\b/gi, "30 day")
    .replace(/\b(?:calendar[\s-]+)?30[\s-]+(?:calendar[\s-]+)?days?\b/gi, "30 day")
    .replace(/\bthirty[\s-]+(?:calendar[\s-]+)?days?\b/gi, "30 day")
    .replace(/\baverage\s+order\s+value\b/gi, "aov")
    .replace(/\blifetime\s+value\b/gi, "ltv")
    .replace(/\bcustomer\s+acquisition\s+cost\b/gi, "cac")
    .replace(/\breturning\s+customers?\b/gi, "repeat customer")
    .replace(/\b(?:paid|collected|settled|settlement)\s+revenue\b/gi, "cash")
    .replace(/\b(?:gross\s+)?booking\s+values?\b/gi, "booked revenue")
    .replace(/\b(?:gross\s+)?booked\s+(?:amounts?|values?)\b/gi, "booked revenue")
    .replace(/\bgross\s+values?\s+committed\s+at\s+order\s+time\b/gi, "booked revenue")
    .replace(/\bpurchase\s+placements?\b/gi, "orders")
    .replace(/\bpurchase\s+volumes?\b/gi, "order count")
    .replace(/\bshop\s+money\s+abbreviations?\b/gi, "currency code")
    .replace(/\b(?:stored\s+)?tender\s+iso\s+codes?\b/gi, "currency code")
    .replace(/\bdisplay\s+marks?\b/gi, "currency symbol")
    .replace(/\bcurrency\s+identifiers?\b/gi, "currency code")
    .replace(/\bcurrency\s+marks?\b/gi, "currency symbol")
    .replace(/\blow[\s-]+on[\s-]+hand\b/gi, "low stock")
    .replace(/\bnear[\s-]+empty\b/gi, "low stock")
    .replace(/\bzero[\s-]+available\b/gi, "out of stock")
    .replace(/\bsold[\s-]+out\b/gi, "out of stock")
    .replace(/\bstock[\s-]+shortages?\b/gi, "low stock")
    .replace(/\bexhausted[\s-]+skus?\b/gi, "out of stock sku")
    .replace(/\bdepleted\s+inventor(?:y|ies)\b/gi, "low inventory")
    .replace(/\b(?:uncompleted|unfinished)[\s-]+(?:cart|checkout)(?:[\s-]+flows?|s)?\b/gi, "abandoned cart")
    .replace(/\b(?:incomplete|unconverted)[\s-]+(?:cart|checkout)(?:[\s-]+flows?|s)?\b/gi, "abandoned cart")
    .replace(/\b(?:one\s+)?merchant[\s-]+local\s+rows?\s+per\s+business\s+date\b/gi, "daily activity date")
    .replace(/\bmanual[\s-]+attention\b/gi, "needs attention")
    .replace(/\bhosted[\s-]+payment\s+continuations?\b/gi, "recoverable payment backlog")
    .replace(/\bpayment\s+rescues?\s+requiring\s+operator\s+intervention\b/gi, "payment needs attention")
    .replace(/\brecoverable[\s-]+payments?\s+work\b/gi, "recoverable payment backlog")
    .replace(/\bvisitors?\b/gi, "traffic");
}

function tokenize(value: string): string[] {
  return normalizeSemanticPhrases(value)
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

function buildWorkflowReadFactTerms(
  cards: readonly WorkflowResolverCard[] | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const facts = new Map<string, ReadonlySet<string>>();
  for (const card of cards ?? []) {
    const text = card.phases.flatMap((phase) => [
      phase.id,
      ...phase.steps.flatMap((step) => [
        step.id,
        ...(step.output?.selectors.flatMap((selector) => [
          selector.alias,
          ...((selector.fields ?? []).map((field) => field.alias)),
        ]) ?? []),
      ]),
    ]);
    facts.set(card.id, new Set(text.flatMap(tokenize)));
  }
  return facts;
}

type WorkflowInputVocabulary = {
  semantic: ReadonlySet<string>;
  rawFields: ReadonlySet<string>;
  rawPhrases: ReadonlySet<string>;
};

function collectInputFieldWords(
  value: unknown,
  target: Set<string>,
  phrases: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectInputFieldWords(item, target, phrases);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.properties !== null && typeof record.properties === "object") {
    for (const [name, schema] of Object.entries(record.properties as Record<string, unknown>)) {
      const words = rawWords(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
      phrases.add(words.join(" "));
      for (const word of words) {
        target.add(word);
      }
      collectInputFieldWords(schema, target, phrases);
    }
  }
  if (typeof record.name === "string" && typeof record.in === "string") {
    for (const word of rawWords(record.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))) {
      target.add(word);
    }
  }
  if (Array.isArray(record.enum)) {
    for (const item of record.enum) {
      if (typeof item === "string") rawWords(item).forEach((word) => target.add(word));
    }
  }
  for (const [key, nested] of Object.entries(record)) {
    if (!["properties", "enum"].includes(key)) {
      collectInputFieldWords(nested, target, phrases);
    }
  }
}

function inputVocabulary(schemas: readonly unknown[]): WorkflowInputVocabulary {
  const semantic = new Set<string>();
  const rawFields = new Set<string>();
  const rawPhrases = new Set<string>();
  for (const schema of schemas) {
    collectInputFieldWords(schema, rawFields, rawPhrases);
    try {
      tokenize(JSON.stringify(schema)).forEach((term) => semantic.add(term));
    } catch {
      // An unstringifiable schema contributes no trusted field vocabulary.
    }
  }
  return { semantic, rawFields, rawPhrases };
}

function buildRouteInputTerms(
  sources: WorkflowResolverSources,
): ReadonlyMap<string, WorkflowInputVocabulary> {
  const operations = new Map(
    sources.operations.map((operation) => [operation.operationId, operation] as const),
  );
  const terms = new Map<string, WorkflowInputVocabulary>();
  for (const route of sources.catalog.routes) {
    const schemas = route.operationIds.flatMap((operationId) => {
      const schema = operations.get(operationId)?.inputSchema;
      return schema === undefined ? [] : [schema];
    });
    terms.set(route.id, inputVocabulary(schemas));
  }
  for (const operation of sources.operations) {
    if (operation.inputSchema === undefined) continue;
    terms.set(
      `operation.${operation.operationId}`,
      inputVocabulary([operation.inputSchema]),
    );
  }
  return terms;
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
  base: Omit<
    SearchCandidate,
    "terms" | "anchorTerms" | "supportTerms" | "actionTerms" | "length" | "normalizedPhrases"
  >,
  fields: Array<{ value?: string; weight: number }>,
  phrases: string[],
  anchors: string[],
  supportText: string[],
): SearchCandidate {
  const terms = new Map<string, number>();
  let length = 0;
  for (const field of fields) length += addTerms(terms, field.value, field.weight);
  return {
    ...base,
    terms,
    anchorTerms: new Set(anchors.flatMap(tokenize)),
    supportTerms: new Set(supportText.flatMap(tokenize)),
    actionTerms: new Set(supportText.flatMap(rawWords).flatMap((word) => {
      const action = actionSupportLemma(word);
      return action ? [action] : [];
    })),
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
    const routeOperations = route.operationIds.flatMap((operationId) => {
      const operation = operationsById.get(operationId);
      return operation ? [operation] : [];
    });
    const operationText = routeOperations.flatMap((operation) => [
      operation.summary,
      operation.description ?? "",
      operation.tags.join(" "),
    ]).join(" ");
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
    ], [...route.examples], [route.title, route.tags.join(" ")], [
      route.title,
      route.summary,
      route.examples.join(" "),
      route.tags.join(" "),
      operationText,
    ]));
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
    ], [
      operation.operationId,
      operation.summary,
      operation.description ?? "",
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
  const normalizedQuery = normalizedPhrase(prompt);
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
      phrase === normalizedQuery
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

const REPORT_WINDOW_CONTEXT = /\b(?:brief|briefing|daily|activity|digest|report|snapshot|summary)\b/i;
const OWNER_BOOKED_OPERATIONS_CONTEXT =
  /(?:\b(?:booked|owner(?:['’]s)?)\b[\s\S]{0,40}\boperations?\b|\boperations?\b[\s\S]{0,40}\b(?:booked|owner(?:['’]s)?)\b)/i;
const AGING_CONTEXT = /\b(?:aged|aging|overdue|pending|stuck|unfulfilled)\b/i;
const FIXED_WINDOW_GENERIC_TERMS = new Set([
  "brief", "briefing", "calendar", "current", "day", "daily", "last", "past",
  "previous", "report", "rolling", "snapshot", "summary", "today", "window",
]);
const CLOSED_READ_REQUEST_MODIFIERS = new Set([
  "accepted", "available", "both", "clear", "compact", "concise", "display", "fixed", "free", "hosted", "known",
  "merchant", "noncomparable", "operational", "otherwise", "owner", "pii", "requested", "risk", "saved",
  "sellable", "small", "still", "supported", "unavailable", "unknown", "unsupported", "waiting", "work", "zero",
]);
const CLOSED_READ_GENERIC_TERMS = new Set([
  "all", "current", "data", "detail", "exact", "existing", "fact", "global",
  "information", "item", "only", "operation", "other", "platform", "record", "safe", "safely",
  "store", "system", "thing", "value",
]);
const FIXED_REPORT_HEAD_NOUNS = new Set([
  "brief", "briefing", "digest", "report", "snapshot", "summary",
]);
const FIXED_REPORT_HEAD_BRIDGES = new Set([
  "activity", "commerce", "operation",
]);
const FIXED_REPORT_SAFE_HEADS = new Set([
  "booked", "merchant", "owner", "proprietor", "shop", "store",
]);
const FIXED_REPORT_AUDIENCE_TERMS = new Set([
  "merchant", "owner", "proprietor", "shop", "store",
]);
const FIXED_REPORT_HEAD_NOISE = new Set([
  "calendar", "concise", "current", "daily", "day", "last", "past", "preceding",
  "previous", "prior", "rolling", "short", "thirty",
]);
const WORD_DAY_COUNTS = new Map([
  ["one", 1],
  ["two", 2],
  ["seven", 7],
  ["fourteen", 14],
  ["thirty", 30],
  ["sixty", 60],
  ["ninety", 90],
]);

function parsedDayCount(value: string): number | null {
  const wordCount = WORD_DAY_COUNTS.get(value.toLowerCase());
  if (wordCount !== undefined) return wordCount;
  if (value.includes(".")) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 1 ? numeric : null;
}

type FixedCalendarWindowState = "compatible" | "mismatch" | "absent";

function hasAudienceCommerceCompound(prompt: string): boolean {
  const audience = String.raw`(?:merchant|owner|proprietor|shop|store)`;
  const subject = String.raw`(?:booked|commerce|operations?)`;
  return new RegExp(
    String.raw`\b(?:${audience})(?:['’]s)?(?:\s+|-)${subject}\b|\b${subject}(?:\s+|-)${audience}\b`,
    "i",
  ).test(prompt);
}

function hasForeignFixedReportHead(
  prompt: string,
  allowedTerms: ReadonlySet<string>,
): boolean {
  const words = normalizeSemanticPhrases(prompt)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map(normalizeToken) ?? [];
  for (let index = 0; index < words.length; index += 1) {
    if (!FIXED_REPORT_HEAD_NOUNS.has(words[index]!)) continue;
    let cursor = index - 1;
    while (cursor >= 0) {
      const term = words[cursor]!;
      if (
        FIXED_REPORT_HEAD_BRIDGES.has(term) ||
        FIXED_REPORT_HEAD_NOISE.has(term) ||
        /^\d+$/.test(term) ||
        STOP_WORDS.has(term) ||
        CLAUSE_CONNECTOR_WORDS.has(term) ||
        isActionWord(term)
      ) {
        cursor -= 1;
        continue;
      }
      if (FIXED_REPORT_SAFE_HEADS.has(term) || allowedTerms.has(term)) return false;
      return true;
    }
    return false;
  }
  return false;
}

function hasFixedRouteDomainSupport(
  prompt: string,
  match: ScoredCandidate,
  workflowFactTerms: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const route = match.candidate.route;
  const promptTokens = controlTokens(prompt);
  const allowed = new Set([
    ...tokenize(
      `${route?.title ?? ""} ${route?.summary ?? ""} ${route?.tags.join(" ") ?? ""} ${route?.rules.join(" ") ?? ""}`,
    ),
    ...(route?.workflowId ? workflowFactTerms.get(route.workflowId) ?? [] : []),
  ]);
  if (hasForeignFixedReportHead(prompt, allowed)) return false;
  if (hasAudienceCommerceCompound(prompt)) return true;
  const words = normalizeSemanticPhrases(prompt)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  return words.some((word) => {
    const term = normalizeToken(word);
    return term.length > 1 &&
    allowed.has(term) &&
    !FIXED_REPORT_AUDIENCE_TERMS.has(term) &&
    matchedControlPhrase(promptTokens, term).unnegated &&
    !CONTROL_NEGATIONS.has(term) &&
    !isActionWord(word) &&
    !isActionWord(term) &&
    !/^\d+$/.test(term) &&
    !STOP_WORDS.has(term) &&
    !CLAUSE_CONNECTOR_WORDS.has(term) &&
    !FIXED_WINDOW_GENERIC_TERMS.has(term) &&
    !CLOSED_READ_GENERIC_TERMS.has(term) &&
    !GENERIC_COMPOUND_SUPPORT_TERMS.has(term) &&
    !CLOSED_READ_REQUEST_MODIFIERS.has(term);
  });
}

function fixedCalendarWindowState(
  prompt: string,
  match: ScoredCandidate,
): FixedCalendarWindowState | null {
  const fixedDays = match.candidate.route?.fixedCalendarDays;
  if (fixedDays === undefined) return null;
  if (match.exactPhrase) return "compatible";
  const normalized = prompt.normalize("NFKD").toLowerCase();
  const operationalAges = operationalAgeRanges(normalized);
  const hasReportContext = REPORT_WINDOW_CONTEXT.test(normalized) ||
    OWNER_BOOKED_OPERATIONS_CONTEXT.test(normalized);
  const isLocalFactWindow = (before: string, after = "", index?: number): boolean => {
    const local = before.slice(-64);
    return (index !== undefined && operationalAges.some((range) =>
      index >= range.start && index < range.end
    )) ||
      /\btop[\s-]*$/i.test(local) ||
      AGING_CONTEXT.test(local) ||
      /\b(?:orders?|checkouts?|payments?|recover(?:y|ies)|fulfillments?)\s*$/i.test(local) ||
      /\b(?:abandoned\s+)?(?:orders?|checkouts?|payments?|recover(?:y|ies)|fulfillments?)(?:\s+(?:aged|aging|overdue|pending|stuck))?\s+(?:for|over|older\s+than)\s*$/i.test(local) ||
      /^(?:\s*-\s*|\s+)(?:old|aged|aging|overdue|stuck)\b/i.test(after) ||
      /^\s+returns?\s+window\b/i.test(after);
  };
  const isCooperativeLocalScope = (index: number, length: number): boolean => {
    if (!hasCooperativeGapLanguage(prompt)) return false;
    const boundaries = ";.!?\n/—–";
    let start = 0;
    for (const boundary of boundaries) {
      start = Math.max(start, normalized.lastIndexOf(boundary, index) + 1);
    }
    let end = normalized.length;
    for (const boundary of boundaries) {
      const next = normalized.indexOf(boundary, index + length);
      if (next >= 0) end = Math.min(end, next);
    }
    const clause = normalized.slice(start, end);
    if (!/\b(?:if\s+(?:known|supported|available)|unavailable|unknown|unsupported|do\s+not\s+estimate|don't\s+estimate)\b/i.test(clause)) {
      return false;
    }
    const beforeScope = normalized.slice(start, index);
    const afterScope = normalized.slice(index + length, Math.min(end, index + length + 64));
    if (lastMatchIndex(afterScope, REPORT_WINDOW_ENTITY) >= 0) return false;
    if (hasAudienceCommerceCompound(afterScope)) return false;
    const reportIndex = lastMatchIndex(beforeScope, REPORT_WINDOW_ENTITY);
    const localActionIndex = lastMatchIndex(
      beforeScope,
      /\b(?:and|include|including|label|leave|mark|plus|say|treat|with)\b/gi,
    );
    return reportIndex < 0 || localActionIndex > reportIndex;
  };
  const isPeriodLabel = (before: string, after: string): boolean =>
    /\b(?:call(?:ed)?|column|heading|label(?:ed)?|name(?:d)?|note|tag|text|title)\s*["'“”]?\s*$/i
      .test(before) ||
    /^[\s"'“”]*(?:as\s+(?:a|the)\s+)?(?:column|heading|label|name|note|tag|text|title)\b/i
      .test(after);
  const wordCounts = [...WORD_DAY_COUNTS.keys()].join("|");
  const count = String.raw`(?:\d+(?:\.\d+)?|${wordCounts})`;
  const windows: Array<{ count: string; basis?: string }> = [];
  const dayExpression = new RegExp(
    String.raw`\b(?<count>${count})(?:\s+|-)(?:(?<basis>business|calendar)(?:\s+|-))?days?\b`,
    "gi",
  );
  const dayResults = [...normalized.matchAll(dayExpression)];
  const stronglyTargetsFixedRoute =
    match.confidence >= NON_EXACT_COMPOUND_ROUTE_CONFIDENCE && match.matchedTerms >= 3;
  const isReportDayScope = (result: RegExpMatchArray): boolean => {
    const index = result.index ?? 0;
    const before = normalized.slice(Math.max(0, index - 80), index);
    const after = normalized.slice(index + result[0].length, index + result[0].length + 64);
    if (isCooperativeLocalScope(index, result[0].length)) return false;
    if (isLocalFactWindow(before, after, index)) return false;
    if (isPeriodLabel(before, after)) return false;
    const hasTemporalLead = /\b(?:last|past|previous|prior|preceding|current|rolling|latest|earlier|for|over|across|during|within|covering|spanning|throughout)(?:\s+(?:a|an|the))?[\s-]*$/i
      .test(before);
    const hasCompletionTail = /^[\s-]*(?:(?:that|which)\s+)?(?:(?:just|recently|most\s+recently)\s+)?(?:completed|finished|ended)\b|^[\s-]*(?:ending|ended)\s+(?:now|today|recently)\b/i
      .test(after);
    return hasTemporalLead || hasCompletionTail || hasReportContext || stronglyTargetsFixedRoute;
  };
  const shouldCollectRelativeNonDay =
    hasReportContext || dayResults.some(isReportDayScope) || stronglyTargetsFixedRoute;
  const nonDayScope = /\b(?:(?:(?:this|last|past|previous|prior|preceding|current|rolling|latest|earlier)[\s-]+)(?:(?:fiscal|financial|calendar|accounting)[\s-]+)?|(?:(?:fiscal|financial|calendar|accounting)[\s-]+)|(?:(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]+)(?:(?:fiscal|financial|calendar|accounting)[\s-]+)?)(?:hours?|weeks?|months?|quarters?|years?)\b/gi;
  if (shouldCollectRelativeNonDay) {
    for (const result of normalized.matchAll(nonDayScope)) {
      const index = result.index ?? 0;
      const before = normalized.slice(Math.max(0, index - 80), index);
      const after = normalized.slice(index + result[0].length, index + result[0].length + 64);
      if (isPeriodLabel(before, after)) continue;
      if (isCooperativeLocalScope(index, result[0].length)) continue;
      if (!isLocalFactWindow(before, after, index)) return "mismatch";
    }
  }
  if (hasReportContext) {
    for (const result of normalized.matchAll(/\b(?:mtd|qtd|ytd|q[1-4]|(?:month|quarter|year)[\s-]+to[\s-]+date)\b/gi)) {
      if (!isCooperativeLocalScope(result.index ?? 0, result[0].length)) return "mismatch";
    }
    const dateRanges = [
      /\b\d{4}-\d{2}-\d{2}\s*(?:to|through|until|-|→|–|—)\s*(?:\d{4}-\d{2}-\d{2}|\d{1,2})\b/gi,
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\s*(?:to|through|until|-|→|–|—)\s*(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?\d{1,2}(?:st|nd|rd|th)?\b/gi,
    ];
    for (const expression of dateRanges) {
      for (const result of normalized.matchAll(expression)) {
        const index = result.index ?? 0;
        const before = normalized.slice(Math.max(0, index - 80), index);
        const after = normalized.slice(index + result[0].length, index + result[0].length + 64);
        if (isCooperativeLocalScope(index, result[0].length)) continue;
        if (!isLocalFactWindow(before, after, index)) return "mismatch";
      }
    }
    for (const result of normalized.matchAll(/\byesterday\b/gi)) {
      const index = result.index ?? 0;
      const before = normalized.slice(Math.max(0, index - 80), index);
      const after = normalized.slice(index + result[0].length, index + result[0].length + 64);
      if (isCooperativeLocalScope(index, result[0].length)) continue;
      if (!isLocalFactWindow(before, after, index)) return "mismatch";
    }
  }

  for (const result of dayResults) {
    if (!isReportDayScope(result)) continue;
    windows.push({
      count: result.groups?.count ?? "",
      ...(result.groups?.basis ? { basis: result.groups.basis } : {}),
    });
  }

  const rangeExpression = new RegExp(
    String.raw`\b(?:over|across)\s+(?<count>${count})(?:\s+days?)?\b`,
    "gi",
  );
  for (const result of normalized.matchAll(rangeExpression)) {
    const index = result.index ?? 0;
    const before = normalized.slice(Math.max(0, index - 80), index);
    const after = normalized.slice(index + result[0].length);
    if (isCooperativeLocalScope(index, result[0].length)) continue;
    if (isLocalFactWindow(before, "", index)) continue;
    if (!hasReportContext) continue;
    if (
      !/\bdays?\b/i.test(result[0]) &&
      !/^\s*(?:$|[;,.!?]|with\b|and\b|including\b|instead\b)/i.test(after)
    ) continue;
    windows.push({ count: result.groups?.count ?? "" });
  }

  const overrideExpression = new RegExp(
    String.raw`\b(?:use|make|switch|change)(?:\s+(?:this|it|the|report|brief|window)){0,2}(?:\s+to)?\s+(?<count>${count})(?:\s+days?)?(?:\s+instead)?\b`,
    "gi",
  );
  for (const result of normalized.matchAll(overrideExpression)) {
    windows.push({ count: result.groups?.count ?? "" });
  }

  const hasMismatch = windows.some((window) => {
    const days = parsedDayCount(window.count);
    return window.basis === "business" || days === null || days !== fixedDays;
  });
  if (hasMismatch) return "mismatch";
  if (fixedDays === 1) {
    if (windows.length > 0) return "mismatch";
    return /\b(?:today(?:['’]s)?|daily)\b/i.test(normalized)
      ? "compatible"
      : "absent";
  }
  return windows.length > 0 ? "compatible" : "absent";
}

const CONTROL_BOUNDARY = "__control_boundary__";
const CONTROL_NEGATIONS = new Set([
  "exclude", "never", "no", "not", "omit", "skip", "without",
]);
const CONTROL_NEGATION_RESETS = new Set([
  "afterward", "afterwards", "also", "but", "finally", "followed", "however", "later",
  "next", "subsequently", "then", "thereafter",
]);
const CONTROL_NEGATION_LOOKBACK = 16;

type ControlPhraseMatch = { matched: boolean; unnegated: boolean };

function controlTokens(value: string): string[] {
  return normalizeSemanticPhrases(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b([a-z]+)n[’']t\b/gi, "$1 not")
    .replace(/\band\s*\/\s*or\b/gi, "and or")
    .replace(/[.;:!?()[\]{}—–/]+|\r?\n/g, ` ${CONTROL_BOUNDARY} `)
    .replace(/,+/g, " ")
    .toLowerCase()
    .match(/__control_boundary__|[a-z0-9]+/g)
    ?.map((token) => token === CONTROL_BOUNDARY
      ? token
      : token === "rows"
        ? "row"
        : normalizeToken(token)) ?? [];
}

function controlPrefixIsNegated(
  promptTokens: readonly string[],
  beforeIndex: number,
): boolean {
  let seen = 0;
  for (let cursor = beforeIndex - 1; cursor >= 0 && seen < CONTROL_NEGATION_LOOKBACK; cursor -= 1) {
    const token = promptTokens[cursor]!;
    if (token === CONTROL_BOUNDARY) return false;
    if (CONTROL_NEGATION_RESETS.has(token)) {
      let localCursor = cursor - 1;
      if (promptTokens[localCursor] === "ever") localCursor -= 1;
      return localCursor >= 0 && CONTROL_NEGATIONS.has(promptTokens[localCursor]!);
    }
    seen += 1;
    if (token === "out" && promptTokens[cursor - 1] === "leave") return true;
    if (CONTROL_NEGATIONS.has(token)) return true;
  }
  return false;
}

function matchedControlPhrase(promptTokens: readonly string[], phrase: string): ControlPhraseMatch {
  const phraseTokens = controlTokens(phrase).filter((token) => token !== CONTROL_BOUNDARY);
  if (phraseTokens.length === 0) return { matched: false, unnegated: false };
  let matched = false;
  let unnegated = false;
  for (let index = 0; index <= promptTokens.length - phraseTokens.length; index += 1) {
    if (!phraseTokens.every((token, offset) => promptTokens[index + offset] === token)) continue;
    matched = true;
    if (!controlPrefixIsNegated(promptTokens, index)) unnegated = true;
  }
  return { matched, unnegated };
}

function matchControlGroups(
  promptTokens: readonly string[],
  groups: readonly (readonly string[])[],
): { matched: boolean; hasNegatedGroup: boolean } {
  let hasNegatedGroup = false;
  for (const group of groups) {
    const matches = group.map((phrase) => matchedControlPhrase(promptTokens, phrase));
    if (!matches.some((match) => match.matched)) {
      return { matched: false, hasNegatedGroup: false };
    }
    if (!matches.some((match) => match.unnegated)) hasNegatedGroup = true;
  }
  return { matched: true, hasNegatedGroup };
}

function matchControl(
  prompt: string,
  surface: WorkflowResolverSurface,
  controls: readonly WorkflowResolverControl[],
): WorkflowResolverControl | null {
  const promptTokens = controlTokens(prompt);
  return controls.find((control) => {
    if (control.surface !== "any" && control.surface !== surface) return false;
    if (control.trigger.noneOf?.some((phrase) =>
      matchedControlPhrase(promptTokens, phrase).unnegated
    )) return false;
    const base = matchControlGroups(promptTokens, control.trigger.allOf);
    if (!base.matched) return false;
    const branches = control.trigger.anyOf?.map((branch) =>
      matchControlGroups(promptTokens, branch.allOf)
    );
    if (branches && !branches.some((branch) => branch.matched)) return false;
    if (!control.trigger.ignoreWhenNegated) return true;
    if (base.hasNegatedGroup) return false;
    return branches === undefined || branches.some((branch) =>
      branch.matched && !branch.hasNegatedGroup
    );
  }) ?? null;
}

function hasCooperativeGapLanguage(prompt: string): boolean {
  const tokens = controlTokens(prompt);
  return [
    "if known",
    "if supported",
    "if available",
    "unavailable",
    "do not estimate",
    "don't estimate",
  ].some((phrase) => matchedControlPhrase(tokens, phrase).unnegated);
}

const ACTION_LEMMAS = new Set([
  "accept", "add", "adjust", "analyze", "announce", "apply", "archive",
  "activate", "approve", "assign", "build", "bypass", "calculate", "cancel", "change", "check", "compare", "configure",
  "choose", "compose", "connect", "create", "decide", "delete", "disable", "edit",
  "deactivate", "download", "email", "enable", "encode", "enroll", "export", "feature", "find", "force", "fulfill",
  "generate", "get", "give", "guarantee", "import", "include", "install", "invent", "keep", "list",
  "issue", "launch", "make", "mark", "message", "move", "notify", "place", "plan", "preserve", "preview", "probe", "publish", "put", "read",
  "reconcile", "recover", "refund", "remove", "replace", "report", "require", "restore", "retry",
  "rename", "reorder", "return", "rewrite", "save", "schedule", "search", "send", "set", "share", "show", "start",
  "stop", "summarize", "test", "trash", "treat", "turn", "unpublish", "update", "upload", "use",
  "validate", "verify", "write",
]);

const ACTION_SUPPORT_GROUPS: readonly (readonly string[])[] = [
  ["create", "add", "build", "make"],
  ["update", "adjust", "change", "edit", "put", "replace", "rewrite", "rotate", "save", "set"],
  ["enable", "activate", "disable", "start", "turn"],
  ["verify", "check", "probe", "test", "validate"],
  ["read", "find", "get", "give", "include", "list", "report", "return", "search", "show", "summarize"],
  ["delete", "remove", "trash"],
  ["preserve", "keep"],
  ["choose", "decide"],
];

const ACTION_SUPPORT_CANONICAL = new Map<string, string>();
for (const group of ACTION_SUPPORT_GROUPS) {
  const canonical = group[0]!;
  for (const action of group) ACTION_SUPPORT_CANONICAL.set(action, canonical);
}

const IRREGULAR_ACTION_LEMMAS = new Map([
  ["built", "build"],
  ["found", "find"],
  ["got", "get"],
  ["made", "make"],
  ["sent", "send"],
  ["set", "set"],
  ["wrote", "write"],
  ["written", "write"],
]);

const ACTION_LEAD_PREFIXES = new Set([
  "afterward", "afterwards", "carefully", "ever", "explicitly", "finally", "later",
  "never", "next", "now", "only", "please", "safely", "separately", "simultaneously",
  "subsequently", "thereafter",
]);

const MUTATION_ACTION_LEMMAS = new Set([
  "activate", "add", "adjust", "announce", "apply", "approve", "archive", "assign",
  "build", "cancel", "change", "configure", "connect", "create", "deactivate", "delete",
  "disable", "download", "edit", "email", "enable", "encode", "enroll", "export",
  "feature", "force", "fulfill", "generate", "import", "install", "invent", "issue",
  "launch", "make", "mark", "message", "move", "notify", "place", "publish", "recover",
  "refund", "remove", "rename", "reorder", "replace", "restore", "rewrite", "save",
  "schedule", "send", "set", "share", "start", "trash", "turn", "unpublish", "update",
  "upload", "put", "write",
]);

const PRESENTATION_ACTION_LEMMAS = new Set(["build", "create", "generate", "make", "write"]);
const PRESENTATION_OUTPUT_TERMS = new Set([
  "block", "brief", "bullet", "card", "chart", "code", "column", "compact", "concise", "csv",
  "format", "grid", "heading", "html", "icon", "indented", "json", "key", "labeled", "line",
  "delimited", "list", "markdown", "matrix", "monospaced", "nested", "note", "numbered", "object",
  "outline", "paragraph", "pipe", "plain", "prose", "ratio", "report", "section", "sentence", "shaped",
  "short", "style", "summary", "table", "text", "title", "tsv", "value", "yaml",
]);
const STRONG_PRESENTATION_OUTPUT_TERMS = new Set([
  "block", "card", "chart", "code", "column", "csv", "grid", "html", "icon", "json", "line",
  "list", "markdown", "matrix", "object", "outline", "paragraph", "report", "sentence", "summary",
  "table", "tsv", "yaml",
]);
const READ_PROJECTION_OUTPUT_TERMS = new Set([
  "breakdown", "count", "field", "metric", "number", "record", "row", "section", "total", "value",
]);

const MERCHANT_STATE_OBJECT_TERMS = new Set([
  "campaign", "checkout", "coupon", "customer", "delivery", "discount", "fulfillment",
  "inventory", "menu", "navigation", "order", "page", "payment", "product", "provider",
  "refund", "setting", "shipping", "stock", "theme",
]);

const CLAUSE_CONNECTOR_WORDS = new Set([
  "along", "also", "and", "as", "but", "plus", "then", "well", "while", "with",
]);

const GENERIC_COMPOUND_SUPPORT_TERMS = new Set([
  "all", "api", "credential", "current", "data", "detail", "exact", "existing", "fact", "field",
  "event", "global", "if", "information", "item", "method", "only", "option", "other", "platform",
  "provider", "record", "safe", "safely", "secret", "service", "setting", "setup", "state",
  "status", "store", "system", "thing", "unrelated", "value",
]);

const CONTEXTUAL_ACTION_SUPPORT = new Set(["preserve", "publish", "reconcile", "verify"]);
const CONTEXTUAL_REFERENCE_TERMS = new Set([
  "else", "everything", "it", "provider", "store", "that", "them", "this",
]);
const CONTEXTUAL_FILLER_TERMS = new Set(["if", "out", "time"]);

type PromptClauseAnalysis = {
  clauses: string[];
  overflow: boolean;
};

function rawWords(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’]/g, "'")
    .toLowerCase()
    .match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
}

function undoubleFinalLetter(value: string): string {
  const final = value.at(-1);
  return final && value.length > 2 && value.at(-2) === final
    ? value.slice(0, -1)
    : value;
}

function actionLemma(value: string): string | null {
  const word = value.replace(/[^a-z]/g, "");
  if (!word) return null;
  const irregular = IRREGULAR_ACTION_LEMMAS.get(word);
  if (irregular) return ACTION_LEMMAS.has(irregular) ? irregular : null;
  if (ACTION_LEMMAS.has(word)) return word;

  const candidates = new Set<string>();
  if (word.endsWith("ies") && word.length > 3) candidates.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("ied") && word.length > 3) candidates.add(`${word.slice(0, -3)}y`);
  if (word.endsWith("s") && word.length > 2) candidates.add(word.slice(0, -1));
  for (const suffix of ["ed", "ing"] as const) {
    if (!word.endsWith(suffix) || word.length <= suffix.length + 1) continue;
    const stem = word.slice(0, -suffix.length);
    candidates.add(stem);
    candidates.add(`${stem}e`);
    candidates.add(undoubleFinalLetter(stem));
  }
  return [...candidates].find((candidate) => ACTION_LEMMAS.has(candidate)) ?? null;
}

function actionSupportLemma(value: string): string | null {
  const action = actionLemma(value);
  return action ? (ACTION_SUPPORT_CANONICAL.get(action) ?? action) : null;
}

function isActionWord(value: string): boolean {
  return actionLemma(value) !== null;
}

function stripLeadingCoordinator(value: string): string {
  return value.replace(
    /^(?:(?:and\s+then|as\s+well\s+as|along\s+with|while\s+also|but\s+also|followed\s+by|afterwards?|subsequently|later|next|thereafter|finally|then|also|plus|and|or|but)\s+)+/i,
    "",
  ).trim();
}

function startsWithAction(value: string): boolean {
  const words = rawWords(stripLeadingCoordinator(value));
  while (words[0] && ACTION_LEAD_PREFIXES.has(words[0])) words.shift();
  if (words[0] === "do" && words[1] === "not") words.splice(0, 2);
  if (words[0] === "don't") words.shift();
  return Boolean(words[0] && isActionWord(words[0]));
}

function separatorResetsNegation(value: string): boolean {
  return /[;:!?./—–\r\n]/.test(value) ||
    /\b(?:afterwards?|also|but|finally|followed\s+by|however|later|next|subsequently|then|thereafter)\b/i
      .test(value);
}

type SecondaryActionState = {
  hasNegatedAction: boolean;
  hasUnnegatedMutation: boolean;
  hasUnnegatedOtherAction: boolean;
};

function secondaryActionState(prompt: string): SecondaryActionState {
  const state: SecondaryActionState = {
    hasNegatedAction: false,
    hasUnnegatedMutation: false,
    hasUnnegatedOtherAction: false,
  };
  for (const separator of prompt.matchAll(
    /[;:!?&/—–]+|\r?\n\s*(?:[-*•]\s*)?|\.(?=\s|$)|,\s*(?:and\s+)?|\b(?:and\s+then|as\s+well\s+as|along\s+with|while\s+also|but\s+also|followed\s+by|afterwards?|subsequently|later|next|thereafter|finally|then|also|plus|and|or|but)\b/gi,
  )) {
    const separatorIndex = separator.index ?? 0;
    const left = prompt.slice(0, separatorIndex);
    const rightStart = separatorIndex + separator[0].length;
    const right = stripLeadingCoordinator(prompt.slice(rightStart));
    const words = rawWords(right);
    const prefixTokens = controlTokens(prompt.slice(0, separatorIndex));
    let negated = controlPrefixIsNegated(prefixTokens, prefixTokens.length);
    if (separatorResetsNegation(separator[0])) {
      let localCursor = prefixTokens.length - 1;
      if (prefixTokens[localCursor] === "ever") localCursor -= 1;
      negated = localCursor >= 0 && CONTROL_NEGATIONS.has(prefixTokens[localCursor]!);
    }
    while (words[0] && ACTION_LEAD_PREFIXES.has(words[0])) {
      if (words[0] === "never") negated = true;
      words.shift();
    }
    if (words[0] === "do" && words[1] === "not") {
      negated = true;
      words.splice(0, 2);
    } else if (words[0] === "don't" || words[0] === "not") {
      negated = true;
      words.shift();
    }
    const rawAction = words[0] ?? "";
    if (
      rawAction === "mark" &&
      words.length === 1 &&
      /\b(?:currency|identifier|symbol)\s*$/i.test(left)
    ) continue;
    if (
      rawAction.endsWith("ed") &&
      words.slice(1, 5).map(normalizeToken).some((term) =>
        ["amount", "code", "count", "currency", "inventory", "payment", "stock", "symbol", "total", "value"]
          .includes(term)
      )
    ) continue;
    if (
      ["exclude", "omit", "skip"].includes(rawAction) ||
      rawAction === "leave" && words[1] === "out"
    ) {
      state.hasNegatedAction = true;
      continue;
    }
    const action = rawAction ? actionLemma(rawAction) : null;
    // A plural action-shaped noun (for example, "refunds and returns") is a
    // fact list, not imperative evidence for a separate mutation.
    if (rawAction.endsWith("s") && action !== rawAction) continue;
    const normalizedTail = words.slice(1, 8).map(normalizeToken);
    const boundedTail = words.slice(1, CONTROL_NEGATION_LOOKBACK + 1).map(normalizeToken);
    if (
      action !== null &&
      PRESENTATION_ACTION_LEMMAS.has(action) &&
      normalizedTail.some((word) => PRESENTATION_OUTPUT_TERMS.has(word)) &&
      !normalizedTail.includes("page") &&
      (
        normalizedTail.some((word) => STRONG_PRESENTATION_OUTPUT_TERMS.has(word)) ||
        !normalizedTail.some((word) => MERCHANT_STATE_OBJECT_TERMS.has(word))
      )
    ) continue;
    if (
      action === "mark" &&
      boundedTail.some((word) =>
        ["noncomparable", "unavailable", "unknown", "unsupported"].includes(word)
      )
    ) continue;
    if (
      action === "add" &&
      normalizedTail.some((word) => READ_PROJECTION_OUTPUT_TERMS.has(word))
    ) continue;
    if (action === null) continue;
    if (negated) {
      state.hasNegatedAction = true;
    } else if (MUTATION_ACTION_LEMMAS.has(action)) {
      state.hasUnnegatedMutation = true;
    } else if (actionSupportLemma(action) !== "read") {
      state.hasUnnegatedOtherAction = true;
    }
  }
  return state;
}

function hasAction(value: string): boolean {
  return rawWords(value).some(isActionWord);
}

function isMeaningfulActionClause(value: string): boolean {
  const terms = rawWords(value).filter((word) => !CLAUSE_CONNECTOR_WORDS.has(word));
  return hasAction(value) && terms.length >= 2;
}

function splitActionClauses(prompt: string): PromptClauseAnalysis {
  const clauses: string[] = [];
  let clauseStart = 0;
  const separators = prompt.matchAll(
    /[;!?]+|\.(?=\s|$)|,\s*|\b(?:and\s+then|as\s+well\s+as|along\s+with|while\s+also|but\s+also|followed\s+by|afterwards?|subsequently|later|next|thereafter|finally|then|also|plus|and|but)\b/gi,
  );
  const pushClause = (rawClause: string): boolean => {
    const clause = stripLeadingCoordinator(rawClause.trim());
    if (!isMeaningfulActionClause(clause)) return false;
    clauses.push(clause);
    return clauses.length > MAX_MEANINGFUL_CLAUSES;
  };

  for (const separator of separators) {
    const separatorIndex = separator.index ?? 0;
    const left = prompt.slice(clauseStart, separatorIndex);
    const rightStart = separatorIndex + separator[0].length;
    const right = prompt.slice(rightStart);
    if (!hasAction(left) || !startsWithAction(right)) continue;
    const previousClauseCount = clauses.length;
    if (pushClause(left)) {
      return { clauses: clauses.slice(0, MAX_MEANINGFUL_CLAUSES), overflow: true };
    }
    if (clauses.length === previousClauseCount) continue;
    clauseStart = rightStart;
  }

  if (pushClause(prompt.slice(clauseStart))) {
    return { clauses: clauses.slice(0, MAX_MEANINGFUL_CLAUSES), overflow: true };
  }
  return { clauses, overflow: false };
}

function splitLexicalClauses(prompt: string): PromptClauseAnalysis {
  const clauses = prompt
    .split(/(?:[;!?]+|\.(?:\s|$)|,(?:\s+and)?\s+|\b(?:and then|then|also|plus)\b)/i)
    .map((clause) => clause.trim())
    .filter((clause) => unique(tokenize(clause)).length >= 2);
  return {
    clauses: clauses.slice(0, MAX_MEANINGFUL_CLAUSES),
    overflow: clauses.length > MAX_MEANINGFUL_CLAUSES,
  };
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

function fallbackSupportsRequestedAction(prompt: string, match: ScoredCandidate): boolean {
  if (match.exactPhrase) return true;
  const requestedActions = new Set(rawWords(prompt).flatMap((word) => {
    const action = actionSupportLemma(word);
    return action ? [action] : [];
  }));
  return [...requestedActions].some((action) => match.candidate.actionTerms.has(action));
}

function hasInformativeRouteSupport(prompt: string, match: ScoredCandidate): boolean {
  const informative = unique(tokenize(prompt)).filter((term) =>
    !isActionWord(term) &&
    !/^\d+$/.test(term) &&
    !STOP_WORDS.has(term) &&
    !CLAUSE_CONNECTOR_WORDS.has(term) &&
    !GENERIC_COMPOUND_SUPPORT_TERMS.has(term)
  );
  return informative.some((term) => match.candidate.anchorTerms.has(term)) ||
    informative.filter((term) => match.candidate.supportTerms.has(term)).length >= 4;
}

function hasCuratedWriteIntent(prompt: string, match: ScoredCandidate): boolean {
  if (match.candidate.route?.kind === "read" || match.score < 4.5) return false;
  const hasMutation = rawWords(prompt).some((word) => {
    const action = actionLemma(word);
    return action !== null && MUTATION_ACTION_LEMMAS.has(action);
  });
  return hasMutation && hasInformativeRouteSupport(prompt, match);
}

function hasUnsupportedCredentialWriteTerms(
  prompt: string,
  match: ScoredCandidate,
  routeInputTerms: ReadonlyMap<string, WorkflowInputVocabulary>,
): boolean {
  const route = match.candidate.route;
  if (route?.kind === "read") return false;
  const promptTokens = controlTokens(prompt);
  const inputVocabulary = routeInputTerms.get(match.candidate.id);
  const rawPromptTerms = rawWords(prompt.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  const credentialFieldTerms = new Set([
    "api", "client", "host", "password", "secret", "sid", "smtp", "token", "username", "webhook",
  ]);
  const hasCredentialIntent = matchedControlPhrase(promptTokens, "secret").unnegated ||
    rawPromptTerms.some((term) => credentialFieldTerms.has(term));
  if (!hasCredentialIntent) return false;
  const unsupportedRawFields = unique(rawPromptTerms).filter((term) =>
    credentialFieldTerms.has(term) &&
    !inputVocabulary?.rawFields.has(term) &&
    matchedControlPhrase(promptTokens, term).unnegated
  );
  if (unsupportedRawFields.length > 0) return true;
  const allowed = new Set([
    ...match.candidate.anchorTerms,
    ...(inputVocabulary?.semantic ?? []),
  ]);
  const modifiers = new Set(["bounded", "supplied", "tracking"]);
  const unsupported = unique(tokenize(prompt)).filter((term) => {
    if (allowed.has(term)) return false;
    if (term === "secret") return true;
    return !isActionWord(term) &&
      !/^\d+$/.test(term) &&
      !STOP_WORDS.has(term) &&
      !CONTROL_NEGATIONS.has(term) &&
      !CLAUSE_CONNECTOR_WORDS.has(term) &&
      !GENERIC_COMPOUND_SUPPORT_TERMS.has(term) &&
      !modifiers.has(term) &&
      matchedControlPhrase(promptTokens, term).unnegated;
  });
  return unsupported.length > 0;
}

const CREDENTIAL_DOMAIN_ALIASES = new Map([
  ["email", "email"],
  ["facebook", "meta"],
  ["mailgun", "mailgun"],
  ["meta", "meta"],
  ["polar", "polar"],
  ["sms", "sms"],
  ["smtp", "smtp"],
  ["sslcommerz", "sslcommerz"],
  ["stripe", "stripe"],
  ["twilio", "twilio"],
  ["whatsapp", "whatsapp"],
] as const);

function hasForeignCredentialDomain(
  prompt: string,
  match: ScoredCandidate,
): boolean {
  if (match.candidate.route?.kind === "read") return false;
  const promptTokens = controlTokens(prompt);
  const hasCredentialIntent = [
    "account sid", "api key", "client id", "credential", "credentials", "key",
    "password", "secret", "sender account", "smtp host", "token",
  ].some((phrase) => matchedControlPhrase(promptTokens, phrase).unnegated);
  if (!hasCredentialIntent) return false;

  const declaredDomains = new Set(tokenize(match.candidate.operationIds.join(" ")));
  return [...CREDENTIAL_DOMAIN_ALIASES].some(([phrase, domain]) =>
    matchedControlPhrase(promptTokens, phrase).unnegated &&
    !declaredDomains.has(domain)
  );
}

function hasSchemaBackedWriteSupport(
  prompt: string,
  match: ScoredCandidate,
  routeInputTerms: ReadonlyMap<string, WorkflowInputVocabulary>,
): boolean {
  if (!match.candidate.route || match.candidate.route.kind === "read") return false;
  const promptTerms = unique(tokenize(prompt));
  const inputTerms = routeInputTerms.get(match.candidate.id)?.semantic;
  if (!inputTerms || inputTerms.size === 0) return false;
  const hasDomainAnchor = promptTerms.some((term) =>
    match.candidate.anchorTerms.has(term) &&
    !isActionWord(term) &&
    !GENERIC_COMPOUND_SUPPORT_TERMS.has(term)
  );
  const promptActions = rawWords(prompt).flatMap((word) => {
    const action = actionSupportLemma(word);
    return action ? [action] : [];
  });
  const hasInputField = promptTerms.some((term) =>
    inputTerms.has(term) &&
    !GENERIC_COMPOUND_SUPPORT_TERMS.has(term)
  ) || inputTerms.has("enable") && (
    /\b(?:on|off)\b/i.test(prompt) || promptActions.includes("enable")
  );
  const hasMutation = rawWords(prompt).some((word) => {
    const action = actionLemma(word);
    return action !== null && MUTATION_ACTION_LEMMAS.has(action);
  });
  return hasDomainAnchor && hasInputField && hasMutation && match.score >= 4.5;
}

function hasExplicitInputPhraseSupport(
  prompt: string,
  match: ScoredCandidate,
  routeInputTerms: ReadonlyMap<string, WorkflowInputVocabulary>,
): boolean {
  if (!match.candidate.route || match.candidate.route.kind === "read") return false;
  const vocabulary = routeInputTerms.get(match.candidate.id);
  if (!vocabulary) return false;
  const rawPrompt = ` ${rawWords(
    prompt.replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
  ).join(" ")} `;
  const hasPhrase = [...vocabulary.rawPhrases].some((phrase) =>
    phrase.includes(" ") && rawPrompt.includes(` ${phrase} `)
  );
  if (!hasPhrase) return false;
  return unique(tokenize(prompt)).some((term) =>
    match.candidate.anchorTerms.has(term) &&
    (!isActionWord(term) || ["email", "sms", "whatsapp"].includes(term)) &&
    !GENERIC_COMPOUND_SUPPORT_TERMS.has(term)
  );
}

function hasUnsupportedNotificationEvent(
  prompt: string,
  match: ScoredCandidate,
  routeInputTerms: ReadonlyMap<string, WorkflowInputVocabulary>,
): boolean {
  if (match.exactPhrase) return false;
  const vocabulary = routeInputTerms.get(match.candidate.id);
  if (!vocabulary) return false;
  for (const event of prompt.matchAll(
    /\b(?:email|sms|whatsapp)\s+([a-z]+(?:[_-][a-z]+)+)\s+(?:alerts?|messages?|notifications?|rules?)\b/gi,
  )) {
    const phrase = rawWords(event[1] ?? "").join(" ");
    if (phrase && !vocabulary.rawPhrases.has(phrase)) return true;
  }
  return false;
}

function guardedRouteSupportsClause(
  clause: string,
  clauseMatch: ScoredCandidate,
  wholePromptMatch: ScoredCandidate,
): boolean {
  const clauseActionTerms = new Set(rawWords(clause).flatMap((word) => {
    const action = actionSupportLemma(word);
    return action ? [action] : [];
  }));
  const hasSupportedAction = [...clauseActionTerms].some((action) =>
    clauseMatch.candidate.actionTerms.has(action)
  );
  const clauseTerms = unique(tokenize(clause));
  const hasInformativeMatch = clauseTerms.some((term) =>
    clauseMatch.candidate.supportTerms.has(term) &&
    !isActionWord(term) &&
    !CLAUSE_CONNECTOR_WORDS.has(term) &&
    !GENERIC_COMPOUND_SUPPORT_TERMS.has(term)
  );
  const contextualTerms = rawWords(clause).map(normalizeToken)
    .filter((term) => !isActionWord(term));
  const hasContextualReference = [...clauseActionTerms].some((action) =>
    CONTEXTUAL_ACTION_SUPPORT.has(action)
  ) && contextualTerms.some((term) => CONTEXTUAL_REFERENCE_TERMS.has(term)) &&
    contextualTerms.every((term) =>
      STOP_WORDS.has(term) ||
      CLAUSE_CONNECTOR_WORDS.has(term) ||
      CONTEXTUAL_REFERENCE_TERMS.has(term) ||
      CONTEXTUAL_FILLER_TERMS.has(term) ||
      GENERIC_COMPOUND_SUPPORT_TERMS.has(term)
    );
  return clauseMatch.candidate.id === wholePromptMatch.candidate.id &&
    hasSupportedAction &&
    (hasInformativeMatch || hasContextualReference);
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
  const workflowFactTerms = buildWorkflowReadFactTerms(sources.catalog.cards);
  const routeInputTerms = buildRouteInputTerms(sources);
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

    const scoredRoutes = scoreCandidates(boundedPrompt, surface, index, "route");
    const topFixedWindowState = scoredRoutes[0]
      ? fixedCalendarWindowState(boundedPrompt, scoredRoutes[0])
      : null;
    if (
      scoredRoutes[0] &&
      topFixedWindowState !== null &&
      topFixedWindowState !== "compatible" &&
      strongRouteMatch(scoredRoutes[0], scoredRoutes[1])
    ) {
      return {
        kind: "choices",
        disposition: "ask",
        version: sources.catalog.version,
        choices: choicesFromRanked([scoredRoutes[0]]),
        safetyNotes: [
          topFixedWindowState === "mismatch"
            ? "The requested reporting window does not match this fixed merchant-calendar workflow; choose the reviewed window or a separate bounded report."
            : "This workflow requires an explicit compatible merchant-calendar window; choose the reviewed window or a separate bounded report.",
        ],
      };
    }
    const compatibleRoutes = scoredRoutes.filter((match) => {
      const state = fixedCalendarWindowState(boundedPrompt, match);
      return state === null || state === "compatible";
    });
    if (
      compatibleRoutes[0]?.candidate.route?.fixedCalendarDays !== undefined &&
      !compatibleRoutes[0].exactPhrase &&
      !hasFixedRouteDomainSupport(boundedPrompt, compatibleRoutes[0], workflowFactTerms)
    ) {
      return {
        kind: "choices",
        disposition: "ask",
        version: sources.catalog.version,
        choices: choicesFromRanked([compatibleRoutes[0]]),
        safetyNotes: [
          "The reporting window matches, but the request needs a supported domain scope before this fixed workflow can execute.",
        ],
      };
    }
    const explicitInputRoutes = compatibleRoutes.filter((match) =>
      hasExplicitInputPhraseSupport(boundedPrompt, match, routeInputTerms)
    );
    const routes = !compatibleRoutes[0]?.exactPhrase && explicitInputRoutes.length === 1
      ? [
          explicitInputRoutes[0]!,
          ...compatibleRoutes.filter((match) => match !== explicitInputRoutes[0]),
        ]
      : compatibleRoutes;
    const topRouteKind = routes[0]?.candidate.route?.kind;
    const topRouteHasSchemaSupport = routes[0]
      ? hasSchemaBackedWriteSupport(boundedPrompt, routes[0], routeInputTerms) ||
        hasExplicitInputPhraseSupport(boundedPrompt, routes[0], routeInputTerms)
      : false;
    const topRouteHasCuratedWriteIntent = routes[0]
      ? hasCuratedWriteIntent(boundedPrompt, routes[0])
      : false;
    const clauseAnalysis = topRouteKind === "read"
      ? splitLexicalClauses(boundedPrompt)
      : splitActionClauses(boundedPrompt);
    const clauses = clauseAnalysis.clauses;
    if (
      routes[0]?.exactPhrase &&
      strongRouteMatch(routes[0], routes[1])
    ) {
      const plan = planFromRoutes([routes[0]], [boundedPrompt]);
      if (plan) return resolvedRoutePlan(sources.catalog.version, plan, details);
    }

    const secondaryActions = topRouteKind === "read"
      ? secondaryActionState(boundedPrompt)
      : null;
    if (
      routes[0] &&
      topRouteKind === "read" &&
      strongRouteMatch(routes[0], routes[1]) &&
      secondaryActions?.hasUnnegatedMutation
    ) {
      return {
        kind: "choices",
        disposition: "ask",
        version: sources.catalog.version,
        choices: choicesFromRanked([routes[0]]),
        safetyNotes: [
          "A read workflow cannot absorb a separate mutation clause; split and confirm the write independently.",
        ],
      };
    }
    if (
      routes[0] &&
      topRouteKind === "read" &&
      routes[0].candidate.route?.fixedCalendarDays !== undefined &&
      topFixedWindowState === "compatible" &&
      !secondaryActions?.hasUnnegatedMutation &&
      hasFixedRouteDomainSupport(boundedPrompt, routes[0], workflowFactTerms)
    ) {
      const plan = planFromRoutes([routes[0]], [boundedPrompt]);
      if (plan) return resolvedRoutePlan(sources.catalog.version, plan, details);
    }
    if (
      routes[0] &&
      topRouteKind === "read" &&
      (
        strongRouteMatch(routes[0], routes[1]) ||
        routes[0].candidate.route?.fixedCalendarDays !== undefined &&
        topFixedWindowState === "compatible" &&
        hasFixedRouteDomainSupport(boundedPrompt, routes[0], workflowFactTerms)
      ) &&
      secondaryActions?.hasNegatedAction &&
      !secondaryActions.hasUnnegatedMutation &&
      !secondaryActions.hasUnnegatedOtherAction
    ) {
      const plan = planFromRoutes([routes[0]], [boundedPrompt]);
      if (plan) return resolvedRoutePlan(sources.catalog.version, plan, details);
    }
    const fallbacks = scoreCandidates(boundedPrompt, surface, index, "operation-fallback");
    if (clauseAnalysis.overflow) {
      return {
        kind: "choices",
        disposition: "ask",
        version: sources.catalog.version,
        choices: choicesFromRanked([...routes.slice(0, 3), ...fallbacks.slice(0, 3)]
          .sort((left, right) =>
            right.score - left.score || left.candidate.id.localeCompare(right.candidate.id)
          )),
        safetyNotes: [
          "The request contains more than eight action clauses; split it into smaller reviewed requests.",
        ],
      };
    }

    if (
      routes[0] &&
      topRouteKind !== undefined &&
      topRouteKind !== "read" &&
      !routes[0].exactPhrase &&
      strongRouteMatch(routes[0], routes[1]) &&
      !topRouteHasSchemaSupport &&
      !hasInformativeRouteSupport(boundedPrompt, routes[0])
    ) {
      return {
        kind: "choices",
        disposition: "ask",
        version: sources.catalog.version,
        choices: choicesFromRanked([routes[0]]),
        safetyNotes: [
          "This write request lacks an informative workflow anchor; clarify the target domain before any mutation.",
        ],
      };
    }
    if (
      routes[0] &&
      topRouteKind !== undefined &&
      topRouteKind !== "read" &&
      !routes[0].exactPhrase &&
      (
        strongRouteMatch(routes[0], routes[1]) ||
        topRouteHasSchemaSupport ||
        topRouteHasCuratedWriteIntent
      ) &&
      hasForeignCredentialDomain(boundedPrompt, routes[0])
    ) {
      return {
        kind: "choices",
        disposition: "ask",
        version: sources.catalog.version,
        choices: choicesFromRanked([routes[0]]),
        safetyNotes: [
          "The selected write workflow does not own the requested provider credential domain; choose the correct provider workflow before any secret-bearing mutation.",
        ],
      };
    }

    const nonExactWriteOrMixedCompound = Boolean(
      routes[0] &&
      clauses.length > 1 &&
      !routes[0].exactPhrase &&
      topRouteKind !== undefined &&
      topRouteKind !== "read"
    );
    const lowConfidenceReadCompound = Boolean(
      routes[0] &&
      clauses.length > 1 &&
      !routes[0].exactPhrase &&
      topRouteKind === "read" &&
      routes[0].confidence < NON_EXACT_COMPOUND_ROUTE_CONFIDENCE
    );
    const guardedCompoundRoute = Boolean(
      nonExactWriteOrMixedCompound || lowConfidenceReadCompound
    );
    if (
      routes[0] &&
      !guardedCompoundRoute &&
      (
        strongRouteMatch(routes[0], routes[1]) ||
        topRouteHasSchemaSupport ||
        topRouteHasCuratedWriteIntent
      )
    ) {
      const plan = planFromRoutes([routes[0]], [boundedPrompt]);
      if (plan) {
        return resolvedRoutePlan(sources.catalog.version, plan, details);
      }
    }

    if (clauses.length > 1 && clauses.length <= MAX_MEANINGFUL_CLAUSES) {
      const clauseMatches: ScoredCandidate[] = [];
      let complete = true;
      for (const clause of clauses) {
        const ranked = scoreCandidates(clause, surface, index, "route");
        const contextualRouteMatch = routes[0]
          ? ranked.find((match) => match.candidate.id === routes[0]!.candidate.id) ?? {
              ...routes[0],
              score: 0,
              confidence: 0,
              matchedTerms: 0,
              queryTerms: Math.max(unique(tokenize(clause)).length, 1),
              exactPhrase: false,
            }
          : undefined;
        const guardedClauseMatch = Boolean(
          nonExactWriteOrMixedCompound &&
          routes[0] &&
          contextualRouteMatch &&
          guardedRouteSupportsClause(clause, contextualRouteMatch, routes[0])
        );
        const strongestIndependentMatch = ranked[0] && strongRouteMatch(ranked[0], ranked[1])
          ? ranked[0]
          : undefined;
        const selectedMatch = guardedClauseMatch
          ? contextualRouteMatch
          : nonExactWriteOrMixedCompound &&
              routes[0] &&
              strongestIndependentMatch?.candidate.id === routes[0].candidate.id
            ? undefined
            : strongestIndependentMatch;
        if (!selectedMatch) {
          complete = false;
          break;
        }
        clauseMatches.push(selectedMatch);
      }
      const uniqueMatches = unique(clauseMatches.map((match) => match.candidate.id))
        .map((id) => clauseMatches.find((match) => match.candidate.id === id)!);
      if (
        complete &&
        uniqueMatches.length <= MAX_COMPOSED_ROUTES &&
        (
          nonExactWriteOrMixedCompound
            ? uniqueMatches.length === 1
            : uniqueMatches.length > 1
        )
      ) {
        const plan = planFromRoutes(uniqueMatches, clauses);
        if (plan) {
          return resolvedRoutePlan(sources.catalog.version, plan, details);
        }
      }
    }

    const topFallbackOperation = fallbacks[0]?.candidate.operationIds[0]
      ? index.operationsById.get(fallbacks[0].candidate.operationIds[0]!)
      : undefined;
    const guardedCompoundFallback = Boolean(
      fallbacks[0] &&
      clauses.length > 1 &&
      topFallbackOperation?.risk !== "read"
    );
    if (
      fallbacks[0] &&
      topFallbackOperation?.risk !== "read" &&
      strongFallbackMatch(fallbacks[0], fallbacks[1]) &&
      hasUnsupportedCredentialWriteTerms(boundedPrompt, fallbacks[0], routeInputTerms)
    ) {
      return {
        kind: "choices",
        disposition: "ask",
        version: sources.catalog.version,
        choices: choicesFromRanked(fallbacks.slice(0, 3)),
        safetyNotes: [
          "The selected write operation does not declare every requested credential field or provider domain; clarify before any secret-bearing mutation.",
        ],
      };
    }
    if (
      fallbacks[0] &&
      topFallbackOperation?.risk !== "read" &&
      strongFallbackMatch(fallbacks[0], fallbacks[1]) &&
      hasUnsupportedNotificationEvent(boundedPrompt, fallbacks[0], routeInputTerms)
    ) {
      return {
        kind: "choices",
        disposition: "ask",
        version: sources.catalog.version,
        choices: choicesFromRanked(fallbacks.slice(0, 3)),
        safetyNotes: [
          "The requested notification event is not declared by this write schema; choose a supported event before mutation.",
        ],
      };
    }
    if (
      !guardedCompoundRoute &&
      !guardedCompoundFallback &&
      fallbacks[0] &&
      strongFallbackMatch(fallbacks[0], fallbacks[1]) &&
      (
        topFallbackOperation?.risk === "read" ||
        fallbackSupportsRequestedAction(boundedPrompt, fallbacks[0])
      )
    ) {
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
    if (
      selector.exactItems !== undefined &&
      (
        !Number.isSafeInteger(selector.exactItems) ||
        selector.exactItems < 1 ||
        selector.exactItems !== selector.maxItems
      )
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
      ...(selector.exactItems !== undefined ? { exactItems: selector.exactItems } : {}),
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
      if (
        selector.exactItems !== undefined &&
        selected.value.length !== selector.exactItems
      ) return null;
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
