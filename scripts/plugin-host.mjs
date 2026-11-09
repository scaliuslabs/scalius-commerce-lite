// Where the app authoring tools find what they need, for `pnpm plugin` in a
// Scalius checkout: the SDK, esbuild and the platform contracts compiled from
// this checkout's sources. The SDK's own CLI (`scalius-plugin`) runs the same
// scripts with scripts/plugin-host.sdk.mjs in this module's place
// (scripts/build-plugin-sdk.mjs), so an app outside any checkout gets the
// same commands. Both modules export the same names; nothing else in the
// authoring scripts may assume the checkout's layout.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";

/** This Scalius checkout (null in the SDK's CLI). */
export const CHECKOUT = resolve(import.meta.dirname, "..");
/** The SDK an app falls back to before its own install. */
export const SDK_DIR = join(CHECKOUT, "packages/plugin-sdk");
/** The command a developer types, for messages. */
export const CLI = "pnpm plugin";

const requireFromCheckout = createRequire(join(CHECKOUT, "package.json"));

/** esbuild, resolved from the checkout. */
export async function loadEsbuild() {
  return import(pathToFileURL(requireFromCheckout.resolve("esbuild")).href);
}

async function compile(entry) {
  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

let pluginContract = null;
let registryContract = null;

/** The plugin contract (manifest parser, handler check, storefront rules and fixtures) compiled for Node. */
export function loadPluginContract() {
  pluginContract ??= compile(join(SDK_DIR, "tooling/contract.ts"));
  return pluginContract;
}

/** The signed registry format compiled for Node. */
export function loadRegistryContract() {
  registryContract ??= compile(join(SDK_DIR, "tooling/registry.ts"));
  return registryContract;
}

/**
 * A fingerprint of the sources an SDK build is made from (the SDK and the
 * shared contract it re-exports, tests left out). The build stamps it into
 * `dist/build.json`; `validate` compares an app's installed build with this
 * checkout's, so a tarball packed before a change (a new scope, a new
 * operation) is named instead of silently typing an older platform.
 */
export function sdkSourceDigest() {
  const hash = createHash("sha256");
  const files = [join(SDK_DIR, "package.json"), ...[join(SDK_DIR, "src"), join(CHECKOUT, "packages/shared/src")].flatMap(listSourceFiles)]
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file))
    .sort();
  for (const file of files) hash.update(relative(CHECKOUT, file)).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

function listSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listSourceFiles(path) : [path];
  });
}

/**
 * The SDK build an app's installed SDK should match: this checkout's
 * sources, and how to repack them into the app.
 */
export function sdkReference() {
  return {
    digest: sdkSourceDigest(),
    from: "this checkout's sources",
    refresh: `pnpm --dir ${SDK_DIR} pack --pack-destination <app>/vendor, point package.json at the new tarball and npm install`,
  };
}

/**
 * Packs the SDK into `destination` for a standalone app (`create`): `pnpm
 * pack`, whose prepack builds `dist/` (the published layout) from this
 * checkout. Returns the process result and the command, for a failure.
 */
export function packSdk(destination) {
  const args = ["--dir", SDK_DIR, "pack", "--pack-destination", destination];
  // The pack builds the SDK first (its prepack); keep that output, so a failure says what happened.
  const result = spawnSync(resolvePnpmExecutable(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return { result, command: `pnpm ${args.join(" ")}` };
}
