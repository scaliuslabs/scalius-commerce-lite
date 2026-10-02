// The context every plugin handler receives (docs/platform/PLUGINS.md). It is
// the whole surface a plugin can reach: each call crosses the host bridge,
// which checks the plugin's granted manifest before doing anything. The same
// context is built for a sandboxed plugin (Dynamic Worker, Workers Paid) and a
// bundled one (in-process, Workers Free). Part of the versioned plugin API.

import type { EventTopic, EventsApiVersion } from "@scalius/shared/events";
import type { PluginSettingValue } from "@scalius/shared/plugins";

/** Store facts every handler may read. */
export interface PluginStoreInfo {
  name: string;
  /** Absolute storefront origin, or null until the merchant sets it. */
  url: string | null;
  currency: string;
  decimalPlaces: number;
  timezone: string;
  locale: string;
}

/** One `/api/v1` operation call: the same validation, RBAC and audit as the dashboard. */
export interface PluginApiCallInput {
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  /** Required for mutating operations; replays return the first result. */
  idempotencyKey?: string;
}

export interface PluginApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: { code: string; message: string } | null;
}

export interface PluginApi {
  /** Calls an operation by its stable id (`dashboard.orders.get`). Denied unless the grant covers its permission. */
  call<T = unknown>(operationId: string, input?: PluginApiCallInput): Promise<PluginApiResult<T>>;
}

export interface PluginStorageQuery {
  /** Equality on declared index fields. */
  where?: Record<string, string | number | boolean | null>;
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string | null;
}

export interface PluginStorageCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  get(id: string): Promise<T | null>;
  put(id: string, record: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  query(query?: PluginStorageQuery): Promise<{ records: Array<{ id: string; data: T }>; nextCursor: string | null }>;
  count(where?: PluginStorageQuery["where"]): Promise<number>;
}

export interface PluginKv {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface PluginHttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface PluginHttp {
  /** https only, to the manifest's `allowedHosts`; redirects are followed only to allowed hosts. */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<PluginHttpResponse>;
}

export interface PluginCustomFields {
  /** Values of this plugin's own fields on one resource. */
  get(ownerType: string, ownerId: string): Promise<Record<string, unknown>>;
  set(ownerType: string, ownerId: string, values: Record<string, unknown>): Promise<void>;
}

export interface PluginMessaging {
  /**
   * Sends through the store's configured providers; recipients are resolved by the platform.
   * `marketing: true` (with `customerId`) sends only when the customer is subscribed on that
   * channel now (`queued: false` otherwise); e-mail then carries the store's unsubscribe
   * footer and RFC 8058 List-Unsubscribe headers. Transactional mail leaves it unset.
   */
  email(input: { customerId?: string; to?: string; subject: string; html: string; text?: string; marketing?: boolean }): Promise<{ queued: boolean }>;
  sms(input: { customerId?: string; to?: string; text: string; marketing?: boolean }): Promise<{ queued: boolean }>;
  /** A dashboard notification for staff. */
  notifyStaff(input: { title: string; body?: string; url?: string }): Promise<void>;
}

export interface PluginLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface PluginContext {
  plugin: { id: string; version: string };
  store: PluginStoreInfo;
  /** The installation's settings; secrets are present only here, decrypted. */
  settings: Readonly<Record<string, PluginSettingValue>>;
  api: PluginApi;
  storage: Record<string, PluginStorageCollection>;
  kv: PluginKv;
  http: PluginHttp;
  customFields: PluginCustomFields;
  messaging: PluginMessaging;
  log: PluginLogger;
}

/**
 * What an event handler receives (the webhook delivery body, minus `data`:
 * read the resource's current state with `ctx.api`).
 *
 * Delivery is at least once. The same event can arrive again (a retry after
 * your handler threw or timed out, a lost acknowledgement), so make handlers
 * idempotent: `id` is stable across every attempt, use it as your
 * idempotency key (store it, or pass it as `idempotencyKey`/request key to
 * `ctx.api.call`). Events are not ordered across resources.
 *
 * Your plugin also receives events caused by its own writes (an
 * `order.updated` after it edits an order), as Shopify apps do. Write only
 * when something would change, so your handler converges instead of looping.
 * The platform bounds runaway loops with your `ctx.api` rate limit and a cap
 * on deliveries in flight, not by filtering your own events.
 *
 * A handler that throws or times out is retried with backoff (1 min, 5 min,
 * 30 min, 1 h, 3 h, 6 h, 12 h; 8 attempts), then the delivery is exhausted
 * and the merchant can retry it from the app's page.
 */
export interface PluginEvent<T extends EventTopic = EventTopic> {
  /** The event id: your idempotency key. */
  id: string;
  topic: T;
  apiVersion: EventsApiVersion;
  occurredAt: string;
  resource: { type: string; id: string };
  facts: Record<string, unknown>;
}

/**
 * A route request as the plugin sees it: headers are filtered, cookies and
 * auth never pass. Admin and public routes see only `accept`,
 * `accept-language`, `content-type`, `if-none-match`, `user-agent` and
 * `x-requested-with`; webhook routes see every header except credentials and
 * network headers (so provider signature headers arrive). Bodies are capped:
 * 1 MiB admin and webhooks, 256 KiB public.
 */
export interface PluginRouteRequest {
  method: string;
  /** The path after the route name. */
  subpath: string;
  query: Record<string, string>;
  /** Lowercase names. */
  headers: Record<string, string>;
  /**
   * Parsed JSON when the body is JSON, an object of fields when it is a form
   * (`application/x-www-form-urlencoded`), else null.
   */
  body: unknown;
  /** Webhook routes: the exact body text, for signature checks. Null elsewhere. */
  rawBody: string | null;
  /** Admin routes: the staff member's id. */
  staffId: string | null;
}

/**
 * Responses are always JSON (`body`, or nothing for 204). A plugin may not
 * set cookies, CSP, CORS, `content-type` or redirect `location` headers.
 * Admin responses are never cached. A public or webhook response is
 * `no-store` unless it sets exactly `cache-control: public, max-age=N` with
 * N ≤ 300.
 */
export interface PluginRouteResponse {
  status?: number;
  headers?: Record<string, string>;
  /** JSON for API routes; a UI tree for admin pages/cards; `{ html, css? }` for storefront sections. */
  body?: unknown;
}
