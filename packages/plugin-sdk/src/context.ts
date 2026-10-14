// The context every plugin handler receives (docs/platform/PLUGINS.md). It is
// the whole surface a plugin can reach: each call crosses the host bridge,
// which checks the plugin's granted manifest before doing anything. The same
// context is built for a sandboxed plugin (Dynamic Worker, Workers Paid) and a
// bundled one (in-process, Workers Free). Part of the versioned plugin API.

import type { EventTopic, EventsApiVersion } from "@scalius/shared/events";
import type { PluginRenderContext, PluginSettingValue } from "@scalius/shared/plugins";

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
  /**
   * Calls a stable app-API operation by id (`dashboard.orders.get`):
   * `x-scalius-agent.stability: "stable"` in the OpenAPI contract. Any other
   * operation refuses with `api.operation_not_stable`, and one the approved
   * scopes do not cover with `api.operation_forbidden`.
   */
  call<T = unknown>(operationId: string, input?: PluginApiCallInput): Promise<PluginApiResult<T>>;
}

export interface PluginStorageQuery {
  /** Equality on declared index fields. */
  where?: Record<string, string | number | boolean | null>;
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string | null;
}

/** A record with the revision its last write gave it. */
export interface PluginRecordVersion<T extends Record<string, unknown> = Record<string, unknown>> {
  data: T;
  revision: number;
}

/**
 * The revision a write requires: the one you read (the record is unchanged
 * since), or null (the record must not exist). A write that finds anything
 * else changes nothing and fails with `storage.conflict`.
 */
export interface PluginWriteCondition {
  expectedRevision?: number | null;
}

/**
 * One app collection. Every write advances the record's revision; pass the
 * revision you read to write only if nobody wrote since (compare-and-set).
 */
export interface PluginStorageCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  get(id: string): Promise<T | null>;
  /** The record and its revision, for a conditional write. */
  getVersion(id: string): Promise<PluginRecordVersion<T> | null>;
  put(id: string, record: T, options?: PluginWriteCondition): Promise<{ revision: number }>;
  /**
   * Merges top-level fields into an existing record (`storage.not_found`
   * otherwise). Without `expectedRevision` a concurrent write is re-read and
   * merged again, so no update is lost.
   */
  update(id: string, patch: Partial<T>, options?: { expectedRevision?: number }): Promise<PluginRecordVersion<T>>;
  /**
   * Adds `delta` to a whole-number field (absent: 0; a missing record is
   * created), atomically. A result outside `min`/`max` changes nothing and
   * fails with `storage.out_of_range`: a balance never goes below its floor,
   * however many debits race.
   */
  increment(id: string, field: string, delta: number, options?: { min?: number; max?: number }): Promise<{ value: number; revision: number }>;
  delete(id: string, options?: PluginWriteCondition): Promise<boolean>;
  query(query?: PluginStorageQuery): Promise<{ records: Array<{ id: string; data: T }>; nextCursor: string | null }>;
  count(where?: PluginStorageQuery["where"]): Promise<number>;
}

/** One write of an atomic `ctx.storage.batch`; `check` writes nothing and only adds its condition. */
export type PluginStorageOperation =
  | { op: "put"; collection: string; id: string; record: Record<string, unknown>; expectedRevision?: number | null }
  | { op: "delete"; collection: string; id: string; expectedRevision?: number | null }
  | { op: "check"; collection: string; id: string; expectedRevision: number | null };

/**
 * The app's declared collections by name (`ctx.storage.points`), and
 * `batch`: up to 25 puts, deletes and checks across collections, written
 * all-or-nothing in one database batch. Any failed condition aborts it with
 * `storage.conflict` (`error.details.index` is not exposed; re-read and retry).
 */
export type PluginStorage = Record<string, PluginStorageCollection> & {
  batch(operations: PluginStorageOperation[]): Promise<{ revisions: Array<number | null> }>;
};

export interface PluginKv {
  get<T = unknown>(key: string): Promise<T | null>;
  /** The live entry and its revision, for `compareAndSet`. */
  getVersion<T = unknown>(key: string): Promise<{ value: T; revision: number } | null>;
  set(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<{ revision: number }>;
  /**
   * Sets the entry only while it is still at `expectedRevision` (null: no
   * live entry); otherwise nothing changes and it fails with `kv.conflict`.
   */
  compareAndSet(key: string, expectedRevision: number | null, value: unknown, options?: { ttlSeconds?: number }): Promise<{ revision: number }>;
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
  /**
   * A browser notification to one signed-in buyer (needs `customers.view`):
   * Web Push to the browsers they subscribed on their account page, or the
   * store's app push provider. `url` is a store path (`/account/orders`).
   * `delivered: false` when the buyer has no subscribed browser.
   */
  pushCustomer(input: { customerId: string; title: string; body?: string; url?: string; tag?: string }): Promise<{ delivered: boolean }>;
}

/** Typed lines on order timelines (needs `orders.edit`; each kind declared in `manifest.timeline`). */
export interface PluginTimeline {
  /**
   * Adds a line staff see on the order (and agents read): your app's name,
   * the kind's title and `message` (plain text, 500 characters), with up to
   * 10 small typed `fields`. Never put buyer contact data in it. The same
   * `idempotencyKey` (an event id) adds the line once. It changes nothing on
   * the order and emits no event.
   */
  add(input: {
    orderId: string;
    kind: string;
    message: string;
    fields?: Record<string, string | number | boolean>;
    idempotencyKey?: string;
  }): Promise<{ id: string }>;
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
  storage: PluginStorage;
  kv: PluginKv;
  http: PluginHttp;
  customFields: PluginCustomFields;
  messaging: PluginMessaging;
  timeline: PluginTimeline;
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
  /**
   * Public routes asked to draw a checkout or account block: what to
   * draw. Answer `{ body: { html } }`.
   * The platform sanitizes the HTML and caches it until the app's settings,
   * version or a collection the block declares in `reads` change, so the
   * answer must depend only on those and this context: while rendering, the
   * app may read its settings and those collections; `ctx.api`, `ctx.http`,
   * `ctx.kv`, custom fields, messaging and every write are refused. Never
   * per-buyer: there is no customer here. Null on every other request.
   */
  render?: PluginRenderContext | null;
  /**
   * Public routes reached through the storefront proxy (`/apps/<id>/...`):
   * the signed-in customer's id, resolved by the platform from the store's
   * own session (the app never sees a cookie or token). Null for guests, on
   * direct API requests and on every other surface. Use it to key the
   * buyer's own records; read more with `ctx.api` if the app has
   * `customers.view`.
   */
  customer?: { id: string } | null;
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
  /**
   * JSON for API routes; a UI document (`ui.page(...)`) for admin pages,
   * cards and widgets; an action result (`ui.result(...)`) for buttons and
   * forms; `{ html, head? }` for sections and product blocks; `{ page }` or
   * `{ redirect }` for a proxied page navigation.
   */
  body?: unknown;
}
