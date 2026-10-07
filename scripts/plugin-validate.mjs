// `pnpm plugin validate [path]`: every check a store makes when it loads a
// plugin, run on the author's machine, reported one line each. Packs nothing
// and writes nothing.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { bundlePlugin, loadPluginContract, pluginPackageDir, resolvePluginEntry, root, sealBundle } from "./plugin-build.mjs";
import { BUNDLE_MAX_BYTES, loadPermissionCheck } from "./plugin-registry.mjs";

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

  const permissions = await loadPermissionCheck();
  if (!permissions) {
    add("note", "Permissions", "Skipped: the permission catalog cannot be loaded from a script. The store checks them when the app is installed.");
  } else if (manifest.permissions.length === 0) {
    add("pass", "Permissions", "none requested");
  } else {
    let bad = 0;
    for (const permission of manifest.permissions) {
      if (!permissions.isKnownPermission(permission)) {
        bad += 1;
        add("fail", "Permissions", `${permission} is not a Scalius permission.`);
      } else if (!permissions.isPluginGrantablePermission(permission)) {
        bad += 1;
        add("fail", "Permissions", `${permission} cannot be granted to an app (staff, agent access, webhooks and app management stay with people).`);
      }
    }
    if (bad === 0) add("pass", "Permissions", manifest.permissions.join(", "));
  }

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

  // The packed bundle also carries the image digests; their size is fixed, so measure with placeholders.
  const size = Buffer.byteLength(sealBundle(bundled, assets));
  if (size > BUNDLE_MAX_BYTES) add("fail", "Bundle size", `${mib(size)} is over the 16 MiB a registry lists.`);
  else if (size > BUNDLE_WARN_BYTES) add("warn", "Bundle size", `${mib(size)} is large; the sandbox loads it on every cold start. Keep it under 1 MiB.`);
  else add("pass", "Bundle size", mib(size));

  return result(manifest.id);
}

const MARK = { pass: "✓", fail: "✗", warn: "!", note: "-" };

export function formatChecks(checks) {
  return checks.map((check) => `${MARK[check.status]} ${check.label}${check.detail ? `: ${check.detail}` : ""}`).join("\n");
}

/** Runs the checks, prints them and sets the exit code. */
export async function runValidate(directory) {
  if (!existsSync(directory)) {
    console.error(`✗ ${relative(root, directory) || directory} does not exist.`);
    process.exitCode = 1;
    return null;
  }
  console.log(`Checking ${relative(process.cwd(), directory) || "."}`);
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
