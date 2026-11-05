// The developer loop uses the same packer and fixture projections as a store.
// It writes a static preview, so it needs neither a server nor store credentials.
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { bundlePlugin, componentJobs, loadPluginContract, packPlugin, root, smokeSettings } from "./plugin-build.mjs";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const load = (code) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const FIXTURE_KEYS = ["product", "settings", "objects", "context"];
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A preview fixture (`--fixture <json>`): what the default fixtures leave
 * out, such as the custom fields a component reads.
 *
 *   {
 *     "product": { "fields": { "engraving": true } },          // over the fixture product page
 *     "settings": { "component:preview": { "maxLetters": 12 } },   // over a view's default settings
 *     "objects": { "section:lookbook": { "looks": { "records": [], "fields": {} } } },
 *     "context": { "page": { "kind": "product", "path": "/products/shirt" } }
 *   }
 *
 * Views are keyed like the preview's headings: `section:<type>`, `component:<type>`, `skin:<id>`.
 */
export function readPreviewFixture(path) {
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the fixture ${path}: ${error.message}`);
  }
  if (!isRecord(fixture)) throw new Error(`${path} is not a JSON object with ${FIXTURE_KEYS.join(", ")}.`);
  const unknown = Object.keys(fixture).find((key) => !FIXTURE_KEYS.includes(key));
  if (unknown) throw new Error(`${path}: unknown key "${unknown}" (use ${FIXTURE_KEYS.join(", ")}).`);
  for (const key of FIXTURE_KEYS) {
    if (fixture[key] !== undefined && !isRecord(fixture[key])) throw new Error(`${path}: ${key} is an object.`);
  }
  return fixture;
}

/**
 * Renders the app's storefront parts on the SDK's fixture stores (all three
 * unless `stores` names some): the sample shop, an empty new store and
 * another shop with its own name, logo, catalogue and currency, so a part
 * that only works on its developer's store shows it here.
 */
export async function previewPlugin(directory, output = join(directory, "dist/preview.html"), { fixture = {}, stores } = {}) {
  const packed = await packPlugin(directory);
  const contract = await loadPluginContract();
  const { storefrontShown } = await load(await bundlePlugin(join(root, "packages/plugin-sdk/src/storefront/testing.ts")));
  const names = stores?.length ? stores : [...contract.FIXTURE_STORES];
  const unknownStore = names.find((name) => !contract.FIXTURE_STORES.includes(name));
  if (unknownStore) throw new Error(`--store ${unknownStore} is not a fixture store (${contract.FIXTURE_STORES.join(", ")}).`);
  const storefront = packed.manifest.storefront;
  const views = new Set([
    ...storefront.sections.map((section) => `section:${section.type}`),
    ...storefront.components.map((component) => `component:${component.type}`),
    ...storefront.skins.map((skin) => `skin:${skin.id}`),
  ]);
  for (const key of ["settings", "objects"]) {
    const unknown = Object.keys(fixture[key] ?? {}).find((id) => !views.has(id));
    if (unknown) throw new Error(`The fixture's ${key} names ${unknown}, which is not a view of this app (${[...views].join(", ") || "none"}).`);
  }
  const module = packed.storefront.find((file) => file.path === contract.STOREFRONT_MODULE_FILE);
  const rendered = module ? (await load(module.bytes)).default : null;
  const assetPath = `${relative(dirname(output), join(directory, "dist/storefront")).replaceAll("\\", "/")}/`;
  // Parts render with the store's own file base (`/_x/<app>/<release>/`), which
  // the output check keeps; the preview then points it at the packed files
  // beside it. A relative base would be dropped by the check, with every asset().
  const storeAssetBase = `/_x/${packed.id}/${"0".repeat(64)}/`;
  const localAssets = (html) => html.split(storeAssetBase).join(assetPath);
  const empty = {};
  let count = 0;
  const blocks = names.map((name) => {
    const store = contract.fixtureStore(name);
    const settingsFor = (id, schema) => ({ ...smokeSettings(contract, schema, store), ...(fixture.settings?.[id] ?? {}) });
    const product = store.productPage(fixture.product ?? {});
    const jobs = [
      ...storefront.sections.map((section) => ({
        id: `section:${section.type}`, kind: "section", type: section.type, instanceId: `preview-${section.type}`, settings: settingsFor(`section:${section.type}`, section.settings),
        ...(fixture.objects?.[`section:${section.type}`] ? { objects: fixture.objects[`section:${section.type}`] } : {}),
      })),
      ...componentJobs(contract, storefront.components, "preview").map((job) => ({
        ...job,
        settings: { ...smokeSettings(contract, storefront.components.find((component) => component.type === job.type).settings, store), ...(fixture.settings?.[`component:${job.type}`] ?? {}) },
        ...(job.target.startsWith("product.") ? { data: product } : {}),
        ...(job.target.startsWith("product_card.") ? { data: store.skinData("product_card") } : {}),
      })),
      ...storefront.skins.map((skin) => ({
        id: `skin:${skin.id}`, kind: "skin", target: skin.target, component: skin.id, settings: settingsFor(`skin:${skin.id}`, skin.settings),
        data: skin.target === "product_main" ? product : store.skinData(skin.target), ...(skin.target.startsWith("section:") ? { instanceId: "preview" } : {}),
      })),
    ];
    const context = store.context({ ...(fixture.context ?? {}), assets: storeAssetBase, preview: true });
    const results = rendered ? rendered.render({ abi: contract.STOREFRONT_COMPONENT_ABI, context, jobs }).results : [];
    count = results.length;
    empty[name] = [];
    const sections = results.map((result) => {
      if ("error" in result) throw new Error(`${result.id} on the ${name} store: ${result.error}`);
      const shown = storefrontShown(result.html, packed.id);
      if (!shown.html.trim()) empty[name].push(result.id);
      const note = shown.html.trim()
        ? ""
        : name === "sample"
          ? "<p><strong>Rendered nothing with these fixtures.</strong> A component that reads custom fields, records or settings the defaults leave empty draws nothing without them: pass them with <code>--fixture &lt;json&gt;</code>.</p>"
          : "<p><strong>Rendered nothing on this store.</strong> Right for a part with nothing to show (a skin then gives way to the store's own unit); wrong if buyers lose something they need.</p>";
      return `<section class="preview"><h3>${escapeHtml(result.id)}</h3>${note}${shown.dropped ? `<p>${shown.dropped} unsupported elements or attributes removed by the host.</p>` : ""}<div>${localAssets(shown.html)}</div></section>`;
    });
    return `<section class="store" id="store-${name}"><h2>${escapeHtml(name)} store</h2><p>${escapeHtml(store.description)}</p>\n${sections.join("\n")}</section>`;
  });
  const document = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' file:; img-src data: file: https:; font-src file:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(packed.manifest.name)} fixture preview</title>
${storefront.stylesheet ? `<link rel="stylesheet" href="${escapeHtml(assetPath)}styles.css">` : ""}
<style>body{margin:0;font:16px/1.5 system-ui;color:#202124;background:#fafafa}body>header,.store>h2,.store>p,.preview{padding:0 24px}body>header{padding:24px}.store{border-top:4px solid #202124;padding-top:16px}.preview{background:white;margin:16px;padding:24px;border:1px solid #ddd;border-radius:8px}.preview>h3{font:14px monospace;border-bottom:1px solid #ddd;padding-bottom:12px}scalius-embed{display:block;padding:16px;border:1px dashed #777}scalius-embed:before{content:"Core embed: " attr(kind);font:14px system-ui}</style></head>
<body><header><h1>${escapeHtml(packed.manifest.name)} fixture preview</h1><p>Default settings on ${names.length === 1 ? "one fixture store" : `${names.length} fixture stores`}: ${names.map((name) => `<a href="#store-${name}">${name}</a>`).join(", ")}. Your theme must look right on each: another store's name, logo, catalogue and currency, and a new store with nothing in it. Core embeds are placeholders; scripts and checkout actions are disabled. Verify the composed page in your local store before shipping.</p></header>
${count ? blocks.join("\n") : '<section class="preview"><p>This app declares no storefront components. The package passed validation; test its handlers with @scalius/plugin-sdk/testing.</p></section>'}
</body></html>\n`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, document);
  return { id: packed.id, output, views: count, stores: names, empty: empty.sample ?? empty[names[0]] ?? [], emptyOn: empty };
}

/** Serialized rebuilds, including an edit that arrives while packing. */
export async function devPlugin(directory, output, options = {}) {
  let running = false;
  let pending = false;
  let stopped = false;
  let timer;
  const rebuild = async () => {
    if (running) { pending = true; return; }
    running = true;
    do {
      pending = false;
      try {
        const result = await previewPlugin(directory, output, options);
        console.log(`✓ ${result.id}: ${result.views} fixture view(s) on the ${result.stores.join(", ")} store${result.stores.length === 1 ? "" : "s"}. Open or refresh ${pathToFileURL(result.output).href}`);
      } catch (error) {
        console.error(`✗ ${error.message}`);
      }
    } while (pending && !stopped);
    running = false;
  };
  const watcher = watch(directory, { recursive: true }, (_event, file) => {
    if (!file || /(^|[/\\])(?:node_modules|dist|\.git|\.env[^/\\]*|\.dev\.vars[^/\\]*)(?:[/\\]|$)/.test(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 120);
  });
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    watcher.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  watcher.on("error", (error) => { console.error(error.message); process.exitCode = 1; stop(); });
  await rebuild();
  console.log("Watching app sources. Press Ctrl+C to stop.");
  return { close: stop };
}
