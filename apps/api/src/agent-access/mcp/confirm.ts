// Confirmation for gated agent writes (decision D2).
//
// A grant's confirm policy defaults to `destructive_financial`: a gated call
// runs only after a person approves it (audit R2 F3). What counts as proof
// that a person approved is one table, `APPROVAL_PROOF` (grant kind x
// approval class): an approval a signed-in staff member gave in the dashboard
// (`../approvals.ts`: the refused call returns an approval link for the
// grant's owner, never anything the agent could redeem itself) proves every
// class for every grant. A native client dialog (MCP form elicitation on
// 2026-07-28 clients) is only the client saying a person answered: the
// client holds the whole handshake, so it is accepted only from an OAuth app
// and only for a reviewed ordinary write. Money, deletes and security never
// take it, and a CLI or access key never does (its credential is a file or
// a string any local process can read).
//
// The dialog's request state is a confirm token: an HMAC over the grant, the
// exact operations and inputs, and a 10-minute expiry, so issuing one writes
// nothing; its single use is claimed in `system_kv` immediately before the
// dispatch, so a replay is a 409.

import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { systemKv } from "@scalius/database/schema";
import { getDb } from "@scalius/database/client";
import type { AgentOperationPolicy } from "../../openapi/agent-operation-manifest";
import { AgentDispatchError, type AgentOperationInput } from "../dispatch-error";
import type { AgentGrantKind, AgentPrincipal } from "../types";
import type { CONFIRM_TARGET_KINDS } from "../summary-rows";
import { APPROVAL_CLASSES, approvalClassOf as sharedApprovalClassOf, type ApprovalClass } from "@scalius/shared/agent-approval";

export type AgentConfirmPolicy = "none" | "destructive_financial";

export const CONFIRM_TOKEN_TTL_SECONDS = 10 * 60;
const TOKEN_PATTERN = /^sct_([0-9a-z]{1,10})_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;
const POLICY_KEY_PREFIX = "agent-confirm-policy:";
const USED_KEY_PREFIX = "agent-confirm-used:";
const encoder = new TextEncoder();

/**
 * What proves a person approved: `dashboard`, only an approval a signed-in
 * staff member gave in the dashboard; `dashboard_or_client_dialog`, that or an
 * accepted native client dialog.
 */
export type ApprovalProof = "dashboard" | "dashboard_or_client_dialog";

/** The approval rule: one row per grant kind, one cell per approval class. */
export const APPROVAL_PROOF: Readonly<Record<AgentGrantKind, Readonly<Record<ApprovalClass, ApprovalProof>>>> = {
  oauth: { financial: "dashboard", destructive: "dashboard", security: "dashboard", reviewed: "dashboard_or_client_dialog" },
  cli: { financial: "dashboard", destructive: "dashboard", security: "dashboard", reviewed: "dashboard" },
  pat: { financial: "dashboard", destructive: "dashboard", security: "dashboard", reviewed: "dashboard" },
};

type GatedOperation = Pick<AgentOperationPolicy, "risk" | "method"> & Partial<Pick<AgentOperationPolicy, "confirmation" | "impact">>;

/**
 * The approval class of this request's operation (`@scalius/shared/agent-approval`),
 * or null when it runs without one: a `money_fields` write is financial only
 * when this request changes one of its money fields.
 */
export function approvalClassOf(operation: GatedOperation, changedMoneyFields: readonly string[] = []): ApprovalClass | null {
  return sharedApprovalClassOf(operation, changedMoneyFields);
}

/** Operations the confirm policy gates: those with an approval class. */
export function isConfirmGated(operation: GatedOperation, changedMoneyFields: readonly string[] = []): boolean {
  return approvalClassOf(operation, changedMoneyFields) !== null;
}

/** A step as approval sees it: its operation and the money fields it changes. */
export interface GatedStep {
  operation: GatedOperation;
  changedMoneyFields?: readonly string[];
}

/** The strictest approval class among these steps, or null when none is gated. */
export function strictestApprovalClass(steps: readonly GatedStep[]): ApprovalClass | null {
  const classes = steps.map((step) => approvalClassOf(step.operation, step.changedMoneyFields));
  return APPROVAL_CLASSES.find((approvalClass) => classes.includes(approvalClass)) ?? null;
}

/**
 * What proves a person approved these steps for this grant: the strictest
 * cell any gated one reaches, or null when none is gated.
 */
export function approvalProofFor(grantKind: AgentGrantKind, steps: readonly GatedStep[]): ApprovalProof | null {
  let proof: ApprovalProof | null = null;
  for (const { operation, changedMoneyFields } of steps) {
    const approvalClass = approvalClassOf(operation, changedMoneyFields);
    if (approvalClass === null) continue;
    const cell = APPROVAL_PROOF[grantKind][approvalClass];
    if (cell === "dashboard") return "dashboard";
    proof = cell;
  }
  return proof;
}

/**
 * Why a change waits, for the agent to act on: its approval class, the
 * operations and money fields that set it off, and that no standing
 * pre-approval exists for this kind of grant (each gated change is approved
 * once, in the dashboard, by the store owner).
 */
export function approvalReason(principal: Pick<AgentPrincipal, "grantKind">, steps: readonly ConfirmStep[]) {
  const gated = steps.filter((step) => isConfirmGated(step.operation, step.changedMoneyFields));
  const fields = gated.flatMap((step) => (step.changedMoneyFields ?? []).map((pointer) => `${step.operation.operationId}${pointer}`));
  return {
    approvalClass: strictestApprovalClass(steps),
    gatedOperationIds: gated.map((step) => step.operation.operationId),
    ...(fields.length > 0 ? { changedMoneyFields: fields } : {}),
    proof: approvalProofFor(principal.grantKind, steps),
    preApproval: "none",
  };
}

/** The input keys that select records by a filter instead of naming them. */
export const FILTER_SELECTION_KEYS = ["filter", "matching"] as const;

/**
 * A gated change that selects its records by a filter: the filter's key, or
 * null. The owner approves what they read, and a filter matches again when
 * the change runs (a record added in between would be changed unseen), so a
 * change that needs approval names its records by id.
 */
export function filterSelectionOf(input: { body?: unknown }): string | null {
  const body = input.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return FILTER_SELECTION_KEYS.find((key) => {
    const value = (body as Record<string, unknown>)[key];
    return value !== undefined && value !== null;
  }) ?? null;
}

/** The refusal of a gated change that selects by filter, for both agent lanes. */
export function filterSelectionRefusal(operationId: string, key: string): AgentDispatchError {
  return new AgentDispatchError(
    "selection_needs_ids",
    `${operationId} needs the owner's approval, so it must name the records it changes: read their ids with the list operation, then send them instead of ${key}. An approval covers the records the owner saw, never whatever a filter matches when it runs.`,
    400,
  );
}

/**
 * The grant's confirm policy. On by default; a human turns it off for one
 * grant (a `system_kv` row written by the dashboard grant settings).
 */
export async function readAgentConfirmPolicy(env: Env, principal: AgentPrincipal): Promise<AgentConfirmPolicy> {
  if (principal.preset === "read") return "none";
  const now = Math.floor(Date.now() / 1000);
  const row = await getDb(env).select({ value: systemKv.value }).from(systemKv)
    .where(and(
      eq(systemKv.key, `${POLICY_KEY_PREFIX}${principal.grantId}`),
      or(isNull(systemKv.expiresAt), gt(systemKv.expiresAt, now)),
    ))
    .get();
  return row?.value === "none" ? "none" : "destructive_financial";
}

/** Sets one grant's confirm policy. Human-only: never reachable from an agent call. */
export async function writeAgentConfirmPolicy(env: Env, grantId: string, policy: AgentConfirmPolicy): Promise<void> {
  const key = `${POLICY_KEY_PREFIX}${grantId}`;
  if (policy === "destructive_financial") {
    await getDb(env).delete(systemKv).where(eq(systemKv.key, key));
    return;
  }
  await getDb(env).insert(systemKv).values({ key, value: policy, expiresAt: null })
    .onConflictDoUpdate({ target: systemKv.key, set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` } });
}

export interface ConfirmStep {
  operation: AgentOperationPolicy;
  input: AgentOperationInput;
  /** For a `money_fields` write: the money fields this request changes (input pointers). */
  changedMoneyFields?: readonly string[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The exact operations and inputs a token covers; the idempotency key is excluded (it is generated per call). */
export async function confirmBinding(steps: readonly ConfirmStep[]): Promise<string> {
  return sha256Hex(JSON.stringify(canonical(steps.map(({ operation, input }) => ({
    operationId: operation.operationId,
    path: input.path ?? {},
    query: input.query ?? {},
    body: input.body ?? null,
  })))));
}

async function confirmKey(env: Env): Promise<CryptoKey> {
  const pepper = env.AGENT_TOKEN_PEPPER?.trim();
  if (!pepper) throw new AgentDispatchError("agent_runtime_unconfigured", "Agent access is not configured", 503);
  const root = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const purpose = new Uint8Array(await crypto.subtle.sign("HMAC", root, encoder.encode("scalius/agent-confirm-token/v1")));
  return crypto.subtle.importKey("raw", purpose, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function macInput(grantId: string, binding: string, expiresAt: number, nonce: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${grantId}\n${binding}\n${expiresAt}\n${nonce}`);
}

export async function mintConfirmToken(
  env: Env,
  principal: AgentPrincipal,
  binding: string,
): Promise<{ confirmToken: string; expiresAt: string }> {
  const expiresAt = Math.floor(Date.now() / 1000) + CONFIRM_TOKEN_TTL_SECONDS;
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const key = await confirmKey(env);
  const mac = base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, macInput(principal.grantId, binding, expiresAt, nonce))));
  return {
    confirmToken: `sct_${expiresAt.toString(36)}_${nonce}_${mac}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
}

/**
 * Verifies the token for exactly these steps, then claims its one use.
 * Throws `confirm_token_invalid` (wrong grant, input or expired) or
 * `confirm_token_used` (409, a replay).
 */
export async function consumeConfirmToken(
  env: Env,
  principal: AgentPrincipal,
  binding: string,
  token: string,
): Promise<void> {
  const match = token.match(TOKEN_PATTERN);
  const invalid = () => new AgentDispatchError(
    "confirm_token_invalid",
    "The confirmToken is not valid for this grant, operation and input, or it expired",
    400,
  );
  if (!match) throw invalid();
  const expiresAt = Number.parseInt(match[1]!, 36);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + CONFIRM_TOKEN_TTL_SECONDS) throw invalid();
  const key = await confirmKey(env);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(match[3]!),
    macInput(principal.grantId, binding, expiresAt, match[2]!),
  );
  if (!valid) throw invalid();
  const claimKey = `${USED_KEY_PREFIX}${(await sha256Hex(token)).slice(0, 48)}`;
  const won = await getDb(env).insert(systemKv)
    .values({ key: claimKey, value: principal.grantId, expiresAt })
    .onConflictDoUpdate({
      target: systemKv.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      setWhere: lte(systemKv.expiresAt, now),
    })
    .returning({ key: systemKv.key });
  if (won.length === 0) {
    throw new AgentDispatchError("confirm_token_used", "This confirmToken was already used", 409);
  }
}

/** "productIds" with 3 entries reads "3 products"; "lines" with 1 reads "1 line". */
export function countedNoun(key: string, count: number): string {
  const words = key.replace(/Ids?$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").toLowerCase().trim();
  const base = !words || words === "ids" || words === "id" ? "item" : words;
  const singular = base.endsWith("ies")
    ? `${base.slice(0, -3)}y`
    : /(ss|x|ch|sh)es$/.test(base)
      ? base.slice(0, -2)
      : base.endsWith("s") && !base.endsWith("ss") ? base.slice(0, -1) : base;
  if (count === 1) return `1 ${singular}`;
  const plural = /[^aeiou]y$/.test(singular)
    ? `${singular.slice(0, -1)}ies`
    : /(s|x|ch|sh)$/.test(singular) ? `${singular}es` : `${singular}s`;
  return `${count} ${plural}`;
}

/** The approval summary is written from the schema in ./confirm-summary.ts. */

/** The store records an approval can name for its owner. */
export type ConfirmTargetKind = (typeof CONFIRM_TARGET_KINDS)[number];

/**
 * What a gated change acts on, read from the very input the approval binds:
 * ids by kind (at most 20 kept for names, all counted) and whether it selects
 * "everything matching a filter". The approval page resolves the ids to
 * product titles, SKUs, order numbers and customer names when the owner looks.
 */
export interface ConfirmTarget {
  kind: ConfirmTargetKind;
  ids: string[];
  total: number;
  matching: boolean;
}

export const CONFIRM_TARGET_IDS_KEPT = 20;

/** Path segments and input keys that name a store record. */
const SEGMENT_KINDS: Readonly<Record<string, ConfirmTargetKind>> = {
  products: "product",
  variants: "variant",
  orders: "order",
  customers: "customer",
  discounts: "discount",
  categories: "category",
  collections: "collection",
  pages: "page",
  users: "staff",
};
const KEY_KINDS: Readonly<Record<string, ConfirmTargetKind>> = {
  productId: "product", productIds: "product", products: "product",
  variantId: "variant", variantIds: "variant", variants: "variant",
  orderId: "order", orderIds: "order", orders: "order",
  customerId: "customer", customerIds: "customer", customers: "customer",
  categoryId: "category", categoryIds: "category",
  collectionIds: "collection",
  userId: "staff", staffMemberId: "staff",
};

function idsOf(value: unknown): string[] {
  const one = (item: unknown): string | null => {
    if (typeof item === "string") return item;
    if (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string") {
      return (item as { id: string }).id;
    }
    return null;
  };
  if (Array.isArray(value)) return value.map(one).filter((id): id is string => id !== null && id.length > 0);
  const id = one(value);
  return id ? [id] : [];
}

export function confirmTargets(steps: readonly ConfirmStep[]): ConfirmTarget[] {
  const byKind = new Map<ConfirmTargetKind, { ids: Set<string>; matching: boolean }>();
  const add = (kind: ConfirmTargetKind, ids: readonly string[], matching = false) => {
    const target = byKind.get(kind) ?? { ids: new Set<string>(), matching: false };
    ids.forEach((id) => target.ids.add(id.slice(0, 64)));
    target.matching ||= matching;
    byKind.set(kind, target);
  };
  for (const { operation, input } of steps.filter((step) => isConfirmGated(step.operation, step.changedMoneyFields))) {
    const segments = operation.pathTemplate.split("/").filter(Boolean);
    const resource = segments.map((segment) => SEGMENT_KINDS[segment]).find(Boolean);
    segments.forEach((segment, index) => {
      const name = /^\{([^}]+)\}$/.exec(segment)?.[1];
      if (!name) return;
      const kind = name === "id" ? SEGMENT_KINDS[segments[index - 1] ?? ""] : KEY_KINDS[name];
      const value = input.path?.[name];
      if (kind && value !== undefined) add(kind, [String(value)]);
    });
    const body = input.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
    for (const [key, value] of Object.entries(body)) {
      if ((key === "matching" || key === "filter") && resource && typeof value === "object" && value !== null) add(resource, [], true);
    }
    // Ids at any depth (an order's `items.*.productId`, a discount's `effects.*.config.productIds`):
    // every record a change names is named on the page.
    const visit = (value: unknown, depth: number) => {
      if (depth > 8 || typeof value !== "object" || value === null) return;
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, depth + 1));
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === "matching" || key === "filter") continue;
        const kind = KEY_KINDS[key] ?? (key === "ids" && depth === 0 ? resource : undefined);
        if (kind) add(kind, idsOf(item));
        else visit(item, depth + 1);
      }
    };
    visit(body, 0);
  }
  return [...byKind].map(([kind, { ids, matching }]) => ({
    kind,
    ids: [...ids].slice(0, CONFIRM_TARGET_IDS_KEPT),
    total: ids.size,
    matching,
  }));
}
