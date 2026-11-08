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
 * first (see the README "Parallel local stacks"). These defaults are the only
 * port numbers dev tooling spells out (scripts/check-source-policies.mjs).
 *
 * A helper that attaches to a running stack (dev-admin, the smokes, the
 * doctor) reads `readStackPorts`: each variable that is set, else the ports
 * the stack recorded in its Wrangler state when `sync-platform` pointed its
 * Platform settings there, else the defaults. Given only `--state`, it finds
 * that stack's dashboard and storefront instead of assuming :4323 and :4322.
 *
 * Readers: apps/api `pnpm dev` (wrangler --port), apps/storefront `pnpm dev`
 * (astro --port, and the API origin `astro dev` calls), apps/admin-v2
 * vite.config.ts (port and API proxy target), scripts/dev-doctor.mjs, and
 * `sync-platform` below, which points the local Platform settings document at
 * the same origins.
 *
 *   node scripts/dev-ports.mjs sync-platform [--state <dir>]
 *   node scripts/dev-ports.mjs defaults              # "<api> <storefront> <admin>" (dev.sh)
 *   node scripts/dev-ports.mjs port <api|storefront|admin>
 *   node scripts/dev-ports.mjs api-worker-name       # scalius-api-local[-<api port>]
 *   node scripts/dev-ports.mjs storefront-config     # built storefront bound to it
 *   node scripts/dev-ports.mjs verify-binding        # the storefront reached this API
 *   node scripts/dev-ports.mjs scheduled-url         # where the local scheduled handler runs
 *   node scripts/dev-ports.mjs scheduled-tick        # call it every minute until stopped (dev.sh)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

/** Sets the SCALIUS_DEV_*_PORT variables, so child processes and `readDevPorts()` agree. */
export function exportDevPorts(ports, env = process.env) {
  for (const [key, name] of Object.entries(DEV_PORT_ENV)) env[name] = String(ports[key]);
  return ports;
}

/** The file in a stack's Wrangler state that records the ports its Platform settings point at. */
export const STACK_PORTS_FILE = "scalius-dev-ports.json";

/**
 * The Wrangler state directory of a stack: `state`, else SCALIUS_WRANGLER_STATE,
 * else the repository's `.wrangler/state`; a relative path resolves from the
 * repository root (as dev-local-utils.mjs resolveLocalStatePath; this file
 * imports nothing at load, so a built storefront's tooling can copy it alone).
 */
export function devStateDir({ env = process.env, state } = {}) {
  const value = state || env.SCALIUS_WRANGLER_STATE;
  if (!value) return resolve(REPO_ROOT, ".wrangler", "state");
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}

/** Records the ports a stack's Platform settings point at, beside its database. */
export function writeStackPorts(stateDir, ports) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, STACK_PORTS_FILE), `${JSON.stringify({ api: ports.api, storefront: ports.storefront, admin: ports.admin })}\n`);
}

/** The ports recorded in a stack's state, or null when none (or an unreadable record) is there. */
export function readRecordedStackPorts(stateDir) {
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(join(stateDir, STACK_PORTS_FILE), "utf8"));
  } catch {
    return null;
  }
  // All three or nothing: a partial record must not mix with the defaults.
  if (!Object.keys(DEV_PORT_ENV).every((key) => Number.isInteger(recorded?.[key]))) return null;
  try {
    return readDevPorts(Object.fromEntries(Object.entries(DEV_PORT_ENV).map(([key, name]) => [name, String(recorded[key])])));
  } catch {
    return null;
  }
}

/**
 * The ports of a running stack, for a helper that attaches to it: each
 * SCALIUS_DEV_*_PORT that is set, else the port recorded in the stack's
 * Wrangler state (`state`, else SCALIUS_WRANGLER_STATE, else the default
 * state), else the default. A helper given only the API port and the state
 * therefore never takes the stack's dashboard for the default one.
 */
export function readStackPorts({ env = process.env, state } = {}) {
  const recorded = readRecordedStackPorts(devStateDir({ env, state }));
  const merged = { ...env };
  for (const [key, name] of Object.entries(DEV_PORT_ENV)) {
    if (String(env[name] ?? "").trim() === "" && recorded) merged[name] = String(recorded[key]);
  }
  return readDevPorts(merged);
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

/** The local cron cadence: the production trigger is `* * * * *`, so one minute. */
export const DEV_SCHEDULED_TICK_SECONDS = 60;

/**
 * Where wrangler dev runs the API Worker's scheduled handler. `wrangler dev` never fires
 * its configured cron by itself, so retries, the outbox and app crons would sit still.
 */
export function devScheduledUrl(ports = readDevPorts()) {
  return `http://127.0.0.1:${ports.api}/cdn-cgi/local/scheduled?cron=*+*+*+*+*`;
}

/**
 * Calls the scheduled handler every `intervalSeconds` until `signal` aborts and returns
 * `{ ticks, failures }`. Calls never overlap (the next wait starts after a call ends). A
 * call that does not answer, or answers outside 2xx (a wrong path answers 404), is logged
 * every time with the running failure count, so a tick that never runs cannot pass for one
 * that does; the loop keeps going because the API may be restarting.
 */
export async function runScheduledTick({
  ports = readDevPorts(),
  intervalSeconds = DEV_SCHEDULED_TICK_SECONDS,
  fetchImpl = fetch,
  signal,
  log = (message) => console.error(message),
} = {}) {
  const url = devScheduledUrl(ports);
  const result = { ticks: 0, failures: 0 };
  while (!signal?.aborted) {
    await new Promise((done) => {
      const timer = setTimeout(done, intervalSeconds * 1000);
      signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
    });
    if (signal?.aborted) break;
    result.ticks += 1;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.max(30_000, intervalSeconds * 1000)) });
      await response.arrayBuffer();
      if (!response.ok) {
        result.failures += 1;
        log(`Scheduled tick failed (${result.failures} of ${result.ticks}): ${url} answered ${response.status}.`);
      }
    } catch (error) {
      result.failures += 1;
      log(`Scheduled tick failed (${result.failures} of ${result.ticks}): ${url} did not answer (${error instanceof Error ? error.message : error}).`);
    }
  }
  return result;
}

function isLoopbackOrigin(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.origin === String(value);
  } catch {
    return false;
  }
}

/**
 * Dashboard UI preview (docs/ADMIN-QUALITY.md): a dashboard served from
 * another local port (a worktree's `vite` on 4400) talks to the shared local
 * API, which trusts one dashboard origin, the one in its Platform settings
 * (Better Auth's trusted origins, the cookie-origin guard and the realtime
 * check all read it). The Vite dev proxy therefore presents the Platform
 * dashboard origin as the request's Origin. Only loopback origins on both
 * sides are ever rewritten, so the API's checks stay as they are and nothing
 * outside a developer's machine is affected (this file is dev tooling and
 * never ships in a bundle).
 */
export function previewProxyOrigin(requestOrigin, platformDashboardOrigin) {
  if (!requestOrigin || requestOrigin === platformDashboardOrigin) return requestOrigin;
  if (!isLoopbackOrigin(requestOrigin) || !isLoopbackOrigin(platformDashboardOrigin)) return requestOrigin;
  return platformDashboardOrigin;
}

/**
 * The dashboard dev proxy's Origin rewrite (`previewProxyOrigin`), toward the
 * Platform dashboard origin as it is now. The returned function takes a
 * request's headers; one that carries an Origin (sign-in, writes, the realtime
 * socket) waits for a fresh read of GET /api/v1/platform (concurrent requests
 * share one read), so a Platform change (sync-platform, setup, a settings
 * save) holds for the next request without a dev-server restart. While the
 * API does not answer, the last origin read is used; before any read, or with
 * no dashboard URL stored, the Origin passes unchanged.
 */
export function platformOriginPresenter({ apiOrigin, fetchImpl = fetch, timeoutMs = 3_000 }) {
  let known = null;
  let inFlight = null;
  async function read() {
    try {
      const response = await fetchImpl(`${apiOrigin}/api/v1/platform`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return known;
      const body = await response.json();
      const url = body?.data?.dashboardUrl;
      known = url ? new URL(url).origin : null;
    } catch {
      // Not up yet, restarting or a malformed URL: keep the last origin read.
    }
    return known;
  }
  const current = () => (inFlight ??= read().finally(() => { inFlight = null; }));
  return async function present(headers) {
    const origin = headers.origin;
    if (typeof origin !== "string") return;
    const presented = previewProxyOrigin(origin, await current());
    if (!presented || presented === origin) return;
    headers.origin = presented;
    if (typeof headers.referer === "string") headers.referer = `${presented}/`;
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
  const [command, ...args] = argv;
  // `port <app>` takes the app name as its one positional argument.
  const app = command === "port" && args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const rest = app ? args.slice(1) : args;
  const options = { command, app, state: undefined, out: undefined, mediaUrl: undefined };
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
 * Points the local Platform document at this stack's origins. Its mirror is a
 * per-colo Cache API hint (60 s) that a restarted API starts without, so the
 * API reads these origins on its next start. Local state only
 * (`wrangler --local`); run it while the API is stopped or before it starts.
 */
export async function syncLocalPlatform({ env = process.env, state } = {}) {
  const { execFileSync } = await import("node:child_process");
  const { resolvePnpmExecutable } = await import("./dev-local-utils.mjs");
  const apiDir = resolve(REPO_ROOT, "apps", "api");
  const wranglerState = devStateDir({ env, state });
  const ports = readDevPorts(env);
  const origins = devOrigins(ports);
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
  // Helpers that attach to this stack later read its ports from here (readStackPorts).
  writeStackPorts(wranglerState, ports);
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
  if (options.command === "defaults") {
    console.log(`${DEFAULT_DEV_PORTS.api} ${DEFAULT_DEV_PORTS.storefront} ${DEFAULT_DEV_PORTS.admin}`);
    return;
  }
  if (options.command === "port") {
    const ports = readDevPorts();
    if (!Object.hasOwn(ports, options.app ?? "")) throw new Error("Usage: node scripts/dev-ports.mjs port <api|storefront|admin>");
    console.log(ports[options.app]);
    return;
  }
  if (options.command === "api-worker-name") {
    console.log(devApiWorkerName());
    return;
  }
  if (options.command === "scheduled-url") {
    console.log(devScheduledUrl());
    return;
  }
  if (options.command === "scheduled-tick") {
    const seconds = Number(process.env.SCALIUS_DEV_CRON_TICK_SECONDS ?? DEV_SCHEDULED_TICK_SECONDS);
    if (!(seconds > 0)) throw new Error("SCALIUS_DEV_CRON_TICK_SECONDS must be a positive number.");
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
    await runScheduledTick({ intervalSeconds: seconds, signal: controller.signal });
    return;
  }
  if (options.command === "storefront-config") {
    // Rebinds the built storefront (apps/storefront/dist/server) to this stack's API.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const storefrontDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "storefront");
    const serverDir = resolve(storefrontDir, "dist", "server");
    const ports = readDevPorts();
    const config = localStorefrontWorkerConfig(JSON.parse(readFileSync(resolve(serverDir, "wrangler.json"), "utf8")), { apiWorkerName: devApiWorkerName(ports), port: ports.storefront });
    // Wrangler loads local runtime configuration beside the selected config.
    const out = options.out ? resolve(options.out) : resolve(storefrontDir, "wrangler.local.json");
    config.main = resolve(serverDir, config.main);
    if (config.assets?.directory) config.assets.directory = resolve(serverDir, config.assets.directory);
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
  console.error("Usage: node scripts/dev-ports.mjs <sync-platform [--state <dir>] | print | defaults | port <api|storefront|admin> | api-worker-name | scheduled-url | scheduled-tick | storefront-config [--out <file>] | verify-binding [--media-url <origin>]>");
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
