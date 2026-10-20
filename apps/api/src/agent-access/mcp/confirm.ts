// Confirmation for destructive and financial agent writes (decision D2).
//
// A grant's confirm policy defaults to `destructive_financial`: such a call
// runs only after a person approves it (audit R2 F3), either in the dashboard
// (`../approvals.ts`: the refused call returns an approval link for the
// grant's owner, never anything the agent could redeem itself) or, for an
// OAuth app or the paired CLI, in a native client dialog (MCP form
// elicitation on 2026-07-28 clients). The dialog's request state is a confirm
// token: an HMAC over the grant, the exact operations and inputs, and a
// 10-minute expiry, so issuing one writes nothing; its single use is claimed
// in `system_kv` immediately before the dispatch, so a replay is a 409.

import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { systemKv } from "@scalius/database/schema";
import { getDb } from "@scalius/database/client";
import type { AgentOperationManifestEntry } from "../../openapi/agent-operation-manifest";
import { AgentDispatchError, type AgentOperationInput } from "../dispatch";
import type { AgentPrincipal } from "../types";

export type AgentConfirmPolicy = "none" | "destructive_financial";

export const CONFIRM_TOKEN_TTL_SECONDS = 10 * 60;
const TOKEN_PATTERN = /^sct_([0-9a-z]{1,10})_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;
const POLICY_KEY_PREFIX = "agent-confirm-policy:";
const USED_KEY_PREFIX = "agent-confirm-used:";
const encoder = new TextEncoder();

/**
 * Operations the confirm policy gates: every destructive or financial one,
 * every security change (access keys, roles, webhooks, platform origins: as
 * consequential as deletes and money), plus any the registry marks
 * `confirmation: "required"` (a registry entry can add a gate, never remove
 * one). A security read (a GET such as the masked email or SMS setup) keeps
 * its tag, which a grant's risk ceiling must allow, but changes nothing, so
 * it needs no approval.
 */
export function isConfirmGated(operation: Pick<AgentOperationManifestEntry, "risk" | "method">): boolean {
  if ((operation as { confirmation?: unknown }).confirmation === "required") return true;
  if (operation.risk === "security") return operation.method !== "GET";
  return operation.risk === "destructive" || operation.risk === "financial";
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
  operation: AgentOperationManifestEntry;
  input: AgentOperationInput;
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

function factValue(value: unknown): string | null {
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 37)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  return null;
}

/** "Process order refund: id=ord_1, amount=500, reason=damaged": what the merchant approves. */
export function confirmSummary(steps: readonly ConfirmStep[]): string {
  const describe = ({ operation, input }: ConfirmStep) => {
    const facts: string[] = [];
    for (const [key, value] of Object.entries(input.path ?? {})) facts.push(`${key}=${String(value)}`);
    const body = input.body;
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      for (const [key, value] of Object.entries(body)) {
        if (/key$|token|secret|password/i.test(key)) continue;
        const text = factValue(value);
        if (text !== null) facts.push(`${key}=${text}`);
      }
    }
    for (const [key, value] of Object.entries(input.query ?? {})) {
      const text = factValue(value);
      if (text !== null) facts.push(`${key}=${text}`);
    }
    const title = operation.summary || operation.operationId;
    return facts.length > 0 ? `${title}: ${facts.slice(0, 6).join(", ")}` : title;
  };
  const gated = steps.filter((step) => isConfirmGated(step.operation));
  const text = gated.length === 1
    ? describe(gated[0]!)
    : `${gated.length} ${gated.length === 1 ? "change" : "changes"}: ${gated.map(describe).join("; ")}`;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
