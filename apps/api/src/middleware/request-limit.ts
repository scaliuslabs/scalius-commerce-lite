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
 * A request without a client address came over a service binding (the
 * storefront's server calls that do not forward the buyer): every request
 * from the internet carries `cf-connecting-ip`. The storefront gateway owns
 * those buyers' budget, so they share no bucket here.
 */
function clientAddress(c: LimitContext): string | null {
  const address = getTrustedClientAddress(c);
  return address === "unknown" ? null : address;
}

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

/** The path parameter `name` of a template, read from the request path segment by segment. */
function pathParam(template: string, pathname: string, name: string): string {
  const keys = template.split("/");
  const values = pathname.split("/");
  const index = keys.findIndex((key) => key === `:${name}` || key.startsWith(`:${name}{`));
  return index >= 0 ? decodeURIComponent(values[index] ?? "") : "";
}

async function chargeBudget(c: LimitContext, limit: RouteLimit, route: { method: string; path: string }, address: string): Promise<void> {
  const { budget } = limit;
  switch (budget.kind) {
    case "exempt":
      return;
    case "read": {
      if (isLoopback(address)) return;
      const subject = `${getTrustedClientIp(c)}${shardOf(planLimits().requests.readsPerMinute)}`;
      if (!(await isWithinRateLimit(c.env, "RL_STANDARD", "request:read", subject))) {
        refuse(c, "Too many requests. Please try again in a minute.");
      }
      return;
    }
    case "standard":
    case "strict": {
      const purpose = `request:${budget.bucket ?? `${route.method} ${route.path}`}`;
      const tier = budget.kind === "strict" ? "RL_STRICT" : "RL_STANDARD";
      if (!(await isWithinRateLimit(c.env, tier, purpose, getTrustedClientIp(c)))) {
        refuse(c, "Too many requests. Please try again in a minute.");
      }
      return;
    }
    case "provider": {
      // Keyed by the provider and the sender's network: buyers' and other
      // networks' traffic never spends a gateway's budget.
      const providerId = pathParam(route.path, new URL(c.req.url).pathname, "provider");
      const subject = `${getClientNetworkForLog(c)}${shardOf(planLimits().requests.providerCallbacksPerMinute)}`;
      if (!(await isWithinRateLimit(c.env, "RL_STANDARD", `request:provider:${route.path}:${providerId}`, subject))) {
        refuse(c, "Too many callbacks from this network. Retry later.");
      }
      return;
    }
  }
}

/** The distinct values of a guessed body field, normalized as codes are (case, spaces, dashes). */
async function guessedValues(c: LimitContext, field: string): Promise<string[]> {
  if (!(c.req.header("Content-Type") ?? "").toLowerCase().includes("json")) return [];
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const raw = body && typeof body === "object" ? body[field] : undefined;
  const values = (Array.isArray(raw) ? raw : [raw])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toUpperCase().replace(/[\s-]+/g, ""))
    .filter(Boolean);
  return [...new Set(values)].slice(0, MAX_GUESSES_PER_REQUEST);
}

async function chargeGuesses(c: LimitContext, guesses: NonNullable<RouteLimit["guesses"]>, memo: GuessMemo | null): Promise<void> {
  const values = await guessedValues(c, guesses.field);
  if (values.length === 0) return;
  const ip = getTrustedClientIp(c);
  const purpose = `guess:${guesses.bucket}`;
  const keys = await Promise.all(values.map((value) => rateLimitKey(c.env, purpose, `${ip}\0${value}`)));
  const tried = memo ? await Promise.all(keys.map((key) => memo.has(key))) : keys.map(() => false);
  const fresh = keys.filter((_, index) => !tried[index]);
  if (fresh.length === 0) return;
  const allowed = await Promise.all(fresh.map(() => isWithinRateLimit(c.env, "RL_STRICT", purpose, ip)));
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
    const address = limit ? clientAddress(c) : null;
    if (!route || !limit || !address) return next();
    await chargeBudget(c, limit, route, address);
    if (limit.guesses) await chargeGuesses(c, limit.guesses, memoOf());
    return next();
  };
}

export const requestLimitMiddleware = createRequestLimitMiddleware();
