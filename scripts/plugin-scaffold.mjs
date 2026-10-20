// The files `pnpm plugin create` writes: a small plugin that touches the
// surfaces most apps need (an event, a checkout function, a storefront
// section, an admin page and an object migration), with a test for each. Copy the
// patterns in packages/plugin-sdk/README.md for the rest (settings, storage, cron, webhooks).

/**
 * `standalone` scaffolds an app that lives anywhere (its own repository):
 * it depends on the published `@scalius/plugin-sdk@^<sdkVersion>` and has
 * a self-contained tsconfig, no workspace protocol and no repo-relative path.
 * Without it the app is a package of this workspace (`plugins/<name>`).
 */
export function scaffoldFiles(id, name, { standalone = false, sdkVersion = "0.1.0" } = {}) {
  const title = name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const vendor = id.split(".")[0];
  const project = standalone
    ? {
      "package.json": `${JSON.stringify({
        name: `${vendor}-${name}`,
        version: "0.1.0",
        private: true,
        type: "module",
        license: "UNLICENSED",
        exports: { ".": "./src/index.ts" },
        scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
        dependencies: { "@scalius/plugin-sdk": `^${sdkVersion}` },
        devDependencies: { typescript: "^6.0.3", vitest: "^5.0.4" },
      }, null, 2)}\n`,
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM"],
          types: [],
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          isolatedModules: true,
          verbatimModuleSyntax: true,
          jsx: "react-jsx",
          jsxImportSource: "@scalius/plugin-sdk/storefront",
          noEmit: true,
        },
        include: ["src/**/*"],
      }, null, 2)}\n`,
      ".gitignore": "node_modules/\ndist/\n# Signing keys never belong in a repository.\n*.pem\n",
    }
    : {
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
          jsx: "react-jsx",
          jsxImportSource: "@scalius/plugin-sdk/storefront",
          paths: { "@scalius/shared/*": ["../../packages/shared/src/*"] },
          noEmit: true,
          tsBuildInfoFile: `../../node_modules/.cache/tsbuild/plugin-${name}.tsbuildinfo`,
        },
        include: ["src/**/*"],
        references: [{ path: "../../packages/shared" }, { path: "../../packages/plugin-sdk" }],
      }, null, 2)}\n`,
    };
  return {
    ...project,
    "src/index.ts": `import { defineManifest, definePlugin, PLUGIN_API_VERSION, ui } from "@scalius/plugin-sdk";

// The manifest declares everything the app does. The platform refuses a
// handler that is not declared here, and shows the merchant what the app
// asks for before they turn it on. \`pnpm plugin validate\` checks this file.
// defineManifest keeps its literal types: handlers get \`ctx.objects.notes\`
// typed by its fields, and a mistake is reported at the key that is wrong.
export const manifest = defineManifest({
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
  objects: {
    notes: {
      name: "App notes",
      fields: [{ key: "value", name: "Value", type: "single_line_text", required: true }],
    },
  },
  routes: {
    admin: [{ name: "overview", methods: ["GET"], description: "The app's page in the dashboard." }],
    public: [],
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
      settings: [
        { key: "heading", label: "Heading", type: "text", default: "Hello from ${title}", maxLength: 120 },
        { key: "text", label: "Text", type: "textarea", default: "", maxLength: 500 },
      ],
    }],
  },
});

export default definePlugin({
  manifest,

  events: {
    // Delivery is at least once: keep a handler safe to run twice for the same event.
    "order.created": async (event, ctx) => {
      await ctx.objects.notes.put("last_order", { value: event.resource.id });
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
              { label: "Latest order", value: (await ctx.objects.notes.get("last_order"))?.value ?? "None yet" },
              { label: "Install note", value: (await ctx.objects.notes.get("install_note"))?.value ?? "Not written" },
            ]),
          ]),
        ], { title: ${JSON.stringify(title)}, description: "What this app did for the store." }),
      }),
    },
  },

  migrations: {
    // Idempotent: it may run again after a crash, so it keeps what is there.
    "1": async (ctx) => {
      if ((await ctx.objects.notes.get("install_note")) === null) {
        await ctx.objects.notes.put("install_note", { value: "Installed" }, { expectedRevision: null });
      }
    },
  },
});
`,
    "src/storefront.tsx": `import type { StorefrontSettingsOf } from "@scalius/plugin-sdk";
import { defineStorefront, type SectionProps } from "@scalius/plugin-sdk/storefront";
import type { manifest } from "./index";

// Components receive resolved settings (typed from the manifest) and escape text automatically.
function Banner({ settings }: SectionProps<StorefrontSettingsOf<typeof manifest, "section", "banner">>) {
  const heading = settings.heading.trim();
  const text = settings.text.trim();
  if (!heading && !text) return null;
  return (
    <section class="mx-auto max-w-7xl p-6 text-center">
      {heading && <h2 class="text-xl font-bold">{heading}</h2>}
      {text && <p class="mt-2 text-muted-foreground">{text}</p>}
    </section>
  );
}

export default defineStorefront({ sections: { banner: Banner } });
`,
    "src/index.test.ts": `// Unit tests with the SDK's test harness: the platform's own runtime over an
// in-memory bridge. Run them with \`pnpm test\`.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures, parsePluginUiDocument } from "@scalius/plugin-sdk/testing";
import { renderSection } from "@scalius/plugin-sdk/storefront/testing";
import plugin from "./index";
import storefront from "./storefront";

describe(${JSON.stringify(id)}, () => {
  it("remembers the latest order", async () => {
    const harness = createPluginTestHarness(plugin);
    const result = await harness.deliver(fixtures.event("order.created", { resource: { type: "order", id: "o1" } }));
    expect(result.ok).toBe(true);
    expect(harness.records.get("notes")?.get("last_order")).toEqual({ value: "o1" });
  });

  it("offers no discounts at checkout", async () => {
    const harness = createPluginTestHarness(plugin);
    const result = await harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput());
    expect(result.value).toEqual({ discounts: [] });
  });

  it("writes its install note once, however often the migration runs", async () => {
    const harness = createPluginTestHarness(plugin);
    expect((await harness.runMigrations()).ok).toBe(true);
    harness.records.get("notes")!.set("install_note", { value: "Changed by the merchant" });
    expect((await harness.runMigrations()).ok).toBe(true);
    expect(harness.records.get("notes")?.get("install_note")).toEqual({ value: "Changed by the merchant" });
  });

  it("draws the banner from its settings and escapes them", () => {
    const html = renderSection(storefront, "banner", { heading: "Sale <now>", text: "" });
    expect(html).toContain("Sale &lt;now&gt;");
    expect(html).not.toContain("<now>");
    expect(renderSection(storefront, "banner", { heading: "", text: "" })).toBe("");
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
