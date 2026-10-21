#!/usr/bin/env node
// `pnpm plugin <command>`: the operator's tool for bundled plugins
// (packages/plugin-sdk/docs/apps.md). Plugins compiled into the API Worker are listed
// in scalius.plugins.json; this keeps that lockfile, the generated
// apps/api/src/plugins/bundled.gen.ts, the plugins' listing images
// (assets.gen.ts), the catalog of first-party plugins not bundled
// (catalog.gen.ts) and the sandbox wrapper in step.
//
//   pnpm plugin create <vendor.name> [--dir <folder>]          scaffold an app (outside this repo: on a packed SDK build)
//   pnpm plugin validate [path]                                check a plugin the way a store loads it
//   pnpm plugin preview <path> [--out <html>] [--fixture <json>]   render storefront fixtures to a static HTML file
//   pnpm plugin dev <path> [--fixture <json>]                 rebuild and preview fixtures as sources change
//   pnpm plugin pack <path> [--key <pem | folder>] [--developer <name>]   pack, sign and zip a plugin for upload or a registry
//   pnpm plugin keygen <out-dir>                               make an Ed25519 signing key
//   pnpm plugin index <dist-dir> ... --out <dir> --name <name> [--base-url <url>]   build a static registry
//   pnpm plugin add <path | package>                           pack, check and bundle a plugin
//   pnpm plugin add <vendor.name> --registry <index url> [--version <v>]   install a signed release from a registry
//   pnpm plugin trust <name> <public key>                      trust a developer's signing key
//   pnpm plugin remove <plugin id>                             stop bundling a plugin
//   pnpm plugin list                                           what is bundled, and whether it is current
//   pnpm plugin build [plugin id ...]                          repack bundled plugins, regenerate the wrapper
//   pnpm plugin sandbox <on|off>                               record the operator's sandbox choice
//   pnpm plugin wrangler-config [--local] [--plan paid]        print the API Wrangler config to use

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  buildRegistry,
  generateSigningKey,
  installFromRegistry,
  loadRegistryContract,
  packSigned,
  parseCommandArgs,
  trustedKeysWith,
  userPath,
} from "./plugin-registry.mjs";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";
import {
  scaffoldFiles,
  sdkRefreshCommand,
  sdkTarballName,
  SDK_VENDOR_DIR,
  standaloneNextSteps,
  vendoredSdkDependency,
} from "./plugin-scaffold.mjs";
import { runValidate } from "./plugin-validate.mjs";
import { devPlugin, previewPlugin, readPreviewFixture } from "./plugin-dev.mjs";
import { stripJsonc } from "./check-worker-env.mjs";
import { resolvePlan, withPlanProfile } from "./plan.mjs";

export { pluginSandboxEnabled, scaffoldFiles };

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
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
  const runtime = writeIfChanged(SANDBOX_RUNTIME_GEN, renderSandboxRuntimeGen(await buildSandboxRuntime()));
  const packed = await packForGenerated(lockfile);
  const assets = writeIfChanged(ASSETS_GEN, renderAssetsGen([...packed.bundled, ...packed.catalog]));
  const catalog = writeIfChanged(CATALOG_GEN, renderCatalogGen(packed.catalog));
  for (const path of writeStorefrontGenerated(lockfile, packed.bundled)) console.log(`Updated ${relative(root, path)}`);
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

/** Whether `directory` is a package of this workspace (pnpm-workspace.yaml: apps/*, packages/*, plugins/*). */
export function isWorkspacePackageDir(directory) {
  const path = relative(root, directory).split("\\").join("/");
  return /^(?:apps|packages|plugins)\/[^/]+$/.test(path);
}

/** The SDK release a standalone app is scaffolded on. */
export function sdkVersion() {
  return JSON.parse(readFileSync(join(root, "packages/plugin-sdk/package.json"), "utf8")).version;
}

/** An absolute path as a user types it in a shell: `~` for the home folder, quoted when it has a space. */
export function shellPath(path, home = homedir()) {
  if (/[\s'"]/.test(path)) return `'${path.replaceAll("'", "'\\''")}'`;
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * `@scalius/plugin-sdk` is not on the npm registry yet, so a standalone app
 * installs this checkout's SDK build: `pnpm pack` (its prepack builds
 * `dist/`, the published layout) into `<app>/vendor/`.
 */
function packSdkInto(directory) {
  const destination = join(directory, SDK_VENDOR_DIR);
  mkdirSync(destination, { recursive: true });
  const result = spawnSync(resolvePnpmExecutable(), ["--dir", join(root, "packages/plugin-sdk"), "pack", "--pack-destination", destination], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const tarball = join(destination, sdkTarballName(sdkVersion()));
  if (result.status !== 0 || !existsSync(tarball)) {
    throw new Error(`Could not pack the SDK into ${destination} (pnpm pack exited ${result.status ?? "by signal"}).`);
  }
}

function create(id, args) {
  if (!id || !PLUGIN_ID.test(id)) throw new Error("Usage: pnpm plugin create <vendor.name> [--dir <folder>] (lowercase, e.g. acme.loyalty)");
  const flags = parseCommandArgs(args).flags;
  const name = id.split(".")[1];
  const dir = flags.get("--dir");
  const directory = typeof dir === "string" ? userPath(dir) : join(root, "plugins", name);
  const shown = relative(process.env.INIT_CWD || process.cwd(), directory) || ".";
  if (existsSync(directory)) throw new Error(`${shown} already exists.`);
  const standalone = !isWorkspacePackageDir(directory);
  const version = sdkVersion();
  if (standalone) {
    try {
      packSdkInto(directory);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  const options = standalone ? { standalone, sdkVersion: version, sdkDependency: vendoredSdkDependency(version) } : { standalone };
  for (const [file, contents] of Object.entries(scaffoldFiles(id, basename(directory), options))) {
    const path = join(directory, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  if (standalone) {
    const paths = { repo: shellPath(root), app: shellPath(directory) };
    const steps = standaloneNextSteps({ ...paths, version });
    console.log(`Created ${paths.app}: a standalone app on this checkout's SDK build, ${SDK_VENDOR_DIR}/${sdkTarballName(version)}.
@scalius/plugin-sdk is not on npm yet: keep the tarball in the app's repository. Then:
${steps.map(([command, purpose]) => `  ${purpose}:\n    ${command}`).join("\n")}
For a newer SDK build, repack it, point package.json at the new file and npm install:
    ${sdkRefreshCommand(paths)}`);
    return;
  }
  const where = relative(root, directory);
  console.log(`Created ${where}. Run pnpm install, then:
  pnpm --dir ${where} test         run its tests
  pnpm plugin dev ${where}         watch and preview its components
  pnpm plugin validate ${where}    check it the way a store loads it
  pnpm plugin add ${where}         bundle it into this store`);
}

async function validate(target) {
  await runValidate(userPath(target ?? "."));
}

async function pack(target, flags) {
  if (!target) throw new Error("Usage: pnpm plugin pack <path> [--key <pem | folder>] [--developer <name>]");
  const key = flags.get("--key");
  const packed = await packSigned(userPath(target), {
    key: typeof key === "string" ? userPath(key) : null,
    developer: typeof flags.get("--developer") === "string" ? flags.get("--developer") : null,
  });
  console.log(`Packed ${packed.id}@${packed.version} (${packed.sha256.slice(0, 12)}) in ${relative(process.cwd(), packed.dist) || "dist"}`);
  const { pluginKeyFingerprint } = await loadRegistryContract();
  console.log(packed.signature
    ? `Signed with key ${pluginKeyFingerprint(packed.signature.keyId)} (labelled "${packed.signature.developer}"). A store trusts the key, not the label: give merchants this fingerprint so they can check it before they trust your key.`
    : "Not signed: a store needs a Super Admin to accept it as unsigned. Sign it with --key <folder> (make a key with: pnpm plugin keygen <folder>).");
  console.log(`Upload package: ${relative(process.cwd(), packed.zipPath)}`);
}

async function keygen(outDir) {
  if (!outDir) throw new Error("Usage: pnpm plugin keygen <out-dir>");
  const directory = userPath(outDir);
  const key = await generateSigningKey(directory);
  console.log(`Private key: ${key.keyFile}`);
  console.log(`Public key:  ${key.publicKey}`);
  const { pluginKeyFingerprint } = await loadRegistryContract();
  console.log(`Key fingerprint: ${pluginKeyFingerprint(key.keyId)}`);
  console.log("Give merchants this fingerprint: the dashboard shows it before a store trusts your key.");
  console.log("\nKeep the private key out of this repository and out of version control: anyone who has it can publish apps as you.");
  if (!relative(root, directory).startsWith("..")) {
    console.log("! This folder is inside the repository. Move signing-key.pem somewhere private before you commit anything.");
  }
  console.log(`Sign a pack with: pnpm plugin pack <app> --key ${outDir}`);
  console.log("Share the public key: stores add it with `pnpm plugin trust <your name> <public key>`.");
}

async function index(distDirs, flags) {
  const out = flags.get("--out");
  if (typeof out !== "string") throw new Error("Usage: pnpm plugin index <dist-dir> [<dist-dir> ...] --out <registry-dir> --name <registry name> [--base-url <url>]");
  const { index: written, added } = await buildRegistry(distDirs.map((dir) => userPath(dir)), {
    out: userPath(out),
    name: typeof flags.get("--name") === "string" ? flags.get("--name") : null,
  });
  for (const entry of added) console.log(`Listed ${entry.id}@${entry.version} (${entry.sha256.slice(0, 12)}, ${entry.size} bytes)`);
  console.log(`Wrote ${join(relative(process.cwd(), userPath(out)) || ".", "index.json")}: ${written.apps.length} release${written.apps.length === 1 ? "" : "s"} in "${written.name}".`);
  const baseUrl = flags.get("--base-url");
  if (typeof baseUrl === "string") {
    const indexUrl = `${baseUrl.replace(/\/+$/, "")}/index.json`;
    console.log(`Serve the folder over https at ${baseUrl}. Stores add ${indexUrl}; on Workers Free: pnpm plugin add <vendor.name> --registry ${indexUrl}`);
  }
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
  await add(relative(root, installed.directory));
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
    case "create":
      return create(parseCommandArgs(rest).positional[0], rest);
    case "validate":
      return validate(parseCommandArgs(rest).positional[0]);
    case "dev":
    case "preview": {
      const parsed = parseCommandArgs(rest);
      if (!parsed.positional[0]) throw new Error(`Usage: pnpm plugin ${command} <path>`);
      const directory = userPath(parsed.positional[0]);
      const fixturePath = parsed.flags.get("--fixture");
      const options = typeof fixturePath === "string" ? { fixture: readPreviewFixture(userPath(fixturePath)) } : {};
      const out = parsed.flags.get("--out");
      if (command === "dev") return devPlugin(directory, typeof out === "string" ? userPath(out) : undefined, options);
      const preview = await previewPlugin(directory, typeof out === "string" ? userPath(out) : undefined, options);
      console.log(`${preview.id}: ${preview.views} fixture view(s). Open ${pathToFileURL(preview.output).href}`);
      if (preview.empty.length > 0) console.log(`! ${preview.empty.join(", ")} rendered nothing with these fixtures; pass the fields or records it reads with --fixture <json>.`);
      return undefined;
    }
    case "pack": {
      const parsed = parseCommandArgs(rest);
      return pack(parsed.positional[0], parsed.flags);
    }
    case "keygen":
      return keygen(parseCommandArgs(rest).positional[0]);
    case "index": {
      const parsed = parseCommandArgs(rest);
      return index(parsed.positional, parsed.flags);
    }
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
