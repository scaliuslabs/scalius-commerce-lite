// The context every plugin handler receives (packages/plugin-sdk/docs/apps.md). It is
// the whole surface a plugin can reach: each call crosses the host bridge,
// which checks the plugin's granted manifest before doing anything. The same
// context is built for a sandboxed plugin (Dynamic Worker, Workers Paid) and a
// bundled one (in-process, Workers Free). Part of the versioned plugin API.

import type { EventTopic, EventsApiVersion } from "@scalius/shared/events";
import type { PluginSettingValue } from "@scalius/shared/plugins";
import type { PluginCustomerRole, PluginCustomerRoleGrant } from "@scalius/shared/plugins/customer-roles";
import type { PluginJob } from "@scalius/shared/plugins/jobs";

export type { PluginCustomerRole, PluginCustomerRoleGrant } from "@scalius/shared/plugins/customer-roles";
export type { PluginJob, PluginJobStatus, PluginJobStepInput, PluginJobStepResult } from "@scalius/shared/plugins/jobs";

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
  /**
   * The Idempotency-Key header (8 to 200 printable characters): every stable
   * mutation takes it, and a repeat within 24 hours returns the first result.
   * Required only where the operation's `idempotency` is `required` (stock moves).
   */
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
   * Calls a stable app-API operation by its app name, the resource and the
   * verb (`orders.get`, `products.create`; `stableContract.operations` in
   * `@scalius/plugin-sdk/testing` lists them). A dashboard operation id
   * (`dashboard.resources.orders.get`) is unknown here. Any other
   * operation refuses with `api_operation_not_stable`, and one the approved
   * scopes do not cover with `api_operation_forbidden`. Buyer contact
   * fields (`x-scalius-protected` in the contract) read null unless the app
   * holds the matching `read_customer_*` scope.
   */
  call<T = unknown>(operation: string, input?: PluginApiCallInput): Promise<PluginApiResult<T>>;
}

/**
 * Money in an object field or custom field, as every app boundary carries it
 * (the API, webhooks, functions, ports): integer minor units of `currency`,
 * the store currency (`ctx.store.currency`). `{ amountMinor: 125000, currency:
 * "BDT" }` is 1,250 taka. Writes take exactly this shape; a list field holds
 * an array of them.
 */
export interface PluginMoney {
  amountMinor: number;
  currency: string;
}

export interface PluginObjectQuery {
  /** Equality on declared index fields; a money field matches a `PluginMoney` (or its `amountMinor`). */
  where?: Record<string, string | number | boolean | null | PluginMoney>;
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string | null;
}

/** A record with the revision its last write gave it. */
export interface PluginRecordVersion<T extends Record<string, unknown> = Record<string, unknown>> {
  data: T;
  revision: number;
  handle: string | null;
  status: "active" | "draft" | "published";
}

/**
 * The revision a write requires: the one you read (the record is unchanged
 * since), or null (the record must not exist). A write that finds anything
 * else changes nothing and fails with `object_conflict`.
 */
export interface PluginWriteCondition {
  expectedRevision?: number | null;
}

/**
 * One app object. Every write advances the record's revision; pass the
 * revision you read to write only if nobody wrote since (compare-and-set).
 */
export interface PluginObjectCollection<T extends Record<string, unknown> = Record<string, unknown>> {
  get(id: string): Promise<T | null>;
  getByHandle(handle: string): Promise<(PluginRecordVersion<T> & { id: string }) | null>;
  /** The record and its revision, for a conditional write. */
  getVersion(id: string): Promise<PluginRecordVersion<T> | null>;
  put(id: string, record: T, options?: PluginWriteCondition & { handle?: string | null; status?: "active" | "draft" | "published" }): Promise<{ revision: number }>;
  /**
   * Merges top-level fields into an existing record (`object_not_found`
   * otherwise). Without `expectedRevision` a concurrent write is re-read and
   * merged again, so no update is lost.
   */
  update(id: string, patch: Partial<T>, options?: { expectedRevision?: number }): Promise<PluginRecordVersion<T>>;
  /**
   * Adds `delta` to a whole-number field (absent: 0; a missing record is
   * created), atomically. A money field is not a whole number: `update` it
   * with the new `PluginMoney`. A result outside `min`/`max` changes nothing and
   * fails with `object_out_of_range`: a balance never goes below its floor,
   * however many debits race.
   */
  increment(id: string, field: string, delta: number, options?: { min?: number; max?: number }): Promise<{ value: number; revision: number }>;
  delete(id: string, options?: PluginWriteCondition): Promise<boolean>;
  query(query?: PluginObjectQuery): Promise<{ records: Array<PluginRecordVersion<T> & { id: string }>; nextCursor: string | null }>;
  count(where?: PluginObjectQuery["where"]): Promise<number>;
}

/** One write of an atomic `ctx.objects.batch`; `check` writes nothing and only adds its condition. */
export type PluginObjectOperation =
  | { op: "put"; object: string; id: string; record: Record<string, unknown>; expectedRevision?: number | null; handle?: string | null; status?: "active" | "draft" | "published" }
  | { op: "delete"; object: string; id: string; expectedRevision?: number | null }
  | { op: "check"; object: string; id: string; expectedRevision: number | null };

/**
 * The app's declared objects by name (`ctx.objects.points`), and
 * `batch`: up to 25 puts, deletes and checks across objects, written
 * all-or-nothing in one database batch. Any failed condition aborts it with
 * `object_conflict` (`error.details.index` is not exposed; re-read and retry).
 */
export type PluginObjects = Record<string, PluginObjectCollection> & {
  batch(operations: PluginObjectOperation[]): Promise<{ revisions: Array<number | null> }>;
};

export interface PluginKv {
  get<T = unknown>(key: string): Promise<T | null>;
  /** The live entry and its revision, for `compareAndSet`. */
  getVersion<T = unknown>(key: string): Promise<{ value: T; revision: number } | null>;
  set(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<{ revision: number }>;
  /**
   * Sets the entry only while it is still at `expectedRevision` (null: no
   * live entry); otherwise nothing changes and it fails with `kv_conflict`.
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

/**
 * The app's own custom fields (its namespace, declared in `customFields`).
 * The merchant's fields (`custom` namespace) are `ctx.api.call`
 * operations (`custom_fields.get_<owner>_values`, `set_<owner>_values`),
 * which never show an app another app's fields.
 */
export interface PluginCustomFields {
  /** Values of this plugin's own fields on one resource, typed per field (money as `PluginMoney`). */
  get(ownerType: string, ownerId: string): Promise<Record<string, unknown>>;
  set(ownerType: string, ownerId: string, values: Record<string, unknown>): Promise<void>;
}

export interface PluginMessaging {
  /**
   * Sends through the store's configured providers, from the store's sender. Pass one of:
   * - `customerId` (needs `read_customers`): the platform resolves the address and never returns it;
   * - `to`: a staff member's email, or an address held in a `messaging.recipients` field of
   *   your own records, exactly as the record holds it; any other address needs the sensitive
   *   `send_messages_any` scope (`messaging_recipient_not_allowed` otherwise).
   * `marketing: true` (with `customerId`) sends only when the customer is subscribed on that
   * channel now (`queued: false` otherwise); e-mail then carries the store's unsubscribe
   * footer and RFC 8058 List-Unsubscribe headers. Transactional mail leaves it unset.
   * Limits: `PLUGIN_MESSAGE_LIMITS` per message, `messagesPerMinute` of the store's plan.
   */
  email(input: {
    customerId?: string;
    to?: string;
    subject: string;
    html: string;
    text?: string;
    marketing?: boolean;
    /**
     * Sends at most once per key (8 to 200 printable characters) within 24
     * hours: a repeat, e.g. a redelivered event's handler, answers
     * `duplicate: true` and sends nothing. A failed send releases the key.
     * Derive it from what the message is about (`seller-notice-${splitId}`).
     */
    idempotencyKey?: string;
  }): Promise<{ queued: boolean; duplicate?: boolean }>;
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

/**
 * Typed lines on order timelines (needs `orders.edit`; each kind declared in
 * `manifest.admin.timeline`): the one way an app writes on a timeline. Staff
 * notes (`orders.comment_add`) are the dashboard's, not the app API's.
 */
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

/**
 * Actions on a placed order, for event handlers (a reaction after commit,
 * never a checkout decision): an `order.created` handler that finds the
 * order risky holds it for review. `hold` and `assessRisk` need the
 * write_orders scope, `riskHistory` read_orders. Each is idempotent per
 * order and app, so a redelivered event changes nothing.
 */
export interface PluginOrders {
  /**
   * Puts the order on hold for staff review: it is not shipped, handed over
   * or moved on until staff release it (cancelling stays possible). One hold
   * per order and app; a hold staff released is not placed again. Nothing is
   * ever cancelled automatically. `reason` (plain text, 500 characters) is
   * shown to staff: never put buyer contact data in it. Gift cards and
   * downloads of an order paid at checkout wait for the `order.created`
   * delivery of every app granted `write_orders` (at most 10 minutes after
   * the order was placed), so hold from that handler.
   */
  hold(input: { orderId: string; reason: string }): Promise<void>;
  /**
   * Advice staff see on the order's customer card: a level and up to five
   * reasons (200 characters each). One per order and app: the first stands.
   */
  assessRisk(input: { orderId: string; level: "low" | "medium" | "high"; reasons: string[] }): Promise<void>;
  /** The buyer's earlier orders, counts only: the same customer record or account, incomplete payments left out. */
  riskHistory(orderId: string): Promise<{ orders: number; cancelled: number; returnedToSender: number }>;
}

/**
 * Roles the app gives customers (needs `read_customers`): a name the app
 * chooses (`seller`, `wholesale`: a lower-case letter, then up to 31
 * lower-case letters, digits, `_` or `-`) and an optional `ref`, the app's
 * own record id (`seller_42`). Each app reads and writes only its own roles,
 * at most 10 per customer. The app's proxied pages see them as
 * `request.customer.roles` and its checkout functions as
 * `cart.customer.roles`, so a page or price rule gates on a role without a
 * read of its own. Never put buyer contact data in a role or ref.
 */
export interface PluginCustomerRoles {
  /**
   * Gives the customer the role; granting it again only updates `ref`.
   * Refuses a missing or deleted customer (`customers_not_found`) and an
   * 11th role (`customer_roles_limit`).
   */
  grant(customerId: string, role: string, options?: { ref?: string | null }): Promise<void>;
  /** Takes the role away; a role the customer does not hold is not an error. */
  revoke(customerId: string, role: string): Promise<void>;
  /** The app's roles on the customer, by role (`grantedAt` ISO 8601). */
  list(customerId: string): Promise<PluginCustomerRoleGrant[]>;
}

export interface PluginCustomers {
  roles: PluginCustomerRoles;
}

/**
 * Background jobs (manifest `jobs`): a long admin action, such as an import
 * of hundreds of products, that one run cannot finish within its platform
 * calls and wall time. `start` keeps the job and returns at once; the
 * platform then runs the job's handler (`jobs[name]`) one step at a time,
 * right after the request and every minute after, each step a run of its
 * own with its own limits. A step gets `{ id, name, input, state, step }` and
 * answers `{ state?, progress?, message?, done? }`: `state` (64 KiB of JSON)
 * goes to the next step, `done: true` finishes. A step that throws, times
 * out or answers something invalid is tried again a minute later, three
 * times in all, then the job fails (`job_step_failed`, `job_invalid_step`).
 * A step may repeat after a crash (never more than that step), so make each
 * one safe to run again: pass an idempotency key derived from the job id and
 * step to writes. Show progress with `ui.progress(..., { live: true })`.
 */
export interface PluginJobs {
  /**
   * Starts a declared job with `input` (16 KiB of JSON). With `key` (8 to
   * 200 printable characters) a second start under it answers the first
   * job instead of starting another. At most the plan's running jobs per app
   * (3 on Workers Free): another start is refused with `jobs_limit`.
   */
  start(name: string, options?: { input?: unknown; key?: string }): Promise<{ id: string; status: PluginJob["status"] }>;
  /** One of the app's jobs, or null. */
  get(id: string): Promise<PluginJob | null>;
  /** The app's jobs (of one job with `name`), newest first, at most 20. */
  list(options?: { name?: string; limit?: number }): Promise<PluginJob[]>;
  /** Stops a running job: it fails with `cancelled` (a step in flight does not commit). */
  cancel(id: string): Promise<PluginJob>;
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
  /** The installation's settings; secrets are present only here, decrypted. A feature's settings are present only while it is on. */
  settings: Readonly<Record<string, PluginSettingValue>>;
  /**
   * The app's features that are on (`manifest.features`). An off feature's
   * providers, routes, jobs and settings do not exist; use this to leave its
   * parts out of shared screens (`ctx.features.includes("pathao")`).
   */
  features: readonly string[];
  api: PluginApi;
  objects: PluginObjects;
  kv: PluginKv;
  http: PluginHttp;
  customFields: PluginCustomFields;
  messaging: PluginMessaging;
  timeline: PluginTimeline;
  orders: PluginOrders;
  customers: PluginCustomers;
  jobs: PluginJobs;
  log: PluginLogger;
}

/**
 * What an event handler receives (the webhook delivery body, minus `data`:
 * read the resource's current state with `ctx.api`).
 *
 * Delivery is at least once. The same event can arrive again (a retry after
 * your handler threw or timed out, a lost acknowledgement), so make handlers
 * idempotent: `id` is stable across every attempt, use it as your
 * idempotency key (store it, or pass it as `idempotencyKey` to
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
   * Public routes reached through the storefront proxy (`/apps/<id>/...`):
   * the signed-in customer's id, resolved by the platform from the store's
   * own session (the app never sees a cookie or token). Null for guests, on
   * direct API requests and on every other surface. Use it to key the
   * buyer's own records; read more with `ctx.api` if the app has
   * `customers.view`.
   *
   * Forms: a signed-in buyer's form post (`POST`, `PUT`, `PATCH`, `DELETE`
   * as a form, multipart or text body) reaches the handler only with the
   * platform's form token verified. The storefront adds the token to every
   * `<form method="post">` on your proxy, so plain HTML forms work without
   * JavaScript and need nothing from you; the field is removed from `body`.
   * JSON requests need no token (a cross-site page cannot send them).
   *
   * `roles`: the roles this app gave the customer (`ctx.customers.roles`),
   * by role, read with the session. Gate a seller portal on
   * `request.customer?.roles.some((entry) => entry.role === "seller")`.
   */
  customer?: { id: string; roles: PluginCustomerRole[] } | null;
  /**
   * Public routes: the store's own pages to link and redirect to (never
   * hard-code `/account`). Root paths: on a market presence page the
   * platform keeps every link, form action and redirect inside the presence.
   * Null on admin and webhook routes.
   */
  routes?: PluginStorefrontRoutes | null;
}

/** The store's core pages (`request.routes`). */
export interface PluginStorefrontRoutes {
  readonly home: string;
  readonly search: string;
  readonly cart: string;
  /** The buyer's account. */
  readonly account: string;
  /** Where a guest signs in. */
  readonly signIn: string;
  /** The buyer's order history. */
  readonly orders: string;
  /** Guest order lookup. */
  readonly trackOrder: string;
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
   * forms; `{ html, head? }` for sections and product-slot components; `{ page }` or
   * `{ redirect }` for a proxied page navigation.
   */
  body?: unknown;
}
