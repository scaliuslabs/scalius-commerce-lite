// The 30 merchant tasks of the agent release bar (audit AGENT-TOOLING-SPEC
// §4.6). Each one is the tool-call script a careful model would run through
// the MCP server, the tables it may change, and the postconditions checked in
// the database afterwards. `grant` is Operator unless the task cannot run
// there; `knownGap` records, verbatim, why the tool surface cannot finish it
// yet (the harness fails if a gap closes without the list being updated).

import type { DatabaseSync } from "node:sqlite";
import { rowsOf, type ScriptedAgent } from "./agent";
import type { EvalFixtures } from "./seed";
import type { EvalGrant, EvalStore } from "./store";

export interface TaskContext {
  agent: ScriptedAgent;
  fx: EvalFixtures;
  sqlite: DatabaseSync;
  store: EvalStore;
  /** What the script read, for postconditions that compare tool output with database truth. */
  facts: Record<string, unknown>;
}

export interface MerchantTask {
  n: number;
  prompt: (fx: EvalFixtures) => string;
  /** The operation set the task needs (the routing corpus's accept set). */
  ops: string[];
  grant?: EvalGrant;
  /** Why the task needs more than the Operator grant. */
  needs?: string;
  /** Tables the task may change (ambient trigger/audit tables are allowed for every task). */
  writes: string[];
  run(ctx: TaskContext): Promise<void>;
  verify(ctx: TaskContext): string[];
  knownGap?: string;
}

const one = <T = Record<string, unknown>>(sqlite: DatabaseSync, sql: string, ...params: Array<string | number | null>) =>
  sqlite.prepare(sql).get(...params) as T | undefined;
const all = <T = Record<string, unknown>>(sqlite: DatabaseSync, sql: string, ...params: Array<string | number | null>) =>
  sqlite.prepare(sql).all(...params) as T[];

function check(failures: string[], ok: boolean, message: string) {
  if (!ok) failures.push(message);
}

const PRODUCT_DEFAULTS = {
  description: null,
  freeDelivery: false,
  metaTitle: null,
  metaDescription: null,
  productCondition: "new",
  media: [],
} as const;

async function findOrder(ctx: TaskContext, number: string) {
  const data = await ctx.agent.read("dashboard.orders.list", { query: { search: number, limit: 1 } });
  const order = rowsOf(data)[0];
  if (!order) throw new Error(`order ${number} not found by search`);
  return order as { id: string; [key: string]: unknown };
}

async function findProductVariant(ctx: TaskContext, search: string) {
  const data = await ctx.agent.read("dashboard.resources.variants.lookup", { body: { skus: [search] } });
  return rowsOf(data)[0] as { id: string; productId: string; sku: string; [key: string]: unknown } | undefined;
}

function nextWeekday(day: number, hour: number, minute: number): number {
  // Asia/Dhaka is UTC+6 without DST.
  const now = new Date();
  const dhaka = new Date(now.getTime() + 6 * 3_600_000);
  const delta = (day - dhaka.getUTCDay() + 7) % 7 || 7;
  const target = Date.UTC(dhaka.getUTCFullYear(), dhaka.getUTCMonth(), dhaka.getUTCDate() + delta, hour, minute);
  return Math.floor((target - 6 * 3_600_000) / 1000);
}

export const MERCHANT_TASKS: readonly MerchantTask[] = [
  {
    n: 1,
    prompt: () => "How much did we sell today and how many orders are still unfulfilled?",
    ops: ["dashboard.home.activity", "dashboard.orders.list"],
    writes: [],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      const steps = await ctx.agent.readSteps([
        // The 90-day default is cut to the 8 KB budget from the end, which drops today: ask for one day.
        { id: "today", operationId: "dashboard.home.activity", input: { query: { days: 1 } } },
        { id: "open", operationId: "dashboard.orders.list", input: { query: { view: "unfulfilled", limit: 1 } } },
      ]);
      const days = (steps.today?.dailyActivityData ?? []) as Array<{ orders: number; revenue: number }>;
      ctx.facts.todayOrders = days.at(-1)?.orders;
      ctx.facts.lastDays = days.slice(-2);
      ctx.facts.unfulfilled = (steps.open?.pagination as { total?: number } | undefined)?.total;
    },
    verify(ctx) {
      const failures: string[] = [];
      const placed = one<{ n: number }>(ctx.sqlite, "SELECT count(*) AS n FROM orders WHERE deleted_at IS NULL")!.n;
      const open = one<{ n: number }>(ctx.sqlite, "SELECT count(*) AS n FROM orders WHERE deleted_at IS NULL AND fulfillment_status <> 'complete' AND status NOT IN ('cancelled', 'returned', 'refunded')")!.n;
      check(failures, ctx.facts.todayOrders === placed, `today's orders ${String(ctx.facts.todayOrders)} != ${placed} (last days ${JSON.stringify(ctx.facts.lastDays)})`);
      check(failures, ctx.facts.unfulfilled === open, `unfulfilled ${String(ctx.facts.unfulfilled)} != ${open}`);
      return failures;
    },
  },
  {
    n: 2,
    prompt: () => "Which 5 products have the lowest stock?",
    ops: ["dashboard.inventory.list"],
    writes: [],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      const data = await ctx.agent.read("dashboard.inventory.list", { query: { section: "variants", sort: "available", order: "asc", limit: 5 } },
        { select: ["/variants/*/sku", "/variants/*/available", "/variants/*/productName"] });
      ctx.facts.skus = rowsOf(data).map((row) => row.sku);
    },
    verify(ctx) {
      const truth = all<{ sku: string }>(ctx.sqlite, `SELECT sku FROM product_variants WHERE deleted_at IS NULL AND track_inventory = 1
        ORDER BY stock - reserved_stock ASC, sku LIMIT 5`).map((row) => row.sku);
      const got = (ctx.facts.skus as string[] | undefined) ?? [];
      return [...truth].sort().join() === [...got].sort().join() ? [] : [`lowest stock ${got.join()} != ${truth.join()}`];
    },
  },
  {
    n: 3,
    prompt: () => "Is checkout ready to take orders, and what is blocking it?",
    ops: ["dashboard.checkout.readiness_get"],
    grant: "full",
    needs: "checkout.readiness_get needs settings.general.view, which the Operator preset excludes as a sensitive permission.",
    writes: [],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      const data = await ctx.agent.read("dashboard.checkout.readiness_get");
      ctx.facts.status = data.status;
      ctx.facts.issues = rowsOf(data.issues).map((issue) => issue.code);
    },
    verify(ctx) {
      // The seeded store has no delivery zone, so checkout must report a blocker.
      const issues = (ctx.facts.issues as string[] | undefined) ?? [];
      return ctx.facts.status !== "ready" && issues.length > 0 ? [] : [`readiness ${String(ctx.facts.status)} with ${issues.length} issues`];
    },
  },
  {
    n: 4,
    prompt: () => "What is left to set up before launch?",
    ops: ["dashboard.setup.checklist"],
    writes: [],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      const data = await ctx.agent.read("dashboard.setup.checklist");
      ctx.facts.done = data.done;
      ctx.facts.total = data.total;
      ctx.facts.open = rowsOf(data.steps).filter((step) => step.done === false).length;
    },
    verify(ctx) {
      const open = ctx.facts.open as number;
      return typeof ctx.facts.total === "number" && open > 0 && open === (ctx.facts.total as number) - (ctx.facts.done as number)
        ? [] : [`checklist done ${String(ctx.facts.done)}/${String(ctx.facts.total)}, open ${String(open)}`];
    },
  },
  {
    n: 5,
    prompt: () => "Create a simple product \"Cotton Panjabi\", ৳1,500, 20 in stock, publish",
    ops: ["dashboard.products.create"],
    writes: ["products", "product_variants", "inventory_*", "product_*", "search_*", "sku_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const { data } = await ctx.agent.change("dashboard.products.create", {
        body: { ...PRODUCT_DEFAULTS, name: "Cotton Panjabi", price: 1500, categoryId: ctx.fx.categories.panjabi, isActive: true, defaultSku: { sku: "PANJ-COTTON", trackInventory: true, stock: 20 } },
      });
      ctx.facts.productId = data.id;
      await ctx.agent.read("dashboard.products.get_section", { path: { id: String(data.id), section: "base" } });
    },
    verify(ctx) {
      const failures: string[] = [];
      const product = one<{ price_minor: number; is_active: number }>(ctx.sqlite, "SELECT price_minor, is_active FROM products WHERE name = 'Cotton Panjabi' AND deleted_at IS NULL");
      check(failures, product?.price_minor === 150_000 && product.is_active === 1, `product row ${JSON.stringify(product)}`);
      const skus = all<{ stock: number }>(ctx.sqlite, "SELECT v.stock FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.name = 'Cotton Panjabi' AND v.deleted_at IS NULL");
      check(failures, skus.length === 1 && skus[0]!.stock === 20, `skus ${JSON.stringify(skus)}`);
      return failures;
    },
  },
  {
    n: 6,
    prompt: () => "Create a t-shirt in S/M/L × red/blue, ৳800 each, 10 of each",
    ops: ["dashboard.products.create"],
    writes: ["products", "product_variants", "inventory_*", "product_*", "search_*", "sku_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops, "full");
      const sizes = ["S", "M", "L"];
      const colours = ["Red", "Blue"];
      const variants = colours.flatMap((colour) => sizes.map((size) => ({
        id: `draft_${colour}_${size}`.toLowerCase(),
        selectedOptionValueIds: [`draft_size_${size}`.toLowerCase(), `draft_colour_${colour}`.toLowerCase()],
        imageId: null, sku: `TS-${colour.toUpperCase()}-${size}`, price: 800, stock: 10, trackInventory: true,
        weight: null, barcode: null, barcodeType: null, discountType: "percentage", discountPercentage: 0, discountAmount: null,
      })));
      const { data } = await ctx.agent.change("dashboard.products.create", {
        body: {
          ...PRODUCT_DEFAULTS, name: "Classic T-Shirt", price: 800, categoryId: null, isActive: true,
          optionMatrix: {
            options: [
              { id: "draft_option_size", name: "Size", standardMapping: "size", values: sizes.map((size) => ({ id: `draft_size_${size}`.toLowerCase(), value: size })) },
              { id: "draft_option_colour", name: "Colour", standardMapping: "color", values: colours.map((colour) => ({ id: `draft_colour_${colour}`.toLowerCase(), value: colour })) },
            ],
            variants,
          },
        },
      });
      ctx.facts.productId = data.id;
      await ctx.agent.read("dashboard.inventory.list", { query: { section: "variants", search: "TS-", limit: 10 } }, { select: ["/variants/*/sku", "/variants/*/available"] });
    },
    verify(ctx) {
      const rows = all<{ sku: string; stock: number; price_minor: number }>(ctx.sqlite, `SELECT v.sku, v.stock, v.price_minor FROM product_variants v
        JOIN products p ON p.id = v.product_id WHERE p.name = 'Classic T-Shirt' AND v.deleted_at IS NULL ORDER BY v.sku`);
      const ok = rows.length === 6 && rows.every((row) => row.stock === 10 && row.price_minor === 80_000) && rows.some((row) => row.sku === "TS-RED-M");
      return ok ? [] : [`t-shirt skus ${JSON.stringify(rows)}`];
    },
  },
  {
    n: 7,
    prompt: () => "Upload these 3 local photos as the product gallery",
    ops: ["dashboard.media.upload_initiate", "dashboard.media.upload_complete"],
    writes: ["media", "media_*", "product_*", "products"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.media.upload_part"]);
      const photo = new Uint8Array(1024).fill(7);
      const { data } = await ctx.agent.change("dashboard.media.upload_initiate", { body: { filename: "front.jpg", mimeType: "image/jpeg", size: photo.byteLength } });
      const session = data.session as { id: string };
      // The bytes go through the direct-upload client action (the CLI lane), never through MCP JSON.
      const action = await ctx.agent.clientAction("dashboard.media.upload_part", { path: { id: session.id, partNumber: 1 } });
      ctx.facts.clientAction = action;
      await ctx.agent.change("dashboard.media.upload_complete", { path: { id: session.id } });
    },
    verify(ctx) {
      const media = one<{ n: number }>(ctx.sqlite, "SELECT count(*) AS n FROM media")!.n;
      return media >= 3 ? [] : [`media rows ${media} (expected 3 gallery photos)`];
    },
    knownGap: "upload_part is a direct-upload client action: an MCP-only agent receives the PUT instructions but cannot send bytes, and the test D1 store has no media bucket; the gallery needs the CLI lane (scalius media upload).",
  },
  {
    n: 8,
    prompt: () => "Raise every Shoes price by 5% (show me first)",
    ops: ["dashboard.resources.variants.bulk_set_prices"],
    writes: ["bulk_runs", "bulk_run_*", "product_variants", "products", "product_*", "price_*", "search_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const input = { body: { filter: { category: ctx.fx.categories.shoes }, change: { mode: "percent", percent: 5 } } };
      const { data, preview } = await ctx.agent.change("dashboard.resources.variants.bulk_set_prices", input);
      ctx.facts.previewTotal = ((preview.preview as { data?: { run?: { total?: number } } } | undefined)?.data)?.run?.total;
      const run = data.run as { id: string };
      ctx.facts.runId = run.id;
      await ctx.store.drainBulkRuns();
      await ctx.agent.read("dashboard.resources.bulk_runs.get", { path: { id: run.id } });
    },
    verify(ctx) {
      const failures: string[] = [];
      const prices = Object.fromEntries(all<{ sku: string; price_minor: number }>(ctx.sqlite, "SELECT sku, price_minor FROM product_variants WHERE sku IN ('RUNNER', 'LOAFER', 'SANDAL', 'BELT')").map((row) => [row.sku, row.price_minor]));
      check(failures, prices.RUNNER === 210_000 && prices.LOAFER === 315_000 && prices.SANDAL === 126_000, `shoe prices ${JSON.stringify(prices)}`);
      check(failures, prices.BELT === 70_000, "a non-shoe price changed");
      check(failures, ctx.facts.previewTotal === 3, `preview total ${String(ctx.facts.previewTotal)}`);
      return failures;
    },
  },
  {
    n: 9,
    prompt: () => "Change the SEO title and description of Cotton Panjabi",
    ops: ["dashboard.products.update_section"],
    writes: ["products", "product_*", "search_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const list = await ctx.agent.read("dashboard.products.list_summaries", { query: { search: "Cotton Panjabi", limit: 1 } });
      const product = rowsOf(list)[0] as { id: string; aggregateRevision?: number };
      const base = await ctx.agent.read("dashboard.products.get_section", { path: { id: product.id, section: "base" } });
      const revision = Number(base.aggregateRevision ?? product.aggregateRevision);
      await ctx.agent.change("dashboard.products.update_section", {
        path: { id: product.id, section: "base" },
        body: { section: "base", expectedAggregateRevision: revision, patch: { metaTitle: "Cotton Panjabi for Eid | Breathable", metaDescription: "A light cotton panjabi for Eid and summer, tailored in Dhaka." } },
      });
      await ctx.agent.read("dashboard.products.get_section", { path: { id: product.id, section: "base" } }, { select: ["/metaTitle", "/metaDescription", "/aggregateRevision"] });
    },
    verify(ctx) {
      const row = one<{ meta_title: string; meta_description: string }>(ctx.sqlite, "SELECT meta_title, meta_description FROM products WHERE name = 'Cotton Panjabi'");
      return row?.meta_title === "Cotton Panjabi for Eid | Breathable" && row.meta_description?.startsWith("A light cotton") ? [] : [`seo ${JSON.stringify(row)}`];
    },
  },
  {
    n: 10,
    prompt: () => "Move 10 units of TS-RED-M from Dhaka to Chittagong",
    ops: ["dashboard.inventory_transfers.create"],
    writes: ["inventory_*", "product_variants", "product_low_stock_alerts", "search_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.inventory_transfers.ship", "dashboard.inventory_transfers.receive"]);
      const reads = await ctx.agent.readSteps([
        { id: "sku", operationId: "dashboard.resources.variants.lookup", input: { body: { skus: ["TS-RED-M"] } } },
        { id: "locations", operationId: "dashboard.inventory_locations.list" },
      ]);
      const variant = rowsOf(reads.sku)[0] as { id: string };
      const locations = rowsOf(reads.locations) as Array<{ id: string; name: string }>;
      const origin = locations.find((location) => location.name === "Dhaka")!.id;
      const destination = locations.find((location) => location.name === "Chittagong")!.id;
      const steps = [
        { id: "draft", operationId: "dashboard.inventory_transfers.create", input: { body: { originLocationId: origin, destinationLocationId: destination, lines: [{ variantId: variant.id, quantity: 10 }] } } },
        { id: "ship", operationId: "dashboard.inventory_transfers.ship", input: { path: { transferId: { $step: "draft", pointer: "/data/id" } }, body: { expectedRevision: { $step: "draft", pointer: "/data/revision" } } } },
        { id: "receive", operationId: "dashboard.inventory_transfers.receive", input: { path: { transferId: { $step: "draft", pointer: "/data/id" } }, body: { lines: [{ lineId: { $step: "draft", pointer: "/data/lines/0/id" }, quantity: 10 }] } } },
      ];
      await ctx.agent.changeSteps(steps);
      await ctx.agent.read("dashboard.inventory.list", { query: { section: "variants", search: "TS-RED-M", locationId: destination } }, { select: ["/variants/*/sku", "/variants/*/available"] });
    },
    verify(ctx) {
      const transfer = one<{ status: string }>(ctx.sqlite, "SELECT status FROM inventory_transfers ORDER BY created_at DESC LIMIT 1");
      return transfer?.status === "received" ? [] : [`transfer ${JSON.stringify(transfer)}`];
    },
  },
  {
    n: 11,
    prompt: () => "Create collection \"Eid Picks\" with 6 products and add it to the main menu",
    ops: ["dashboard.collections.create", "dashboard.navigation.items_create"],
    writes: ["collections", "collection_*", "navigation_*", "search_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.navigation.menus_publish"]);
      const reads = await ctx.agent.readSteps([
        { id: "products", operationId: "dashboard.products.list_summaries", input: { query: { limit: 6 } } },
        { id: "menus", operationId: "dashboard.navigation.menus_list" },
      ]);
      const productIds = rowsOf(reads.products).slice(0, 6).map((product) => String(product.id));
      const main = rowsOf(reads.menus).find((menu) => menu.handle === "main") as { id: string; revision: number };
      await ctx.agent.changeSteps([
        { id: "picks", operationId: "dashboard.collections.create", input: { body: { name: "Eid Picks", presentation: "grid", isActive: true, config: { source: "manual", productIds } } } },
        { id: "link", operationId: "dashboard.navigation.items_create", input: { path: { menuId: main.id }, body: { label: "Eid Picks", labelMode: "custom", target: { type: "resource", resourceType: "collection", resourceId: { $step: "picks", pointer: "/data/collection/id" } }, expectedRevision: main.revision } } },
        { id: "live", operationId: "dashboard.navigation.menus_publish", input: { path: { menuId: main.id }, body: { expectedRevision: { $step: "link", pointer: "/data/revision" } } } },
      ]);
      await ctx.agent.read("dashboard.navigation.items_list", { path: { menuId: main.id } });
      ctx.facts.menuId = main.id;
    },
    verify(ctx) {
      const failures: string[] = [];
      const collection = one<{ id: string; config: string }>(ctx.sqlite, "SELECT id, config FROM collections WHERE name = 'Eid Picks'");
      check(failures, Boolean(collection), "no Eid Picks collection");
      const ids = collection ? (JSON.parse(collection.config) as { productIds?: string[] }).productIds ?? [] : [];
      check(failures, ids.length === 6, `collection has ${ids.length} products`);
      const item = one(ctx.sqlite, "SELECT 1 FROM navigation_menu_items WHERE menu_id = ? AND label = 'Eid Picks'", String(ctx.facts.menuId ?? ctx.fx.menus.main));
      check(failures, Boolean(item), "main menu has no Eid Picks link");
      return failures;
    },
  },
  {
    n: 12,
    prompt: () => "Create code EID10, 10% off Fri–Sun, ৳2,000 minimum",
    ops: ["dashboard.discounts.create"],
    grant: "full",
    needs: "discounts.create needs discounts.create, which the Operator preset excludes as a sensitive permission.",
    writes: ["promotion*", "discount*", "search_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops, "full");
      const starts = nextWeekday(5, 0, 0);
      const { data } = await ctx.agent.change("dashboard.discounts.create", {
        body: {
          name: "EID10", method: "code", codes: [{ code: "EID10" }],
          effects: [{ target: "order", allocation: "once", kind: "percentage_off", config: { basisPoints: 1000 } }],
          conditions: [{ kind: "minimum_merchandise_subtotal", config: { amountMinor: 200_000, currency: "BDT" } }],
          startsAt: new Date(starts * 1_000).toISOString(), endsAt: new Date((starts + 3 * 86_400 - 1) * 1_000).toISOString(), timeZone: "Asia/Dhaka",
        },
      });
      const discount = (data as { discount: { id: string; revision: number } }).discount;
      await ctx.agent.change("dashboard.discounts.activate", { path: { id: discount.id }, body: { expectedRevision: discount.revision } });
      ctx.facts.discountId = discount.id;
      await ctx.agent.read("dashboard.discounts.get", { path: { id: discount.id } }, { select: ["/discount/status", "/discount/codes", "/discount/startsAt", "/discount/endsAt"] });
    },
    verify(ctx) {
      const code = one(ctx.sqlite, "SELECT 1 FROM promotion_codes WHERE upper(code) = 'EID10'");
      return code ? [] : ["no EID10 code row"];
    },
  },
  {
    n: 13,
    prompt: () => "Approve pending reviews and reply to the 1-star one",
    ops: ["dashboard.reviews.moderate", "dashboard.reviews.reply"],
    grant: "custom",
    needs: "Review moderation is an opt-in grant scope: no preset (Operator or Full) reaches it, only a Custom grant (decision D5).",
    writes: ["product_review*", "products", "product_*", "search_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const pending = rowsOf(await ctx.agent.read("dashboard.reviews.list", { query: { status: "pending" } }, { select: ["/items/*/id", "/items/*/rating"] }));
      await ctx.agent.change("dashboard.reviews.moderate", { body: { ids: pending.map((review) => review.id), action: "publish", requestKey: "eval-approve-pending-0001" } });
      const oneStar = pending.find((review) => review.rating === 1)!;
      const current = await ctx.agent.read("dashboard.reviews.get", { path: { id: String(oneStar.id) } }, { select: ["/version", "/status"] });
      await ctx.agent.change("dashboard.reviews.reply", { path: { id: String(oneStar.id) }, body: { body: "We are sorry about the stitching. We have sent you a replacement.", version: Number(current.version) } });
    },
    verify(ctx) {
      const rows = all<{ id: string; status: string; reply_body: string | null }>(ctx.sqlite, "SELECT id, status, reply_body FROM product_reviews ORDER BY id");
      const ok = rows.every((row) => row.status === "published") && rows.find((row) => row.id === ctx.fx.reviews.oneStar)?.reply_body?.startsWith("We are sorry");
      return ok ? [] : [`reviews ${JSON.stringify(rows)}`];
    },
  },
  {
    n: 14,
    prompt: (fx) => `Fulfil order #${fx.orders.o1042.number} and book it with Pathao`,
    ops: ["dashboard.orders.create_shipment"],
    writes: ["delivery_*", "orders", "order_*", "fulfil*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.delivery_providers.list"]);
      const order = await findOrder(ctx, ctx.fx.orders.o1042.number);
      const providers = rowsOf(await ctx.agent.read("dashboard.delivery_providers.list"));
      const pathao = providers.find((provider) => String(provider.id ?? "").includes("pathao") || String(provider.name ?? "").toLowerCase().includes("pathao"));
      if (!pathao) throw new Error(`no Pathao delivery provider is configured (providers: ${providers.map((provider) => String(provider.id)).join(",") || "none"})`);
      await ctx.agent.change("dashboard.orders.create_shipment", { path: { id: order.id }, body: { providerId: String(pathao.id) } });
    },
    verify(ctx) {
      const shipment = one(ctx.sqlite, "SELECT 1 FROM delivery_shipments WHERE order_id = ?", ctx.fx.orders.o1042.id);
      return shipment ? [] : ["no shipment row"];
    },
    knownGap: "Booking with Pathao needs the Bangladesh pack's Pathao provider connected with real credentials (a security-risk delivery_providers.create the merchant does in the browser); the seeded store has none, so create_shipment cannot be exercised deterministically.",
  },
  {
    n: 15,
    prompt: (fx) => `Refund ৳500 on order #${fx.orders.o1042.number}`,
    ops: ["dashboard.orders.refund"],
    grant: "full",
    needs: "orders.refund is financial risk and the refund permission is excluded from Operator (ceiling write).",
    writes: ["orders", "order_*", "refund_*", "customer*", "notification*", "gift_card*", "store_credit*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const order = await findOrder(ctx, ctx.fx.orders.o1042.number);
      await ctx.agent.change("dashboard.orders.refund", { path: { id: order.id }, body: { amount: 500, reason: "requested_by_customer", manualSettlementConfirmed: true, requestKey: "eval-refund-500-0001" } });
      await ctx.agent.read("dashboard.orders.payments", { path: { id: order.id } });
    },
    verify(ctx) {
      const attempts = one<{ n: number }>(ctx.sqlite, "SELECT count(*) AS n FROM refund_attempts WHERE order_id = ?", ctx.fx.orders.o1042.id)!.n;
      const refunded = one<{ s: number }>(ctx.sqlite, `SELECT coalesce(sum(abs(amount_minor)), 0) AS s FROM order_payments
        WHERE order_id = ? AND id IN (SELECT refund_payment_id FROM refund_attempts WHERE order_id = ?)`, ctx.fx.orders.o1042.id, ctx.fx.orders.o1042.id)!.s;
      return attempts === 1 && refunded === 50_000 ? [] : [`refund attempts ${attempts}, refunded ${refunded}`];
    },
  },
  {
    n: 16,
    prompt: (fx) => `Cancel order #${fx.orders.o1043.number} and put the stock back`,
    ops: ["dashboard.orders.update_status"],
    // The cancellation notice records the push provider's health (settings key push:fcm, category notification_provider_health).
    writes: ["orders", "order_*", "product_variants", "inventory_*", "notification*", "customer*", "search_*", "product_*", "settings"],
    async run(ctx) {
      ctx.facts.reservedBefore = one<{ r: number }>(ctx.sqlite, "SELECT reserved_stock AS r FROM product_variants WHERE sku = 'SANDAL'")!.r;
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const order = await findOrder(ctx, ctx.fx.orders.o1043.number);
      await ctx.agent.change("dashboard.orders.update_status", { path: { id: order.id }, body: { status: "cancelled", reason: "customer_changed_mind" } });
      await ctx.agent.read("dashboard.inventory.list", { query: { section: "variants", search: "SANDAL" } }, { select: ["/variants/*/sku", "/variants/*/reservedStock", "/variants/*/available"] });
    },
    verify(ctx) {
      const order = one<{ status: string }>(ctx.sqlite, "SELECT status FROM orders WHERE id = ?", ctx.fx.orders.o1043.id);
      const reserved = one<{ r: number }>(ctx.sqlite, "SELECT reserved_stock AS r FROM product_variants WHERE sku = 'SANDAL'")!.r;
      return order?.status === "cancelled" && reserved === (ctx.facts.reservedBefore as number) - 3
        ? [] : [`order ${order?.status}, sandal reserved ${reserved} (was ${String(ctx.facts.reservedBefore)})`];
    },
  },
  {
    n: 17,
    prompt: (fx) => `Accept a return of one item on order #${fx.orders.o1040.number}`,
    ops: ["dashboard.orders.return_create", "dashboard.orders.return_receive"],
    writes: ["orders", "order_*", "product_variants", "inventory_*", "notification*", "customer*", "search_*", "product_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.orders.return_approve"]);
      const found = await findOrder(ctx, ctx.fx.orders.o1040.number);
      const order = await ctx.agent.read("dashboard.orders.get", { path: { id: found.id } }, { select: ["/version", "/items/*/id", "/items/*/quantity"] });
      const itemId = String((order.items as Array<{ id: string }> | undefined)?.[0]?.id);
      const { data: created } = await ctx.agent.change("dashboard.orders.return_create", {
        path: { id: found.id }, body: { expectedOrderVersion: Number(order.version), reason: "Wrong size", lines: [{ orderItemId: itemId, quantity: 1 }] },
      });
      const returnedData = await ctx.agent.read("dashboard.orders.return_get", { path: { id: found.id, returnId: String(created.returnId) } });
      const returned = ((returnedData.return ?? returnedData) as { version: number; lines: Array<{ id: string }> });
      const lineId = String(returned.lines[0]!.id);
      await ctx.agent.changeSteps([
        { id: "approve", operationId: "dashboard.orders.return_approve", input: { path: { id: found.id, returnId: String(created.returnId) }, body: { expectedVersion: Number(returned.version), lines: [{ lineId, approvedQuantity: 1, rejectedQuantity: 0 }] } } },
        { id: "receive", operationId: "dashboard.orders.return_receive", input: { path: { id: found.id, returnId: String(created.returnId) }, body: { expectedVersion: { $step: "approve", pointer: "/data/version" }, lines: [{ lineId, receivedQuantity: 1, restockQuantity: 1, damagedQuantity: 0 }] } } },
      ]);
    },
    verify(ctx) {
      const row = one<{ status: string }>(ctx.sqlite, "SELECT status FROM order_returns WHERE order_id = ?", ctx.fx.orders.o1040.id);
      return row && ["received", "completed", "closed"].includes(row.status) ? [] : [`return ${JSON.stringify(row)}`];
    },
  },
  {
    n: 18,
    prompt: () => "Create a COD order for customer Rahim with two panjabis",
    ops: ["dashboard.resources.orders.create"],
    writes: ["orders", "order_*", "admin_order_*", "cod_tracking", "product_variants", "inventory_*", "customer*", "notification*", "search_*", "product_*", "analytics_*"],
    async run(ctx) {
      ctx.facts.ordersBefore = one<{ n: number }>(ctx.sqlite, "SELECT count(*) AS n FROM orders WHERE customer_id = ?", ctx.fx.customers.rahim)!.n;
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const reads = await ctx.agent.readSteps([
        { id: "customer", operationId: "dashboard.customers.list", input: { query: { search: "Rahim", limit: 1 } } },
        { id: "sku", operationId: "dashboard.resources.variants.lookup", input: { body: { skus: ["PANJ-COTTON"] } } },
      ]);
      const customer = rowsOf(reads.customer)[0] as { id: string };
      const variant = rowsOf(reads.sku)[0] as { id: string; productId: string };
      const { data } = await ctx.agent.change("dashboard.resources.orders.create", {
        body: {
          customerId: customer.id, paymentMethod: "cod", shippingMinor: 6000,
          items: [{ productId: variant.productId, variantId: variant.id, quantity: 2 }],
          shippingAddress: { countryCode: "BD", line1: "House 1, Road 2", locality: "Dhaka", placeIds: { city: "city_dhaka", zone: "zone_gulshan" } },
        },
      });
      ctx.facts.orderId = (data.order as { id?: string } | undefined)?.id;
    },
    verify(ctx) {
      const after = one<{ n: number }>(ctx.sqlite, "SELECT count(*) AS n FROM orders WHERE customer_id = ?", ctx.fx.customers.rahim)!.n;
      const order = one<{ payment_method: string; q: number }>(ctx.sqlite, `SELECT o.payment_method, sum(oi.quantity) AS q FROM orders o JOIN order_items oi ON oi.order_id = o.id
        JOIN product_variants v ON v.id = oi.variant_id WHERE o.id = ? AND v.sku = 'PANJ-COTTON' GROUP BY o.id`, String(ctx.facts.orderId ?? ""));
      return after === (ctx.facts.ordersBefore as number) + 1 && order?.payment_method === "cod" && order.q === 2 ? [] : [`order ${JSON.stringify(order)}, Rahim orders ${after}`];
    },
  },
  {
    n: 19,
    prompt: () => "Export last month's orders as CSV",
    ops: ["dashboard.orders.export"],
    writes: ["agent_artifact*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const now = new Date();
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      const data = await ctx.agent.read("dashboard.orders.export", { query: { startDate: first.toISOString().slice(0, 10), endDate: last.toISOString().slice(0, 10) } });
      ctx.facts.artifact = data?.artifact ?? data;
    },
    verify(ctx) {
      const artifact = ctx.facts.artifact as { filename?: string } | undefined;
      return artifact?.filename?.endsWith(".csv") ? [] : [`artifact ${JSON.stringify(artifact)}`];
    },
  },
  {
    n: 20,
    prompt: () => "Tag every customer with more than 3 orders as VIP",
    ops: ["dashboard.resources.customers.bulk_tag"],
    writes: ["bulk_runs", "bulk_run_*", "customer*", "search_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const { data } = await ctx.agent.change("dashboard.resources.customers.bulk_tag", { body: { filter: { minOrders: 4 }, add: ["vip"] } });
      await ctx.store.drainBulkRuns();
      await ctx.agent.read("dashboard.resources.bulk_runs.get", { path: { id: (data.run as { id: string }).id } });
    },
    verify(ctx) {
      const expected = all<{ id: string }>(ctx.sqlite, "SELECT id FROM customers WHERE deleted_at IS NULL AND total_orders > 3 ORDER BY id").map((row) => row.id);
      const tagged = all<{ id: string }>(ctx.sqlite, "SELECT customer_id AS id FROM customer_tag_links WHERE tag = 'vip' ORDER BY customer_id").map((row) => row.id);
      return expected.length > 0 && expected.join() === tagged.join() ? [] : [`vip ${tagged.join()} != ${expected.join()}`];
    },
  },
  {
    n: 21,
    prompt: () => "Enable cash on delivery for Bangladesh only",
    ops: ["dashboard.payments.methods_get", "dashboard.payments.methods_update"],
    grant: "full",
    needs: "payments.methods_get/update need settings.general.view/edit, which the Operator preset excludes as sensitive permissions.",
    writes: ["settings", "store_*", "payment_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const methods = await ctx.agent.read("dashboard.payments.methods_get", {}, { select: ["/enabledMethods", "/defaultMethod", "/revision", "/gateways/*/id", "/gateways/*/countries"] });
      const enabled = new Set([...(methods.enabledMethods as string[] | undefined ?? []), "cod"]);
      await ctx.agent.change("dashboard.payments.methods_update", { body: { enabledMethods: [...enabled], defaultMethod: "cod", expectedRevision: Number(methods.revision) } });
      const after = await ctx.agent.read("dashboard.payments.methods_get", {}, { select: ["/activeMethods", "/gateways/*/id", "/gateways/*/countries"] });
      ctx.facts.after = after;
    },
    verify(ctx) {
      const after = ctx.facts.after as { activeMethods?: unknown[]; gateways?: Array<{ id: string; countries?: string[] }> } | undefined;
      const cod = after?.gateways?.find((gateway) => gateway.id === "cod");
      const active = JSON.stringify(after?.activeMethods ?? []);
      // COD's Bangladesh-only scope is a core declaration (AGENTS.md); methods_get lists only gateways, so it is not shown.
      return active.includes("cod") && (!cod || JSON.stringify(cod.countries) === JSON.stringify(["BD"])) ? [] : [`payments ${JSON.stringify(after)}`];
    },
  },
  {
    n: 22,
    prompt: () => "Delivery ৳60 inside Dhaka, ৳120 outside",
    ops: ["dashboard.shipping_zones.apply_template"],
    writes: ["shipping_*", "delivery_*", "settings"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.shipping_methods.list"]);
      await ctx.agent.change("dashboard.shipping_zones.apply_template", { body: { template: "dhaka_two_zone" } });
      const methods = await ctx.agent.read("dashboard.shipping_methods.list");
      ctx.facts.methods = rowsOf(methods).map((method) => ({ name: method.name, fee: method.fee ?? method.price ?? method.amount }));
    },
    verify(ctx) {
      const fees = JSON.stringify(ctx.facts.methods ?? []);
      return fees.includes("60") && fees.includes("120") ? [] : [`delivery methods ${fees}`];
    },
    knownGap: "apply_template creates the Inside Dhaka and Bangladesh zones, but shipping_methods.list returns names without a fee field, so the agent can neither see nor confirm the ৳60/৳120 rates; setting them needs zone rate ids no read surfaces.",
  },
  {
    n: 23,
    prompt: () => "Charge 5% VAT on Bangladesh orders",
    ops: ["dashboard.taxes.regions_create", "dashboard.taxes.rates_create"],
    grant: "full",
    needs: "taxes.regions_create/rates_create need taxes.manage, which the Operator preset excludes as a sensitive permission.",
    writes: ["tax_*", "settings"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.taxes.classes_list", "dashboard.taxes.classes_create"]);
      const classes = rowsOf(await ctx.agent.read("dashboard.taxes.classes_list", {}, { select: ["/items/*/id", "/items/*/name", "/items/*/isExempt"] }));
      const standard = classes.find((taxClass) => taxClass.isExempt !== true) as { id: string } | undefined;
      // A new store has no tax class: the rate needs one first.
      await ctx.agent.changeSteps([
        ...(standard ? [] : [{ id: "standard", operationId: "dashboard.taxes.classes_create", input: { body: { name: "Standard" } } }]),
        { id: "region", operationId: "dashboard.taxes.regions_create", input: { body: { countryCode: "BD" } } },
        { id: "vat", operationId: "dashboard.taxes.rates_create", input: { body: { taxClassId: standard ? standard.id : { $step: "standard", pointer: "/data/taxClass/id" }, taxRegionId: { $step: "region", pointer: "/data/region/id" }, name: "VAT", rateBps: 500 } } },
      ]);
      await ctx.agent.read("dashboard.taxes.rates_list", {});
    },
    verify(ctx) {
      const rate = one<{ rate_bps: number }>(ctx.sqlite, "SELECT r.rate_bps FROM tax_rates r JOIN tax_regions g ON g.id = r.tax_region_id WHERE g.country_code = 'BD'");
      return rate?.rate_bps === 500 ? [] : [`tax rate ${JSON.stringify(rate)}`];
    },
  },
  {
    n: 24,
    prompt: () => "Connect Meta Pixel + CAPI with a test code and confirm events arrive",
    ops: ["dashboard.meta_conversions.update"],
    grant: "full",
    needs: "meta_conversions.update stores an access token: security risk, above the Operator ceiling.",
    writes: ["settings", "meta_*", "analytics", "system_kv"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.analytics.send_test_event"]);
      const current = await ctx.agent.read("dashboard.meta_conversions.get", {}, { select: ["/revision"] });
      await ctx.agent.change("dashboard.meta_conversions.update", {
        body: { expectedRevision: Number(current.revision), pixelId: "123456789012345", accessToken: "EAAGeval0123456789abcdefTOKEN", testEventCode: "TEST12345", isEnabled: true },
      });
      // "Confirm events arrive" needs the provider's test-event round trip.
      const sent = await ctx.agent.change("dashboard.analytics.send_test_event", { body: { destination: "meta" } });
      ctx.facts.testEvent = sent.data;
      const saved = await ctx.agent.read("dashboard.meta_conversions.get", {}, { select: ["/settings/pixelId", "/settings/isEnabled", "/settings/testEventCode"] });
      ctx.facts.pixelId = (saved.settings as { pixelId?: string } | undefined)?.pixelId;
    },
    verify(ctx) {
      const failures: string[] = [];
      check(failures, ctx.facts.pixelId === "123456789012345", `Meta pixel id reads back as ${String(ctx.facts.pixelId)}`);
      check(failures, Boolean(ctx.facts.testEvent), "no test event confirmation");
      return failures;
    },
  },
  {
    n: 25,
    prompt: () => "Add GA4 with consent mode for EU visitors",
    ops: ["dashboard.analytics.create"],
    writes: ["analytics", "settings", "search_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.analytics.set_active"]);
      const { data } = await ctx.agent.change("dashboard.analytics.create", { body: { name: "GA4", type: "google_analytics", config: "<script async src=\"https://www.googletagmanager.com/gtag/js?id=G-EVAL12345\"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-EVAL12345');</script>", location: "head" } });
      await ctx.agent.change("dashboard.analytics.set_active", { path: { id: String(data.id) }, body: { isActive: true, expectedRevision: Number(data.revision) } });
      await ctx.agent.read("dashboard.analytics.list", {}, { select: ["/items/*/name", "/items/*/isActive"] });
    },
    verify(ctx) {
      const failures: string[] = [];
      const row = one<{ is_active: number }>(ctx.sqlite, "SELECT is_active FROM analytics WHERE name = 'GA4' AND deleted_at IS NULL");
      check(failures, row?.is_active === 1, `GA4 row ${JSON.stringify(row)}`);
      failures.push("no consent-mode setting: GA4 consent defaults for EU visitors are not configurable through any operation");
      return failures;
    },
    knownGap: "No operation configures consent mode: GA4 is added and activated, but consent defaults per region (EEA denied) are not a merchant setting yet (spec S4 / D6 consent banner is not built).",
  },
  {
    n: 26,
    prompt: () => "Invite a staff member who can only manage orders",
    ops: ["dashboard.team.users.invite"],
    grant: "full",
    needs: "team.users.invite and team.roles.create are security risk and team.manage is excluded from Operator.",
    writes: ["user", "account", "user_*", "role*", "permission*", "verification", "notification*", "email_*", "staff_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.team.roles.list", "dashboard.team.roles.create"]);
      const roles = rowsOf(await ctx.agent.read("dashboard.team.roles.list", {}, { select: ["/roles/*/id", "/roles/*/name", "/items/*/id", "/items/*/name"] }));
      let role = roles.find((candidate) => /order/i.test(String(candidate.name))) as { id: string } | undefined;
      if (!role) {
        const { data } = await ctx.agent.change("dashboard.team.roles.create", { body: { name: "order_manager", displayName: "Order manager", description: "Manages orders only", permissions: ["orders.view", "orders.edit"] } });
        role = (data.role ?? data) as { id: string };
      }
      await ctx.agent.change("dashboard.team.users.invite", { body: { name: "Tanvir Hasan", email: "tanvir@eval.test", roleId: role.id } });
    },
    verify(ctx) {
      const invited = one<{ id: string }>(ctx.sqlite, "SELECT id FROM user WHERE email = 'tanvir@eval.test'");
      if (!invited) return ["no invited user"];
      const permissions = all<{ name: string }>(ctx.sqlite, `SELECT p.name FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = ?`, invited.id).map((row) => row.name);
      return permissions.length > 0 && permissions.every((name) => name.startsWith("orders.")) ? [] : [`invited user permissions ${permissions.join()}`];
    },
    knownGap: "team.users.invite answers 500 internal_error on the seeded store (the role is created fine); the invite path depends on auth/email wiring the in-process store does not provide, so the staff invite is unproven.",
  },
  {
    n: 27,
    prompt: () => "Change the homepage hero headline and publish the theme",
    ops: ["dashboard.theme.publish"],
    grant: "full",
    needs: "theme.page_draft_update/publish need settings.theme.edit, which the Operator preset excludes as a sensitive permission.",
    writes: ["settings", "theme_*", "storefront_*", "system_kv"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.theme.page_draft_update"]);
      const workspace = await ctx.agent.read("dashboard.theme.workspace_get", {}, { select: ["/published/revision", "/draft/revision"] });
      const document = await ctx.agent.read("dashboard.theme.document_get", {}, { select: ["/draft/pages/home", "/theme/pages/home", "/pages/home"], maxBytes: 32_768 });
      const home = (findKey(document, "home") ?? []) as Array<{ type?: string; settings?: Record<string, unknown> }>;
      const hero = Array.isArray(home) ? home.find((section) => section.type === "hero") : undefined;
      if (!hero) throw new Error(`no hero section on the home page (document keys: ${Object.keys(document).join(",")})`);
      if (!setHeadline(hero.settings, "Eid collection is here")) throw new Error("hero section has no headline field");
      const published = Number((workspace.published as { revision?: number } | undefined)?.revision ?? 0);
      const draft = Number((workspace.draft as { revision?: number } | undefined)?.revision ?? 0);
      const saved = await ctx.agent.change("dashboard.theme.page_draft_update", { body: { expectedDraftRevision: draft, basePublishedRevision: published, page: "home", value: home } });
      await ctx.agent.change("dashboard.theme.publish", { body: { expectedPublishedRevision: published, expectedDraftRevision: Number(saved.data.revision) } });
      ctx.facts.headline = "Eid collection is here";
    },
    verify(ctx) {
      const published = all<{ v: string }>(ctx.sqlite, "SELECT value AS v FROM settings WHERE value LIKE '%Eid collection is here%'");
      return published.length > 0 ? [] : ["published theme does not carry the new headline"];
    },
    knownGap: "theme.document_get is too large to return inline and comes back as a one-use artifact; editing the hero then needs the artifact fetched outside MCP JSON and the whole home page resent through page_draft_update. No narrow 'set hero headline' operation exists.",
  },
  {
    n: 28,
    prompt: () => "Write and publish an About Us page and link it in the footer",
    ops: ["dashboard.content.create", "dashboard.navigation.items_create"],
    writes: ["pages", "page_*", "navigation_*", "search_*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe([...this.ops, "dashboard.navigation.menus_publish"]);
      const menus = rowsOf(await ctx.agent.read("dashboard.navigation.menus_list", {}, { select: ["/items/*/id", "/items/*/handle", "/items/*/revision"] }));
      const footer = menus.find((menu) => menu.handle === "footer") as { id: string; revision: number };
      await ctx.agent.changeSteps([
        { id: "about", operationId: "dashboard.content.create", input: { body: { title: "About Us", slug: "about-us", content: "<p>We are a family tailoring house in Dhaka, making panjabis since 1998.</p>", metaTitle: "About Us", metaDescription: "Our story: a family tailoring house in Dhaka.", isPublished: true } } },
        { id: "link", operationId: "dashboard.navigation.items_create", input: { path: { menuId: footer.id }, body: { label: "About Us", labelMode: "custom", target: { type: "resource", resourceType: "page", resourceId: { $step: "about", pointer: "/data/page/id" } }, expectedRevision: footer.revision } } },
        { id: "live", operationId: "dashboard.navigation.menus_publish", input: { path: { menuId: footer.id }, body: { expectedRevision: { $step: "link", pointer: "/data/revision" } } } },
      ]);
      await ctx.agent.read("dashboard.navigation.items_list", { path: { menuId: footer.id } }, { select: ["/items/*/label"] });
    },
    verify(ctx) {
      const failures: string[] = [];
      const page = one<{ is_published: number }>(ctx.sqlite, "SELECT is_published FROM pages WHERE title = 'About Us' AND deleted_at IS NULL");
      check(failures, page?.is_published === 1, `page ${JSON.stringify(page)}`);
      check(failures, Boolean(one(ctx.sqlite, "SELECT 1 FROM navigation_menu_items WHERE menu_id = ? AND label = 'About Us'", ctx.fx.menus.footer)), "footer has no About Us link");
      return failures;
    },
  },
  {
    n: 29,
    prompt: () => "Reply to the newest customer message in the inbox",
    ops: ["dashboard.conversations.list", "dashboard.conversations.post"],
    grant: "custom",
    needs: "The inbox is an opt-in grant scope: no preset (Operator or Full) reaches it, only a Custom grant (decision D5).",
    writes: ["conversation*", "notification*", "customer*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const newest = rowsOf(await ctx.agent.read("dashboard.conversations.list", { query: { status: "open" } }, { select: ["/items/0/id", "/items/0/subject", "/items/0/customerName"] }))[0] as { id: string };
      await ctx.agent.change("dashboard.conversations.post", { path: { id: newest.id }, body: { visibility: "public", requestKey: "eval-inbox-reply-0001", body: "Your kurta ships today and should reach Dhaka within 2 days." } });
    },
    verify(ctx) {
      const reply = one(ctx.sqlite, "SELECT 1 FROM conversation_messages WHERE conversation_id = ? AND author_type = 'staff' AND body LIKE 'Your kurta ships today%'", ctx.fx.conversation);
      return reply ? [] : ["no staff reply on the newest thread"];
    },
  },
  {
    n: 30,
    prompt: () => "Issue a ৳1,000 gift card to customer Rahim",
    ops: ["dashboard.gift_cards.create"],
    grant: "full",
    needs: "gift_cards.create is financial risk, above the Operator ceiling (write).",
    writes: ["gift_card*", "customer*", "notification*", "store_credit*"],
    async run(ctx) {
      await ctx.agent.search(this.prompt(ctx.fx), this.ops);
      await ctx.agent.describe(this.ops);
      const customer = rowsOf(await ctx.agent.read("dashboard.customers.list", { query: { search: "Rahim", limit: 1 } }, { select: ["/customers/*/id", "/customers/*/name", "/items/*/id", "/items/*/name"] }))[0] as { id: string };
      await ctx.agent.change("dashboard.gift_cards.create", { body: { requestKey: "eval-gift-rahim-1000", amount: 1000, customerId: customer.id, notify: false } });
      await ctx.agent.read("dashboard.gift_cards.list", {}, { select: ["/items/*/balance", "/items/*/customerId"] });
    },
    verify(ctx) {
      const card = one<{ n: number }>(ctx.sqlite, "SELECT count(*) AS n FROM gift_cards WHERE customer_id = ?", ctx.fx.customers.rahim)!.n;
      return card === 1 ? [] : [`gift cards for Rahim: ${card}`];
    },
  },
];

function findKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (key in (value as Record<string, unknown>)) return (value as Record<string, unknown>)[key];
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findKey(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Sets the first headline-like string in a hero's settings (slides[0].heading, headline, title...). */
function setHeadline(settings: unknown, text: string): boolean {
  if (!settings || typeof settings !== "object") return false;
  for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
    if (/^(headline|heading|title)$/i.test(key) && (typeof value === "string" || value === null || (typeof value === "object" && value !== null))) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const localized = value as Record<string, unknown>;
        const first = Object.keys(localized)[0];
        if (first) { localized[first] = text; return true; }
      }
      (settings as Record<string, unknown>)[key] = text;
      return true;
    }
  }
  for (const value of Object.values(settings as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) if (setHeadline(item, text)) return true;
    } else if (setHeadline(value, text)) return true;
  }
  return false;
}
