import { describe, expect, it } from "vitest";
import { judgeApiBundle, measureWorkerOutput, API_BUNDLE_BUDGET_BYTES, WORKER_SIZE_LIMIT_BYTES } from "./check-api-bundle.mjs";
import { createPluginTestHarness, fixtures, parsePluginUiDocument } from "../packages/plugin-sdk/src/testing.ts";
import { renderSection } from "../packages/plugin-sdk/src/storefront/testing.ts";
import { isPathSource, packPlugin, renderBundledGen, renderCatalogGen, renderLockfile, sealBundle } from "./plugin-build.mjs";
import { BUNDLE_MAX_BYTES } from "./plugin-registry.mjs";
import { editSource, makeTempPlugin } from "./plugin-test-helpers.mjs";
import { BUNDLE_WARN_BYTES, formatChecks, validatePlugin } from "./plugin-validate.mjs";
import { isWorkspacePackageDir, pluginSandboxEnabled, scaffoldFiles, withPluginSandbox } from "./plugins.mjs";
import { root } from "./plugin-build.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

describe("pnpm plugin", () => {
  it("adds the Worker Loader binding only to a generated config", () => {
    const config = withPluginSandbox(`{
      // comment
      "name": "scalius-api",
      "main": "./src/worker.ts",
    }`);
    expect(config).toEqual({ name: "scalius-api", main: "./src/worker.ts", worker_loaders: [{ binding: "LOADER" }] });
    expect(withPluginSandbox(JSON.stringify(config)).worker_loaders).toEqual([{ binding: "LOADER" }]);
  });

  it("turns the sandbox on from the lockfile, the flag or the environment only", () => {
    const off = { version: 1, sandbox: false, plugins: [] };
    expect(pluginSandboxEnabled(off, {}, [])).toBe(false);
    expect(pluginSandboxEnabled(off, {}, ["--plugin-sandbox"])).toBe(true);
    expect(pluginSandboxEnabled(off, { SCALIUS_PLUGIN_SANDBOX: "1" }, [])).toBe(true);
    expect(pluginSandboxEnabled({ ...off, sandbox: true }, {}, [])).toBe(true);
  });

  it("renders the lockfile and the bundled map deterministically", () => {
    const lockfile = {
      version: 1,
      sandbox: false,
      plugins: [
        { id: "zeta.b", version: "1.0.0", source: "plugins/b", sha256: "b".repeat(64) },
        { id: "acme.a", version: "2.0.0", source: "@acme/scalius-a", sha256: "a".repeat(64) },
      ],
    };
    expect(JSON.parse(renderLockfile(lockfile)).plugins.map((plugin) => plugin.id)).toEqual(["acme.a", "zeta.b"]);
    const generated = renderBundledGen(lockfile, (plugin) => (isPathSource(plugin.source) ? `../../../../${plugin.source}/src/index` : plugin.source));
    expect(generated).toContain('"acme.a": {\n    version: "2.0.0"');
    expect(generated).toContain('load: () => import("@acme/scalius-a")');
    expect(generated).toContain('load: () => import("../../../../plugins/b/src/index")');
    expect(generated.indexOf("acme.a")).toBeLessThan(generated.indexOf("zeta.b"));
  });

  it("seals listing image digests into the bundle, so an image change is a new fingerprint", () => {
    expect(sealBundle("export default 1;\n", [])).toBe("export default 1;\n");
    const sealed = sealBundle("export default 1;\n", [{ path: "assets/icon.svg", sha256: "a".repeat(64) }]);
    expect(sealed).toBe(`export default 1;\n//# scalius-assets {"assets/icon.svg":"${"a".repeat(64)}"}\n`);
    expect(sealBundle("export default 1;\n", [{ path: "assets/icon.svg", sha256: "b".repeat(64) }])).not.toBe(sealed);
  });

  it("catalogs an unbundled first-party plugin by its listing and add command", () => {
    const generated = renderCatalogGen([{
      id: "scalius.gift",
      source: "plugins/gift",
      sha256: "c".repeat(64),
      manifest: {
        name: "Gift wrap",
        version: "1.0.0",
        description: "Wrap orders.",
        author: { name: "Scalius" },
        tagline: "Wrap it",
        categories: ["orders"],
        screenshots: [],
        scopes: ["read_orders"],
        translations: { bn: { name: "গিফট র‍্যাপ", tagline: "মুড়ে দিন", pages: { x: "y" } } },
      },
    }]);
    expect(generated).toContain('"source":"plugins/gift"');
    expect(generated).toContain('"tagline":"Wrap it"');
    // Only the listing travels: no capabilities, no surface translations.
    expect(generated).not.toContain("permissions");
    expect(generated).not.toContain("pages");
  });

  it("scaffolds a plugin with an event, a function, a section, an admin page, a migration and a test", () => {
    const files = scaffoldFiles("acme.loyalty", "loyalty");
    expect(Object.keys(files).sort()).toEqual(["package.json", "src/index.test.ts", "src/index.ts", "src/storefront.tsx", "tsconfig.json"]);
    expect(JSON.parse(files["package.json"]).dependencies).toEqual({ "@scalius/plugin-sdk": "workspace:*" });
    const source = files["src/index.ts"];
    expect(source).toContain('id: "acme.loyalty"');
    expect(source).toContain('from "@scalius/plugin-sdk"');
    expect(source).toContain('"order.created": async');
    expect(source).toContain('"checkout.discounts": ()');
    expect(source).toContain('type: "banner"');
    expect(source).toContain('ctx.objects.notes.put');
    expect(source).toContain("defineManifest({");
    expect(source).not.toMatch(/ctx\.kv|request\.render|route: "banner"/);
    expect(files["src/storefront.tsx"]).toContain("defineStorefront");
    expect(JSON.parse(files["tsconfig.json"]).compilerOptions).toMatchObject({ jsx: "react-jsx", jsxImportSource: "@scalius/plugin-sdk/storefront" });
    expect(source).toContain("pages: [{ id: \"overview\"");
    expect(source).toContain("migrations: [{ version: 1");
    expect(source).toContain('"1": async');
    const test = files["src/index.test.ts"];
    for (const used of ["createPluginTestHarness", "harness.deliver", "harness.fn", "harness.runMigrations", "renderSection", 'harness.route("admin"']) {
      expect(test).toContain(used);
    }
  });
});

describe("a standalone app (outside this repository)", () => {
  it("depends on the published SDK, with no workspace protocol or repo-relative path", () => {
    const files = scaffoldFiles("acme.loyalty", "loyalty", { standalone: true, sdkVersion: "0.4.2" });
    const pkg = JSON.parse(files["package.json"]);
    expect(pkg.dependencies).toEqual({ "@scalius/plugin-sdk": "^0.4.2" });
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["typescript", "vitest"]);
    for (const [file, text] of Object.entries(files)) {
      expect(text, file).not.toContain("workspace:");
      expect(text, file).not.toContain("../../");
      expect(text, file).not.toContain("@scalius/tsconfig");
    }
    expect(JSON.parse(files["tsconfig.json"]).compilerOptions).toMatchObject({ jsxImportSource: "@scalius/plugin-sdk/storefront", moduleResolution: "Bundler" });
    expect(files[".gitignore"]).toContain("*.pem");
    expect(files["src/index.ts"]).toContain("defineManifest({");
  });

  it("is chosen for any folder that is not a workspace package", () => {
    expect(isWorkspacePackageDir(join(root, "plugins/loyalty"))).toBe(true);
    expect(isWorkspacePackageDir(join(root, "scratch-apps/loyalty"))).toBe(false);
    expect(isWorkspacePackageDir(join(tmpdir(), "loyalty"))).toBe(false);
  });

  it("validates and packs against this repository's SDK before its npm install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scalius-app-"));
    try {
      for (const [file, text] of Object.entries(scaffoldFiles("acme.outside", "outside", { standalone: true }))) {
        const path = join(dir, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      const outcome = await validatePlugin(dir);
      expect(formatChecks(outcome.checks)).not.toContain("✗");
      expect(outcome).toMatchObject({ ok: true, id: "acme.outside" });
      const packed = await packPlugin(dir);
      expect(packed.storefront.map((file) => file.path)).toEqual(["storefront.js"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("scaffolded plugin", () => {
  it("passes pnpm plugin validate and behaves as its own test says", async () => {
    const plugin = makeTempPlugin({ id: "acme.loyalty" });
    try {
      const outcome = await validatePlugin(plugin.dir);
      expect(formatChecks(outcome.checks)).not.toContain("✗");
      expect(outcome).toMatchObject({ ok: true, id: "acme.loyalty" });
      expect(outcome.checks.map((check) => check.label)).toEqual([
        "Plugin entry", "Bundles", "Plugin definition", "Manifest", "Compatibility", "Handlers match the manifest", "Scopes", "Listing images", "Storefront", "Bundle size",
      ]);

      // The same steps as its generated test, against the packed bundle.
      const packed = await packPlugin(plugin.dir);
      const module = await import(`data:text/javascript;base64,${Buffer.from(packed.code).toString("base64")}`);
      const harness = createPluginTestHarness(module);
      expect((await harness.deliver(fixtures.event("order.created", { resource: { type: "order", id: "o1" } }))).ok).toBe(true);
      expect(harness.records.get("notes")?.get("last_order")).toEqual({ value: "o1" });
      expect((await harness.fn("checkout.discounts", fixtures.checkoutDiscountsInput())).value).toEqual({ discounts: [] });
      expect((await harness.runMigrations()).ok).toBe(true);
      expect(harness.records.get("notes")?.get("install_note")).toEqual({ value: "Installed" });
      harness.records.get("notes").set("install_note", { value: "Changed by the merchant" });
      expect((await harness.runMigrations()).ok).toBe(true);
      expect(harness.records.get("notes")?.get("install_note")).toEqual({ value: "Changed by the merchant" });
      const storefrontFile = packed.storefront.find((file) => file.path === "storefront.js");
      const storefront = await import(`data:text/javascript;base64,${Buffer.from(storefrontFile.bytes).toString("base64")}`);
      const html = renderSection(storefront.default, "banner", { heading: "Sale <now>", text: "" });
      expect(html).toContain("Sale &lt;now&gt;");
      expect(html).not.toContain("<now>");
      expect(renderSection(storefront.default, "banner", { heading: "", text: "" })).toBe("");
      const page = parsePluginUiDocument(((await harness.route("admin", "overview", fixtures.adminRouteRequest())).value).body);
      expect(page.ok).toBe(true);
    } finally {
      plugin.cleanup();
    }
  });
});

describe("pnpm plugin validate", () => {
  it("reports every problem in one run: a missing handler and a missing image", async () => {
    const plugin = makeTempPlugin({ id: "acme.broken" });
    try {
      editSource(plugin.dir, (source) => source
        .replace('categories: ["marketing"],', 'categories: ["marketing"],\n  icon: "assets/missing.svg",')
        .replace('"checkout.discounts": () => ({ discounts: [] }),', ""));
      const outcome = await validatePlugin(plugin.dir);
      const report = formatChecks(outcome.checks);
      expect(outcome.ok).toBe(false);
      expect(report).toContain("✗ Handlers: ");
      expect(report).toContain("checkout.discounts");
      expect(report).toContain("✗ Listing images: assets/missing.svg is declared in the manifest but missing.");
    } finally {
      plugin.cleanup();
    }
  });

  it("lists manifest parse issues with their paths, and names a module that has no plugin", async () => {
    const bad = makeTempPlugin({ id: "acme.bad" });
    const empty = makeTempPlugin({ id: "acme.empty" });
    try {
      editSource(bad.dir, (source) => source.replace('apiVersion: PLUGIN_API_VERSION,', "").replace('version: "0.1.0"', 'version: "one"')
        .replace('scopes: ["read_orders"]', 'scopes: ["read_orders", "orders.view"]'));
      const outcome = await validatePlugin(bad.dir);
      const report = formatChecks(outcome.checks);
      expect(outcome.ok).toBe(false);
      expect(report).toMatch(/✗ Manifest: version/);
      expect(report).toMatch(/✗ Manifest: apiVersion/);
      // Raw RBAC names are not scopes (PLUGIN_SCOPES).
      expect(report).toMatch(/✗ Manifest: scopes\.1/);

      editSource(empty.dir, () => "export const nothing = 1;\n");
      expect(formatChecks((await validatePlugin(empty.dir)).checks)).toContain("✗ Plugin definition: The module has no default export from definePlugin() with a manifest.");
    } finally {
      bad.cleanup();
      empty.cleanup();
    }
  });

  it("compiles and smoke-renders the storefront module, so a broken skin fails validate, not pack (DX-4)", async () => {
    const plugin = makeTempPlugin({ id: "acme.skin" });
    try {
      editSource(plugin.dir, (source) => source.replace("  storefront: {", '  storefront: {\n    skins: [{ id: "page", target: "product-main", name: "Page", settings: [] }],'));
      writeFileSync(join(plugin.dir, "src/storefront.tsx"), `
        import { defineStorefront, raw } from "@scalius/plugin-sdk/storefront";
        export default defineStorefront({ sections: { banner: () => null }, skins: { page: () => raw("<main><h1>No buy form</h1></main>") } });
      `);
      const outcome = await validatePlugin(plugin.dir);
      expect(outcome.ok).toBe(false);
      expect(formatChecks(outcome.checks)).toMatch(/✗ Storefront: skin:page \(product-main\): /);

      writeFileSync(join(plugin.dir, "src/storefront.tsx"), `
        import { defineStorefront } from "@scalius/plugin-sdk/storefront";
        export default defineStorefront({ sections: {} });
      `);
      expect(formatChecks((await validatePlugin(plugin.dir)).checks)).toContain("✗ Storefront: the section banner has no component");
    } finally {
      plugin.cleanup();
    }
  }, 60_000);

  it("warns above 1 MiB and fails above the registry's 16 MiB, and says when the source does not compile", async () => {
    const big = makeTempPlugin({ id: "acme.big" });
    const broken = makeTempPlugin({ id: "acme.syntax" });
    try {
      editSource(big.dir, (source) => `${source}\nexport const padding = ${JSON.stringify("x".repeat(BUNDLE_WARN_BYTES + 10))};\n`);
      const warned = await validatePlugin(big.dir);
      expect(warned.ok).toBe(true);
      expect(warned.checks.find((check) => check.label === "Bundle size")).toMatchObject({ status: "warn" });

      editSource(big.dir, (source) => `${source}\nexport const more = ${JSON.stringify("y".repeat(BUNDLE_MAX_BYTES))};\n`);
      const failed = await validatePlugin(big.dir);
      expect(failed.ok).toBe(false);
      expect(failed.checks.find((check) => check.label === "Bundle size")).toMatchObject({ status: "fail" });

      editSource(broken.dir, (source) => `${source}\nconst = ;`);
      const outcome = await validatePlugin(broken.dir);
      expect(outcome.ok).toBe(false);
      expect(formatChecks(outcome.checks)).toContain("✗ Bundles: ");
    } finally {
      big.cleanup();
      broken.cleanup();
    }
  }, 30_000);
});

describe("API bundle size gate", () => {
  it("measures uploaded modules only and keeps a 10% margin under the documented limit (64 MiB uncompressed, both plans)", () => {
    expect(WORKER_SIZE_LIMIT_BYTES).toBe(64 * 1024 * 1024);
    expect(API_BUNDLE_BUDGET_BYTES).toBe(Math.floor(WORKER_SIZE_LIMIT_BYTES * 0.9));
    expect(judgeApiBundle(API_BUNDLE_BUDGET_BYTES)).toEqual({ ok: true, headroom: 0 });
    expect(judgeApiBundle(API_BUNDLE_BUDGET_BYTES + 1).ok).toBe(false);
    const directory = mkdtempSync(join(tmpdir(), "scalius-bundle-gate-"));
    try {
      writeFileSync(join(directory, "worker.js"), "export default {};".repeat(100));
      writeFileSync(join(directory, "worker.js.map"), "x".repeat(10_000));
      writeFileSync(join(directory, "README.md"), "notes");
      writeFileSync(join(directory, "bundle-meta.json"), "{}");
      writeFileSync(join(directory, "abc-places.json"), "[1]");
      writeFileSync(join(directory, "abc-contract.gen.txt"), "{}");
      const measured = measureWorkerOutput(directory);
      expect(measured.files.sort()).toEqual(["abc-contract.gen.txt", "abc-places.json", "worker.js"]);
      expect(measured.raw).toBe(1805);
      // Only JavaScript counts against the startup budget: Text modules are strings.
      expect(measured.script).toBe(1800);
      expect(measured.gzip).toBeGreaterThan(0);
      expect(measured.gzip).toBeLessThan(measured.raw);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
