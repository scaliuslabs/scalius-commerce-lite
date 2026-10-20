// `Idempotency-Key`: the one retry contract of the stable app API
// (operation-registry/README.md). Every stable mutating operation accepts the
// header (8 to 200 printable characters) and keeps its first response for 24
// hours in `system_kv`: the same caller repeating the same operation with the
// same key gets that response again (`Idempotent-Replayed: true`) instead of
// acting twice. The same key with a different request is refused (422
// idempotency_key_reused), and a repeat while the first is still running
// waits for nothing (409 idempotency_in_progress). A 5xx is not kept, so its
// retry runs again.
//
// The claim and the write are separate: if a Worker dies between the write
// committing and its response being kept, the claim stays "processing" and
// repeats answer 409 until it expires, rather than act twice. Operations with
// a durable retry key of their own (the stock ledger, fulfilments, pickup,
// timeline notes) also derive it from the header (`scopedRequestKey`), so
// even an expired claim never repeats their effect. A response that carries a
// secret shown once (`idempotencySecretResponse`) is never kept: its repeat is
// refused (409 idempotency_secret_not_replayed), so no secret rests in system_kv.
import { z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { systemKv } from "@scalius/database/schema";
import { eq, lte, sql } from "drizzle-orm";
import { sha256Hex } from "@scalius/shared/hash";
import { AppError } from "@scalius/core/errors";
import { routedApiPath } from "../../utils/routed-path";

/** How long a key is remembered: a retry after this creates again. */
export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;
const KEY_PREFIX = "idem:";
const MIN_KEY = 8;
const MAX_KEY = 200;
/** 8 to 200 printable ASCII characters (space included); opaque to the API. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7E]{8,200}$/u;
export const IDEMPOTENCY_KEY_DESCRIPTION = "Retry key (8 to 200 printable characters): repeating the request with it within 24 hours returns the first response (Idempotent-Replayed: true) instead of acting twice.";

export const idempotencyKeyHeaderSchema = z.object({
  "idempotency-key": z.string().regex(IDEMPOTENCY_KEY_PATTERN, "Idempotency-Key is 8 to 200 printable characters.").optional().openapi({
    description: IDEMPOTENCY_KEY_DESCRIPTION,
  }),
});

type Stored =
  | { state: "processing"; request: string }
  | { state: "done"; request: string; status: number; contentType: string | null; body: string; secret?: true };

/** Who the key belongs to: one app, one agent grant or one staff member never share keys. */
function callerScope(c: Context): string {
  const plugin = c.get("pluginPrincipal");
  if (plugin) return `app:${plugin.pluginId}`;
  const agent = c.get("agentPrincipal");
  if (agent) return `agent:${agent.grantId}`;
  const user = c.get("user") as { id?: string } | undefined;
  return `user:${user?.id ?? "anonymous"}`;
}

/**
 * The operation's own retry key for a caller's `Idempotency-Key`: the same
 * caller, operation and key always map to the same request key; no key is a
 * fresh one (the request acts once, and its retry acts again).
 */
export async function scopedRequestKey(c: Context, operationId: string, key: string | undefined): Promise<string> {
  if (!key) return crypto.randomUUID();
  return `api-${(await sha256Hex(`${callerScope(c)}\n${operationId}\n${key}`)).slice(0, 48)}`;
}

function refuse(status: number, code: string, message: string): never {
  throw new AppError(status, code, message);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Takes the key for this request, or returns what an earlier request left under it. */
async function claim(c: Context, storeKey: string, request: string): Promise<Stored | null> {
  const db = c.get("db");
  const now = nowSeconds();
  const value: Stored = { state: "processing", request };
  const won = await db.insert(systemKv)
    .values({ key: storeKey, value: JSON.stringify(value), expiresAt: now + IDEMPOTENCY_WINDOW_SECONDS })
    .onConflictDoUpdate({
      target: systemKv.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      setWhere: lte(systemKv.expiresAt, now),
    })
    .returning({ key: systemKv.key });
  if (won.length > 0) return null;
  const row = await db.select({ value: systemKv.value }).from(systemKv).where(eq(systemKv.key, storeKey)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as Stored;
  } catch {
    return { state: "processing", request: "" };
  }
}

/**
 * Replays a stable mutating operation's first response for a repeated
 * `Idempotency-Key`. Mounted on /admin/*; it acts only on stable operations,
 * and only when the caller sent a key (beta routes keep their own rules).
 */
export const idempotentReplay: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const key = c.req.header("Idempotency-Key");
  if (key === undefined || c.req.method === "GET" || c.req.method === "HEAD") return next();
  // The operation catalog loads only for a request that sent a key (route families never initialize it).
  const { resolveDirectAgentOperation } = await import("../../agent-access/direct-operation");
  const operation = resolveDirectAgentOperation(c.req.method, routedApiPath(c));
  if (!operation || operation.stability !== "stable") return next();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    refuse(400, "idempotency_key_invalid", `Idempotency-Key is ${MIN_KEY} to ${MAX_KEY} printable characters.`);
  }

  const scope = callerScope(c);
  const storeKey = `${KEY_PREFIX}${await sha256Hex(`${scope}\n${operation.operationId}\n${key}`)}`;
  const url = new URL(c.req.url);
  const request = await sha256Hex(`${c.req.method}\n${url.pathname}\n${url.search}\n${await c.req.text()}`);

  const earlier = await claim(c, storeKey, request);
  if (earlier) {
    if (earlier.request !== request) {
      refuse(422, "idempotency_key_reused", "This Idempotency-Key was used for a different request. Use a new key for a new request.");
    }
    if (earlier.state === "processing") {
      refuse(409, "idempotency_in_progress", "A request with this Idempotency-Key is still running. Retry it shortly.");
    }
    if (earlier.secret) {
      refuse(409, "idempotency_secret_not_replayed", "This request already succeeded, and its secret is shown only once. List the resource to find it.");
    }
    return new Response(earlier.body, {
      status: earlier.status,
      headers: {
        ...(earlier.contentType ? { "Content-Type": earlier.contentType } : {}),
        "Cache-Control": "private, no-store",
        "Idempotent-Replayed": "true",
      },
    });
  }

  const db = c.get("db");
  try {
    await next();
  } catch (error) {
    await db.delete(systemKv).where(eq(systemKv.key, storeKey));
    throw error;
  }
  if (c.res.status >= 500) {
    await db.delete(systemKv).where(eq(systemKv.key, storeKey));
    return;
  }
  const secret = c.get("idempotencySecretResponse") === true && c.res.status < 300;
  const done: Stored = {
    state: "done",
    request,
    status: c.res.status,
    contentType: c.res.headers.get("Content-Type"),
    body: secret ? "" : await c.res.clone().text(),
    ...(secret ? { secret: true as const } : {}),
  };
  try {
    await db.update(systemKv).set({ value: JSON.stringify(done) }).where(eq(systemKv.key, storeKey));
  } catch {
    // The create committed; its repeats answer 409 until the claim expires.
    console.warn(JSON.stringify({ event: "idempotency_record_failed", operationId: operation.operationId }));
  }
};
