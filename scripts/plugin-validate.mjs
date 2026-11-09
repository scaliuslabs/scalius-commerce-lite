// `pnpm plugin validate [path]`: every check a store makes when it loads a
// plugin, run on the author's machine, reported one line each. Packs nothing
// and writes nothing.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { bundlePlugin, componentJobs, installedSdk, loadPluginContract, packStorefront, pluginPackageDir, resolvePluginEntry, sdkBuildStamp, SDK_DIR, sealBundle, smokeSettings } from "./plugin-build.mjs";
import { sdkReference } from "./plugin-host.mjs";
import { BUNDLE_MAX_BYTES, shownPath } from "./plugin-registry.mjs";

export const BUNDLE_WARN_BYTES = 1024 * 1024;

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

/**
 * Runs the checks on the plugin package at `directory`. Returns
 * `{ ok, id, checks }`; each check is `{ status: "pass" | "fail" | "warn" | "note", label, detail? }`.
 */
export async function validatePlugin(directory) {
  const checks = [];
  const add = (status, label, detail) => checks.push({ status, label, ...(detail ? { detail } : {}) });
  const result = (id = null) => ({ ok: !checks.some((check) => check.status === "fail"), id, checks });

  let entry;
  try {
    entry = resolvePluginEntry(directory);
  } catch (error) {
    add("fail", "Plugin entry", error.message);
    return result();
  }
  if (!existsSync(entry)) {
    add("fail", "Plugin entry", `${entry} does not exist. Put the plugin in src/index.ts, or name the file in package.json "exports".`);
    return result();
  }
  add("pass", "Plugin entry", relative(directory, entry) || entry);
  const sdk = sdkBuildCheck(directory);
  if (sdk) add(sdk.status, "SDK build", sdk.detail);

  const contract = await loadPluginContract();
  let bundled;
  try {
    bundled = await bundlePlugin(entry);
  } catch (error) {
    const first = error?.errors?.[0];
    add("fail", "Bundles", first ? `${first.text}${first.location ? ` (${first.location.file}:${first.location.line})` : ""}` : error.message);
    return result();
  }
  add("pass", "Bundles");

  let loaded;
  try {
    loaded = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString("base64")}`);
  } catch (error) {
    add("fail", "Loads", `The module throws when it loads: ${error.message}`);
    return result();
  }
  const definition = contract.pluginDefinitionOf(loaded);
  if (!definition || definition.manifest === undefined) {
    add("fail", "Plugin definition", "The module has no default export from definePlugin() with a manifest.");
    return result();
  }
  add("pass", "Plugin definition", "default export from definePlugin()");

  const parsed = contract.parsePluginManifest(definition.manifest);
  if (!parsed.ok) {
    for (const issue of parsed.issues) add("fail", "Manifest", `${issue.path || "(manifest)"}: ${issue.message}`);
    return result();
  }
  const manifest = parsed.manifest;
  const patternIssues = contract.pluginObjectPatternIssues(manifest);
  if (patternIssues.length > 0) {
    for (const issue of patternIssues) add("fail", "Manifest", `${issue.path}: ${issue.message}`);
    return result();
  }
  add("pass", "Manifest", `${manifest.id}@${manifest.version}`);

  const compatible = contract.pluginCompatibility(definition.manifest);
  if (compatible.ok) add("pass", "Compatibility", `plugin API ${manifest.apiVersion}`);
  else add("fail", "Compatibility", compatible.message);

  const inventory = contract.pluginHandlerInventory(manifest);
  const mismatches = contract.checkPluginHandlers(inventory, loaded);
  if (mismatches.length === 0) {
    const counts = [
      ["event", inventory.events.length],
      ["function", inventory.functions.length],
      ["route", inventory.routes.admin.length + inventory.routes.public.length + inventory.routes.webhooks.length],
      ["cron job", inventory.cron.length],
      ["provider", inventory.providers.length],
      ["migration", (inventory.migrations ?? []).length],
    ].filter(([, count]) => count > 0).map(([noun, count]) => `${count} ${noun}${count === 1 ? "" : "s"}`);
    add("pass", "Handlers match the manifest", counts.join(", ") || "none declared");
  } else {
    for (const issue of mismatches) add("fail", "Handlers", issue);
  }

  // The manifest schema already accepts only `PLUGIN_SCOPES` names.
  add("pass", "Scopes", manifest.scopes.length === 0 ? "none requested" : manifest.scopes.join(", "));

  const packageDirectory = pluginPackageDir(directory);
  const declared = [
    ...(manifest.icon ? [{ path: manifest.icon, role: "icon" }] : []),
    ...manifest.screenshots.map((path) => ({ path, role: "screenshot" })),
    ...manifest.providers.flatMap((provider) => (provider.icon ? [{ path: provider.icon, role: "icon" }] : [])),
  ];
  const seen = new Set();
  const assets = [];
  let assetProblems = 0;
  for (const { path, role } of declared.filter(({ path: candidate }) => !seen.has(candidate) && seen.add(candidate))) {
    let bytes;
    try {
      bytes = readFileSync(join(packageDirectory, path));
    } catch {
      assetProblems += 1;
      add("fail", "Listing images", `${path} is declared in the manifest but missing.`);
      continue;
    }
    const problem = contract.checkPluginAsset(path, new Uint8Array(bytes), role);
    if (problem) {
      assetProblems += 1;
      add("fail", "Listing images", problem);
    } else {
      assets.push({ path, sha256: "0".repeat(64) });
    }
  }
  if (assetProblems === 0) add("pass", "Listing images", declared.length === 0 ? "none declared (an icon helps merchants find the app)" : `${declared.length} checked`);

  // The storefront part, exactly as pack builds it: compile the module, islands
  // and stylesheet, check public files and smoke-render every component with
  // its defaults (a skin that breaks its target's embed rule fails here, not at pack).
  let files = null;
  try {
    files = await packStorefront(contract, manifest, directory);
    add("pass", "Storefront", storefrontSummary(manifest.storefront, files.length));
  } catch (error) {
    const first = error?.errors?.[0];
    const message = first ? `${first.text}${first.location ? ` (${first.location.file}:${first.location.line})` : ""}` : String(error?.message ?? error);
    add("fail", "Storefront", message.startsWith(`${directory}: `) ? message.slice(directory.length + 2) : message);
  }

  // Card fields a template names: a store keeps only the ones it has, so these warn, never fail.
  for (const note of contract.storefrontTemplateCardFieldNotes(manifest)) add(note.level, "Template card fields", note.message);

  // Whether the storefront part works on any store, not only the developer's (docs/themes.md).
  if (files) {
    const notes = await portabilityNotes(contract, manifest, files);
    for (const note of notes) add(note.level, PORTABILITY_LABELS[note.rule], `${note.where}: ${note.message}`);
    if (notes.length === 0 && files.length > 0) add("pass", "Works on any store", "no store-specific links, merchant fields, fixed store name or third-party artwork");
  }

  // The packed bundle also carries the image digests; their size is fixed, so measure with placeholders.
  const size = Buffer.byteLength(sealBundle(bundled, assets));
  if (size > BUNDLE_MAX_BYTES) add("fail", "Bundle size", `${mib(size)} is over the 16 MiB a registry lists.`);
  else if (size > BUNDLE_WARN_BYTES) add("warn", "Bundle size", `${mib(size)} is large; the sandbox loads it on every cold start. Keep it under 1 MiB.`);
  else add("pass", "Bundle size", mib(size));

  return result(manifest.id);
}

const PORTABILITY_LABELS = {
  catalog_link: "Catalogue links",
  page_link: "Page links",
  header_link: "Header links",
  merchant_field: "Merchant fields",
  fixed_identity: "Store name and logo",
  artwork_size: "Artwork size",
  artwork_mark: "Artwork rights",
  island_props_url: "Island props",
};

const ISLAND = /<scalius-island\b[^>]*?\sdata-island="([^"]*)"[^>]*?\sdata-props="([^"]*)"/g;
/** An absolute, protocol-relative or store-path link (`/products/…`), as a prop value. */
const LINK = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|\/(?!\/))\S*$/i;

function decodeAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The links among a prop value's strings (nested arrays and objects included), the first few. */
function propLinks(value, found = []) {
  if (found.length >= 3) return found;
  if (typeof value === "string") {
    if (LINK.test(value.trim())) found.push(value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) propLinks(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) propLinks(item, found);
  }
  return found;
}

/**
 * Islands whose props carry links: rendered with their defaults over the
 * sample store's data. A link in markup is checked by the store and follows
 * the page's market path (`/en-in/…`); one in an island's props is JSON the
 * store passes as is, so it can point off the store or at the wrong market.
 * Put links in the markup the island enhances, or pass handles.
 */
export function islandPropsLinkNotes(contract, manifest, module) {
  const { sections, components, skins } = manifest.storefront;
  if (!module || manifest.storefront.islands.length === 0) return [];
  const jobs = [
    ...sections.map((section) => ({ id: `section ${section.type}`, kind: "section", type: section.type, instanceId: "validate", settings: smokeSettings(contract, section.settings) })),
    ...componentJobs(contract, components, "validate").map((job) => ({ ...job, id: `component ${job.type} (${job.target})` })),
    ...skins.map((skin) => ({
      id: `skin ${skin.id} (${skin.target})`, kind: "skin", target: skin.target, component: skin.id, settings: smokeSettings(contract, skin.settings),
      data: contract.fixtureSkinData(skin.target), ...(skin.target.startsWith("section:") ? { instanceId: "validate" } : {}),
    })),
  ];
  let results;
  try {
    results = module.render({ abi: contract.STOREFRONT_COMPONENT_ABI, context: contract.fixtureContext(), jobs }).results;
  } catch {
    return [];
  }
  const notes = [];
  for (const result of results) {
    if (!("html" in result)) continue;
    for (const [, island, raw] of result.html.matchAll(ISLAND)) {
      let props;
      try {
        props = JSON.parse(decodeAttribute(raw));
      } catch {
        continue;
      }
      const links = propLinks(props);
      if (links.length === 0) continue;
      notes.push({
        level: "warn",
        rule: "island_props_url",
        where: `${result.id}, island ${island}`,
        message: `its props carry links (${links.join(", ")}). The store checks links in markup and keeps them on the page's market path; props reach the island unchecked. Put links in the markup the island enhances (an <a> it reads), or pass handles.`,
      });
    }
  }
  return notes;
}

/** A store name and logo no fixture uses, so a skin that draws them shows them and a fixed wordmark does not. */
const PROBE_STORE = "Probe Store Kestrel";
const PROBE_LOGO = { url: "https://media.example.com/probe-store-logo.png", srcset: "https://media.example.com/probe-store-logo.png 400w", width: 400, height: 120, alt: PROBE_STORE };

/**
 * Header and footer skins that draw no store identity: rendered for a store
 * with no logo (its name should show) and one with a logo (the logo or the
 * name should show). A fixed wordmark shows the same on every store.
 */
function identityNotes(contract, manifest, module) {
  const skins = manifest.storefront.skins.filter((skin) => skin.target === "header" || skin.target === "footer");
  if (skins.length === 0 || !module) return [];
  const job = (skin, logo) => {
    const data = contract.fixtureSkinData(skin.target);
    const store = { ...data.store, name: PROBE_STORE, logo, ...(skin.target === "footer" ? { footerLogo: null } : {}) };
    return { id: `${skin.id}:${logo ? "logo" : "name"}`, kind: "skin", target: skin.target, component: skin.id, settings: smokeSettings(contract, skin.settings), data: { ...data, store } };
  };
  const jobs = skins.flatMap((skin) => [job(skin, null), job(skin, PROBE_LOGO)]);
  let results;
  try {
    results = module.render({ abi: contract.STOREFRONT_COMPONENT_ABI, context: contract.fixtureContext({ store: { ...contract.fixtureContext().store, name: PROBE_STORE } }), jobs }).results;
  } catch {
    return [];
  }
  const html = new Map(results.filter((result) => "html" in result).map((result) => [result.id, result.html]));
  const notes = [];
  for (const skin of skins) {
    const plain = html.get(`${skin.id}:name`);
    const branded = html.get(`${skin.id}:logo`);
    if (plain === undefined || branded === undefined) continue;
    const showsName = plain.includes(PROBE_STORE);
    const showsLogo = branded.includes(PROBE_LOGO.url) || branded.includes(PROBE_STORE);
    if (showsName && showsLogo) continue;
    notes.push({
      level: "warn",
      rule: "fixed_identity",
      where: `skin ${skin.id} (${skin.target})`,
      message: !showsName && !showsLogo
        ? "draws neither the store's name nor its logo, so every store shows the same wordmark (or none). Draw data.store.logo with <Image>, falling back to data.store.name."
        : !showsName
          ? "draws nothing for a store without a logo. Fall back to data.store.name when data.store.logo is null."
          : "ignores the store's logo. Draw data.store.logo with <Image> when the store has one, else data.store.name.",
    });
  }
  return notes;
}

async function portabilityNotes(contract, manifest, files) {
  const publicFiles = files.filter((file) => file.path.startsWith("public/")).map((file) => ({ path: file.path.slice("public/".length), bytes: file.bytes.byteLength }));
  const moduleFile = files.find((file) => file.path === contract.STOREFRONT_MODULE_FILE);
  const notes = contract.storefrontPortabilityNotes(manifest, { publicFiles });
  if (!moduleFile) return notes;
  const text = Buffer.from(moduleFile.bytes).toString("utf8");
  notes.push(...contract.storefrontModuleFieldNotes(text, manifest.id));
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(moduleFile.bytes).toString("base64")}`);
  notes.push(...identityNotes(contract, manifest, loaded.default));
  notes.push(...islandPropsLinkNotes(contract, manifest, loaded.default));
  return notes;
}

const MARK = { pass: "✓", fail: "✗", warn: "!", note: "-" };

export function formatChecks(checks) {
  return checks.map((check) => `${MARK[check.status]} ${check.label}${check.detail ? `: ${check.detail}` : ""}`).join("\n");
}

/**
 * The app's installed SDK build against the build the tools expect (the
 * host's `sdkReference`: this checkout's SDK sources, or the SDK the
 * standalone `scalius-plugin` came with): a tarball packed before a platform
 * change types and tests an older platform (a missing scope or operation)
 * while the docs describe the new one. Null when the app uses the host's own
 * SDK (a workspace app, or the package the CLI runs from); a note, never a
 * failure, when there is nothing to compare with.
 */
export function sdkBuildCheck(directory, reference = sdkReference) {
  const sdk = installedSdk(directory);
  if (!sdk) return null;
  // A re-vendored tarball (its name carries its version) that npm install has not installed yet.
  const declared = vendoredSdkVersion(directory);
  if (declared && declared !== sdk.version) return { status: "warn", detail: `package.json names the SDK ${declared}, but ${sdk.version} is installed. Run npm install.` };
  if (sameDirectory(sdk.path, SDK_DIR)) return null;
  const expected = reference();
  if (!expected) return { status: "note", detail: `${sdk.version}; this tool has no SDK build stamp to compare it with` };
  const stamp = sdkBuildStamp(sdk.path);
  if (stamp?.sourceDigest === expected.digest) return { status: "pass", detail: `${sdk.version}, built from ${expected.from}` };
  return { status: "warn", detail: `The app's SDK (${shownPath(sdk.path)}, ${sdk.version}) was built from other sources than ${expected.from}, so its types and harness may lack what the docs describe. Refresh it: ${expected.refresh}.` };
}

/** The version of a vendored SDK tarball the app depends on (`file:vendor/scalius-plugin-sdk-<version>.tgz`), or null. */
function vendoredSdkVersion(directory) {
  try {
    const dependency = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).dependencies?.["@scalius/plugin-sdk"];
    return /^file:.*scalius-plugin-sdk-(.+)\.tgz$/u.exec(dependency ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

function sameDirectory(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

const counted = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Every storefront part the manifest declares, compiled or not: Buyer UI
 * extensions, a pixel, scripts, head tags and the proxy are storefront parts
 * too, so an app with only a checkout extension never reads "none declared".
 */
export function storefrontSummary(storefront, compiledFiles) {
  const { sections, components, skins, islands, templates, extensions, scripts } = storefront;
  const compiled = [
    [sections.length, "section"],
    [components.length, "component"],
    [skins.length, "skin"],
    [templates.length, "template"],
    [islands.length, "island"],
  ].filter(([count]) => count > 0).map(([count, noun]) => counted(count, noun));
  const declared = [
    ...(compiled.length > 0 ? [`${compiled.join(", ")} compiled and rendered with their defaults`] : compiledFiles > 0 ? [`${counted(compiledFiles, "file")} compiled`] : []),
    ...(extensions.length > 0 ? [`${counted(extensions.length, "Buyer UI extension")} (${extensions.map((extension) => extension.target).join(", ")})`] : []),
    ...(storefront.pixel ? ["a pixel"] : []),
    ...(scripts.length > 0 ? [counted(scripts.length, "script")] : []),
    ...(storefront.head ? ["head tags"] : []),
    ...(storefront.proxy ? ["the app proxy"] : []),
  ];
  return declared.join("; ") || "none declared";
}

/** Runs the checks, prints them and sets the exit code. */
export async function runValidate(directory) {
  if (!existsSync(directory)) {
    console.error(`✗ ${shownPath(directory)} does not exist.`);
    process.exitCode = 1;
    return null;
  }
  console.log(`Checking ${shownPath(directory)}`);
  const outcome = await validatePlugin(directory);
  console.log(formatChecks(outcome.checks));
  const failed = outcome.checks.filter((check) => check.status === "fail").length;
  if (failed > 0) {
    console.log(`\n${failed} problem${failed === 1 ? "" : "s"} to fix.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${outcome.id} is ready to pack.`);
  }
  return outcome;
}
