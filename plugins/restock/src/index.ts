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
      { name: "draft", methods: ["POST"], description: "Draft one purchase order per supplier for what is below its reorder point." },
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

/** What to order for each rule below its reorder point: up to its target. */
export function shortfall(rules: ReadonlyArray<{ id: string; data: Rule }>, onHand: ReadonlyMap<string, number>) {
  return rules.flatMap(({ id, data }) => {
    const have = onHand.get(id) ?? 0;
    return have <= data.min_on_hand && data.reorder_to > have ? [{ variantId: id, rule: data, onHand: have, quantity: data.reorder_to - have }] : [];
  });
}

/** A short stable key for an Idempotency-Key: a repeat of the same request is the same key (FNV-1a, hex). */
export function requestKey(prefix: string, parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const character of parts.join("|")) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(16).padStart(8, "0")}`;
}

async function allRules(ctx: Context) {
  const rules: Array<{ id: string; data: Rule }> = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<Context["objects"]["rules"]["query"]>> = await ctx.objects.rules.query({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const record of page.records) rules.push({ id: record.id, data: record.data as Rule });
    cursor = page.nextCursor;
  } while (cursor && rules.length < 1_000);
  return rules;
}

/** The store's active suppliers, every page (50 a page), up to 500. */
async function activeSuppliers(ctx: Context): Promise<Supplier[]> {
  const suppliers: Supplier[] = [];
  let cursor: string | null = null;
  do {
    const page: PluginApiResult<{ suppliers: Supplier[]; nextCursor: string | null }> = await ctx.api.call<{ suppliers: Supplier[]; nextCursor: string | null }>("suppliers.list", { query: { status: "active", limit: 50, ...(cursor ? { cursor } : {}) } });
    if (!page.ok || !page.data) throw new Error(`suppliers.list failed: ${page.error?.code ?? page.status}`);
    suppliers.push(...page.data.suppliers);
    cursor = page.data.nextCursor;
  } while (cursor && suppliers.length < 500);
  return suppliers;
}

async function openPurchaseOrders(ctx: Context): Promise<PurchaseOrder[]> {
  const pages = await Promise.all(["draft", "ordered", "partially_received"].map((status) =>
    ctx.api.call<{ purchaseOrders: PurchaseOrder[] }>("purchase_orders.list", { query: { status, limit: 25 } })));
  return pages.flatMap((page) => {
    if (!page.ok || !page.data) throw new Error(`purchase_orders.list failed: ${page.error?.code ?? page.status}`);
    return page.data.purchaseOrders;
  });
}

const COPY = {
  en: {
    title: "Restock planner", description: "Reorder points per SKU and the purchase orders that fill them.",
    now: "Reorder now", rules: "Reorder rules", open: "Open purchase orders",
    sku: "SKU", onHand: "On hand", order: "To order", supplier: "Supplier", at: "Reorder at", upTo: "Up to", cost: "Unit cost",
    none: "Nothing is below its reorder point.", noRules: "No reorder rules yet", noRulesText: "Add a SKU below with its reorder point and target.",
    draft: "Draft purchase orders", number: "Purchase order", status: "Status", units: "Units open", markOrdered: "Mark ordered", receive: "Receive all",
    noOpen: "No open purchase orders", add: "Add a rule", save: "Save rule", remove: "Remove", unknownSku: "No SKU has this code.",
    targetBelow: "The target must be above the reorder point.", drafted: "Drafted {n} purchase order(s).", nothingToDraft: "Nothing to reorder.",
    sent: "Marked as ordered.", received: "Received into stock.", noSupplier: "No supplier",
  },
  bn: {
    title: "রিস্টক প্ল্যানার", description: "প্রতি SKU-র রি-অর্ডার পয়েন্ট আর যে পারচেজ অর্ডার সেগুলো পূরণ করে।",
    now: "এখন রি-অর্ডার করুন", rules: "রি-অর্ডার নিয়ম", open: "খোলা পারচেজ অর্ডার",
    sku: "SKU", onHand: "হাতে আছে", order: "অর্ডার করতে হবে", supplier: "সরবরাহকারী", at: "রি-অর্ডার পয়েন্ট", upTo: "লক্ষ্য", cost: "একক খরচ",
    none: "কোনো SKU রি-অর্ডার পয়েন্টের নিচে নেই।", noRules: "এখনও কোনো রি-অর্ডার নিয়ম নেই", noRulesText: "নিচে একটি SKU, তার রি-অর্ডার পয়েন্ট ও লক্ষ্য যোগ করুন।",
    draft: "পারচেজ অর্ডারের খসড়া", number: "পারচেজ অর্ডার", status: "অবস্থা", units: "বাকি একক", markOrdered: "অর্ডার করা হয়েছে", receive: "সব গ্রহণ করুন",
    noOpen: "কোনো খোলা পারচেজ অর্ডার নেই", add: "নিয়ম যোগ করুন", save: "নিয়ম সংরক্ষণ", remove: "মুছুন", unknownSku: "এই কোডের কোনো SKU নেই।",
    targetBelow: "লক্ষ্য রি-অর্ডার পয়েন্টের চেয়ে বেশি হতে হবে।", drafted: "{n}টি পারচেজ অর্ডারের খসড়া হয়েছে।", nothingToDraft: "রি-অর্ডার করার কিছু নেই।",
    sent: "অর্ডার করা হয়েছে বলে চিহ্নিত।", received: "স্টকে গ্রহণ করা হয়েছে।", noSupplier: "সরবরাহকারী নেই",
  },
} satisfies Record<PluginAdminLocale, Record<string, string>>;

const toMinor = (value: unknown, decimalPlaces: number) => Math.round(Number(value) * 10 ** decimalPlaces);
const whole = (value: unknown) => (Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null);

export default definePlugin({
  manifest,

  routes: {
    admin: {
      plan: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const rules = await allRules(ctx);
        const [onHand, suppliers, open] = await Promise.all([
          onHandByVariant(ctx, rules.map((rule) => rule.id)),
          activeSuppliers(ctx),
          openPurchaseOrders(ctx),
        ]);
        const supplierName = (id: string | null) => suppliers.find((supplier) => supplier.id === id)?.name ?? copy.noSupplier;
        const short = shortfall(rules, onHand);
        const money = (amountMinor: number) => ({ amountMinor, currency: ctx.store.currency });
        return {
          body: ui.page([
            ui.card(copy.now, [
              ui.table({
                columns: [{ key: "sku", label: copy.sku }, { key: "onHand", label: copy.onHand, align: "end" }, { key: "order", label: copy.order, align: "end" }, { key: "supplier", label: copy.supplier }],
                rows: short.map((line) => ({ id: line.variantId, cells: { sku: line.rule.sku, onHand: line.onHand, order: line.quantity, supplier: supplierName(line.rule.supplier_id) } })),
                empty: { title: copy.none },
              }),
            ], { actions: short.length > 0 ? [ui.button(copy.draft, ui.route("draft"), { tone: "primary" })] : [] }),
            ui.card(copy.open, [
              ui.table({
                columns: [{ key: "number", label: copy.number }, { key: "supplier", label: copy.supplier }, { key: "status", label: copy.status }, { key: "units", label: copy.units, align: "end" }],
                rows: open.map((order) => ({
                  id: order.id,
                  cells: {
                    number: `PO-${order.number}`,
                    supplier: supplierName(order.supplierId),
                    status: { badge: order.status, tone: order.status === "draft" ? "neutral" : "info" },
                    units: order.lines.reduce((total, line) => total + line.quantity - line.receivedQuantity, 0),
                  },
                })),
                empty: { title: copy.noOpen },
              }),
              ...open.map((order) => ui.stack([
                ui.text(`PO-${order.number}`, { emphasis: "strong" }),
                order.status === "draft"
                  ? ui.button(copy.markOrdered, ui.route("mark_ordered", { body: { id: order.id, revision: order.revision } }))
                  : ui.button(copy.receive, ui.route("receive_all", { body: { id: order.id } }), { tone: "primary" }),
              ], { direction: "horizontal" })),
            ]),
            ui.card(copy.rules, [
              ui.table({
                columns: [{ key: "sku", label: copy.sku }, { key: "at", label: copy.at, align: "end" }, { key: "upTo", label: copy.upTo, align: "end" }, { key: "cost", label: copy.cost, align: "end" }, { key: "supplier", label: copy.supplier }],
                rows: rules.map(({ id, data }) => ({ id, cells: { sku: data.sku, at: data.min_on_hand, upTo: data.reorder_to, cost: money(data.unit_cost_minor), supplier: supplierName(data.supplier_id) } })),
                empty: { title: copy.noRules, text: copy.noRulesText },
              }),
              ...(rules.length > 0 ? [ui.stack(rules.slice(0, 20).map(({ id, data }) => ui.button(`${copy.remove} ${data.sku}`, ui.route("remove_rule", { body: { id } }), { tone: "secondary" })), { direction: "horizontal" })] : []),
              ui.form(ui.route("add_rule"), copy.save, [
                ui.textField("sku", copy.sku, { required: true }),
                ui.numberField("min_on_hand", copy.at, { required: true, min: 0 }),
                ui.numberField("reorder_to", copy.upTo, { required: true, min: 1 }),
                ui.numberField("unit_cost", `${copy.cost} (${ctx.store.currency})`, { required: true, min: 0 }),
                ui.select("supplier_id", copy.supplier, [{ value: "none", label: copy.noSupplier }, ...suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name }))]),
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
        const id = (request.body as { id?: unknown } | null)?.id;
        if (typeof id === "string") await ctx.objects.rules.delete(id);
        return { body: ui.result({ refresh: true }) };
      },

      // One draft per supplier, keyed by what it orders: a double click drafts once.
      draft: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const rules = await allRules(ctx);
        const short = shortfall(rules, await onHandByVariant(ctx, rules.map((rule) => rule.id)));
        if (short.length === 0) return { body: ui.result({ toast: { message: copy.nothingToDraft, tone: "info" } }) };
        const bySupplier = new Map<string | null, typeof short>();
        for (const line of short) bySupplier.set(line.rule.supplier_id, [...(bySupplier.get(line.rule.supplier_id) ?? []), line]);
        let drafted = 0;
        for (const [supplierId, lines] of bySupplier) {
          const created = await ctx.api.call("purchase_orders.create", {
            body: {
              supplierId,
              lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, unitCostMinor: line.rule.unit_cost_minor })),
            },
            idempotencyKey: requestKey("restock-draft", [supplierId ?? "none", ...lines.map((line) => `${line.variantId}:${line.quantity}:${line.onHand}`)]),
          });
          if (!created.ok) return { status: created.status, body: ui.result({ toast: { message: created.error?.message ?? "purchase_orders.create failed", tone: "critical" } }) };
          drafted += 1;
        }
        return { body: ui.result({ toast: copy.drafted.replace("{n}", String(drafted)), refresh: true }) };
      },

      mark_ordered: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const { id, revision } = (request.body ?? {}) as { id?: unknown; revision?: unknown };
        if (typeof id !== "string" || typeof revision !== "number") return { status: 422, body: ui.result({ toast: { message: "Missing purchase order.", tone: "critical" } }) };
        const sent = await ctx.api.call("purchase_orders.mark_ordered", { path: { id }, body: { expectedRevision: revision }, idempotencyKey: requestKey("restock-sent", [id, String(revision)]) });
        if (!sent.ok) return { status: sent.status, body: ui.result({ toast: { message: sent.error?.message ?? "purchase_orders.mark_ordered failed", tone: "critical" }, refresh: true }) };
        return { body: ui.result({ toast: copy.sent, refresh: true }) };
      },

      // Receives what is still open; the key is the open quantities, so a repeat receives nothing twice.
      receive_all: async (request, ctx: Context) => {
        const copy = COPY[adminLocale(request)];
        const id = (request.body as { id?: unknown } | null)?.id;
        if (typeof id !== "string") return { status: 422, body: ui.result({ toast: { message: "Missing purchase order.", tone: "critical" } }) };
        const read = await ctx.api.call<{ purchaseOrder: PurchaseOrder }>("purchase_orders.get", { path: { id } });
        if (!read.ok || !read.data) return { status: read.status, body: ui.result({ toast: { message: read.error?.message ?? "purchase_orders.get failed", tone: "critical" } }) };
        const lines = read.data.purchaseOrder.lines
          .filter((line) => line.quantity > line.receivedQuantity)
          .map((line) => ({ lineId: line.id, quantity: line.quantity - line.receivedQuantity }));
        if (lines.length === 0) return { body: ui.result({ refresh: true }) };
        const received = await ctx.api.call("purchase_orders.receive", {
          path: { id },
          body: { lines },
          idempotencyKey: requestKey("restock-receive", [id, ...lines.map((line) => `${line.lineId}:${line.quantity}`)]),
        });
        if (!received.ok) return { status: received.status, body: ui.result({ toast: { message: received.error?.message ?? "purchase_orders.receive failed", tone: "critical" }, refresh: true }) };
        return { body: ui.result({ toast: copy.received, refresh: true }) };
      },
    },
  },
});
