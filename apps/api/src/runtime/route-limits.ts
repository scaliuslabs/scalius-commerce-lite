// The request budget of every route outside the dashboard, as data: one
// class per route, applied by one middleware (middleware/request-limit.ts)
// that every route group app runs (route-groups.ts). A route of a limited
// group without a class fails the census (route-limits.test.ts), so a new
// public route cannot ship unlimited.
//
// Like the mount table, this file imports no router: it names routes by the
// method and path template Hono registers them under (`/products/:slug`,
// relative to /api/v1).
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";
import { REQUEST_BODY_CLASS_BYTES } from "@scalius/shared/request-body-limit";
import { DIGITAL_UPLOAD_PART_BYTES } from "@scalius/shared/digital";
import { normalizeDiscountCode } from "@scalius/shared/discount-code";
import { normalizeGiftCardCode } from "@scalius/shared/gift-card-code";
import { MEDIA_MULTIPART_PART_SIZE_BYTES } from "@scalius/shared/media-policy";
import { planLimits } from "@scalius/shared/plan-limits";
import { classifyRouteGroup, type RouteGroup } from "./route-table";

/**
 * - `read`: the plan's generous read budget per client address, shared by
 *   every read route. A public cached read reaches it only when it renders
 *   (a cache hit runs no route), so only real work is counted.
 * - `standard`: the standard limiter (60 a minute) per client address and
 *   route (or `bucket`, shared by the routes that name it).
 * - `strict`: the strict limiter (5 a minute) per client address and route
 *   (or `bucket`).
 * - `provider`: a provider's server-to-server callback, keyed by the
 *   provider and its source network, never by buyer traffic, so a flood from
 *   elsewhere cannot throttle a gateway into dropping a payment event.
 * - `exempt`: the reason the route needs no budget here (its own finer
 *   budget, or an authority this layer cannot see).
 */
export type RouteBudget =
  | { readonly kind: "read" }
  | { readonly kind: "standard"; readonly bucket?: string }
  | { readonly kind: "strict"; readonly bucket?: string }
  | { readonly kind: "provider" }
  | { readonly kind: "exempt"; readonly reason: string };

export interface RouteLimit {
  readonly budget: RouteBudget;
  /**
   * A JSON body field (a string or a list of strings) carrying secrets the
   * route tests: a discount or gift-card code. Every value a client has not
   * tried in the last hour costs one strict guess from `bucket`, before any
   * work; a value it already tried is free, so a buyer whose applied code is
   * previewed again on every cart change spends nothing. Values are compared
   * as the route's own matcher compares them (`normalize`), so a spelling the
   * matcher treats as the same code is the same guess, and one it treats as
   * another code is another guess.
   */
  readonly guesses?: { readonly field: string; readonly bucket: string; readonly normalize: (value: string) => string };
}

const read: RouteLimit = { budget: { kind: "read" } };
const standard = (bucket?: string): RouteLimit => ({ budget: { kind: "standard", ...(bucket ? { bucket } : {}) } });
const strict = (bucket?: string): RouteLimit => ({ budget: { kind: "strict", ...(bucket ? { bucket } : {}) } });
const provider: RouteLimit = { budget: { kind: "provider" } };
const exempt = (reason: string): RouteLimit => ({ budget: { kind: "exempt", reason } });
const guessing = (limit: RouteLimit, field: string, bucket: string, normalize: (value: string) => string): RouteLimit =>
  ({ ...limit, guesses: { field, bucket, normalize } });
/** A discount code as promotions match it (trimmed, upper case: dashes are part of the code). */
const discountCode = normalizeDiscountCode;
/** A gift-card code as the card lookup reads it; text that cannot be one counts as itself. */
const giftCardCode = (value: string) => normalizeGiftCardCode(value) ?? value.trim().toUpperCase();

/** The groups every route of which declares a class: all but the dashboard's (staff sessions) and installed apps' (their own budget). */
export const LIMITED_ROUTE_GROUPS: ReadonlySet<RouteGroup> = new Set<RouteGroup>([
  "probe",
  "docs",
  "system",
  "public-config",
  "public-catalog",
  "public-content",
  "public-buyer",
]);

const CHECKOUT_PREPARATION = "checkout-prepare budget in the route, after idempotency replay (utils/checkout-rate-limit.ts)";
const AGENT_GRANT = "the agent grant's own budget (middleware/agent-request-boundary.ts); an agent platform's address serves many buyers";

/**
 * `METHOD /path` patterns, first match wins. `*` as the method matches any;
 * a path ending in `/*` matches that prefix and everything below it.
 */
export const ROUTE_LIMIT_RULES: ReadonlyArray<readonly [pattern: string, limit: RouteLimit]> = [
  // Probes and the contract.
  ["GET /health", read],
  ["GET /readyz", read],
  ["GET /meta", read],
  ["GET /openapi.json", read],

  // System: payment providers, webhooks, first-admin setup, the service token, agent pairing.
  ["* /webhooks/*", provider],
  ["* /payment/*", standard()],
  ["GET /setup", read],
  ["POST /setup", strict("first-admin-setup")],
  ["GET /auth/firebase-config", read],
  ["GET /auth/token", standard()],
  ["POST /agent-auth/*", standard()],
  ["GET /agent-artifacts/*", read],
  ["POST /cache/clear", exempt("a dashboard session with settings.cache.manage (adminAuth)")],

  // The storefront's change frontier is answered at Worker entry with a frontier key.
  ["* /storefront/frontier", exempt("frontier key; answered at Worker entry before the route groups")],
  ["* /storefront/frontier/check", exempt("frontier key; answered at Worker entry before the route groups")],
  ["POST /storefront/theme-preview/*", standard()],

  // Agents: one grant budget per agent.
  ["* /storefront/agent-contexts", exempt(AGENT_GRANT)],
  ["* /storefront/agent-contexts/*", exempt(AGENT_GRANT)],
  ["GET /storefront/agent-continuations/*", read],
  ["POST /storefront/agent-continuations/*", standard()],

  // Codes: each new value is a strict guess, wherever a code is tested.
  ["POST /discounts/validate", guessing(standard(), "codes", "discount-code", discountCode)],
  ["POST /checkout/gift-cards/*", guessing(standard(), "code", "gift-card-code", giftCardCode)],
  ["POST /orders/tax-quote", guessing(exempt(CHECKOUT_PREPARATION), "discountCodes", "discount-code", discountCode)],
  ["POST /orders", guessing(exempt(CHECKOUT_PREPARATION), "discountCodes", "discount-code", discountCode)],
  ["POST /orders/cart-validation", exempt(CHECKOUT_PREPARATION)],
  // Track your order: an order number and a contact, per address (the route adds a per-order budget).
  ["POST /orders/lookup/status", strict("order-lookup")],
  // A buyer's file goes to storage: the strict budget per address.
  ["POST /orders/uploads", strict()],
  ["DELETE /orders/uploads/*", strict()],

  // Buyer reads, then buyer writes (the routes add per-buyer, per-contact and per-store budgets).
  ["POST /marketing/subscribe", strict("newsletter")],
  ["GET /customer-auth/identity/*", exempt("a browser redirect flow that answers its own limit with a redirect (customer-auth/identity.ts)")],
  ["GET /customer-auth/*", read],
  ["GET /orders/*", read],
  ["GET /analytics/*", read],
  ["* /customer-auth/*", standard()],
  ["* /orders/*", standard()],
  ["POST /abandoned-checkouts", standard()],
  ["POST /abandoned-checkouts/*", standard()],
  ["POST /marketing/*", standard()],
  ["POST /meta/events", standard()],

  // Catalogue, content and configuration: reads, except a few priced lookups.
  ["GET /search", standard("search")],
  // Up to 50 product cards by handle (rich text's shortcodes): one statement and one card batch,
  // a public cached read, so the read budget counts only a render.
  ["GET /products/by-slugs", read],
  ["POST /address-rules/autocomplete/*", standard("address-autocomplete")],
  ["GET /*", read],
];

const API_BASE = "/api/v1";

function matches(pattern: string, method: string, path: string): boolean {
  const space = pattern.indexOf(" ");
  const patternMethod = pattern.slice(0, space);
  const patternPath = pattern.slice(space + 1);
  if (patternMethod !== "*" && patternMethod !== method) return false;
  if (patternPath.endsWith("/*")) {
    const prefix = patternPath.slice(0, -2);
    return path.startsWith(`${prefix}/`) || (prefix === "" && path.startsWith("/"));
  }
  return path === patternPath;
}

/** The first rule a route matches, as `[pattern, limit]`, or null. */
export function routeLimitRule(method: string, template: string): readonly [string, RouteLimit] | null {
  const path = template.startsWith(API_BASE) ? template.slice(API_BASE.length) || "/" : template;
  return ROUTE_LIMIT_RULES.find(([pattern]) => matches(pattern, method, path)) ?? null;
}

/** Undeclared routes of a limited group still get the standard budget; the census keeps there being none. */
const UNDECLARED: RouteLimit = standard();
const resolved = new Map<string, RouteLimit | null>();

/**
 * The limit of a route by the method and path template Hono matched
 * (`/api/v1/products/:slug`), or null for a route outside the limited groups
 * (the dashboard, installed apps).
 */
export function routeLimitOf(method: string, template: string): RouteLimit | null {
  const key = `${method} ${template}`;
  const cached = resolved.get(key);
  if (cached !== undefined) return cached;
  const group = classifyRouteGroup(template);
  const limit = group && LIMITED_ROUTE_GROUPS.has(group) ? routeLimitRule(method, template)?.[1] ?? UNDECLARED : null;
  resolved.set(key, limit);
  return limit;
}

// ── Request bodies ───────────────────────────────────────────────────────────
//
// Every route of every group, the dashboard's and installed apps' included,
// declares the most bytes its request body may carry. One middleware
// (middleware/body-limit.ts), registered first by every route group app,
// refuses a larger declared length before a byte is read and counts every
// body as it streams, so no route buffers or parses more than its class. A
// route without a class fails the census (route-limits.test.ts).

const KIB = 1024;
const MIB = 1024 * KIB;
/** Multipart framing on top of a file (boundaries, part headers, the other fields). */
const MULTIPART_OVERHEAD_BYTES = 64 * KIB;

/** A route's body ceiling in bytes; a function when it follows the deployed plan. */
export type BodyLimit = number | (() => number);

export const BODY_LIMITS = {
  // The fixed classes are shared with the storefront, which bounds what it
  // forwards by them (`REQUEST_BODY_CLASS_BYTES`): no body for reads; a
  // small JSON form (the largest a buyer form's schema takes is a support
  // request for 100 lines, about 35 KB: route-body-schema-census.test.ts); a
  // cart, an order or a quote (99 lines at their schema caps and the cart's
  // buyer inputs at theirs, CART_LINE_INPUT_LIMITS, about 1 MB of UTF-8 in
  // Bangla, plus a quarter for headroom); a provider's callback or an
  // installed app's route; a dashboard or app API operation (two long
  // rich-text fields in Bangla fit), and the theme editor's preview of what
  // it would save.
  ...REQUEST_BODY_CLASS_BYTES,
  /** One image a buyer or staff member attaches to a conversation or claim. */
  attachment: CONVERSATION_LIMITS.attachmentBytes + MULTIPART_OVERHEAD_BYTES,
  /** One file a buyer or an app's admin form uploads, as the plan allows. */
  upload: () => planLimits().uploads.maxBytes + MULTIPART_OVERHEAD_BYTES,
  /** One part of a media upload. */
  mediaPart: MEDIA_MULTIPART_PART_SIZE_BYTES,
  /** One media item's WebP renditions, every width in one form. */
  mediaRenditions: 32 * MIB,
  /** One part of a digital file, streamed to storage. */
  digitalPart: DIGITAL_UPLOAD_PART_BYTES,
  /** An app package (plugins/package-zip.ts PLUGIN_PACKAGE_MAX_BYTES). */
  appPackage: 20 * MIB,
} as const satisfies Record<string, BodyLimit>;

export type BodyClass = keyof typeof BODY_LIMITS;

/** `METHOD /path` patterns as in ROUTE_LIMIT_RULES, first match wins; paths are templates (`:id`). */
export const ROUTE_BODY_RULES: ReadonlyArray<readonly [pattern: string, body: BodyClass]> = [
  ["GET /*", "none"],

  // Files.
  ["PUT /admin/media/uploads/:id/parts/:partNumber", "mediaPart"],
  ["POST /admin/media/:id/variants", "mediaRenditions"],
  ["PUT /admin/digital-assets/:id/uploads/:uploadId/parts/:partNumber", "digitalPart"],
  ["POST /admin/apps/upload", "appPackage"],
  ["POST /admin/apps/:id/uploads", "upload"],
  ["POST /admin/conversations/attachments", "attachment"],
  ["POST /orders/uploads", "upload"],
  ["POST /customer-auth/conversation-attachments", "attachment"],
  ["POST /customer-auth/warranties/:id/claim-attachments", "attachment"],
  ["POST /orders/receipt/:id/conversation-attachments", "attachment"],
  ["POST /orders/receipt/:id/warranties/:warrantyId/claim-attachments", "attachment"],
  ["POST /orders/receipt/:id/warranty-claims/:claimId/attachments", "attachment"],

  // The dashboard and app API; installed apps' routes (plugins/routes.ts bounds each surface below it).
  ["* /admin/*", "dashboard"],
  ["* /plugins/*", "callback"],

  // Providers, the theme editor's preview, the storefront's frontier check.
  ["* /webhooks/*", "callback"],
  ["* /payment/*", "callback"],
  // The editor previews the unsaved sections it would save in a draft: the draft save's class.
  ["POST /storefront/theme-preview/homepage", "dashboard"],
  ["POST /storefront/frontier/check", "form"],

  // Carts and checkout.
  ["POST /orders", "cart"],
  ["POST /orders/tax-quote", "cart"],
  ["POST /orders/cart-validation", "cart"],
  ["POST /discounts/validate", "cart"],
  ["POST /abandoned-checkouts", "cart"],
  ["POST /meta/events", "cart"],
  ["POST /storefront/agent-contexts", "cart"],
  ["* /storefront/agent-contexts/*", "cart"],
  // A cart shared into a conversation.
  ["PUT /customer-auth/conversations/:id/cart-share", "cart"],
  ["PUT /customer-auth/orders/:id/conversation/cart-share", "cart"],
  ["PUT /orders/receipt/:id/conversation/cart-share", "cart"],

  // Buyer, sign-in and setup forms.
  ["* /customer-auth/*", "form"],
  ["* /orders/*", "form"],
  ["* /marketing/*", "form"],
  ["POST /abandoned-checkouts/*", "form"],
  ["* /storefront/agent-continuations/*", "form"],
  ["POST /storefront/theme-preview/resolve", "form"],
  ["POST /checkout/gift-cards/*", "form"],
  ["POST /address-rules/autocomplete/*", "form"],
  ["POST /agent-auth/*", "form"],
  ["POST /setup", "form"],
  ["POST /cache/clear", "form"],
];

/** The first body rule a route matches, as `[pattern, class]`, or null. */
export function routeBodyRule(method: string, template: string): readonly [string, BodyClass] | null {
  const path = template.startsWith(API_BASE) ? template.slice(API_BASE.length) || "/" : template;
  return ROUTE_BODY_RULES.find(([pattern]) => matches(pattern, method, path)) ?? null;
}

/**
 * A path no route serves still runs middleware that may read a body (an
 * idempotency hash): it gets the small form ceiling, never an unlimited one.
 * The census keeps every real route declared.
 */
const UNMATCHED_BODY: BodyClass = "form";

/**
 * The body ceiling in bytes of a route, by the method and template Hono
 * matched (`/api/v1/admin/media/uploads/:id/parts/:partNumber`) or, for a
 * catch-all route and an unmatched path, the request's own method and path.
 */
export function routeBodyLimitOf(method: string, templateOrPath: string): number {
  const rule = routeBodyRule(method, templateOrPath);
  const limit: BodyLimit = BODY_LIMITS[rule?.[1] ?? UNMATCHED_BODY];
  return typeof limit === "function" ? limit() : limit;
}
