// scalius_search: ranked candidates for a merchant or buyer goal. The
// reviewed workflow resolver contributes curated plans, choices and safety
// controls; a lexical index over the authorized operations contributes the
// rest, so the model picks from evidence instead of trusting one route.

import { AGENT_OPERATIONS } from "../../generated/agent-operations.gen";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { loadAgentAccessBackend } from "../backend";
import type { AgentPrincipal, AgentResource } from "../types";
import { isConfirmGated } from "./confirm";
import { isMcpOperationExposure } from "./operations";
import { jsonBytes } from "./shape";
import { resolveAuthorizedWorkflow, type AuthorizedWorkflowPlan } from "./workflows";

export const SEARCH_DEFAULT_LIMIT = 6;
export const SEARCH_MAX_LIMIT = 10;
const SUMMARY_CHARS = 160;
const INLINE_PLAN_MIN_CONFIDENCE = 0.8;
const INLINE_PLAN_MAX_BYTES = 4 * 1024;
const SEARCH_MAX_BYTES = 6 * 1024;

export interface SearchHit {
  id: string;
  kind: "workflow" | "operation" | "control";
  title: string;
  summary: string;
  score: number;
  risk?: string;
  stability?: string;
  confirm?: true;
  operationIds?: string[];
  plan?: Record<string, unknown>;
  resource?: string;
  disposition?: string;
  code?: string;
  safePlan?: Record<string, unknown> | null;
}

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "my", "me", "i", "in", "on", "at", "with", "all", "every",
  "is", "are", "be", "it", "this", "that", "what", "which", "how", "please", "show", "can", "do", "does", "from",
  "by", "as", "our", "we", "you", "your", "get", "set", "want", "need", "would", "like", "into", "there", "any",
]);

/** A few merchant words that name a different operation vocabulary. */
const SYNONYMS: Record<string, string[]> = {
  stock: ["inventory", "stock"],
  inventory: ["inventory", "stock"],
  coupon: ["discount"],
  code: ["discount", "code"],
  sale: ["discount", "promotion"],
  price: ["price", "pricing"],
  cod: ["cod", "payment", "cash"],
  vat: ["tax"],
  tax: ["tax"],
  delivery: ["shipping", "delivery"],
  shipping: ["shipping", "delivery"],
  staff: ["team", "user", "staff", "role"],
  invite: ["invitation", "invite", "team"],
  menu: ["navigation", "menu"],
  page: ["page", "content"],
  photo: ["media", "image"],
  image: ["media", "image"],
  cancel: ["cancel", "status"],
  buyer: ["customer"],
  client: ["customer"],
};

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("es") && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  return word;
}

export function searchTerms(text: string): string[] {
  return text.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);
}

interface IndexedOperation {
  operation: AgentOperationManifestEntry;
  id: Set<string>;
  summary: Set<string>;
  tags: Set<string>;
  description: Set<string>;
}

const indexes = new Map<AgentResource, IndexedOperation[]>();

/** Immutable generated metadata only: safe at module scope. */
function operationIndex(surface: AgentResource): IndexedOperation[] {
  const existing = indexes.get(surface);
  if (existing) return existing;
  const built = AGENT_OPERATIONS
    .filter((operation) => operation.surface === surface && isMcpOperationExposure(operation))
    .map((operation) => ({
      operation,
      id: new Set(searchTerms(operation.operationId.replace(/^(dashboard|storefront)\./, "").replace(/_/g, " "))),
      summary: new Set(searchTerms(operation.summary)),
      tags: new Set(operation.tags.flatMap(searchTerms)),
      description: new Set(searchTerms(operation.description ?? "")),
    }));
  indexes.set(surface, built);
  return built;
}

function scoreOperation(entry: IndexedOperation, terms: readonly string[][]): number {
  if (terms.length === 0) return 0;
  let total = 0;
  for (const alternatives of terms) {
    let best = 0;
    for (const term of alternatives) {
      const value = (entry.id.has(term) ? 3 : 0) + (entry.summary.has(term) ? 2 : 0) +
        (entry.tags.has(term) ? 1 : 0) + (entry.description.has(term) ? 1 : 0);
      best = Math.max(best, value);
    }
    total += Math.min(best, 4);
  }
  const stable = entry.operation.stability === "stable" ? 0.25 : 0;
  return (total + stable) / (terms.length * 4 + 0.25);
}

function clip(text: string, length = SUMMARY_CHARS): string {
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function compactPlan(plan: AuthorizedWorkflowPlan): Record<string, unknown> {
  return {
    operationIds: plan.operationIds,
    rules: plan.rules,
    requiresFacts: plan.requiresFacts,
    requiresConfirmation: plan.requiresConfirmation,
    requiresVerification: plan.requiresVerification,
    ...(plan.externalAudienceVerification.length > 0 ? { storefrontVerification: plan.externalAudienceVerification.map((item) => item.operationId) } : {}),
  };
}

function workflowResource(plan: AuthorizedWorkflowPlan): string | undefined {
  const id = plan.workflowIds[0];
  return plan.detail && id ? `scalius://workflows/${id}` : undefined;
}

async function workflowHits(query: string, surface: AgentResource, principal: AgentPrincipal) {
  const resolution = await resolveAuthorizedWorkflow({ prompt: query, surface, principal });
  const hits: SearchHit[] = [];
  const notes: string[] = "safetyNotes" in resolution ? resolution.safetyNotes : [];
  if (resolution.kind === "plan") {
    const plan = resolution.plan;
    const inline = compactPlan(plan);
    hits.push({
      id: plan.routeIds[0] ?? plan.workflowIds[0] ?? plan.operationIds[0] ?? "plan",
      kind: "workflow",
      title: clip(plan.title),
      summary: clip(plan.summary),
      score: plan.confidence,
      operationIds: plan.operationIds,
      ...(plan.confidence >= INLINE_PLAN_MIN_CONFIDENCE && jsonBytes(inline) <= INLINE_PLAN_MAX_BYTES ? { plan: inline } : {}),
      ...(workflowResource(plan) ? { resource: workflowResource(plan) } : {}),
    });
  } else if (resolution.kind === "choices") {
    for (const choice of resolution.choices) {
      hits.push({
        id: choice.id,
        kind: "workflow",
        title: clip(choice.title),
        summary: clip(choice.summary),
        score: choice.confidence,
        operationIds: choice.operationIds,
      });
    }
  } else if (resolution.kind === "control") {
    // Refuse/ask controls pass through unchanged: the agent must honour them.
    hits.push({
      id: resolution.classification.controlId,
      kind: "control",
      title: clip(resolution.classification.code),
      summary: clip(resolution.classification.reason),
      score: 1,
      disposition: resolution.disposition,
      code: resolution.classification.code,
      safePlan: resolution.safePlan ? compactPlan(resolution.safePlan) : null,
    });
  }
  return { hits, notes };
}

async function operationHits(
  query: string,
  surface: AgentResource,
  principal: AgentPrincipal,
  limit: number,
): Promise<SearchHit[]> {
  const terms = searchTerms(query).map((term) => [...new Set([term, ...(SYNONYMS[term] ?? []).map(stem)])]);
  if (terms.length === 0) return [];
  const backend = await loadAgentAccessBackend();
  const ranked = operationIndex(surface)
    .map((entry) => ({ entry, score: scoreOperation(entry, terms) }))
    .filter((candidate) => candidate.score >= 0.2)
    .sort((left, right) => right.score - left.score || left.entry.operation.operationId.localeCompare(right.entry.operation.operationId));
  const hits: SearchHit[] = [];
  for (const { entry, score } of ranked) {
    if (hits.length >= limit) break;
    const operation = entry.operation;
    const authorized = await backend.authorizeOperation(principal, {
      rbac: operation.rbac,
      risk: operation.risk,
      surface: operation.surface,
      exposure: operation.exposure,
      principals: operation.principals,
    });
    if (!authorized) continue;
    hits.push({
      id: operation.operationId,
      kind: "operation",
      title: clip(operation.summary),
      summary: clip(operation.description ?? operation.summary),
      score: Number(score.toFixed(3)),
      risk: operation.risk,
      stability: operation.stability,
      ...(isConfirmGated(operation) ? { confirm: true as const } : {}),
    });
  }
  return hits;
}

/**
 * Up to `limit` ranked hits: curated workflow plans and controls first (a
 * confident plan inlines its compact steps), then operations the grant can
 * run. Bounded to 6 KiB.
 */
export async function searchCapabilities(input: {
  query: string;
  limit?: number;
  surface: AgentResource;
  principal: AgentPrincipal;
}): Promise<{ hits: SearchHit[]; notes?: string[] }> {
  const limit = Math.max(1, Math.min(input.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT));
  const workflows = await workflowHits(input.query, input.surface, input.principal);
  const operations = await operationHits(input.query, input.surface, input.principal, limit);
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const hit of [...workflows.hits, ...operations]) {
    if (hits.length >= limit || seen.has(hit.id)) continue;
    seen.add(hit.id);
    hits.push(hit);
  }
  const notes = workflows.notes.slice(0, 3).map((note) => clip(note, 200));
  while (hits.length > 1 && jsonBytes({ hits, notes }) > SEARCH_MAX_BYTES) hits.pop();
  if (hits[0]?.plan && jsonBytes({ hits, notes }) > SEARCH_MAX_BYTES) delete hits[0].plan;
  return notes.length > 0 ? { hits, notes } : { hits };
}
