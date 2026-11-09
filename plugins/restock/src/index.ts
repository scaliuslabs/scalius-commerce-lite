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
//
// What to reorder needs every rule, every open purchase order and the stock
// of every rule's SKU: more than one run may read on the Free plan, so the
// `check` and `draft` jobs work it out a step at a time (./plan.ts) and the
// page shows the last check with when it ran. A page view reads only what it
// shows: the rules, the active suppliers and one page of open purchase
// orders (at most 27 platform calls, 13 of them API calls, at 1,000 rules and
// 500 suppliers).
import { adminContext, adminLocale, adminNumber, defineManifest, definePlugin, PLUGIN_API_VERSION, ui, type PluginAdminLocale, type PluginContextOf, type PluginRouteRequest, type PluginUiNode } from "@scalius/plugin-sdk";
import {
  allRules, apiRead, OPEN_STATUSES, PLAN_CHUNK, PLAN_JOB_KEY, PLAN_KEY, planChunkKey, planStep, RateLimited, requestKey, rulesVersion, startPlanJob,
  type PlanJobLock, type PlanJobName, type PlanSnapshot, type PurchaseOrder, type ShortLine,
} from "./plan";

export { draftKey, draftOrders, MAX_ORDER_LINES, requestKey, shortfall, STEP_CALLS, unitsOnOrder, type Rule, type ShortLine } from "./plan";

export const APP_ID = "scaliuslabs.restock";

export const manifest = defineManifest({
  id: APP_ID,
  name: "Restock Planner",
  version: "1.1.3",
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
      { name: "plan", methods: ["GET"], description: "Reorder rules, the last check of what to reorder, and open purchase orders." },
      { name: "add_rule", methods: ["POST"], description: "Add or change the reorder rule of a SKU." },
      { name: "remove_rule", methods: ["POST"], description: "Remove a SKU's reorder rule." },
      { name: "find_supplier", methods: ["POST"], description: "Narrow the rule form's suppliers to those whose name matches." },
      { name: "check", methods: ["POST"], description: "Check what is at or below its reorder point, in the background." },
      { name: "draft", methods: ["POST"], description: "Draft purchase orders, per supplier, for what is below its reorder point, in the background." },
      { name: "mark_ordered", methods: ["POST"], description: "Mark a draft purchase order as sent to the supplier." },
      { name: "receive_all", methods: ["POST"], description: "Receive every open unit of a purchase order." },
    ],
    public: [],
    webhooks: [],
  },
  jobs: [
    { name: "check", title: "Check stock" },
    { name: "draft", title: "Draft purchase orders" },
  ],
  admin: {
    pages: [{ id: "plan", title: "Restock planner", route: "plan", placement: "products" }],
  },
  translations: {
    bn: {
      name: "রিস্টক প্ল্যানার",
      tagline: "রি-অর্ডার পয়েন্ট আর সাপ্লায়ার পারচেজ অর্ডার",
      description: "প্রতিটি SKU-র রি-অর্ডার পয়েন্ট আর লক্ষ্য ঠিক করুন, এখন কী রি-অর্ডার করতে হবে দেখুন, আর এক পেজ থেকে সাপ্লায়ারের পারচেজ অর্ডার খসড়া, পাঠানো ও গ্রহণ করুন।",
      pages: { plan: "রিস্টক প্ল্যানার" },
      objects: {
        rules: {
          name: "রি-অর্ডার নিয়ম",
          fields: {
            sku: { name: "SKU" },
            title: { name: "আইটেম" },
            min_on_hand: { name: "যখন রি-অর্ডার করবেন" },
            reorder_to: { name: "যত পর্যন্ত রি-অর্ডার করবেন" },
            unit_cost_minor: { name: "প্রতি এককের খরচ" },
            supplier_id: { name: "সাপ্লায়ার" },
          },
        },
      },
      jobs: { check: "স্টক দেখুন", draft: "পারচেজ অর্ডার খসড়া করুন" },
    },
  },
});

type Context = PluginContextOf<typeof manifest>;

interface Variant { id: string; sku: string; productId: string }
interface Supplier { id: string; name: string; status: string }

/** The active suppliers the rule form offers. */
const MAX_SUPPLIERS = 500;
/** Rows per table page (a table draws at most 100; each open purchase order also draws its own button). */
export const PAGE_SIZE = { now: 50, open: 20, rules: 50 } as const;
/** A select holds 100 options: "No supplier" and 99 suppliers. */
export const SUPPLIER_OPTIONS = 99;

/** The store's active suppliers, every page (50 a call: 10 calls at 500), by name. */
async function activeSuppliers(ctx: Context): Promise<Supplier[]> {
  const suppliers: Supplier[] = [];
  let cursor: string | null = null;
  do {
    const page: { suppliers: Supplier[]; nextCursor: string | null } = await apiRead<{ suppliers: Supplier[]; nextCursor: string | null }>(ctx, "suppliers.list", { query: { status: "active", limit: 50, ...(cursor ? { cursor } : {}) } });
    suppliers.push(...page.suppliers);
    cursor = page.nextCursor;
  } while (cursor && suppliers.length < MAX_SUPPLIERS);
  return suppliers.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
}

/**
 * One page of open purchase orders (drafts, then ordered, then partially
 * received), read from the API a page at a time: one call per status at
 * most. Its cursor (`open:<status>:<the API's cursor>`) says where the next
 * page starts; the API's cursors only go forward, so there is no previous page.
 */
export async function openOrdersPage(ctx: Pick<Context, "api">, cursor: string | null) {
  const match = /^open:([0-2]):(.*)$/s.exec(cursor ?? "");
  let status = match ? Number(match[1]) : 0;
  let after: string | null = match?.[2] || null;
  const rows: PurchaseOrder[] = [];
  for (let reads = 0; rows.length < PAGE_SIZE.open && status < OPEN_STATUSES.length && reads < OPEN_STATUSES.length * 2; reads += 1) {
    const page: { purchaseOrders: PurchaseOrder[]; nextCursor: string | null } = await apiRead<{ purchaseOrders: PurchaseOrder[]; nextCursor: string | null }>(ctx, "purchase_orders.list", {
      query: { status: OPEN_STATUSES[status], limit: PAGE_SIZE.open - rows.length, ...(after ? { cursor: after } : {}) },
    });
    rows.push(...page.purchaseOrders);
    if (page.nextCursor) after = page.nextCursor;
    else [status, after] = [status + 1, null];
  }
  const next = status < OPEN_STATUSES.length ? `open:${status}:${after ?? ""}` : null;
  return { rows, pagination: match || next ? { previous: null, next } : null };
}

/**
 * Where a table page starts. Every table on the page shares the dashboard's
 * one `cursor`, so a cursor names its table (`rules:50`); the other tables
 * show their first page.
 */
function pageWindow(total: number, table: "now" | "rules", cursor: string | null) {
  const size = PAGE_SIZE[table];
  const match = /^([a-z]+):(\d{1,7})$/.exec(cursor ?? "");
  const requested = match && match[1] === table ? Number(match[2]) : 0;
  const last = total === 0 ? 0 : Math.floor((total - 1) / size) * size;
  const offset = Math.min(Math.floor(requested / size) * size, last);
  return {
    offset,
    size,
    pagination: total > size
      ? { previous: offset > 0 ? `${table}:${offset - size}` : null, next: offset + size < total ? `${table}:${offset + size}` : null, total }
      : null,
  };
}

/** One page of a table of rows in hand. */
export function tablePage<T>(rows: readonly T[], table: "now" | "rules", cursor: string | null) {
  const { offset, size, pagination } = pageWindow(rows.length, table, cursor);
  return { rows: rows.slice(offset, offset + size), pagination };
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
    noOpen: "No open purchase orders", add: "Add a rule", save: "Save rule", ruleSaved: "Rule saved for {sku}.", unknownSku: "No SKU has this code.",
    targetBelow: "The target must be above the reorder point.",
    willDraft_one: "Drafting makes 1 purchase order.", willDraft_other: "Drafting makes {n} purchase orders: one per supplier, at most 100 lines each.",
    drafted_one: "Drafted 1 purchase order.", drafted_other: "Drafted {n} purchase orders.",
    draftedPart: "Drafted {n} of {total} purchase orders: {error}",
    nothingToDraft: "Nothing to reorder.", draftBusy: "A check or draft is already running. Refresh in a moment.",
    check: "Check stock", checkAgain: "Check again", checking: "Checking stock", drafting: "Drafting purchase orders",
    checkStarted: "Checking stock. The list fills in when it finishes.", draftStarted: "Drafting purchase orders. The result shows here when it finishes.",
    running: "Rules and purchase orders show here when it finishes.",
    notChecked: "Not checked yet", notCheckedText: "Check stock to see what is at or below its reorder point.",
    checkedNow: "Checked just now.", checkedMinutes_one: "Checked 1 minute ago.", checkedMinutes_other: "Checked {n} minutes ago.",
    checkedHours_one: "Checked 1 hour ago.", checkedHours_other: "Checked {n} hours ago.", checkedDays_one: "Checked 1 day ago.", checkedDays_other: "Checked {n} days ago.",
    rulesChanged: "Rules changed after this check. Check again to include them.",
    checkFailed: "The last check stopped before it finished. Check again.",
    rateLimited: "The store is answering too many requests from this app. Refresh in a minute.",
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
    noOpen: "কোনো খোলা পারচেজ অর্ডার নেই", add: "নিয়ম যোগ করুন", save: "নিয়ম সংরক্ষণ", ruleSaved: "{sku} এর নিয়ম সংরক্ষিত হয়েছে।", unknownSku: "এই কোডের কোনো SKU নেই।",
    targetBelow: "লক্ষ্য রি-অর্ডার পয়েন্টের চেয়ে বেশি হতে হবে।",
    willDraft_one: "খসড়ায় ১টি পারচেজ অর্ডার হবে।", willDraft_other: "খসড়ায় {n}টি পারচেজ অর্ডার হবে: প্রতি সরবরাহকারীর জন্য, প্রতিটিতে সর্বোচ্চ ১০০টি লাইন।",
    drafted_one: "১টি পারচেজ অর্ডারের খসড়া হয়েছে।", drafted_other: "{n}টি পারচেজ অর্ডারের খসড়া হয়েছে।",
    draftedPart: "{total}টির মধ্যে {n}টি পারচেজ অর্ডারের খসড়া হয়েছে: {error}",
    nothingToDraft: "রি-অর্ডার করার কিছু নেই।", draftBusy: "একটি যাচাই বা খসড়া এখন চলছে। একটু পরে রিফ্রেশ করুন।",
    check: "স্টক যাচাই করুন", checkAgain: "আবার যাচাই করুন", checking: "স্টক যাচাই হচ্ছে", drafting: "পারচেজ অর্ডারের খসড়া হচ্ছে",
    checkStarted: "স্টক যাচাই হচ্ছে। শেষ হলে তালিকাটি দেখাবে।", draftStarted: "পারচেজ অর্ডারের খসড়া হচ্ছে। শেষ হলে ফল এখানে দেখাবে।",
    running: "শেষ হলে নিয়ম ও পারচেজ অর্ডার এখানে দেখাবে।",
    notChecked: "এখনও যাচাই করা হয়নি", notCheckedText: "কোনটি রি-অর্ডার পয়েন্টে বা তার নিচে আছে দেখতে স্টক যাচাই করুন।",
    checkedNow: "এইমাত্র যাচাই করা হয়েছে।", checkedMinutes_one: "১ মিনিট আগে যাচাই করা হয়েছে।", checkedMinutes_other: "{n} মিনিট আগে যাচাই করা হয়েছে।",
    checkedHours_one: "১ ঘণ্টা আগে যাচাই করা হয়েছে।", checkedHours_other: "{n} ঘণ্টা আগে যাচাই করা হয়েছে।", checkedDays_one: "১ দিন আগে যাচাই করা হয়েছে।", checkedDays_other: "{n} দিন আগে যাচাই করা হয়েছে।",
    rulesChanged: "এই যাচাইয়ের পরে নিয়ম বদলেছে। সেগুলো ধরতে আবার যাচাই করুন।",
    checkFailed: "শেষ যাচাইটি শেষ হওয়ার আগেই থেমে গেছে। আবার যাচাই করুন।",
    rateLimited: "স্টোর এই অ্যাপের অনেক অনুরোধের উত্তর দিচ্ছে। এক মিনিট পরে রিফ্রেশ করুন।",
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
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : typeof value === "number" ? adminNumber(value, locale) : value;
  });
}

/** The singular or plural form of a counted message. */
const counted = (copy: Copy, key: "willDraft" | "drafted" | "suppliersMatch" | "checkedMinutes" | "checkedHours" | "checkedDays", n: number) => copy[`${key}_${n === 1 ? "one" : "other"}`];

/** When a check ran, in words: just now, minutes, hours or days ago. */
function checkedAgo(locale: PluginAdminLocale, copy: Copy, checkedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 60_000));
  if (minutes < 1) return copy.checkedNow;
  const [key, n] = minutes < 60 ? ["checkedMinutes", minutes] as const : minutes < 24 * 60 ? ["checkedHours", Math.floor(minutes / 60)] as const : ["checkedDays", Math.floor(minutes / (24 * 60))] as const;
  return say(locale, counted(copy, key, n), { n });
}

/** A toast holds at most 120 characters. */
const toastText = (message: string) => (message.length > 120 ? `${message.slice(0, 119)}…` : message);
const optionLabel = (label: string) => (label.length > 120 ? `${label.slice(0, 119)}…` : label);

const toMinor = (value: unknown, decimalPlaces: number) => Math.round(Number(value) * 10 ** decimalPlaces);
const whole = (value: unknown) => (Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null);

const pagination = (page: { pagination: { previous: string | null; next: string | null; total?: number } | null }) => (page.pagination ? { pagination: page.pagination } : {});

/** What the last draft did, as a banner. */
function draftBanner(locale: PluginAdminLocale, copy: Copy, draft: NonNullable<PlanSnapshot["draft"]>): PluginUiNode {
  if (draft.failure) return ui.banner("critical", draft.drafted > 0 ? say(locale, copy.draftedPart, { n: draft.drafted, total: draft.total, error: draft.failure }) : draft.failure);
  if (draft.total === 0) return ui.banner("info", copy.nothingToDraft);
  return ui.banner("success", say(locale, counted(copy, "drafted", draft.drafted), { n: draft.drafted }));
}

async function planPage(request: PluginRouteRequest, ctx: Context) {
  const locale = adminLocale(request);
  const copy = COPY[locale];
  const page = (children: PluginUiNode[]) => ({ body: ui.page(children, { title: copy.title, description: copy.description }) });
  const { cursor } = adminContext(request);
  const search = (request.query.supplier ?? "").trim().slice(0, 100);

  // A check or draft under way: its progress alone (the dashboard reads this again every few seconds), no API reads.
  const lock = await ctx.kv.get<PlanJobLock>(PLAN_JOB_KEY);
  const job = lock ? await ctx.jobs.get(lock.jobId) : null;
  if (lock && job?.status === "running") {
    const max = Math.max(1, job.progress.total);
    return page([ui.card(copy.now, [ui.progress(lock.name === "draft" ? copy.drafting : copy.checking, Math.min(job.progress.done, max), max, { live: true, help: copy.running })])]);
  }

  const plan = await ctx.kv.get<PlanSnapshot>(PLAN_KEY);
  const now = pageWindowFor(plan, cursor);
  const chunk = plan && plan.short > 0 ? (await ctx.kv.get<ShortLine[]>(planChunkKey(Math.floor(now.offset / PLAN_CHUNK)))) ?? [] : [];
  const shortRows = chunk.slice(now.offset % PLAN_CHUNK, now.offset % PLAN_CHUNK + now.size);
  const rules = await allRules(ctx);
  const [suppliers, open] = await Promise.all([activeSuppliers(ctx), openOrdersPage(ctx, cursor)]);
  const names = new Map(suppliers.map((supplier) => [supplier.id, supplier.name]));
  const supplierName = (id: string | null) => (id ? names.get(id) : undefined) ?? copy.noSupplier;
  const money = (amountMinor: number) => ({ amountMinor, currency: ctx.store.currency });

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

  // The last job's outcome: a failed check or draft, or what the last draft did.
  const outcome: PluginUiNode[] = job && lock && job.id === lock.jobId
    ? job.status === "failed"
      ? [ui.banner("critical", copy.checkFailed)]
      : plan?.jobId === job.id && plan.draft ? [draftBanner(locale, copy, plan.draft)] : []
    : [];
  const checked: PluginUiNode[] = plan
    ? [
      ui.text(checkedAgo(locale, copy, plan.checkedAt, Date.now()), { tone: "neutral", size: "sm" }),
      ...(plan.rulesVersion !== (await rulesVersion(rules)) ? [ui.text(copy.rulesChanged, { tone: "warning", size: "sm" })] : []),
      ...(plan.orders > 0 ? [ui.text(say(locale, counted(copy, "willDraft", plan.orders), { n: plan.orders }), { tone: "neutral", size: "sm" })] : []),
    ]
    : [];

  return page([
    ...outcome,
    ui.card(copy.now, [
      ui.table({
        columns: [
          { key: "sku", label: copy.sku },
          { key: "onHand", label: copy.onHand, align: "end" },
          { key: "onOrder", label: copy.onOrder, align: "end" },
          { key: "order", label: copy.order, align: "end" },
          { key: "supplier", label: copy.supplier },
        ],
        rows: shortRows.map((line) => ({ id: line.variantId, cells: { sku: line.sku, onHand: line.onHand, onOrder: line.onOrder, order: line.quantity, supplier: supplierName(line.supplierId) } })),
        ...pagination(now),
        empty: plan ? { title: copy.none } : { title: copy.notChecked, text: copy.notCheckedText },
      }),
      ...checked,
    ], {
      actions: [
        ui.button(plan ? copy.checkAgain : copy.check, ui.route("check"), plan && plan.short > 0 ? {} : { tone: "primary" }),
        ...(plan && plan.short > 0 ? [ui.button(copy.draft, ui.route("draft"), { tone: "primary" })] : []),
      ],
    }),
    ui.card(copy.open, [
      ui.table({
        columns: [{ key: "number", label: copy.number }, { key: "supplier", label: copy.supplier }, { key: "status", label: copy.status }, { key: "units", label: copy.units, align: "end" }],
        rows: open.rows.map((order) => ({
          id: order.id,
          cells: {
            number: `PO-${order.number}`,
            supplier: supplierName(order.supplierId),
            status: { badge: order.status, tone: order.status === "draft" ? "neutral" : "info" },
            units: order.lines.reduce((total, line) => total + Math.max(0, line.quantity - line.receivedQuantity), 0),
          },
        })),
        ...pagination(open),
        empty: { title: copy.noOpen },
      }),
      ...open.rows.map((order) => ui.stack([
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
  ]);
}

/** The Reorder now page of the stored plan the cursor names. */
const pageWindowFor = (plan: PlanSnapshot | null, cursor: string | null) => pageWindow(plan?.short ?? 0, "now", cursor);

/** Starts a check or a draft and lets the page show its progress. */
async function startJob(request: PluginRouteRequest, ctx: Context, name: PlanJobName) {
  const copy = COPY[adminLocale(request)];
  if ((await startPlanJob(ctx, name)) === "busy") return { body: ui.result({ toast: { message: copy.draftBusy, tone: "info" } }) };
  return { body: ui.result({ toast: { message: name === "draft" ? copy.draftStarted : copy.checkStarted, tone: "info" }, refresh: true }) };
}

export default definePlugin({
  manifest,

  routes: {
    admin: {
      plan: async (request, ctx: Context) => {
        try {
          return await planPage(request, ctx);
        } catch (error) {
          if (!(error instanceof RateLimited)) throw error;
          const copy = COPY[adminLocale(request)];
          return { body: ui.page([ui.banner("warning", copy.rateLimited)], { title: copy.title, description: copy.description }) };
        }
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
        return { body: ui.result({ toast: copy.ruleSaved.replace("{sku}", variant.sku), refresh: true }) };
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

      check: (request, ctx: Context) => startJob(request, ctx, "check"),

      // Purchase orders per supplier, at most 100 lines each, keyed by the job and what each creates (`draftKey`).
      draft: (request, ctx: Context) => startJob(request, ctx, "draft"),

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

  jobs: {
    check: (ctx: Context, job) => planStep(ctx, job, false),
    draft: (ctx: Context, job) => planStep(ctx, job, true),
  },
});
