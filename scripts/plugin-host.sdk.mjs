// The host of the SDK's own CLI, `scalius-plugin` (dist/cli.js in the
// published package): built in place of scripts/plugin-host.mjs by
// scripts/build-plugin-sdk.mjs, with the same exports. The platform contracts
// are compiled in, esbuild is the SDK's dependency, and the SDK is the
// package this file ships in, so no Scalius checkout is needed.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as pluginContract from "../packages/plugin-sdk/tooling/contract.ts";
import * as registryContract from "../packages/plugin-sdk/tooling/registry.ts";

export const CHECKOUT = null;
/** The installed SDK package: this file is its dist/cli.js. */
export const SDK_DIR = resolve(import.meta.dirname, "..");
export const CLI = "npx scalius-plugin";

export function loadEsbuild() {
  return import("esbuild");
}

export async function loadPluginContract() {
  return pluginContract;
}

export async function loadRegistryContract() {
  return registryContract;
}

/** This CLI's own build stamp (dist/build.json): the SDK build it was made with. Null when it has none. */
export function sdkReference() {
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(join(SDK_DIR, "dist/build.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof stamp?.sourceDigest !== "string") return null;
  return {
    digest: stamp.sourceDigest,
    from: `the SDK this ${CLI} came with (${stamp.version})`,
    refresh: "point package.json at the SDK tarball you meant to use and run npm install",
  };
}

/**
 * Packs this SDK, as installed, into `destination` for a new standalone app
 * (`create`): the same files and version the CLI runs from, already built.
 */
export function packSdk(destination) {
  const args = ["pack", SDK_DIR, "--pack-destination", destination, "--ignore-scripts", "--silent"];
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  return { result, command: `npm ${args.join(" ")}` };
}
