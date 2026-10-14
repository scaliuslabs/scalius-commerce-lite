// The files `pnpm plugin create` writes: a small plugin that touches the
// surfaces most apps need (an event, a checkout function, a storefront
// section, an admin page and a data update), with a test for each. Copy the
// patterns in packages/plugin-sdk/README.md for the rest (settings, storage, cron, webhooks).

export function scaffoldFiles(id, name) {
  const title = name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const vendor = id.split(".")[0];
  return {
    "package.json": `${JSON.stringify({
      name: `@scalius/plugin-${name}`,
      version: "0.1.0",
      private: true,
      type: "module",
      license: "AGPL-3.0-only",
      exports: { ".": "./src/index.ts" },
      scripts: { test: "vitest run", typecheck: "../../node_modules/typescript7/bin/tsc --build" },
      dependencies: { "@scalius/plugin-sdk": "workspace:*" },
      devDependencies: { "@scalius/tsconfig": "workspace:*", vitest: "^5.0.3" },
    }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({
      extends: "@scalius/tsconfig/base.json",
      compilerOptions: {
        types: [],
        lib: ["ES2022", "DOM"],
        paths: { "@scalius/shared/*": ["../../packages/shared/src/*"] },
        noEmit: true,
        tsBuildInfoFile: `../../node_modules/.cache/tsbuild/plugin-${name}.tsbuildinfo`,
      },
      include: ["src/**/*"],
      references: [{ path: "../../packages/shared" }, { path: "../../packages/plugin-sdk" }],
    }, null, 2)}\n`,
    "src/index.ts": `import {
  definePlugin,
  PLUGIN_API_VERSION,
  ui,
  type PluginManifestInput,
} from "@scalius/plugin-sdk";

// The manifest declares everything the app does. The platform refuses a
// handler that is not declared here, and shows the merchant what the app
// asks for before they turn it on. \`pnpm plugin validate\` checks this file.
export const manifest = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(title)},
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Describe what ${title} does for the merchant.",
  author: { name: ${JSON.stringify(vendor)} },
  tagline: "One line that sells ${title}",
  categories: ["marketing"],
  scopes: ["read_orders"],
  events: ["order.created"],
  functions: [{ point: "checkout.discounts", priority: 100 }],
  routes: {
    admin: [{ name: "overview", methods: ["GET"], description: "The app's page in the dashboard." }],
    public: [{ name: "banner", methods: ["GET"], description: "Draws the banner section." }],
    webhooks: [],
  },
  // Runs once after an install or an update, in order. Add new versions at
  // the end; never change or remove one that has shipped.
  migrations: [{ version: 1, description: "Write the install note" }],
  admin: {
    pages: [{ id: "overview", title: ${JSON.stringify(title)}, route: "overview" }],
  },
  storefront: {
    sections: [{
      type: "banner",
      name: "Banner",
      description: "A short message for the store.",
      route: "banner",
      settings: [
        { key: "heading", label: "Heading", type: "text", default: "Hello from ${title}", maxLength: 120 },
        { key: "text", label: "Text", type: "textarea", default: "", maxLength: 500 },
      ],
    }],
  },
} satisfies PluginManifestInput;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => \`&#\${character.charCodeAt(0)};\`);
}

export default definePlugin({
  manifest,

  events: {
    // Delivery is at least once: keep a handler safe to run twice for the same event.
    "order.created": async (event, ctx) => {
      await ctx.kv.set("last_order", event.resource.id);
      ctx.log.info("Order created", { orderId: event.resource.id });
    },
  },

  functions: {
    // Pure: it gets the cart and the app's settings, and returns what to apply.
    "checkout.discounts": () => ({ discounts: [] }),
  },

  routes: {
    admin: {
      overview: async (_request, ctx) => ({
        body: ui.page([
          ui.card("At a glance", [
            ui.keyValue([
              { label: "Latest order", value: (await ctx.kv.get<string>("last_order")) ?? "None yet" },
              { label: "Install note", value: (await ctx.kv.get<string>("install_note")) ?? "Not written" },
            ]),
          ]),
        ], { title: ${JSON.stringify(title)}, description: "What this app did for the store." }),
      }),
    },
    public: {
      // Storefront output: drawn from the section's settings alone, sanitized
      // and cached by the platform until they change.
      banner: (request) => {
        const settings = request.render?.settings ?? {};
        const heading = String(settings.heading ?? "").trim();
        const text = String(settings.text ?? "").trim();
        if (!heading && !text) return { body: { html: "" } };
        return {
          body: {
            html: \`<div class="mx-auto max-w-7xl px-3 py-6 text-center sm:px-6">\${heading ? \`<h2 class="text-xl font-bold">\${escapeHtml(heading)}</h2>\` : ""}\${text ? \`<p class="mt-2 text-muted-foreground">\${escapeHtml(text)}</p>\` : ""}</div>\`,
          },
        };
      },
    },
  },

  migrations: {
    // Idempotent: it may run again after a crash, so it keeps what is there.
    "1": async (ctx) => {
      if ((await ctx.kv.get("install_note")) === null) await ctx.kv.set("install_note", "Installed");
    },
  },
});
`,
    "src/index.test.ts": `// Unit tests with the SDK's test harness: the platform's own runtime over an
// in-memory bridge. Run them with \`pnpm test\`.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures, parsePluginUiDocument } from "@scalius/plugin-sdk/testing";
import plugin from "./index";

describe(${JSON.stringify(id)}, () => {
  it("remembers the latest order", async () => {
    const harness = createPluginTestHarness(plugin);
    const result = await harness.deliver(fixtures.event("order.created", { resource: { type: "order", id: "o1" } }));
    expect(result.ok).toBe(true);
    expect(harness.kv.get("last_order")).toBe("o1");
  });

  it("offers no discounts at checkout", async () => {
    const harness = createPluginTestHarness(plugin);
    const result = await harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput());
    expect(result.value).toEqual({ discounts: [] });
  });

  it("writes its install note once, however often the migration runs", async () => {
    const harness = createPluginTestHarness(plugin);
    expect((await harness.runMigrations()).ok).toBe(true);
    harness.kv.set("install_note", "Changed by the merchant");
    expect((await harness.runMigrations()).ok).toBe(true);
    expect(harness.kv.get("install_note")).toBe("Changed by the merchant");
  });

  it("draws the banner from its settings and escapes them", async () => {
    const harness = createPluginTestHarness(plugin);
    const result = await harness.render("section", "banner", { settings: { heading: "Sale <now>", text: "" } });
    expect(result.value).toEqual({ body: { html: expect.stringContaining("Sale &#60;now&#62;") } });
    expect(JSON.stringify(result.value)).not.toContain("<now>");
  });

  it("answers its admin page with a valid UI document", async () => {
    const harness = createPluginTestHarness(plugin);
    await harness.runMigrations();
    const result = await harness.route("admin", "overview", fixtures.adminRouteRequest());
    const page = parsePluginUiDocument((result.value as { body: unknown }).body);
    expect(page.ok).toBe(true);
    expect(JSON.stringify(page)).toContain("Installed");
  });
});
`,
  };
}
