// Restock Planner (`scaliuslabs.restock`): reorder points per SKU, a list of
// what to reorder now, and supplier purchase orders drafted, sent and
// received from one page. An ERP-style app built only on the stable app API:
//
//   variants.lookup        a SKU code to the SKU
//   suppliers.list         who supplies it
//   inventory_levels.list  what is on hand, every location (≤90 SKUs a call)
//   purchase_orders.*      create a draft per supplier, mark it ordered,
//                          receive it (stock moves through the store's own
//                          ledger, once per Idempotency-Key)
//
// The rules are the app's own records (`ctx.objects.rules`, one per SKU). The
// costs a purchase order carries need the Sensitive `read_product_costs`
// scope beside `write_inventory`.
import { adminContext, adminLocale, defineManifest, definePlugin, PLUGIN_API_VERSION, ui, type PluginAdminLocale, type PluginApiResult, type PluginContextOf } from "@scalius/plugin-sdk";

export const APP_ID = "scaliuslabs.restock";

export const manifest = defineManifest({
  id: APP_ID,
  name: "Restock Planner",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Set a reorder point and a target for each SKU, see what to reorder now, and draft, send and receive supplier purchase orders from one page.",
  author: { name: "Scalius Labs" },
  tagline: "Reorder points and supplier purchase orders",
  categories: ["inventory", "operations"],
  scopes: ["write_inventory", "read_product_costs"],
  objects: {
    rules: {
      name: "Reorder rules",
      admin: "read",
      fields: [
        { key: "sku", name: "SKU", type: "single_line_text", required: true },
        { key: "title", name: "Item", type: "single_line_text" },
        { key: "min_on_hand", name: "Reorder at", type: "integer", required: true },
        { key: "reorder_to", name: "Reorder up to", type: "integer", required: true },
        /** Cost per unit, in minor units of the store currency. */
        { key: "unit_cost_minor", name: "Unit cost", type: "integer", required: true },
        { key: "supplier_id", name: "Supplier", type: "single_line_text" },
      ],
      indexes: ["supplier_id"],
    },
  },
  routes: {
    admin: [
      { name: "plan", methods: ["GET"], description: "Reorder rules, what to reorder now and open purchase orders." },
      { name: "add_rule", methods: ["POST"], description: "Add or change the reorder rule of a SKU." },
      { name: "remove_rule", methods: ["POST"], description: "Remove a SKU's reorder rule." },
      { name: "find_supplier", methods: ["POST"], description: "Narrow the rule form's suppliers to those whose name matches." },
      { name: "draft", methods: ["POST"], description: "Draft purchase orders, per supplier, for what is below its reorder point." },
      { name: "mark_ordered", methods: ["POST"], description: "Mark a draft purchase order as sent to the supplier." },
      { name: "receive_all", methods: ["POST"], description: "Receive every open unit of a purchase order." },
    ],
    public: [],
    webhooks: [],
  },
  admin: {
    pages: [{ id: "plan", title: "Restock planner", route: "plan", placement: "products" }],
  },
});

type Context = PluginContextOf<typeof manifest>;


export interface Rule extends Record<string, unknown> {
  sku: string;
  title: string;
  min_on_hand: number;
  reorder_to: number;
  unit_cost_minor: number;
  supplier_id: string | null;
}

interface Variant { id: string; sku: string; productId: string }
interface Level { variantId: string; onHand: number }
interface Supplier { id: string; name: string; status: string }
interface PurchaseOrder {
  id: string;
  number: number;
  status: string;
  supplierId: string | null;
  currency: string;
  revision: number;
  lines: Array<{ id: string; variantId: string; quantity: number; receivedQuantity: number; unitCostMinor: number }>;
}

/** The most SKUs one `inventory_levels.list` call takes. */
const LEVEL_BATCH = 90;
/** The most lines one purchase order takes (`purchase_orders.create`). */
export const MAX_ORDER_LINES = 100;
/** The rules the app reads and the active suppliers it offers. */
const MAX_RULES = 1_000;
const MAX_SUPPLIERS = 500;
/** Open purchase orders read per status: what they still bring in is subtracted from every shortfall. */
const MAX_OPEN_PER_STATUS = 500;
const OPEN_STATUSES = ["draft", "ordered", "partially_received"] as const;
/** Rows per table page (a table draws at most 100; each open purchase order also draws its own button). */
export const PAGE_SIZE = { now: 50, open: 20, rules: 50 } as const;
/** A select holds 100 options: "No supplier" and 99 suppliers. */
export const SUPPLIER_OPTIONS = 99;
/** The last purchase order the app drafted for each supplier (see `draftKey`). */
const LAST_DRAFTS = "last-drafts";
const LAST_DRAFTS_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Held while a draft runs, so two drafts never read the same stock; outlives the longest run. */
const DRAFT_LOCK = "draft-lock";
const DRAFT_LOCK_TTL_SECONDS = 60;

/** On hand per SKU, every location summed: one call per 90 SKUs. */
export async function onHandByVariant(ctx: Pick<Context, "api">, variantIds: readonly string[]): Promise<Map<string, number>> {
  const onHand = new Map<string, number>(variantIds.map((id) => [id, 0]));
  for (let offset = 0; offset < variantIds.length; offset += LEVEL_BATCH) {
    let cursor: string | null = null;
    do {
      const page: PluginApiResult<{ levels: Level[]; nextCursor: string | null }> = await ctx.api.call<{ levels: Level[]; nextCursor: string | null }>("inventory_levels.list", {
        query: { variantIds: variantIds.slice(offset, offset + LEVEL_BATCH).join(","), limit: 100, ...(cursor ? { cursor } : {}) },
      });
      if (!page.ok || !page.data) throw new Error(`inventory_levels.list failed: ${page.error?.code ?? page.status}`);
      for (const level of page.data.levels) onHand.set(level.variantId, (onHand.get(level.variantId) ?? 0) + level.onHand);
      cursor = page.data.nextCursor;
    } while (cursor);
  }
  return onHand;
}

/** Units still to arrive per SKU: what open purchase orders ordered and have not received. */
export function unitsOnOrder(orders: readonly PurchaseOrder[]): Map<string, number> {
  const onOrder = new Map<string, number>();
  for (const order of orders) {
    for (const line of order.lines) {
      const open = line.quantity - line.receivedQuantity;
      if (open > 0) onOrder.set(line.variantId, (onOrder.get(line.variantId) ?? 0) + open);
    }
  }
  return onOrder;
}

/**
 * What to order for each rule whose stock position (on hand plus still on
 * order) is at or below its reorder point: up to its target. Units already
 * on an open purchase order count, so drafting again orders nothing twice.
 */
export function shortfall(rules: ReadonlyArray<{ id: string; data: Rule }>, onHand: ReadonlyMap<string, number>, onOrder: ReadonlyMap<string, number> = new Map()) {
  return rules.flatMap(({ id, data }) => {
    const have = onHand.get(id) ?? 0;
    const incoming = onOrder.get(id) ?? 0;
    const position = have + incoming;
    return position <= data.min_on_hand && data.reorder_to > position
      ? [{ variantId: id, rule: data, onHand: have, onOrder: incoming, quantity: data.reorder_to - position }]
      : [];
  });
}

type Shortfall = ReturnType<typeof shortfall>;

/** The purchase orders a shortfall drafts: one per supplier, split at 100 lines. */
export function draftOrders(short: Shortfall): Array<{ supplierId: string | null; lines: Shortfall }> {
  const bySupplier = new Map<string | null, Shortfall>();
  for (const line of short) bySupplier.set(line.rule.supplier_id, [...(bySupplier.get(line.rule.supplier_id) ?? []), line]);
  return [...bySupplier].flatMap(([supplierId, lines]) => {
    const orders: Array<{ supplierId: string | null; lines: Shortfall }> = [];
    for (let offset = 0; offset < lines.length; offset += MAX_ORDER_LINES) orders.push({ supplierId, lines: lines.slice(offset, offset + MAX_ORDER_LINES) });
    return orders;
  });
}

/** An Idempotency-Key: the same parts are the same key (SHA-256, hex; 8 to 200 characters). */
export async function requestKey(prefix: string, parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return `${prefix}-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A draft's key is what it creates (its supplier and every line's SKU,
 * quantity and unit cost), never a read such as on hand: a repeat of the same
 * draft replays it, and a changed cost is a new draft, not a 422.
 *
 * What it creates alone is not enough: a draft received the same day can
 * leave the same lines short again, and that genuine new draft would replay
 * the first for 24 hours. So the key also holds the last purchase order the
 * app drafted for the supplier (`LAST_DRAFTS`), written only once a create
 * answers. A retry after a lost answer never wrote it, so it is still the
 * same key and replays; a draft after a recorded one is a new key.
 */
export function draftKey(order: { supplierId: string | null; lines: Shortfall }, lastDrafted: string | null): Promise<string> {
  return requestKey("restock-draft", [
    order.supplierId ?? "",
    lastDrafted ?? "",
    ...order.lines.map((line) => `${line.variantId}:${line.quantity}:${line.rule.unit_cost_minor}`),
  ]);
}

const supplierSlot = (supplierId: string | null) => supplierId ?? "none";

async function allRules(ctx: Context) {
  const rules: Array<{ id: string; data: Rule }> = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<Context["objects"]["rules"]["query"]>> = await ctx.objects.rules.query({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const record of page.records) rules.push({ id: record.id, data: record.data as Rule });
    cursor = page.nextCursor;
  } while (cursor && rules.length < MAX_RULES);
  // By SKU, so pages, lines and purchase orders keep one order.
  return rules.sort((left, right) => left.data.sku.localeCompare(right.data.sku, "en", { sensitivity: "base" }) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** The store's active suppliers, every page (50 a page), up to 500, by name. */
async function activeSuppliers(ctx: Context): Promise<Supplier[]> {
  const suppliers: Supplier[] = [];
  let cursor: string | null = null;
  do {
    const page: PluginApiResult<{ suppliers: Supplier[]; nextCursor: string | null }> = await ctx.api.call<{ suppliers: Supplier[]; nextCursor: string | null }>("suppliers.list", { query: { status: "active", limit: 50, ...(cursor ? { cursor } : {}) } });
    if (!page.ok || !page.data) throw new Error(`suppliers.list failed: ${page.error?.code ?? page.status}`);
    suppliers.push(...page.data.suppliers);
    cursor = page.data.nextCursor;
  } while (cursor && suppliers.length < MAX_SUPPLIERS);
  return suppliers.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
}

/** Every draft, ordered and partially received purchase order, every page (50 a page). */
async function openPurchaseOrders(ctx: Context): Promise<PurchaseOrder[]> {
  const byStatus = await Promise.all(OPEN_STATUSES.map(async (status) => {
    const orders: PurchaseOrder[] = [];
    let cursor: string | null = null;
    do {
      const page: PluginApiResult<{ purchaseOrders: PurchaseOrder[]; nextCursor: string | null }> = await ctx.api.call<{ purchaseOrders: PurchaseOrder[]; nextCursor: string | null }>("purchase_orders.list", { query: { status, limit: 50, ...(cursor ? { cursor } : {}) } });
      if (!page.ok || !page.data) throw new Error(`purchase_orders.list failed: ${page.error?.code ?? page.status}`);
      orders.push(...page.data.purchaseOrders);
      cursor = page.data.nextCursor;
    } while (cursor && orders.length < MAX_OPEN_PER_STATUS);
    return orders;
  }));
  return byStatus.flat();
}

/**
 * One page of a table. Every table on the page shares the dashboard's one
 * `cursor`, so a cursor names its table (`rules:50`); the other tables show
 * their first page.
 */
export function tablePage<T>(rows: readonly T[], table: keyof typeof PAGE_SIZE, cursor: string | null) {
  const size = PAGE_SIZE[table];
  const match = /^([a-z]+):(\d{1,7})$/.exec(cursor ?? "");
  const requested = match && match[1] === table ? Number(match[2]) : 0;
  const last = rows.length === 0 ? 0 : Math.floor((rows.length - 1) / size) * size;
  const offset = Math.min(Math.floor(requested / size) * size, last);
  return {
    rows: rows.slice(offset, offset + size),
    pagination: rows.length > size
      ? { previous: offset > 0 ? `${table}:${offset - size}` : null, next: offset + size < rows.length ? `${table}:${offset + size}` : null, total: rows.length }
      : null,
  };
}

/** The suppliers the rule form offers: all of them when they fit, otherwise those matching a search, by name. */
export function supplierChoices(suppliers: readonly Supplier[], search: string) {
  const needle = search.trim().toLocaleLowerCase();
  const matched = needle ? suppliers.filter((supplier) => supplier.name.toLocaleLowerCase().includes(needle)) : suppliers;
  return { shown: matched.slice(0, SUPPLIER_OPTIONS), matched: matched.length };
}

const COPY = {
  en: {
    title: "Restock planner", description: "Reorder points per SKU and the purchase orders that fill them.",
    now: "Reorder now", rules: "Reorder rules", open: "Open purchase orders",
    sku: "SKU", onHand: "On hand", onOrder: "On order", order: "To order", supplier: "Supplier", at: "Reorder at", upTo: "Up to", cost: "Unit cost",
    none: "Nothing is below its reorder point.", noRules: "No reorder rules yet", noRulesText: "Add a SKU below with its reorder point and target.",
    draft: "Draft purchase orders", number: "Purchase order", status: "Status", units: "Units open", markOrdered: "Mark ordered", receive: "Receive all",
    noOpen: "No open purchase orders", add: "Add a rule", save: "Save rule", unknownSku: "No SKU has this code.",
    targetBelow: "The target must be above the reorder point.",
    willDraft_one: "Drafting makes 1 purchase order.", willDraft_other: "Drafting makes {n} purchase orders: one per supplier, at most 100 lines each.",
    drafted_one: "Drafted 1 purchase order.", drafted_other: "Drafted {n} purchase orders.",
    draftedPart: "Drafted {n} of {total} purchase orders: {error}",
    nothingToDraft: "Nothing to reorder.", draftBusy: "Another draft is running. Refresh in a moment.",
    sent: "Marked as ordered.", received: "Received into stock.", noSupplier: "No supplier",
    rule: "Rule", removeRule: "Remove rule", removeTitle: "Remove this reorder rule?", removeText: "The SKU stops appearing in Reorder now. Its stock and purchase orders stay as they are.",
    removed: "Rule removed.", pickRule: "Choose a rule to remove.", missingOrder: "Choose a purchase order.",
    findSupplier: "Find a supplier", supplierName: "Supplier name", search: "Search", showAll: "Show every supplier",
    suppliersFirst: "Showing the first {shown} of {total} suppliers. Search to find another.",
    suppliersMatch_one: "1 supplier matches “{q}”.", suppliersMatch_other: "{n} suppliers match “{q}”.",
    suppliersMatchSome: "Showing {shown} of {n} suppliers matching “{q}”. Type more of the name.",
    suppliersNoMatch: "No supplier matches “{q}”.",
  },
  bn: {
    title: "রিস্টক প্ল্যানার", description: "প্রতি SKU-র রি-অর্ডার পয়েন্ট আর যে পারচেজ অর্ডার সেগুলো পূরণ করে।",
    now: "এখন রি-অর্ডার করুন", rules: "রি-অর্ডার নিয়ম", open: "খোলা পারচেজ অর্ডার",
    sku: "SKU", onHand: "হাতে আছে", onOrder: "অর্ডারে আছে", order: "অর্ডার করতে হবে", supplier: "সরবরাহকারী", at: "রি-অর্ডার পয়েন্ট", upTo: "লক্ষ্য", cost: "একক খরচ",
    none: "কোনো SKU রি-অর্ডার পয়েন্টের নিচে নেই।", noRules: "এখনও কোনো রি-অর্ডার নিয়ম নেই", noRulesText: "নিচে একটি SKU, তার রি-অর্ডার পয়েন্ট ও লক্ষ্য যোগ করুন।",
    draft: "পারচেজ অর্ডারের খসড়া", number: "পারচেজ অর্ডার", status: "অবস্থা", units: "বাকি একক", markOrdered: "অর্ডার করা হয়েছে", receive: "সব গ্রহণ করুন",
    noOpen: "কোনো খোলা পারচেজ অর্ডার নেই", add: "নিয়ম যোগ করুন", save: "নিয়ম সংরক্ষণ", unknownSku: "এই কোডের কোনো SKU নেই।",
    targetBelow: "লক্ষ্য রি-অর্ডার পয়েন্টের চেয়ে বেশি হতে হবে।",
    willDraft_one: "খসড়ায় ১টি পারচেজ অর্ডার হবে।", willDraft_other: "খসড়ায় {n}টি পারচেজ অর্ডার হবে: প্রতি সরবরাহকারীর জন্য, প্রতিটিতে সর্বোচ্চ ১০০টি লাইন।",
    drafted_one: "১টি পারচেজ অর্ডারের খসড়া হয়েছে।", drafted_other: "{n}টি পারচেজ অর্ডারের খসড়া হয়েছে।",
    draftedPart: "{total}টির মধ্যে {n}টি পারচেজ অর্ডারের খসড়া হয়েছে: {error}",
    nothingToDraft: "রি-অর্ডার করার কিছু নেই।", draftBusy: "আরেকটি খসড়া চলছে। একটু পরে রিফ্রেশ করুন।",
    sent: "অর্ডার করা হয়েছে বলে চিহ্নিত।", received: "স্টকে গ্রহণ করা হয়েছে।", noSupplier: "সরবরাহকারী নেই",
    rule: "নিয়ম", removeRule: "নিয়ম মুছুন", removeTitle: "এই রি-অর্ডার নিয়মটি মুছবেন?", removeText: "SKU-টি আর \"এখন রি-অর্ডার করুন\"-এ দেখাবে না। এর স্টক ও পারচেজ অর্ডার যেমন আছে তেমনই থাকবে।",
    removed: "নিয়ম মুছে ফেলা হয়েছে।", pickRule: "মুছতে একটি নিয়ম বেছে নিন।", missingOrder: "একটি পারচেজ অর্ডার বেছে নিন।",
    findSupplier: "সরবরাহকারী খুঁজুন", supplierName: "সরবরাহকারীর নাম", search: "খুঁজুন", showAll: "সব সরবরাহকারী দেখান",
    suppliersFirst: "{total} জন সরবরাহকারীর প্রথম {shown} জন দেখানো হচ্ছে। অন্য কাউকে পেতে খুঁজুন।",
    suppliersMatch_one: "“{q}”-এর সাথে ১ জন সরবরাহকারী মেলে।", suppliersMatch_other: "“{q}”-এর সাথে {n} জন সরবরাহকারী মেলে।",
    suppliersMatchSome: "“{q}”-এর সাথে মেলা {n} জনের মধ্যে {shown} জন দেখানো হচ্ছে। নামের আরও অংশ লিখুন।",
    suppliersNoMatch: "“{q}”-এর সাথে কোনো সরবরাহকারী মেলে না।",
  },
} satisfies Record<PluginAdminLocale, Record<string, string>>;

type Copy = (typeof COPY)[PluginAdminLocale];

/** A message with its `{name}` values filled in, numbers in the dashboard's digits. */
function say(locale: PluginAdminLocale, template: string, values: Record<string, string | number> = {}): string {
  const digits = new Intl.NumberFormat(locale === "bn" ? "bn-BD" : "en-US");
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : typeof value === "number" ? digits.format(value) : value;
  });
}

/** The singular or plural form of a counted message. */
const counted = (copy: Copy, key: "willDraft" | "drafted" | "suppliersMatch", n: number) => copy[`${key}_${n === 1 ? "one" : "other"}`];

/** A toast holds at most 120 characters. */
const toastText = (message: string) => (message.length > 120 ? `${message.slice(0, 119)}…` : message);
const optionLabel = (label: string) => (label.length > 120 ? `${label.slice(0, 119)}…` : label);

const toMinor = (value: unknown, decimalPlaces: number) => Math.round(Number(value) * 10 ** decimalPlaces);
const whole = (value: unknown) => (Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null);
const isKvConflict = (error: unknown) => (error as { code?: unknown } | null)?.code === "kv_conflict" || /kv_conflict/.test(error instanceof Error ? error.message : "");

/** Runs `work` while this installation holds the draft lock; null when another draft holds it. */
async function whileDrafting<T>(ctx: Context, work: () => Promise<T>): Promise<T | null> {
  try {
    await ctx.kv.compareAndSet(DRAFT_LOCK, null, { since: new Date().toISOString() }, { ttlSeconds: DRAFT_LOCK_TTL_SECONDS });
  } catch (error) {
    if (isKvConflict(error)) return null;
    throw error;
  }
  try {
    return await work();
  } finally {
    await ctx.kv.delete(DRAFT_LOCK);
  }
}

const pagination = (page: { pagination: { previous: string | null; next: string | null; total: number } | null }) => (page.pagination ? { pagination: page.pagination } : {});

export default definePlugin({
  manifest,

  routes: {
    admin: {
      plan: async (request, ctx: Context) => {
        const locale = adminLocale(request);
        const copy = COPY[locale];
        const { cursor } = adminContext(request);
        const search = (request.query.supplier ?? "").trim().slice(0, 100);
        const rules = await allRules(ctx);
        const [onHand, suppliers, open] = await Promise.all([
          onHandByVariant(ctx, rules.map((rule) => rule.id)),
          activeSuppliers(ctx),
          openPurchaseOrders(ctx),
        ]);
        const names = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
        const supplierName = (id: string | null) => (id ? names.get(id) : undefined) ?? copy.noSupplier;
        const short = shortfall(rules, onHand, unitsOnOrder(open));
        const orders = draftOrders(short).length;
        const money = (amountMinor: number) => ({ amountMinor, currency: ctx.store.currency });

        const shortPage = tablePage(short, "now", cursor);
        const openPage = tablePage(open, "open", cursor);
        const rulesPage = tablePage(rules, "rules", cursor);
        const choices = supplierChoices(suppliers, search);
        const supplierHelp = search
          ? choices.matched === 0
            ? say(locale, copy.suppliersNoMatch, { q: search })
            : choices.matched > choices.shown.length
              ? say(locale, copy.suppliersMatchSome, { q: search, shown: choices.shown.length, n: choices.matched })
              : say(locale, counted(copy, "suppliersMatch", choices.matched), { q: search, n: choices.matched })
          : suppliers.length > choices.shown.length
            ? say(locale, copy.suppliersFirst, { shown: choices.shown.length, total: suppliers.length })
            : null;

        return {
          body: ui.page([
            ui.card(copy.now, [
              ui.table({
                columns: [
                  { key: "sku", label: copy.sku },
                  { key: "onHand", label: copy.onHand, align: "end" },
                  { key: "onOrder", label: copy.onOrder, align: "end" },
                  { key: "order", label: copy.order, align: "end" },
                  { key: "supplier", label: copy.supplier },
                ],
                rows: shortPage.rows.map((line) => ({ id: line.variantId, cells: { sku: line.rule.sku, onHand: line.onHand, onOrder: line.onOrder, order: line.quantity, supplier: supplierName(line.rule.supplier_id) } })),
                ...pagination(shortPage),
                empty: { title: copy.none },
              }),
              ...(orders > 0 ? [ui.text(say(locale, counted(copy, "willDraft", orders), { n: orders }), { tone: "neutral", size: "sm" })] : []),
            ], { actions: short.length > 0 ? [ui.button(copy.draft, ui.route("draft"), { tone: "primary" })] : [] }),
            ui.card(copy.open, [
              ui.table({
                columns: [{ key: "number", label: copy.number }, { key: "supplier", label: copy.supplier }, { key: "status", label: copy.status }, { key: "units", label: copy.units, align: "end" }],
                rows: openPage.rows.map((order) => ({
                  id: order.id,
                  cells: {
                    number: `PO-${order.number}`,
                    supplier: supplierName(order.supplierId),
                    status: { badge: order.status, tone: order.status === "draft" ? "neutral" : "info" },
                    units: order.lines.reduce((total, line) => total + Math.max(0, line.quantity - line.receivedQuantity), 0),
                  },
                })),
                ...pagination(openPage),
                empty: { title: copy.noOpen },
              }),
              ...openPage.rows.map((order) => ui.stack([
                ui.text(`PO-${order.number}`, { emphasis: "strong" }),
                order.status === "draft"
                  ? ui.button(copy.markOrdered, ui.route("mark_ordered", { body: { id: order.id, revision: order.revision } }))
                  : ui.button(copy.receive, ui.route("receive_all", { body: { id: order.id } }), { tone: "primary" }),
              ], { direction: "horizontal" })),
            ]),
            ui.card(copy.rules, [
              ui.table({
                columns: [{ key: "sku", label: copy.sku }, { key: "at", label: copy.at, align: "end" }, { key: "upTo", label: copy.upTo, align: "end" }, { key: "cost", label: copy.cost, align: "end" }, { key: "supplier", label: copy.supplier }],
                rows: rulesPage.rows.map(({ id, data }) => ({ id, cells: { sku: data.sku, at: data.min_on_hand, upTo: data.reorder_to, cost: money(data.unit_cost_minor), supplier: supplierName(data.supplier_id) } })),
                ...pagination(rulesPage),
                empty: { title: copy.noRules, text: copy.noRulesText },
              }),
              // Removes any rule on the page shown, so paging reaches every rule.
              ...(rulesPage.rows.length > 0
                ? [ui.form(ui.route("remove_rule"), copy.removeRule, [
                  ui.select("rule", copy.rule, rulesPage.rows.map(({ id, data }) => ({ value: id, label: optionLabel(data.sku) })), { required: true, placeholder: copy.pickRule }),
                ], { confirm: { title: copy.removeTitle, text: copy.removeText, confirmLabel: copy.removeRule, destructive: true } })]
                : []),
            ]),
            ui.card(copy.add, [
              ...(suppliers.length > SUPPLIER_OPTIONS || search
                ? [ui.form(ui.route("find_supplier"), copy.search, [
                  ui.textField("q", copy.findSupplier, { value: search, placeholder: copy.supplierName, maxLength: 100 }),
                ]), ...(search ? [ui.link(copy.showAll, ui.to.page("plan"))] : [])]
                : []),
              ui.form(ui.route("add_rule"), copy.save, [
                ui.textField("sku", copy.sku, { required: true }),
                ui.numberField("min_on_hand", copy.at, { required: true, min: 0, integer: true }),
                ui.numberField("reorder_to", copy.upTo, { required: true, min: 1, integer: true }),
                ui.numberField("unit_cost", `${copy.cost} (${ctx.store.currency})`, { required: true, min: 0 }),
                ui.select("supplier_id", copy.supplier, [{ value: "none", label: copy.noSupplier }, ...choices.shown.map((supplier) => ({ value: supplier.id, label: optionLabel(supplier.name) }))], supplierHelp ? { help: supplierHelp } : {}),
              ]),
            ]),
          ], { title: copy.title, description: copy.description }),
        };
      },

      add_rule: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { values } = adminContext(request);
        const sku = typeof values.sku === "string" ? values.sku.trim() : "";
        const min = whole(values.min_on_hand);
        const target = whole(values.reorder_to);
        const costMinor = toMinor(values.unit_cost, ctx.store.decimalPlaces);
        if (min === null || target === null || target <= min) return { status: 422, body: ui.result({ errors: { reorder_to: copy.targetBelow } }) };
        const found = sku ? await ctx.api.call<{ variants: Variant[] }>("variants.lookup", { body: { skus: [sku] } }) : null;
        const variant = found?.data?.variants.find((candidate) => candidate.sku.toLowerCase() === sku.toLowerCase());
        if (!variant) return { status: 422, body: ui.result({ errors: { sku: copy.unknownSku } }) };
        const supplierId = typeof values.supplier_id === "string" && values.supplier_id && values.supplier_id !== "none" ? values.supplier_id : null;
        await ctx.objects.rules.put(variant.id, { sku: variant.sku, title: variant.sku, min_on_hand: min, reorder_to: target, unit_cost_minor: Number.isSafeInteger(costMinor) && costMinor >= 0 ? costMinor : 0, supplier_id: supplierId });
        return { body: ui.result({ toast: copy.save, refresh: true }) };
      },

      remove_rule: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const id = adminContext(request).values.rule;
        if (typeof id !== "string" || !id) return { status: 422, body: ui.result({ errors: { rule: copy.pickRule } }) };
        await ctx.objects.rules.delete(id);
        return { body: ui.result({ toast: copy.removed, refresh: true }) };
      },

      find_supplier: (request) => {
        const search = adminContext(request).values.q;
        const text = typeof search === "string" ? search.trim().slice(0, 100) : "";
        return { body: ui.result({ navigate: ui.to.page("plan", text ? { supplier: text } : undefined) }) };
      },

      // Purchase orders per supplier, at most 100 lines each, keyed by what each creates (`draftKey`).
      draft: async (request, ctx: Context) => {
        const locale = adminLocale(request);
        const copy = COPY[locale];
        const outcome = await whileDrafting(ctx, async () => {
          // Read before the open purchase orders: a draft recorded here has
          // committed, so its purchase order is in the list read after.
          const lastDrafted = (await ctx.kv.get<Record<string, string>>(LAST_DRAFTS)) ?? {};
          const rules = await allRules(ctx);
          const [onHand, open] = await Promise.all([onHandByVariant(ctx, rules.map((rule) => rule.id)), openPurchaseOrders(ctx)]);
          const orders = draftOrders(shortfall(rules, onHand, unitsOnOrder(open)));
          const recorded: Record<string, string> = {};
          let failure: PluginApiResult | null = null;
          let drafted = 0;
          try {
            for (const order of orders) {
              const created = await ctx.api.call<{ purchaseOrder: PurchaseOrder }>("purchase_orders.create", {
                body: {
                  supplierId: order.supplierId,
                  lines: order.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, unitCostMinor: line.rule.unit_cost_minor })),
                },
                idempotencyKey: await draftKey(order, lastDrafted[supplierSlot(order.supplierId)] ?? null),
              });
              if (!created.ok || !created.data) {
                failure = created;
                break;
              }
              recorded[supplierSlot(order.supplierId)] = created.data.purchaseOrder.id;
              drafted += 1;
            }
          } finally {
            if (Object.keys(recorded).length > 0) await ctx.kv.set(LAST_DRAFTS, { ...lastDrafted, ...recorded }, { ttlSeconds: LAST_DRAFTS_TTL_SECONDS });
          }
          return { total: orders.length, drafted, failure };
        });
        if (!outcome) return { body: ui.result({ toast: { message: copy.draftBusy, tone: "info" } }) };
        const { total, drafted, failure } = outcome;
        if (failure) {
          const error = failure.error?.message ?? "purchase_orders.create failed";
          return { status: failure.status, body: ui.result({ toast: { message: toastText(drafted > 0 ? say(locale, copy.draftedPart, { n: drafted, total, error }) : error), tone: "critical" }, refresh: drafted > 0 }) };
        }
        if (total === 0) return { body: ui.result({ toast: { message: copy.nothingToDraft, tone: "info" }, refresh: true }) };
        return { body: ui.result({ toast: say(locale, counted(copy, "drafted", drafted), { n: drafted }), refresh: true }) };
      },

      mark_ordered: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { id, revision } = (request.body ?? {}) as { id?: unknown; revision?: unknown };
        if (typeof id !== "string" || typeof revision !== "number") return { status: 422, body: ui.result({ toast: { message: copy.missingOrder, tone: "critical" } }) };
        // The purchase order at the revision read: a repeat replays, a later revision is a new request.
        const sent = await ctx.api.call("purchase_orders.mark_ordered", { path: { id }, body: { expectedRevision: revision }, idempotencyKey: await requestKey("restock-sent", [id, String(revision)]) });
        if (!sent.ok) return { status: sent.status, body: ui.result({ toast: { message: toastText(sent.error?.message ?? "purchase_orders.mark_ordered failed"), tone: "critical" }, refresh: true }) };
        return { body: ui.result({ toast: copy.sent, refresh: true }) };
      },

      // Receives what is still open. The key is each open line's open and
      // received units: a repeat receives nothing twice, and a line that has
      // changed since (more received, a new quantity) is a new receipt.
      receive_all: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const id = (request.body as { id?: unknown } | null)?.id;
        if (typeof id !== "string") return { status: 422, body: ui.result({ toast: { message: copy.missingOrder, tone: "critical" } }) };
        const read = await ctx.api.call<{ purchaseOrder: PurchaseOrder }>("purchase_orders.get", { path: { id } });
        if (!read.ok || !read.data) return { status: read.status, body: ui.result({ toast: { message: toastText(read.error?.message ?? "purchase_orders.get failed"), tone: "critical" } }) };
        const open = read.data.purchaseOrder.lines.filter((line) => line.quantity > line.receivedQuantity);
        if (open.length === 0) return { body: ui.result({ refresh: true }) };
        const received = await ctx.api.call("purchase_orders.receive", {
          path: { id },
          body: { lines: open.map((line) => ({ lineId: line.id, quantity: line.quantity - line.receivedQuantity })) },
          idempotencyKey: await requestKey("restock-receive", [id, ...open.map((line) => `${line.id}:${line.quantity - line.receivedQuantity}:${line.receivedQuantity}`)]),
        });
        if (!received.ok) return { status: received.status, body: ui.result({ toast: { message: toastText(received.error?.message ?? "purchase_orders.receive failed"), tone: "critical" }, refresh: true }) };
        return { body: ui.result({ toast: copy.received, refresh: true }) };
      },
    },
  },
});
