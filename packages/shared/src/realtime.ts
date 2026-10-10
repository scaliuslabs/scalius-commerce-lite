/**
 * The realtime hub's wire contract (docs/platform/REALTIME.md), shared by the
 * API Worker's hub (apps/api/src/realtime) and the dashboard client
 * (apps/admin-v2/src/lib/realtime). Notices carry ids, kinds, states and
 * revisions only: never PII, message text or money (COMMERCE-HOOKS H3).
 */

/** The topics a staff socket can hear. Each one is granted by a permission (below). */
export const REALTIME_TOPICS = [
  "orders",
  "payments",
  "returns",
  "inbox",
  "reviews",
  "products",
  "inventory",
  "customers",
  "categories",
  "collections",
  "pages",
  "settings",
] as const;
export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

/** The view permission behind each topic. `settings` is granted by any `settings.*` permission. */
const TOPIC_PERMISSION: Readonly<Record<Exclude<RealtimeTopic, "settings">, string>> = {
  orders: "orders.view",
  payments: "orders.view",
  returns: "orders.view",
  inbox: "conversations.view",
  reviews: "reviews.view",
  products: "products.view",
  inventory: "inventory.view",
  customers: "customers.view",
  categories: "categories.view",
  collections: "collections.view",
  pages: "pages.view",
};

/** The topics a staff member's permissions allow, in catalog order. */
export function realtimeTopicsFor(permissions: ReadonlySet<string> | readonly string[]): RealtimeTopic[] {
  const granted = permissions instanceof Set ? permissions : new Set(permissions);
  return REALTIME_TOPICS.filter((topic) => {
    if (topic === "settings") {
      for (const permission of granted) if (permission.startsWith("settings.")) return true;
      return false;
    }
    return granted.has(TOPIC_PERMISSION[topic]);
  });
}

export function isRealtimeTopic(value: unknown): value is RealtimeTopic {
  return typeof value === "string" && (REALTIME_TOPICS as readonly string[]).includes(value);
}

/**
 * The editors that show presence and save notices, by key prefix, and the
 * topic a socket needs to join one. A key is `<prefix>:<id>`.
 */
export const PRESENCE_KEY_TOPICS = {
  order: "orders",
  product: "products",
  category: "categories",
  collection: "collections",
  page: "pages",
  theme: "settings",
  settings: "settings",
} as const satisfies Record<string, RealtimeTopic>;
export type PresenceKeyPrefix = keyof typeof PRESENCE_KEY_TOPICS;

const PRESENCE_KEY = /^(order|product|category|collection|page|theme|settings):[A-Za-z0-9_.-]{1,80}$/;
/** Editors one socket may watch at once (a page with a few settings cards). */
export const MAX_WATCHED_KEYS = 12;

/**
 * Lists that show who has a record open ("Rahim is viewing" on an order row):
 * a socket watching the list `order` hears the presence of every `order:<id>`
 * key without joining it. The prefix's topic is required, as for a key.
 */
export const PRESENCE_LIST_PREFIXES = ["order", "product"] as const satisfies readonly PresenceKeyPrefix[];
export type PresenceListPrefix = (typeof PRESENCE_LIST_PREFIXES)[number];

export function isPresenceListPrefix(value: unknown): value is PresenceListPrefix {
  return typeof value === "string" && (PRESENCE_LIST_PREFIXES as readonly string[]).includes(value);
}

/**
 * A field's key inside an editor: the control's form name (`price`,
 * `seo.title`, `variants.0.sku`), never its value. Generated element ids
 * (`:r1:`, `radix-:r2:`) do not match, so a key names the same field in
 * every browser.
 */
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
/** Field keys one save notice may name. */
export const MAX_SAVED_FIELDS = 20;
/** Focus messages the hub accepts from one socket per second; more are dropped. */
export const MAX_FOCUS_PER_SECOND = 8;

export function isFieldKey(value: unknown): value is string {
  return typeof value === "string" && FIELD_KEY.test(value);
}

export function presenceKey(prefix: PresenceKeyPrefix, id: string): string {
  return `${prefix}:${id}`;
}

/** The topic a presence key needs, or null for a malformed key. */
export function presenceKeyTopic(key: unknown): RealtimeTopic | null {
  const prefix = presenceKeyPrefix(key);
  return prefix === null ? null : PRESENCE_KEY_TOPICS[prefix];
}

/** The prefix of a well-formed presence key (`order` of `order:ord_1`), or null. */
export function presenceKeyPrefix(key: unknown): PresenceKeyPrefix | null {
  if (typeof key !== "string" || !PRESENCE_KEY.test(key)) return null;
  return key.slice(0, key.indexOf(":")) as PresenceKeyPrefix;
}

/** One change: what changed, never its content. `id` and `rev` only when the source knows them. */
export interface RealtimeChange {
  topic: RealtimeTopic;
  /** An event topic (`order.created`) or `changed` for a table-level notice. */
  kind: string;
  id?: string;
  rev?: number;
  /** A state such as an order status, for "N new orders" and status badges. */
  status?: string;
}

/** A staff member as other staff see them in presence: id and display name only. */
export interface RealtimePerson {
  id: string;
  name: string;
}

/**
 * A person on a presence key. `editing` when they have unsaved changes there
 * or a field focused; `field` is the key of the field they are in. Both are
 * left out for someone who is only viewing.
 */
export interface RealtimePresence extends RealtimePerson {
  editing?: true;
  field?: string;
}

/** Server → client. */
export type RealtimeServerMessage =
  | { t: "hello"; userId: string; topics: RealtimeTopic[] }
  | { t: "changes"; items: RealtimeChange[] }
  | { t: "presence"; key: string; people: RealtimePresence[] }
  | { t: "saved"; key: string; by: RealtimePerson; rev: number | null; fields?: string[] };

/**
 * Client → server. Plain `ping` is answered by the hub's auto-response without waking it.
 * - `watch`: the editors this socket has open (`keys`) and the lists that show presence (`lists`).
 * - `saved`: this editor saved `key`; `fields` names the fields it changed (keys, never values).
 * - `focus`: the field this editor is in on `key` (null for none) and whether it has unsaved changes.
 */
export type RealtimeClientMessage =
  | { t: "watch"; keys: string[]; lists?: PresenceListPrefix[] }
  | { t: "saved"; key: string; rev: number | null; fields?: string[] }
  | { t: "focus"; key: string; field: string | null; editing: boolean };

export const REALTIME_PING = "ping";
export const REALTIME_PONG = "pong";

/** The store's one hub (`idFromName`): the deployment is one store. */
export const REALTIME_HUB_NAME = "store";

/** Close codes the client acts on: reconnect (and authenticate again) now. */
export const REALTIME_CLOSE_REAUTH = 4001;
