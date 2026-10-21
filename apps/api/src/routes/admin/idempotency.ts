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
// The claim and the write are separate, so a Worker can die after the write
// commits and before its response is kept. The claim therefore holds a short
// lease (`IDEMPOTENCY_LEASE_SECONDS`), not the whole day: once it lapses
// without a response, a repeat recovers by the operation's own guard
// (`retryAfterLostResponse`). An operation whose effect is keyed by the
// request (the stock ledger, orders, payments, refunds, fulfilments, gift
// cards and bulk runs derive their durable key from the header with
// `scopedRequestKey`; batch creates key each item), or that sets a target
// state (a PUT, a DELETE, a write under a required revision, a status move),
// runs again: a first run that committed is answered from its own record or
// refused by its revision, and one that never committed acts now. A create
// with no such key (a new random id) never runs twice: its repeat answers 409
// idempotency_outcome_unknown and the caller reads to find out. A response
// that carries a secret shown once (`idempotencySecretResponse`) is never
// kept: its repeat is refused (409 idempotency_secret_not_replayed), so no
// secret rests in system_kv.
import { z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { systemKv } from "@scalius/database/schema";
import { and, eq, lte, sql } from "drizzle-orm";
import { sha256Hex } from "@scalius/shared/hash";
import { AppError } from "@scalius/core/errors";
import type { AgentOperationPolicy } from "../../openapi/agent-operation-manifest";
import { routedApiPath } from "../../utils/routed-path";

/** How long a key is remembered: a retry after this creates again. */
export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;
/**
 * How long a running request holds its key. Longer than any request lives
 * (provider calls time out well inside it); a claim still `processing` after
 * it belongs to a Worker that died, and a repeat recovers.
 */
export const IDEMPOTENCY_LEASE_SECONDS = 120;
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
  // `lease` names the run holding the key until `leaseUntil` (epoch seconds); a claim kept before leases had neither and reads as lapsed.
  | { state: "processing"; request: string; lease?: string; leaseUntil?: number }
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

/**
 * Stable POST writes that a repeat may run again after a lost response: their
 * effect is keyed by the request (`scopedRequestKey`, batch item keys, a bulk
 * run's operation key), sets a target state (restore, void, delivered, ready
 * for pickup, capture), matches by a natural key (an object type, a place
 * import) or only reads (`variants.lookup`). Any other POST or PATCH without
 * a required revision answers `idempotency_outcome_unknown` instead, so a new
 * stable create stays safe until it is listed here with a key of its own
 * (`idempotency.test.ts` holds the list to the stable contract).
 */
const RERUN_SAFE_POSTS: ReadonlySet<string> = new Set([
  "dashboard.brands.batch_create",
  "dashboard.categories.batch_create",
  "dashboard.collections.restore",
  "dashboard.delivery_locations.import",
  "dashboard.inventory.adjust",
  "dashboard.inventory.set_stock",
  "dashboard.orders.fulfillment_void",
  "dashboard.orders.mark_delivered",
  "dashboard.orders.pickup_ready",
  "dashboard.resources.app_content.delete",
  "dashboard.resources.customers.bulk_tag",
  "dashboard.resources.fulfillments.create",
  "dashboard.resources.gift_cards.create",
  "dashboard.resources.orders.create",
  "dashboard.resources.payments.capture",
  "dashboard.resources.payments.charge",
  "dashboard.resources.payments.create",
  "dashboard.resources.payments.void",
  "dashboard.resources.products.batch_create",
  "dashboard.resources.products.bulk_publish",
  "dashboard.resources.products.bulk_set_status",
  "dashboard.resources.refunds.create",
  "dashboard.resources.variants.bulk_set_prices",
  "dashboard.resources.variants.bulk_set_stock",
  "dashboard.resources.variants.lookup",
  "objects.types.create",
]);

/**
 * What a repeat does once the first run's lease lapsed without a response:
 * `rerun` when the operation cannot act twice (a PUT or DELETE sets a target
 * state, a required revision refuses a second apply, `RERUN_SAFE_POSTS`), and
 * `outcome_unknown` for a create that would make a second resource.
 */
export function retryAfterLostResponse(
  operation: Pick<AgentOperationPolicy, "operationId" | "method" | "revision">,
): "rerun" | "outcome_unknown" {
  if (operation.revision === "required") return "rerun";
  if (operation.method === "PUT" || operation.method === "DELETE") return "rerun";
  return RERUN_SAFE_POSTS.has(operation.operationId) ? "rerun" : "outcome_unknown";
}

/** A fresh claim's exact stored value: this run's lease, unique so only it can complete or release the key. */
function processingClaim(request: string): string {
  const stored: Stored = { state: "processing", request, lease: crypto.randomUUID(), leaseUntil: nowSeconds() + IDEMPOTENCY_LEASE_SECONDS };
  return JSON.stringify(stored);
}

function parseStored(raw: string): Stored {
  try {
    return JSON.parse(raw) as Stored;
  } catch {
    return { state: "processing", request: "" };
  }
}

/**
 * Takes the key for this request (`own`: the claim's exact value), or returns
 * what an earlier request left under it (`earlier`, with its raw value for a
 * compare-and-set takeover).
 */
async function claim(c: Context, storeKey: string, request: string): Promise<
  { own: string } | { earlier: Stored; raw: string }
> {
  const db = c.get("db");
  const now = nowSeconds();
  const own = processingClaim(request);
  const won = await db.insert(systemKv)
    .values({ key: storeKey, value: own, expiresAt: now + IDEMPOTENCY_WINDOW_SECONDS })
    .onConflictDoUpdate({
      target: systemKv.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      setWhere: lte(systemKv.expiresAt, now),
    })
    .returning({ key: systemKv.key });
  if (won.length > 0) return { own };
  const row = await db.select({ value: systemKv.value }).from(systemKv).where(eq(systemKv.key, storeKey)).get();
  if (!row) return { earlier: { state: "processing", request }, raw: "" };
  return { earlier: parseStored(row.value), raw: row.value };
}

/** Takes over a lapsed claim while it is still exactly `raw`; null when another repeat took it first. */
async function takeOver(c: Context, storeKey: string, raw: string, request: string): Promise<string | null> {
  const own = processingClaim(request);
  const taken = await c.get("db").update(systemKv)
    .set({ value: own })
    .where(and(eq(systemKv.key, storeKey), eq(systemKv.value, raw)))
    .returning({ key: systemKv.key });
  return taken.length > 0 ? own : null;
}

const IN_PROGRESS = "A request with this Idempotency-Key is still running. Retry it shortly.";

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

  const claimed = await claim(c, storeKey, request);
  let own: string;
  if ("own" in claimed) {
    own = claimed.own;
  } else {
    const { earlier } = claimed;
    if (earlier.request !== request) {
      refuse(422, "idempotency_key_reused", "This Idempotency-Key was used for a different request. Use a new key for a new request.");
    }
    if (earlier.state === "done") {
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
    if (!claimed.raw || (earlier.leaseUntil ?? 0) > nowSeconds()) refuse(409, "idempotency_in_progress", IN_PROGRESS);
    // The first run stopped before its response was kept (its Worker died): recover by the operation's own guard.
    if (retryAfterLostResponse(operation) === "outcome_unknown") {
      refuse(409, "idempotency_outcome_unknown", "The first request with this Idempotency-Key stopped before its response was kept, so it may have taken effect. Read the resource to check, and repeat with a new key only if it is missing.");
    }
    const taken = await takeOver(c, storeKey, claimed.raw, request);
    if (!taken) refuse(409, "idempotency_in_progress", IN_PROGRESS);
    own = taken;
  }

  const db = c.get("db");
  // Only this run's own claim is released or completed: a repeat that took over a lapsed lease owns the key now.
  const mine = and(eq(systemKv.key, storeKey), eq(systemKv.value, own));
  try {
    await next();
  } catch (error) {
    await db.delete(systemKv).where(mine);
    throw error;
  }
  if (c.res.status >= 500) {
    await db.delete(systemKv).where(mine);
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
    await db.update(systemKv).set({ value: JSON.stringify(done) }).where(mine);
  } catch {
    // The write committed; a repeat after the lease recovers it (retryAfterLostResponse).
    console.warn(JSON.stringify({ event: "idempotency_record_failed", operationId: operation.operationId }));
  }
};
