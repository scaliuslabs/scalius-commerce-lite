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
 *   node scripts/dev-ports.mjs api-worker-name       # scalius-api-local[-<api port>]
 *   node scripts/dev-ports.mjs storefront-config     # built storefront bound to it
 *   node scripts/dev-ports.mjs verify-binding        # the storefront reached this API
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

/**
 * Worker name of the local API. Wrangler's dev registry is global to the
 * machine, so two local APIs with one name compete for it and a built
 * storefront's service binding can reach the other stack's API. The default
 * stack keeps `scalius-api-local`; a stack on another API port is
 * `scalius-api-local-<port>`. apps/api `pnpm dev` passes it as `--name`.
 */
export const DEFAULT_API_WORKER_NAME = "scalius-api-local";

export function devApiWorkerName(ports = readDevPorts()) {
  return ports.api === DEFAULT_DEV_PORTS.api ? DEFAULT_API_WORKER_NAME : `${DEFAULT_API_WORKER_NAME}-${ports.api}`;
}

/**
 * A built storefront's `dist/server/wrangler.json` rebound for a local stack:
 * no production route, BACKEND_API pointed at this stack's API worker name,
 * and the stack's storefront port. Returns a new object.
 */
export function localStorefrontWorkerConfig(builtConfig, { apiWorkerName, port, inspectorPort } = {}) {
  if (!apiWorkerName) throw new Error("localStorefrontWorkerConfig needs apiWorkerName");
  const config = structuredClone(builtConfig);
  delete config.routes;
  const services = config.services ?? [];
  if (!services.some((s) => s.binding === "BACKEND_API")) throw new Error("The built storefront config has no BACKEND_API service binding.");
  config.services = services.map((s) => (s.binding === "BACKEND_API" ? { ...s, service: apiWorkerName } : s));
  config.dev = {
    ...(config.dev ?? {}),
    ...(port ? { port } : {}),
    ...(inspectorPort ? { inspector_port: inspectorPort } : {}),
    enable_containers: false,
  };
  return config;
}

const CANONICAL_PATTERNS = [
  /<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["']/i,
  /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["']/i,
  /<meta\b[^>]*\bproperty=["']og:url["'][^>]*\bcontent=["']([^"']+)["']/i,
];

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Problems with a storefront home page rendered through its API: the
 * canonical URL comes from the Platform document of the API that answered,
 * and media URLs from its media origin. A storefront bound to another local
 * stack's API renders that stack's origins. Empty array when it matches.
 */
export function storefrontBindingProblems(html, { storefrontUrl, mediaUrl } = {}) {
  const problems = [];
  const canonical = CANONICAL_PATTERNS.map((p) => p.exec(html)?.[1]).find(Boolean);
  const expected = originOf(storefrontUrl);
  if (!canonical) problems.push("the home page has no canonical URL, so the API it reached cannot be identified");
  else if (originOf(canonical) !== expected) {
    problems.push(`the home page's canonical origin is ${originOf(canonical) ?? canonical}, not ${expected}: the storefront reached another stack's API`);
  }
  if (mediaUrl) {
    const base = mediaUrl.replace(/\/+$/, "");
    const mediaOrigins = new Set([...html.matchAll(/(?:src|srcset|href)=["']([^"' ,]+\/media\/[^"' ,]+)/gi)]
      .map((m) => originOf(m[1])).filter(Boolean));
    const expectedMedia = originOf(base);
    const foreign = [...mediaOrigins].filter((o) => o !== expectedMedia && /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o));
    if (foreign.length) problems.push(`media URLs come from ${foreign.join(", ")}, not ${expectedMedia}: the storefront reached another stack's API`);
  }
  return problems;
}

/** Fetches the storefront home page and throws when it was rendered by another stack's API. */
export async function verifyStorefrontBinding({ storefrontUrl, mediaUrl, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${storefrontUrl.replace(/\/+$/, "")}/`, { headers: { "User-Agent": "scalius-binding-check" } });
  const html = await response.text();
  if (response.status >= 500) throw new Error(`Storefront binding check: ${storefrontUrl}/ answered ${response.status}.`);
  const problems = storefrontBindingProblems(html, { storefrontUrl, mediaUrl });
  if (problems.length) throw new Error(`Storefront binding check failed for ${storefrontUrl}: ${problems.join("; ")}.`);
  return true;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, state: undefined, out: undefined, mediaUrl: undefined };
  const valued = { "--state": "state", "--out": "out", "--media-url": "mediaUrl" };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!(flag in valued)) throw new Error(`Unknown argument ${arg}`);
    const value = inline ?? rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`Option ${flag} requires a value.`);
    options[valued[flag]] = value;
  }
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
    const ports = readDevPorts();
    console.log(JSON.stringify({ ports, origins: devOrigins(ports), apiWorkerName: devApiWorkerName(ports) }, null, 2));
    return;
  }
  if (options.command === "api-worker-name") {
    console.log(devApiWorkerName());
    return;
  }
  if (options.command === "storefront-config") {
    // Rebinds the built storefront (apps/storefront/dist/server) to this stack's API.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "storefront", "dist", "server");
    const ports = readDevPorts();
    const config = localStorefrontWorkerConfig(JSON.parse(readFileSync(resolve(serverDir, "wrangler.json"), "utf8")), { apiWorkerName: devApiWorkerName(ports), port: ports.storefront });
    const out = options.out ? resolve(options.out) : resolve(serverDir, "wrangler.local.json");
    writeFileSync(out, `${JSON.stringify(config, null, 1)}\n`);
    console.log(`${out}: BACKEND_API -> ${devApiWorkerName(ports)}, port ${ports.storefront}. Serve it with wrangler dev -c <that file> beside the API.`);
    return;
  }
  if (options.command === "verify-binding") {
    const origins = devOrigins();
    await verifyStorefrontBinding({ storefrontUrl: origins.storefrontUrl, mediaUrl: options.mediaUrl ?? origins.mediaUrl });
    console.log(`${origins.storefrontUrl} renders through this stack's API (${devApiWorkerName()}).`);
    return;
  }
  console.error("Usage: node scripts/dev-ports.mjs <sync-platform [--state <dir>] | print | api-worker-name | storefront-config [--out <file>] | verify-binding [--media-url <origin>]>");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
