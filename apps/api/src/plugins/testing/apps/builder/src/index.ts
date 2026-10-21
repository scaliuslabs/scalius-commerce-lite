// Store builder (`acme.builder`): a theme app's one-click store setup, on the
// stable app API only (app operation names through `ctx.api.call`), the way a
// demo-content pack or a theme's onboarding works:
//
// - the dashboard's Set up button starts the `setup` background job
//   (`ctx.jobs.start`, idempotent by key) and the page shows its live
//   progress (`ui.progress`);
// - step 1 batch-creates the categories and the brand (`categories.batch_create`,
//   `brands.batch_create`, per-item keys so a retried step creates nothing twice);
// - step 2 reads their ids back by repeating the same item keys (each item
//   replays, nothing is created twice), then creates the collection with its
//   handle (`collections.create`) and the products in minor units
//   (`products.batch_create`);
// - step 3 applies the app's template, whose sections name the categories and
//   the collection by handle (`theme.get`, `theme.apply_template`), and points
//   a section at another category by handle (`theme.section_settings_set`);
// - step 4 creates and publishes the footer menu, a category linked by handle
//   (`menus.create`), and gives the store owner's customer the app's
//   `founder` role (`ctx.customers.roles`), which the app's page reads back.

import { definePlugin, PLUGIN_API_VERSION, ui, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.builder",
  name: "Store builder",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Sets up a launch-ready store: catalogue, home page layout and footer menu in one click.",
  author: { name: "Acme" },
  scopes: ["write_products", "write_themes", "write_navigation", "read_customers"],
  routes: {
    admin: [{ name: "setup", methods: ["GET", "POST"], description: "Start the store setup and watch it." }],
  },
  jobs: [{ name: "setup", title: "Set up the store" }],
  storefront: {
    sections: [
      { type: "note", name: "Launch note", description: "A short line of text.", settings: [{ key: "text", label: "Text", type: "text", default: "Now open", maxLength: 80 }] },
    ],
    templates: [{
      id: "launch",
      name: "Launch",
      description: "Category tiles, the hot deals and a laptops rail.",
      themeVersion: 12,
      theme: {
        sections: [
          { id: "tiles", type: "category_tiles", version: 1, settings: { style: "round", title: "Shop by category", categoryIds: ["@category:laptops", "@category:phones"] } },
          { id: "deals", type: "product_rail", version: 1, settings: { title: "Hot deals", source: { kind: "collection", handle: "hot-deals" }, limit: 8 } },
          { id: "laptops", type: "product_rail", version: 1, settings: { title: "Laptops", source: { kind: "category", handle: "laptops" }, limit: 8 } },
        ],
      },
    }],
  },
} satisfies PluginManifestInput;

/** The setup's steps; progress reads `step of SETUP_STEPS`. */
export const SETUP_STEPS = 4;

type SetupInput = { customerId?: string };

async function call<T = Record<string, unknown>>(ctx: PluginContext, name: string, input: Parameters<PluginContext["api"]["call"]>[1]): Promise<T> {
  const result = await ctx.api.call(name, input);
  if (!result.ok) throw new Error(`${name}: ${result.error?.code ?? result.status} ${result.error?.message ?? ""}`.trim());
  return result.data as T;
}

type Ref = { id: string; slug: string; revision: number };
type Batch<N extends string> = { items: Array<{ key: string; outcome: string } & Record<N, Ref | null>> };

const steps: Array<(ctx: PluginContext, input: SetupInput, jobId: string) => Promise<string>> = [
  async (ctx) => {
    await call(ctx, "categories.batch_create", {
      body: { items: [
        { key: "laptops", name: "Laptops", slug: "laptops", status: "published" },
        { key: "phones", name: "Phones", slug: "phones", status: "published" },
      ] },
    });
    await call(ctx, "brands.batch_create", { body: { items: [{ key: "volt", name: "Volt", slug: "volt", status: "published" }] } });
    return "Categories and brand ready";
  },
  async (ctx, _input, jobId) => {
    const categories = await call<Batch<"category">>(ctx, "categories.batch_create", {
      body: { items: [
        { key: "laptops", name: "Laptops", slug: "laptops", status: "published" },
        { key: "phones", name: "Phones", slug: "phones", status: "published" },
      ] },
    });
    const brands = await call<Batch<"brand">>(ctx, "brands.batch_create", { body: { items: [{ key: "volt", name: "Volt", slug: "volt", status: "published" }] } });
    const laptops = categories.items.find((item) => item.key === "laptops")?.category?.id ?? null;
    await call(ctx, "collections.create", {
      body: { name: "Hot deals", slug: "hot-deals", presentation: "grid", isActive: false, config: { source: "manual" } },
      idempotencyKey: `builder-collection-${jobId}`,
    });
    await call(ctx, "products.batch_create", {
      body: { items: ["Volt Book 14", "Volt Book 16"].map((name, index) => ({
        key: `book-${index}`,
        name,
        condition: "new",
        categoryId: laptops,
        brandId: brands.items[0]?.brand?.id ?? null,
        variants: [{ sku: `VOLT-BOOK-${index}`, priceMinor: 9_900_000 + index * 1_000_000 }],
      })) },
    });
    return "Collection and products ready";
  },
  async (ctx) => {
    const { theme } = await call<{ theme: { draft: { revision: number; basePublishedRevision: number } } }>(ctx, "theme.get", {});
    const applied = await call<{ draft: { revision: number; basePublishedRevision: number } }>(ctx, "theme.apply_template", {
      body: { template: "launch", expectedDraftRevision: theme.draft.revision, basePublishedRevision: theme.draft.basePublishedRevision },
    });
    await call(ctx, "theme.section_settings_set", {
      body: {
        sectionId: "laptops",
        settings: { title: "Phones", source: { kind: "category", handle: "phones" } },
        expectedDraftRevision: applied.draft.revision,
        basePublishedRevision: applied.draft.basePublishedRevision,
      },
    });
    return "Home page drafted";
  },
  async (ctx, input) => {
    await call(ctx, "menus.create", {
      body: {
        name: "Footer shop",
        handle: "footer-shop",
        publish: true,
        items: [
          { key: "shop", label: "Shop", target: { type: "label" } },
          { key: "laptops", parentKey: "shop", label: "Laptops", target: { type: "resource", resourceType: "category", handle: "laptops" } },
          { key: "about", label: "About us", target: { type: "internal_path", path: "/about" } },
        ],
      },
      idempotencyKey: "builder-footer-menu",
    });
    if (input.customerId) await ctx.customers.roles.grant(input.customerId, "founder", { ref: "builder" });
    return "Footer menu published";
  },
];

export default definePlugin({
  manifest,
  routes: {
    admin: {
      setup: async (request, ctx) => {
        if (request.method === "POST") {
          const body = (request.body ?? {}) as { customerId?: unknown };
          const job = await ctx.jobs.start("setup", {
            key: "builder-setup-1",
            input: typeof body.customerId === "string" ? { customerId: body.customerId } : {},
          });
          return { body: { job, ...ui.result({ toast: "Setup started", refresh: true }) } };
        }
        const [job] = await ctx.jobs.list({ name: "setup", limit: 1 });
        const customerId = typeof request.query.customer === "string" ? request.query.customer : null;
        const roles = customerId ? await ctx.customers.roles.list(customerId) : [];
        return {
          body: ui.page([
            job
              ? ui.progress("Setting up your store", job.progress.done, Math.max(1, job.progress.total), { live: job.status === "running", ...(job.message ? { help: job.message } : {}) })
              : ui.empty("Not set up yet"),
            ...(roles.length > 0 ? [ui.text(`Roles: ${roles.map((entry) => entry.role).join(", ")}`)] : []),
          ], { title: "Store builder" }),
        };
      },
    },
  },
  jobs: {
    setup: async (ctx, job) => {
      const step = ((job.state ?? {}) as { step?: number }).step ?? 0;
      const message = await steps[step]!(ctx, (job.input ?? {}) as SetupInput, job.id);
      const done = step + 1;
      return { state: { step: done }, progress: { done, total: SETUP_STEPS }, message, done: done >= SETUP_STEPS };
    },
  },
});
