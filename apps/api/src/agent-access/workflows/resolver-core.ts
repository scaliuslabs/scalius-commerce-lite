export type WorkflowResolverSurface = "dashboard" | "storefront";
export type WorkflowResolverIntentKind = "read" | "write" | "mixed";
export type WorkflowResolverDisposition = "execute" | "ask" | "unsupported" | "refuse";

export type WorkflowResolverOperation = {
  operationId: string;
  surface: string;
  exposure: string;
  risk: string;
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

export type WorkflowResolverCatalog = {
  version: string;
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
      return {
        kind: "plan",
        disposition: "execute",
        version: sources.catalog.version,
        plan,
        safetyNotes: [],
      };
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
        return {
          kind: "plan",
          disposition: "execute",
          version: sources.catalog.version,
          plan,
          safetyNotes: [],
        };
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
          return {
            kind: "plan",
            disposition: "execute",
            version: sources.catalog.version,
            plan,
            safetyNotes: [],
          };
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
