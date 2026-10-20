// The developer loop uses the same packer and fixture projections as a store.
// It writes a static preview, so it needs neither a server nor store credentials.
import { mkdirSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { bundlePlugin, loadPluginContract, packPlugin, root, smokeSettings } from "./plugin-build.mjs";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const load = (code) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

export async function previewPlugin(directory, output = join(directory, "dist/preview.html")) {
  const packed = await packPlugin(directory);
  const contract = await loadPluginContract();
  const { storefrontShown } = await load(await bundlePlugin(join(root, "packages/plugin-sdk/src/storefront/testing.ts")));
  const storefront = packed.manifest.storefront;
  const jobs = [
    ...storefront.sections.map((section) => ({ id: `section:${section.type}`, kind: "section", type: section.type, instanceId: `preview-${section.type}`, settings: smokeSettings(contract, section.settings) })),
    ...storefront.productBlocks.map((block) => ({ id: `block:${block.type}`, kind: "block", target: block.placement, type: block.type, instanceId: `preview-${block.type}`, settings: smokeSettings(contract, block.settings), data: contract.fixtureProductPage() })),
    ...storefront.skins.map((skin) => ({ id: `skin:${skin.id}`, kind: "skin", target: skin.target, component: skin.id, settings: smokeSettings(contract, skin.settings), data: contract.fixtureSkinData(skin.target), ...(skin.target.startsWith("section:") ? { instanceId: "preview" } : {}) })),
  ];
  const module = packed.storefront.find((file) => file.path === contract.STOREFRONT_MODULE_FILE);
  const assetPath = `${relative(dirname(output), join(directory, "dist/storefront")).replaceAll("\\", "/")}/`;
  const context = contract.fixtureContext({ assets: assetPath, preview: true });
  const results = module ? (await load(module.bytes)).default.render({ abi: contract.STOREFRONT_COMPONENT_ABI, context, jobs }).results : [];
  const sections = results.map((result) => {
    if ("error" in result) throw new Error(`${result.id}: ${result.error}`);
    const shown = storefrontShown(result.html, packed.id);
    return `<section class="preview"><h2>${escapeHtml(result.id)}</h2>${shown.dropped ? `<p>${shown.dropped} unsupported elements or attributes removed by the host.</p>` : ""}<div>${shown.html}</div></section>`;
  });
  const document = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' file:; img-src data: file: https:; font-src file:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(packed.manifest.name)} fixture preview</title>
${storefront.stylesheet ? `<link rel="stylesheet" href="${escapeHtml(assetPath)}styles.css">` : ""}
<style>body{margin:0;font:16px/1.5 system-ui;color:#202124;background:#fafafa}body>header,.preview{padding:24px}.preview{background:white;margin:16px;border:1px solid #ddd;border-radius:8px}.preview>h2{font:14px monospace;border-bottom:1px solid #ddd;padding-bottom:12px}scalius-embed{display:block;padding:16px;border:1px dashed #777}scalius-embed:before{content:"Core embed: " attr(kind);font:14px system-ui}</style></head>
<body><header><h1>${escapeHtml(packed.manifest.name)} fixture preview</h1><p>Sample data and default settings. Core embeds are placeholders; scripts and checkout actions are disabled. Verify the composed page in your local store before shipping.</p></header>
${sections.length ? sections.join("\n") : '<section class="preview"><p>This app declares no storefront components. The package passed validation; test its handlers with @scalius/plugin-sdk/testing.</p></section>'}
</body></html>\n`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, document);
  return { id: packed.id, output, views: results.length };
}

/** Serialized rebuilds, including an edit that arrives while packing. */
export async function devPlugin(directory, output) {
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
        const result = await previewPlugin(directory, output);
        console.log(`✓ ${result.id}: ${result.views} fixture view(s). Open or refresh ${pathToFileURL(result.output).href}`);
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
