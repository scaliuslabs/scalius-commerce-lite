#!/usr/bin/env node
/**
 * Local development ports: the one dev-only source for where the API, the
 * storefront and the dashboard listen, so parallel stacks (agent slots,
 * worktrees) need no hand edits.
 *
 * The source is three process environment variables, read only by dev
 * tooling and never by a Worker (they are not Wrangler `vars`, and nothing is
 * bundled from them except the storefront's `astro dev` API origin):
 *
 *   SCALIUS_DEV_API_PORT         default 8787
 *   SCALIUS_DEV_STOREFRONT_PORT  default 4322
 *   SCALIUS_DEV_ADMIN_PORT       default 4323
 *
 * `bash scripts/dev.sh --api-port 8931 --storefront-port 4531 --admin-port 4532`
 * sets them for every app it starts. Running an app on its own, export them
 * first (see the README "Parallel local stacks").
 *
 * Readers: apps/api `pnpm dev` (wrangler --port), apps/storefront `pnpm dev`
 * (astro --port, and the API origin `astro dev` calls), apps/admin-v2
 * vite.config.ts (port and API proxy target), scripts/dev-doctor.mjs, and
 * `sync-platform` below, which points the local Platform settings document at
 * the same origins.
 *
 *   node scripts/dev-ports.mjs sync-platform [--state <dir>]
 */

import { pathToFileURL } from "node:url";

export const DEFAULT_DEV_PORTS = Object.freeze({ api: 8787, storefront: 4322, admin: 4323 });

export const DEV_PORT_ENV = Object.freeze({
  api: "SCALIUS_DEV_API_PORT",
  storefront: "SCALIUS_DEV_STOREFRONT_PORT",
  admin: "SCALIUS_DEV_ADMIN_PORT",
});

function parsePort(name, raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = String(raw).trim();
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${name} must be a TCP port (1-65535), got '${value}'.`);
  }
  return Number(value);
}

/** The ports of this local stack. Throws on a malformed or duplicated port. */
export function readDevPorts(env = process.env) {
  const ports = {
    api: parsePort(DEV_PORT_ENV.api, env[DEV_PORT_ENV.api], DEFAULT_DEV_PORTS.api),
    storefront: parsePort(DEV_PORT_ENV.storefront, env[DEV_PORT_ENV.storefront], DEFAULT_DEV_PORTS.storefront),
    admin: parsePort(DEV_PORT_ENV.admin, env[DEV_PORT_ENV.admin], DEFAULT_DEV_PORTS.admin),
  };
  if (new Set(Object.values(ports)).size !== 3) {
    throw new Error(`Local dev ports must differ: api ${ports.api}, storefront ${ports.storefront}, admin ${ports.admin}.`);
  }
  return ports;
}

/** Loopback origins of this stack, in the Platform settings shape. */
export function devOrigins(ports = readDevPorts()) {
  const apiUrl = `http://localhost:${ports.api}`;
  return {
    apiUrl,
    storefrontUrl: `http://localhost:${ports.storefront}`,
    dashboardUrl: `http://localhost:${ports.admin}`,
    mediaUrl: `${apiUrl}/api/v1/media`,
  };
}

const PLATFORM_FIELDS = ["storefrontUrl", "apiUrl", "dashboardUrl", "mediaUrl"];

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** SQL truth: the stored field is unset or a loopback URL (local dev owns it). */
function isLocalField(document, field) {
  const value = `json_extract(${document}, '$.${field}')`;
  return `(coalesce(${value}, '') = ''`
    + ` OR ${value} GLOB 'http://localhost' OR ${value} GLOB 'http://localhost[:/]*'`
    + ` OR ${value} GLOB 'http://127.0.0.1' OR ${value} GLOB 'http://127.0.0.1[:/]*'`
    + ` OR ${value} GLOB 'http://[[]::1]*')`;
}

/**
 * One statement that points the local Platform settings document at these
 * origins. Only fields that are unset or already loopback are replaced, so an
 * origin a developer saved in the dashboard (a tunnel, a real domain) stays.
 * The row is created when missing; nothing changes (and the revision stays)
 * when the document already matches.
 */
export function platformSyncSql(origins) {
  const current = "CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END";
  const next = `json_set(${current}, ${PLATFORM_FIELDS.map((field) =>
    `'$.${field}', CASE WHEN ${isLocalField(current, field)} THEN ${sqlString(origins[field])} ELSE json_extract(${current}, '$.${field}') END`,
  ).join(", ")})`;
  const inserted = JSON.stringify(Object.fromEntries(PLATFORM_FIELDS.map((field) => [field, origins[field]])));
  return [
    "INSERT INTO settings (id, key, value, type, category, revision, updated_at)",
    `VALUES ('local_dev_platform', 'document', ${sqlString(inserted)}, 'json', 'platform', 1, unixepoch())`,
    "ON CONFLICT(key, category) DO UPDATE SET",
    `value = ${next}, revision = settings.revision + 1, updated_at = unixepoch()`,
    `WHERE ${next} IS NOT json(${current})`,
    // A row comes back only when the document was created or changed.
    "RETURNING revision",
  ].join(" ");
}

/** KV mirror of the Platform document (packages/core settings store). */
export const PLATFORM_KV_KEY = "settings:platform";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, state: undefined };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--state") options.state = rest[++index];
    else if (arg.startsWith("--state=")) options.state = arg.slice("--state=".length);
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (options.state === "") throw new Error("Option --state requires a value.");
  return options;
}

/** Rows the statement returned (`wrangler d1 execute --json`), or null if unreadable. */
function returnedRows(output) {
  try {
    const results = JSON.parse(output);
    return (Array.isArray(results) ? results : [results])
      .reduce((total, result) => total + (Array.isArray(result?.results) ? result.results.length : 0), 0);
  } catch {
    return null;
  }
}

/**
 * Points the local Platform document at this stack's origins, then drops its
 * KV mirror (a hint the API rebuilds from D1), so the API reads these origins
 * on its next request even when the mirror was stale. Local state only
 * (`wrangler --local`); run it while the API is stopped or before it starts.
 */
export async function syncLocalPlatform({ env = process.env, state } = {}) {
  const { execFileSync } = await import("node:child_process");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { resolveLocalStatePath, resolvePnpmExecutable } = await import("./dev-local-utils.mjs");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const apiDir = resolve(root, "apps", "api");
  const wranglerState = resolveLocalStatePath(root, state || env.SCALIUS_WRANGLER_STATE);
  const origins = devOrigins(readDevPorts(env));
  const pnpm = resolvePnpmExecutable({ env });
  const wrangler = (args, stdio) => execFileSync(pnpm, ["exec", "wrangler", ...args, "--local", "--persist-to", wranglerState], {
    cwd: apiDir,
    encoding: "utf8",
    stdio,
  });

  const output = wrangler(
    ["d1", "execute", "DB", "--config", "wrangler.local.jsonc", "--json", "--command", platformSyncSql(origins)],
    ["ignore", "pipe", "pipe"],
  );
  wrangler(["kv", "key", "delete", PLATFORM_KV_KEY, "--binding", "CACHE", "--config", "wrangler.local.jsonc"], ["ignore", "ignore", "pipe"]);
  return { origins, changed: returnedRows(output) !== 0, wranglerState };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "sync-platform") {
    const { origins, changed } = await syncLocalPlatform({ state: options.state });
    console.log(
      `Local Platform settings ${changed ? "updated" : "already current"}: storefront ${origins.storefrontUrl}, `
      + `API ${origins.apiUrl}, dashboard ${origins.dashboardUrl} (origins saved as non-loopback URLs are kept).`,
    );
    return;
  }
  if (options.command === "print") {
    console.log(JSON.stringify({ ports: readDevPorts(), origins: devOrigins() }, null, 2));
    return;
  }
  console.error("Usage: node scripts/dev-ports.mjs <sync-platform [--state <dir>] | print>");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
