// The app author's commands: one implementation for `pnpm plugin` in a
// Scalius checkout (scripts/plugins.mjs) and for the SDK's own CLI,
// `scalius-plugin` (scripts/plugin-sdk-cli.mjs), which an app outside any
// checkout runs from its installed SDK. Where they differ is the host
// (scripts/plugin-host.mjs): where the SDK, esbuild and the contracts come
// from, and what the command is called.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packPlugin } from "./plugin-build.mjs";
import { devPlugin, previewPlugin, readPreviewFixture } from "./plugin-dev.mjs";
import { CHECKOUT, CLI, packSdk } from "./plugin-host.mjs";
import {
  buildRegistry,
  generateSigningKey,
  isPackedRelease,
  loadRegistryContract,
  packSigned,
  parseCommandArgs,
  readPackedRelease,
  shownPath,
  userPath,
} from "./plugin-registry.mjs";
import { scaffoldFiles, sdkRefreshCommand, sdkTarballName, sdkVersion, SDK_VENDOR_DIR, standaloneNextSteps, vendoredSdkDependency } from "./plugin-scaffold.mjs";

export { sdkVersion };
import { runValidate } from "./plugin-validate.mjs";

export const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** The authoring commands, as `--help` lists them (`<app>` defaults to the current folder). */
export const AUTHORING_USAGE = [
  ["create <vendor.name> [--storefront | --theme] [--dir <folder>]", "scaffold an app (with a storefront section), or a theme starter"],
  ["validate [app]", "check an app the way a store loads it"],
  ["build [app]", "pack an app into its dist/ folder"],
  ["preview [app] [--store sample|empty|other] [--out <html>] [--fixture <json>]", "render storefront parts on three fixture stores (or one) to a static HTML file"],
  ["dev [app] [--store sample|empty|other] [--fixture <json>]", "rebuild and preview fixtures as sources change"],
  ["pack [app] [--key <pem | folder>] [--developer <name>]", "pack, sign and zip an app for upload or a registry"],
  ["verify [zip | dist | app]", "check a packed app the way a store checks an upload"],
  ["keygen <out-dir>", "make an Ed25519 signing key"],
  ["index <dist-dir> ... --out <dir> --name <name> [--base-url <url>]", "build a static registry"],
];

export function authoringHelp() {
  return AUTHORING_USAGE.map(([usage, purpose]) => `${CLI} ${usage}`.padEnd(64) + `  ${purpose}`);
}

/** Whether `directory` is a package of the checkout's workspace (pnpm-workspace.yaml: apps/*, packages/*, plugins/*). */
export function isWorkspacePackageDir(directory) {
  if (!CHECKOUT) return false;
  const path = relative(CHECKOUT, directory).split("\\").join("/");
  return /^(?:apps|packages|plugins)\/[^/]+$/.test(path);
}

/**
 * The app a command acts on: the path given, else the nearest folder with a
 * package.json from where the command ran (`npm run validate` in a subfolder
 * still checks the app).
 */
export function appPath(target) {
  if (target !== undefined) return userPath(target);
  const start = userPath(".");
  for (let current = start; ; current = dirname(current)) {
    if (existsSync(join(current, "package.json"))) return current;
    if (dirname(current) === current) return start;
  }
}

/** An absolute path as a user types it in a shell: `~` for the home folder, quoted when it has a space. */
export function shellPath(path, home = homedir()) {
  if (/[\s'"]/.test(path)) return `'${path.replaceAll("'", "'\\''")}'`;
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * `@scalius/plugin-sdk` is not on the npm registry yet, so a standalone app
 * installs the host's SDK build, packed into `<app>/vendor/` (in a checkout
 * its prepack builds `dist/` first).
 */
function packSdkInto(directory) {
  const destination = join(directory, SDK_VENDOR_DIR);
  mkdirSync(destination, { recursive: true });
  const { result, command } = packSdk(destination);
  const tarball = join(destination, sdkTarballName(sdkVersion()));
  if (result.status !== 0 || !existsSync(tarball)) throw new Error(packFailure(result, command));
}

/** Why packing the SDK failed: how the command ended and the end of its output (the SDK build's errors are in it). */
export function packFailure(result, command) {
  const how = result.error ? `could not start (${result.error.message})`
    : result.signal ? `was stopped by ${result.signal}${result.signal === "SIGKILL" ? " (out of memory?)" : ""}`
      : result.status === 0 ? "wrote no tarball" : `exited ${result.status}`;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").map((line) => line.trimEnd())
    .filter((line) => line && !/^(?:examples|docs|dist)\/|^[A-Za-z-]+\.(?:md|json)$|^LICENSE$|^PLUGIN-EXCEPTION$/.test(line));
  return [
    `Could not pack the SDK: \`${command}\` ${how}.`,
    ...(output.length > 0 ? ["Its output ended with:", ...output.slice(-30).map((line) => `  ${line}`)] : []),
    `Nothing was created. Fix the error above, then run ${CLI} create again.`,
  ].join("\n");
}

function create(id, args) {
  if (!id || !PLUGIN_ID.test(id)) throw new Error(`Usage: ${CLI} create <vendor.name> [--storefront | --theme] [--dir <folder>] (lowercase, e.g. acme.loyalty)`);
  const flags = parseCommandArgs(args).flags;
  const name = id.split(".")[1];
  const dir = flags.get("--dir");
  // In a checkout an app is a workspace package by default; anywhere else, a folder where the command ran.
  const directory = typeof dir === "string" ? userPath(dir) : CHECKOUT ? join(CHECKOUT, "plugins", name) : userPath(name);
  const shown = shownPath(directory);
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
  const theme = flags.has("--theme");
  const storefront = flags.has("--storefront");
  const repo = CHECKOUT ? shellPath(CHECKOUT) : undefined;
  const options = standalone
    ? { standalone, theme, storefront, sdkVersion: version, sdkDependency: vendoredSdkDependency(version), repo, app: shellPath(directory) }
    : { standalone, theme, storefront, app: relative(CHECKOUT, directory) };
  for (const [file, contents] of Object.entries(scaffoldFiles(id, basename(directory), options))) {
    const path = join(directory, file);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  if (standalone) {
    const paths = { repo, app: shellPath(directory) };
    const steps = standaloneNextSteps({ ...paths, version });
    console.log(`Created ${paths.app}: a standalone app on the SDK build ${SDK_VENDOR_DIR}/${sdkTarballName(version)}.
@scalius/plugin-sdk is not on npm yet: keep the tarball in the app's repository. Then:
${steps.map(([command, purpose]) => `  ${purpose}:\n    ${command}`).join("\n")}
For a newer SDK, replace the tarball, point package.json at the new file and npm install${repo ? `:\n    ${sdkRefreshCommand(paths)}` : " (the SDK README, Upgrade the SDK)."}`);
    return;
  }
  const where = relative(CHECKOUT, directory);
  console.log(`Created ${where}${theme ? " (a theme starter)" : ""}. Its AGENTS.md has the rules for you and your AI agent. Run pnpm install, then:
  pnpm --dir ${where} test         run its tests
  pnpm plugin dev ${where}         watch and preview its components
  pnpm plugin preview ${where}     render it on a sample, an empty and another store
  pnpm plugin validate ${where}    check it the way a store loads it
  pnpm plugin add ${where}         bundle it into this store`);
}

/** Packs each app into its `dist/` (the bundle, manifest, images and storefront files), nothing signed or zipped. */
export async function buildApps(targets) {
  for (const directory of targets.length > 0 ? targets.map(appPath) : [appPath()]) {
    const packed = await packPlugin(directory);
    console.log(`Built ${packed.id}@${packed.version} (${packed.sha256.slice(0, 12)}) in ${shownPath(join(directory, "dist"))}`);
  }
}

async function pack(target, flags) {
  const key = flags.get("--key");
  const packed = await packSigned(appPath(target), {
    key: typeof key === "string" ? userPath(key) : null,
    developer: typeof flags.get("--developer") === "string" ? flags.get("--developer") : null,
  });
  console.log(`Packed ${packed.id}@${packed.version} (${packed.sha256.slice(0, 12)}) in ${shownPath(packed.dist)}`);
  const { pluginKeyFingerprint } = await loadRegistryContract();
  console.log(packed.signature
    ? `Signed with key ${pluginKeyFingerprint(packed.signature.keyId)} (labelled "${packed.signature.developer}"). A store trusts the key, not the label: give merchants this fingerprint so they can check it before they trust your key.`
    : `Not signed: a store needs a Super Admin to accept it as unsigned. Sign it with --key <folder> (make a key with: ${CLI} keygen <folder>).`);
  console.log(`Upload package: ${shownPath(packed.zipPath)}`);
}

/**
 * The packed release `verify` checks: a ZIP or `dist` folder as given, or an
 * app folder's own upload ZIP (`dist/<id>-<version>.zip`, what `pack` wrote).
 */
export function releaseToVerify(path) {
  if (isPackedRelease(path)) return path;
  const dist = join(path, "dist");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  } catch {
    throw new Error(`${shownPath(path)} is neither a packed app (an upload ZIP or a dist folder) nor an app with one: run ${CLI} pack first.`);
  }
  const zip = join(dist, `${manifest.id}-${manifest.version}.zip`);
  return existsSync(zip) ? zip : dist;
}

async function verify(target) {
  const path = releaseToVerify(appPath(target));
  const release = await readPackedRelease(path);
  const parts = [`bundle ${release.sha256.slice(0, 12)}`, `${release.assets.length} listing image(s)`, `${release.storefront.length} storefront file(s)`];
  console.log(`✓ ${shownPath(path)}: ${release.id}@${release.version} (${parts.join(", ")})`);
  console.log(release.signer
    ? `✓ Signed by "${release.signer.name}", key ${release.signer.fingerprint}: the signature matches the code and manifest.`
    : "- Not signed: a store installs it only after a Super Admin accepts it as unsigned.");
}

async function keygen(outDir) {
  if (!outDir) throw new Error(`Usage: ${CLI} keygen <out-dir>`);
  const directory = userPath(outDir);
  const key = await generateSigningKey(directory);
  console.log(`Private key: ${key.keyFile}`);
  console.log(`Public key:  ${key.publicKey}`);
  const { pluginKeyFingerprint } = await loadRegistryContract();
  console.log(`Key fingerprint: ${pluginKeyFingerprint(key.keyId)}`);
  console.log("Give merchants this fingerprint: the dashboard shows it before a store trusts your key.");
  console.log("\nKeep the private key out of every repository and out of version control: anyone who has it can publish apps as you.");
  const workspace = CHECKOUT ?? userPath(".");
  if (!relative(workspace, directory).startsWith("..")) {
    console.log(`! This folder is inside ${CHECKOUT ? "the repository" : "the folder you ran this in"}. Move signing-key.pem somewhere private before you commit anything.`);
  }
  console.log(`Sign a pack with: ${CLI} pack <app> --key ${outDir}`);
  console.log("Share the public key: stores add it with `pnpm plugin trust <your name> <public key>`.");
}

async function index(distDirs, flags) {
  const out = flags.get("--out");
  if (typeof out !== "string") throw new Error(`Usage: ${CLI} index <dist-dir> [<dist-dir> ...] --out <registry-dir> --name <registry name> [--base-url <url>]`);
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

async function preview(command, rest) {
  const parsed = parseCommandArgs(rest);
  const directory = appPath(parsed.positional[0]);
  const fixturePath = parsed.flags.get("--fixture");
  const store = parsed.flags.get("--store");
  const options = {
    ...(typeof fixturePath === "string" ? { fixture: readPreviewFixture(userPath(fixturePath)) } : {}),
    // All three fixture stores unless --store names one (sample, empty or other).
    ...(typeof store === "string" ? { stores: [store] } : {}),
  };
  const out = parsed.flags.get("--out");
  if (command === "dev") return devPlugin(directory, typeof out === "string" ? userPath(out) : undefined, options);
  const shown = await previewPlugin(directory, typeof out === "string" ? userPath(out) : undefined, options);
  console.log(`${shown.id}: ${shown.views} fixture view(s) on the ${shown.stores.join(", ")} store${shown.stores.length === 1 ? "" : "s"}. Open ${pathToFileURL(shown.output).href}`);
  if (shown.emptyOn.sample?.length > 0) console.log(`! ${shown.emptyOn.sample.join(", ")} rendered nothing on the sample store; pass the fields or records it reads with --fixture <json>.`);
  for (const name of shown.stores.filter((each) => each !== "sample" && shown.emptyOn[each].length > 0)) {
    console.log(`- ${shown.emptyOn[name].join(", ")} rendered nothing on the ${name} store: right when there is nothing to show, wrong if buyers lose something they need.`);
  }
  return undefined;
}

/**
 * Runs an authoring command. Returns false for a command it does not know
 * (`build` with plugin ids and `add` are the checkout's own: scripts/plugins.mjs).
 */
export async function runAuthoring(command, rest) {
  const parsed = () => parseCommandArgs(rest);
  switch (command) {
    case "create":
      create(parsed().positional[0], rest);
      return true;
    case "validate":
      await runValidate(appPath(parsed().positional[0]));
      return true;
    case "dev":
    case "preview":
      await preview(command, rest);
      return true;
    case "pack":
      await pack(parsed().positional[0], parsed().flags);
      return true;
    case "verify":
      await verify(parsed().positional[0]);
      return true;
    case "keygen":
      await keygen(parsed().positional[0]);
      return true;
    case "index":
      await index(parsed().positional, parsed().flags);
      return true;
    default:
      return false;
  }
}

/** Whether every `build` argument is an app folder (not a bundled plugin id). */
export function buildsFolders(targets) {
  return targets.length > 0 && targets.every((target) => {
    try {
      return statSync(userPath(target)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * `add` from the SDK's CLI: installing an app into a store is the store
 * checkout's job, so this runs that checkout's `pnpm plugin add` on the app.
 */
export function addThroughCheckout(target, flags) {
  const checkout = flags.get("--scalius");
  const app = appPath(target);
  if (typeof checkout !== "string") {
    throw new Error(`add installs the app into a Scalius store you run: ${CLI} add [app] --scalius <your Scalius checkout> (it runs pnpm --dir <checkout> plugin add ${shellPath(app)}). On a Workers Paid store, upload the ZIP that ${CLI} pack wrote on the Apps page instead.`);
  }
  const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--dir", userPath(checkout), "plugin", "add", app], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw new Error(`Could not run pnpm in ${shellPath(userPath(checkout))}: ${result.error.message}`);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
