// The one request limiter of every route outside the dashboard: it reads the
// matched route's class (runtime/route-limits.ts) and charges the native
// limiters before the route runs. Route groups register it first
// (runtime/route-groups.ts), so production and the contract app limit alike.
//
// A public cached read reaches a route only when it renders: a validated
// cache hit is answered before any route group loads, so hits cost nothing.
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { planLimits } from "@scalius/shared/plan-limits";
import { randomInteger } from "@scalius/shared/random";
import { RateLimitError } from "../utils/api-error";
import { getClientNetworkForLog, getTrustedClientAddress, getTrustedClientIp } from "../utils/client-ip";
import { isWithinRateLimit, rateLimitKey } from "../utils/rate-limit";
import { routeLimitOf, type RouteLimit } from "../runtime/route-limits";

/** The wait every refusal names: both limiter namespaces count per 60 s. */
export const REQUEST_LIMIT_RETRY_SECONDS = 60;
/** How long a tried secret stays free to send again from the same client. */
export const GUESS_MEMO_SECONDS = 60 * 60;
/** At most this many values of one guessed field are read from a body (the schemas allow five codes). */
const MAX_GUESSES_PER_REQUEST = 10;

/**
 * The secrets a client already paid a guess for. Backed by the data center's
 * Cache API, like the limiter counters themselves (both are per location);
 * without one, every value is a new guess.
 */
export interface GuessMemo {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
}

const MEMO_ORIGIN = "https://request-limit.invalid/guess/";

export function cacheGuessMemo(cache: Pick<Cache, "match" | "put">): GuessMemo {
  return {
    has: async (key) => Boolean(await cache.match(`${MEMO_ORIGIN}${key}`).catch(() => undefined)),
    add: (key) => cache.put(
      `${MEMO_ORIGIN}${key}`,
      new Response("1", { headers: { "Cache-Control": `public, max-age=${GUESS_MEMO_SECONDS}` } }),
    ).catch(() => undefined),
  };
}

function defaultGuessMemo(): GuessMemo | null {
  return typeof caches === "undefined" ? null : cacheGuessMemo(caches.default);
}

type LimitContext = Context<{ Bindings: Env }>;

/** The route Hono will answer with: the first non-middleware handler it matched. */
function answeringRoute(c: LimitContext): { method: string; path: string } | null {
  return matchedRoutes(c).find((route) => route.method !== "ALL") ?? null;
}

/**
 * The caller's address, or null when the request carries none. Every request
 * from the internet carries `cf-connecting-ip` (Cloudflare's edge sets it, so
 * a client cannot choose it); only a service-binding caller (the storefront)
 * can set it or leave it out. The storefront forwards the buyer's address on
 * every call it makes for a buyer (lib/api/transport.ts); one with none is
 * its own work (a page render's public reads, its service token).
 */
function clientAddress(c: LimitContext): string | null {
  const address = getTrustedClientAddress(c);
  return address === "unknown" ? null : address;
}

/**
 * The subject a strict budget or a code guess charges when no address came:
 * one conservative bucket for the route, shared by every such request, so a
 * caller that forwards no address is limited, never exempt.
 */
const ADDRESSLESS_SUBJECT = "service-binding-without-address";

/** Local development's own traffic: no internet request carries a loopback client address. */
function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.");
}

/** A refusal is never stored by any cache, and names the wait (`Retry-After`). */
function refuse(c: LimitContext, message: string): never {
  c.header("Cache-Control", "private, no-store");
  throw new RateLimitError(message, REQUEST_LIMIT_RETRY_SECONDS);
}

/** One of `ceil(perMinute / 60)` standard keys, picked at random: an approximate `perMinute` ceiling. */
function shardOf(perMinute: number): string {
  const shards = Math.max(1, Math.ceil(perMinute / 60));
  return shards === 1 ? "" : `:${randomInteger(shards)}`;
}

/**
 * The read budget fails open: browsing that misses the cache stays up when
 * the limiter binding is missing or erring (a strict budget fails closed).
 */
async function withinReadBudget(env: Env, subject: string): Promise<boolean> {
  if (!env.RL_STANDARD) return true;
  try {
    return await isWithinRateLimit(env, "RL_STANDARD", "request:read", subject);
  } catch {
    return true;
  }
}

async function chargeBudget(c: LimitContext, limit: RouteLimit, route: { method: string; path: string }, address: string | null): Promise<void> {
  const { budget } = limit;
  switch (budget.kind) {
    case "exempt":
      return;
    case "read": {
      // A page render's public reads come over the service binding without
      // an address; local development reads from loopback. Neither is charged.
      if (!address || isLoopback(address)) return;
      const subject = `${getTrustedClientIp(c)}${shardOf(planLimits().requests.readsPerMinute)}`;
      if (!(await withinReadBudget(c.env, subject))) refuse(c, "Too many requests. Please try again in a minute.");
      return;
    }
    case "standard": {
      // The storefront's own calls (its service token) carry no address and share no bucket.
      if (!address) return;
      const purpose = `request:${budget.bucket ?? `${route.method} ${route.path}`}`;
      if (!(await isWithinRateLimit(c.env, "RL_STANDARD", purpose, getTrustedClientIp(c)))) {
        refuse(c, "Too many requests. Please try again in a minute.");
      }
      return;
    }
    case "strict": {
      const purpose = `request:${budget.bucket ?? `${route.method} ${route.path}`}`;
      if (!(await isWithinRateLimit(c.env, "RL_STRICT", purpose, address ? getTrustedClientIp(c) : ADDRESSLESS_SUBJECT))) {
        refuse(c, "Too many requests. Please try again in a minute.");
      }
      return;
    }
    case "provider": {
      // Keyed by the route family and the sender's network, never by the
      // provider name in the path (any name would mint a fresh bucket) and
      // never by buyer traffic: another network's flood cannot spend a
      // gateway's budget. A callback always comes from the internet.
      if (!address) return;
      const subject = `${getClientNetworkForLog(c)}${shardOf(planLimits().requests.providerCallbacksPerMinute)}`;
      if (!(await isWithinRateLimit(c.env, "RL_STANDARD", `request:provider:${route.path}`, subject))) {
        refuse(c, "Too many callbacks from this network. Retry later.");
      }
      return;
    }
  }
}

/** The distinct values of a guessed body field, compared as the route's matcher compares them. */
async function guessedValues(c: LimitContext, guesses: NonNullable<RouteLimit["guesses"]>): Promise<string[]> {
  if (!(c.req.header("Content-Type") ?? "").toLowerCase().includes("json")) return [];
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const raw = body && typeof body === "object" ? body[guesses.field] : undefined;
  const values = (Array.isArray(raw) ? raw : [raw])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => guesses.normalize(value))
    .filter(Boolean);
  return [...new Set(values)].slice(0, MAX_GUESSES_PER_REQUEST);
}

async function chargeGuesses(c: LimitContext, guesses: NonNullable<RouteLimit["guesses"]>, memo: GuessMemo | null, address: string | null): Promise<void> {
  const values = await guessedValues(c, guesses);
  if (values.length === 0) return;
  // Without an address every guess shares one bucket: never a way around the budget.
  const subject = address ? getTrustedClientIp(c) : ADDRESSLESS_SUBJECT;
  const purpose = `guess:${guesses.bucket}`;
  const keys = await Promise.all(values.map((value) => rateLimitKey(c.env, purpose, `${subject}\0${value}`)));
  const tried = memo ? await Promise.all(keys.map((key) => memo.has(key))) : keys.map(() => false);
  const fresh = keys.filter((_, index) => !tried[index]);
  if (fresh.length === 0) return;
  const allowed = await Promise.all(fresh.map(() => isWithinRateLimit(c.env, "RL_STRICT", purpose, subject)));
  if (allowed.some((ok) => !ok)) refuse(c, "Too many codes tried. Please wait a minute and try again.");
  if (memo) {
    const remembered = Promise.all(fresh.map((key) => memo.add(key)));
    try {
      c.executionCtx.waitUntil(remembered);
    } catch {
      await remembered;
    }
  }
}

export interface RequestLimitDeps {
  /** The tried-secret memo; defaults to the data center's Cache API (none where it is missing). */
  guessMemo?: () => GuessMemo | null;
}

export function createRequestLimitMiddleware(deps: RequestLimitDeps = {}): MiddlewareHandler<{ Bindings: Env }> {
  const memoOf = deps.guessMemo ?? defaultGuessMemo;
  return async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const route = answeringRoute(c);
    const limit = route ? routeLimitOf(route.method, route.path) : null;
    if (!route || !limit) return next();
    const address = clientAddress(c);
    await chargeBudget(c, limit, route, address);
    if (limit.guesses) await chargeGuesses(c, limit.guesses, memoOf(), address);
    return next();
  };
}

export const requestLimitMiddleware = createRequestLimitMiddleware();
