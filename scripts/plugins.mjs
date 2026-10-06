#!/usr/bin/env node
// `pnpm plugin <command>`: the operator's tool for bundled plugins
// (docs/platform/PLUGINS.md). Plugins compiled into the API Worker are listed
// in scalius.plugins.json; this keeps that lockfile, the generated
// apps/api/src/plugins/bundled.gen.ts, the plugins' listing images
// (assets.gen.ts), the catalog of first-party plugins not bundled
// (catalog.gen.ts) and the sandbox wrapper in step.
//
//   pnpm plugin create <vendor.name> [--dir plugins/<name>]   scaffold a plugin package
//   pnpm plugin add <path | package>                           pack, check and bundle a plugin
//   pnpm plugin remove <plugin id>                             stop bundling a plugin
//   pnpm plugin list                                           what is bundled, and whether it is current
//   pnpm plugin build [plugin id ...]                          repack bundled plugins, regenerate the wrapper
//   pnpm plugin sandbox <on|off>                               record the operator's sandbox choice
//   pnpm plugin wrangler-config [--local] [--plan paid]        print the API Wrangler config to use

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ASSETS_GEN,
  BUNDLED_GEN,
  CATALOG_GEN,
  LOCKFILE,
  SANDBOX_RUNTIME_GEN,
  buildSandboxRuntime,
  isPathSource,
  packForGenerated,
  packPlugin,
  readLockfile,
  renderAssetsGen,
  renderBundledGen,
  renderCatalogGen,
  renderLockfile,
  renderSandboxRuntimeGen,
  root,
  writeIfChanged,
} from "./plugin-build.mjs";
import { stripJsonc } from "./check-worker-env.mjs";
import { resolvePlan, withPlanProfile } from "./plan.mjs";

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const API_DIR = join(root, "apps/api");

/** The sandbox is on when the lockfile says so or the operator asks for it for one run. */
export function pluginSandboxEnabled(lockfile, env = process.env, args = []) {
  return args.includes("--plugin-sandbox") || env.SCALIUS_PLUGIN_SANDBOX === "1" || lockfile.sandbox === true;
}

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
  const runtime = writeIfChanged(SANDBOX_RUNTIME_GEN, renderSandboxRuntimeGen(await buildSandboxRuntime()));
  const packed = await packForGenerated(lockfile);
  const assets = writeIfChanged(ASSETS_GEN, renderAssetsGen([...packed.bundled, ...packed.catalog]));
  const catalog = writeIfChanged(CATALOG_GEN, renderCatalogGen(packed.catalog));
  if (bundled) console.log(`Updated ${relative(root, BUNDLED_GEN)}`);
  if (runtime) console.log(`Updated ${relative(root, SANDBOX_RUNTIME_GEN)}`);
  if (assets) console.log(`Updated ${relative(root, ASSETS_GEN)}`);
  if (catalog) console.log(`Updated ${relative(root, CATALOG_GEN)}`);
}

function normalizeSource(source) {
  if (!isPathSource(source)) return source;
  const path = relative(root, resolve(root, source)).split("\\").join("/");
  if (path.startsWith("..")) throw new Error(`${source} is outside the repository; publish it as a package instead.`);
  return path;
}

async function add(source) {
  if (!source) throw new Error("Usage: pnpm plugin add <path | package>");
  const normalized = normalizeSource(source);
  const packed = await packPlugin(normalized);
  const lockfile = readLockfile();
  const entry = { id: packed.id, version: packed.version, source: normalized, sha256: packed.sha256 };
  lockfile.plugins = [...lockfile.plugins.filter((plugin) => plugin.id !== packed.id), entry];
  await regenerate(lockfile);
  console.log(`Bundled ${packed.id}@${packed.version} (${packed.sha256.slice(0, 12)}). Deploy, then update its installation in the dashboard.`);
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

export function scaffoldFiles(id, name) {
  const title = name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return {
    "package.json": `${JSON.stringify({
      name: `@scalius/plugin-${name}`,
      version: "0.1.0",
      private: true,
      type: "module",
      license: "AGPL-3.0-only",
      exports: { ".": "./src/index.ts" },
      scripts: { test: "vitest run", typecheck: "../../node_modules/typescript7/bin/tsc --noEmit" },
      dependencies: { "@scalius/plugin-sdk": "workspace:*" },
      devDependencies: { "@scalius/tsconfig": "workspace:*", vitest: "^4.1.11" },
    }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({
      extends: "@scalius/tsconfig/base.json",
      compilerOptions: { types: [], lib: ["ES2022", "DOM"], paths: { "@scalius/shared/*": ["../../packages/shared/src/*"] } },
      include: ["src/**/*"],
    }, null, 2)}\n`,
    "src/index.ts": `import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(title)},
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Describe what ${title} does for the merchant.",
  author: { name: ${JSON.stringify(id.split(".")[0])} },
  permissions: ["orders.view"],
  events: ["order.created"],
  routes: { admin: [], public: [{ name: "status", methods: ["GET"] }], webhooks: [] },
  settings: [{ key: "enabled_message", label: "Message", type: "text", default: "Hello" }],
} satisfies PluginManifestInput;

export default definePlugin({
  manifest,
  events: {
    "order.created": async (event, ctx) => {
      ctx.log.info("Order created", { orderId: event.resource.id });
    },
  },
  routes: {
    public: {
      status: async (_request, ctx) => ({ body: { message: String(ctx.settings.enabled_message ?? "") } }),
    },
  },
});
`,
  };
}

function create(id, args) {
  if (!id || !PLUGIN_ID.test(id)) throw new Error("Usage: pnpm plugin create <vendor.name> (lowercase, e.g. acme.loyalty)");
  const dirIndex = args.indexOf("--dir");
  const name = id.split(".")[1];
  const directory = resolve(root, dirIndex === -1 ? `plugins/${name}` : args[dirIndex + 1] ?? "");
  if (existsSync(directory)) throw new Error(`${relative(root, directory)} already exists.`);
  for (const [file, contents] of Object.entries(scaffoldFiles(id, basename(directory)))) {
    const path = join(directory, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  console.log(`Created ${relative(root, directory)}. Run pnpm install, then pnpm plugin add ${relative(root, directory)}.`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const positional = rest.filter((value) => !value.startsWith("--"));
  switch (command) {
    case "create":
      return create(positional[0], rest);
    case "add":
      return add(positional[0]);
    case "remove":
      return remove(positional[0]);
    case "list":
      return list();
    case "build":
      return build(positional);
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
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//   pnpm plugin")).map((line) => line.slice(3)).join("\n"));
      if (command && command !== "help") process.exitCode = 1;
      return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
