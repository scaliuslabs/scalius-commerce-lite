#!/usr/bin/env node
// `pnpm plugin <command>`: the operator's tool for bundled plugins
// (packages/plugin-sdk/docs/apps.md). Plugins compiled into the API Worker are listed
// in scalius.plugins.json; this keeps that lockfile, the generated
// apps/api/src/plugins/bundled.gen.ts, the plugins' listing images
// (assets.gen.ts), the catalog of first-party plugins not bundled
// (catalog.gen.ts) and the sandbox wrapper in step.
//
// The app author's commands (create, validate, build, preview, dev, pack,
// verify, keygen, index) are scripts/plugin-authoring.mjs, shared with the
// SDK's own CLI; `pnpm plugin help` lists them. The store's own:
//
//   pnpm plugin add <path | zip | package>                     pack, check and bundle an app: a folder anywhere, the upload ZIP or a dist folder
//   pnpm plugin add <vendor.name> --registry <index url> [--version <v>]   install a signed release from a registry
//   pnpm plugin trust <name> <public key>                      trust a developer's signing key
//   pnpm plugin remove <plugin id>                             stop bundling a plugin
//   pnpm plugin list                                           what is bundled, and whether it is current
//   pnpm plugin build [plugin id ...]                          repack bundled plugins, regenerate the wrapper (app folders: pack each into dist/)
//   pnpm plugin sandbox <on|off>                               record the operator's sandbox choice
//   pnpm plugin wrangler-config [--local] [--plan paid]        print the API Wrangler config to use

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ASSETS_GEN,
  ASSETS_GEN_TEXT,
  BUNDLED_GEN,
  CATALOG_GEN,
  LOCKFILE,
  SANDBOX_RUNTIME_GEN,
  SANDBOX_RUNTIME_GEN_TEXT,
  buildSandboxRuntime,
  isPathSource,
  packForGenerated,
  packPlugin,
  pluginSandboxEnabled,
  readLockfile,
  renderAssetsGen,
  renderBundledGen,
  renderCatalogGen,
  renderLockfile,
  renderSandboxRuntimeGen,
  root,
  writeIfChanged,
  writeStorefrontGenerated,
} from "./plugin-build.mjs";
import {
  installFromRegistry,
  installLocalRelease,
  isPackedRelease,
  parseCommandArgs,
  trustedKeysWith,
  shownPath,
  userPath,
} from "./plugin-registry.mjs";
import { scaffoldFiles } from "./plugin-scaffold.mjs";
import { authoringHelp, buildApps, buildsFolders, PLUGIN_ID, runAuthoring } from "./plugin-authoring.mjs";
import { stripJsonc } from "./check-worker-env.mjs";
import { resolvePlan, withPlanProfile } from "./plan.mjs";

export { pluginSandboxEnabled, scaffoldFiles };
export { isWorkspacePackageDir, packFailure, shellPath, sdkVersion } from "./plugin-authoring.mjs";

const HELP = new Set(["help", "--help", "-h"]);
const API_DIR = join(root, "apps/api");

/**
 * A Wrangler config with the Worker Loader binding added. The committed
 * configs never carry it (Workers Free must deploy unchanged); the generated
 * file sits beside the original so its relative paths still resolve.
 */
export function withPluginSandbox(configText) {
  const config = JSON.parse(stripJsonc(configText));
  const loaders = Array.isArray(config.worker_loaders) ? config.worker_loaders : [];
  if (!loaders.some((loader) => loader?.binding === "LOADER")) loaders.push({ binding: "LOADER" });
  return { ...config, worker_loaders: loaders };
}

/**
 * The API Wrangler config path for deploy (`--local` for `pnpm dev`). The
 * committed config is the Free config; the sandbox (Worker Loader) and the
 * Paid plan's profile (scripts/plan.mjs) are added in a generated file beside
 * it, so relative paths still resolve.
 */
export function apiWranglerConfig({ local = false, sandbox = false, plan = "free" } = {}) {
  const base = local ? "wrangler.local.jsonc" : "wrangler.jsonc";
  if (!sandbox && plan === "free") return join(API_DIR, base);
  const generated = join(API_DIR, local ? "wrangler.local.deploy.gen.json" : "wrangler.deploy.gen.json");
  const text = readFileSync(join(API_DIR, base), "utf8");
  const config = withPlanProfile(sandbox ? withPluginSandbox(text) : JSON.parse(stripJsonc(text)), plan);
  writeIfChanged(generated, `${JSON.stringify(config, null, 2)}\n`);
  return generated;
}

async function regenerate(lockfile) {
  writeIfChanged(LOCKFILE, renderLockfile(lockfile));
  const bundled = writeIfChanged(BUNDLED_GEN, renderBundledGen(lockfile));
  const sandboxRuntime = renderSandboxRuntimeGen(await buildSandboxRuntime());
  const runtime = [writeIfChanged(SANDBOX_RUNTIME_GEN_TEXT, sandboxRuntime.text), writeIfChanged(SANDBOX_RUNTIME_GEN, sandboxRuntime.module)].some(Boolean);
  const packed = await packForGenerated(lockfile);
  const listingImages = renderAssetsGen([...packed.bundled, ...packed.catalog]);
  const assets = [writeIfChanged(ASSETS_GEN_TEXT, listingImages.text), writeIfChanged(ASSETS_GEN, listingImages.module)].some(Boolean);
  const catalog = writeIfChanged(CATALOG_GEN, renderCatalogGen(packed.catalog));
  for (const path of writeStorefrontGenerated(lockfile, packed.bundled)) console.log(`Updated ${relative(root, path)}`);
  if (bundled) console.log(`Updated ${relative(root, BUNDLED_GEN)}`);
  if (runtime) console.log(`Updated ${relative(root, SANDBOX_RUNTIME_GEN)}`);
  if (assets) console.log(`Updated ${relative(root, ASSETS_GEN)}`);
  if (catalog) console.log(`Updated ${relative(root, CATALOG_GEN)}`);
}

/** A path source as the lockfile keeps it: `plugins/<dir>`, or `./<path>` for another folder of this repository. */
function normalizeSource(source) {
  if (!isPathSource(source)) return source;
  const path = relative(root, resolve(root, source)).split("\\").join("/");
  return path.startsWith("plugins/") ? path : `./${path}`;
}

/**
 * A path `add` installs as a packed release first: anything outside this
 * repository (an app folder, packed here, or what `pnpm plugin pack` wrote)
 * and an upload ZIP anywhere. It becomes `plugins/<vendor>-<name>/`.
 */
function installsAsRelease(path) {
  return relative(root, path).startsWith("..") || isPackedRelease(path) && statSync(path).isFile();
}

async function add(source) {
  if (!source) throw new Error("Usage: pnpm plugin add <path | zip | package>");
  // A path as typed where the command ran, else as the repository has it (`plugins/<dir>`).
  const path = [userPath(source), resolve(root, source)].find((candidate) => existsSync(candidate));
  if (path) {
    if (installsAsRelease(path)) {
      const installed = await installLocalRelease({ source: path, pluginsDir: join(root, "plugins") });
      console.log(`Installed ${installed.id}@${installed.version} from ${shownPath(path)} as ${relative(root, installed.directory)}${installed.signer ? ` (signed by "${installed.signer.name}", key ${installed.signer.fingerprint})` : " (unsigned)"}.`);
      return bundle(installed.directory);
    }
    return bundle(path);
  }
  return bundle(source);
}

async function bundle(source) {
  const normalized = normalizeSource(source);
  const packed = await packPlugin(normalized);
  const lockfile = readLockfile();
  const entry = { id: packed.id, version: packed.version, source: normalized, sha256: packed.sha256 };
  lockfile.plugins = [...lockfile.plugins.filter((plugin) => plugin.id !== packed.id), entry];
  await regenerate(lockfile);
  console.log(`Bundled ${packed.id}@${packed.version} (${packed.sha256.slice(0, 12)}).
A running pnpm dev reloads both Workers by itself: open Apps in the dashboard, then activate it. On a deployed store: pnpm run deploy.`);
}

async function remove(id) {
  const lockfile = readLockfile();
  const next = lockfile.plugins.filter((plugin) => plugin.id !== id);
  if (next.length === lockfile.plugins.length) throw new Error(`${id} is not bundled.`);
  await regenerate({ ...lockfile, plugins: next });
  console.log(`Removed ${id}. Deploy to drop its code; uninstall it in the dashboard first.`);
}

async function build(ids) {
  const lockfile = readLockfile();
  const selected = ids.length > 0 ? lockfile.plugins.filter((plugin) => ids.includes(plugin.id)) : lockfile.plugins;
  if (ids.length > 0 && selected.length !== ids.length) throw new Error(`Not bundled: ${ids.filter((id) => !selected.some((plugin) => plugin.id === id)).join(", ")}`);
  const packedById = new Map();
  for (const plugin of selected) {
    const packed = await packPlugin(plugin.source);
    if (packed.id !== plugin.id) throw new Error(`${plugin.source} is now ${packed.id}, not ${plugin.id}; remove and add it.`);
    packedById.set(plugin.id, packed);
    console.log(`Packed ${packed.id}@${packed.version} (${packed.sha256.slice(0, 12)})`);
  }
  lockfile.plugins = lockfile.plugins.map((plugin) => {
    const packed = packedById.get(plugin.id);
    return packed ? { ...plugin, version: packed.version, sha256: packed.sha256 } : plugin;
  });
  await regenerate(lockfile);
}

async function list() {
  const lockfile = readLockfile();
  console.log(`Sandbox: ${lockfile.sandbox ? "on (Dynamic Workers, Workers Paid)" : "off"}`);
  if (lockfile.plugins.length === 0) {
    console.log("No bundled plugins.");
    return;
  }
  for (const plugin of lockfile.plugins) {
    let state = "current";
    try {
      const packed = await packPlugin(plugin.source);
      if (packed.sha256 !== plugin.sha256 || packed.version !== plugin.version) state = `changed (now ${packed.version}, run pnpm plugin build)`;
    } catch (error) {
      state = `broken: ${error.message}`;
    }
    console.log(`${plugin.id}@${plugin.version}  ${plugin.source}  ${plugin.sha256.slice(0, 12)}  ${state}`);
  }
}

function setSandbox(value) {
  if (value !== "on" && value !== "off") throw new Error("Usage: pnpm plugin sandbox <on|off>");
  const lockfile = readLockfile();
  writeIfChanged(LOCKFILE, renderLockfile({ ...lockfile, sandbox: value === "on" }));
  console.log(value === "on"
    ? "Sandbox on: deploys add the Worker Loader binding (Workers Paid required)."
    : "Sandbox off: only bundled plugins run.");
}

async function addFromRegistry(id, flags) {
  const indexUrl = flags.get("--registry");
  if (!id || typeof indexUrl !== "string") throw new Error("Usage: pnpm plugin add <vendor.name> --registry <index url> [--version <v>]");
  if (!PLUGIN_ID.test(id)) throw new Error(`${id} is not a plugin id (vendor.name, lowercase).`);
  const installed = await installFromRegistry({
    id,
    indexUrl,
    version: typeof flags.get("--version") === "string" ? flags.get("--version") : null,
    pluginsDir: join(root, "plugins"),
    lockfilePath: LOCKFILE,
  });
  console.log(`Downloaded ${installed.id}@${installed.version} from "${installed.registryName}"; signature by ${installed.signer.name} (key ${installed.signer.id}) verified.`);
  await bundle(relative(root, installed.directory));
}

async function trust(name, publicKey) {
  if (!name || !publicKey) throw new Error("Usage: pnpm plugin trust <name> <base64 public key>");
  const lockfile = readLockfile();
  const { key, trustedKeys } = await trustedKeysWith(lockfile, name, publicKey);
  writeIfChanged(LOCKFILE, renderLockfile({ ...lockfile, trustedKeys }));
  console.log(`Trusting ${key.name} (key ${key.id}) for \`pnpm plugin add --registry\`. Apps they sign can now be installed.`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const positional = rest.filter((value) => !value.startsWith("--"));
  switch (command) {
    case "trust": {
      const parsed = parseCommandArgs(rest);
      return trust(parsed.positional[0], parsed.positional[1]);
    }
    case "add": {
      const parsed = parseCommandArgs(rest);
      return parsed.flags.has("--registry") ? addFromRegistry(parsed.positional[0], parsed.flags) : add(parsed.positional[0]);
    }
    case "remove":
      return remove(positional[0]);
    case "list":
      return list();
    case "build":
      return buildsFolders(positional) ? buildApps(positional) : build(positional);
    case "sandbox":
      return setSandbox(positional[0]);
    case "wrangler-config": {
      const local = rest.includes("--local");
      const sandbox = pluginSandboxEnabled(readLockfile(), process.env, rest);
      const path = apiWranglerConfig({ local, sandbox, plan: resolvePlan({ args: rest, sandbox }) });
      console.log(relative(API_DIR, path));
      return undefined;
    }
    default:
      if (await runAuthoring(command, rest)) return undefined;
      console.log([...authoringHelp(), ...readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//   pnpm plugin")).map((line) => line.slice(5))].join("\n"));
      if (command && !HELP.has(command)) {
        console.error(`✗ Unknown command: ${command}`);
        process.exitCode = 1;
      }
      return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
