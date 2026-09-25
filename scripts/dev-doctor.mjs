#!/usr/bin/env node
/**
 * Non-mutating local development diagnostics.
 *
 * Usage:
 *   pnpm dev:doctor
 *   pnpm dev:doctor --require-running
 *   pnpm dev:doctor --profile admin --require-running
 *   pnpm dev:doctor --json
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import net from "net";
import { dirname, join, resolve } from "path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "url";
import {
  assertStringOptions,
  collectLocalSecretSyncIssues,
  collectStaleLocalEnvIssues,
  parseOptions,
  readEnvVarsIfExists,
  resolvePnpmExecutable,
  resolveLocalStatePath,
  trimTrailingSlash,
} from "./dev-local-utils.mjs";
import { DEV_PORT_ENV, devOrigins, readDevPorts } from "./dev-ports.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..");

const CHECK_ORDER = { fail: 0, warn: 1, skip: 2, pass: 3 };
const SERVICE_PROFILES = {
  all: ["mailbox", "api", "admin", "storefront"],
  api: ["mailbox", "api"],
  admin: ["mailbox", "api", "admin"],
  storefront: ["mailbox", "api", "storefront"],
};

export function getServiceIdsForProfile(profile = "all") {
  return [...(SERVICE_PROFILES[profile] ?? SERVICE_PROFILES.all)];
}

export function getDoctorConfig(rawArgs = process.argv.slice(2), env = process.env) {
  const options = parseOptions(rawArgs);
  assertStringOptions(options, ["api", "admin", "storefront", "state", "profile", "api-port", "storefront-port", "admin-port"]);
  const serviceProfile = normalizeServiceProfile(options.profile);
  // Same port source as scripts/dev.sh: flags, else SCALIUS_DEV_*_PORT, else defaults.
  const origins = devOrigins(readDevPorts({
    ...env,
    ...(options["api-port"] ? { [DEV_PORT_ENV.api]: options["api-port"] } : {}),
    ...(options["storefront-port"] ? { [DEV_PORT_ENV.storefront]: options["storefront-port"] } : {}),
    ...(options["admin-port"] ? { [DEV_PORT_ENV.admin]: options["admin-port"] } : {}),
  }));
  return {
    help: Boolean(options.help || rawArgs.includes("-h")),
    json: Boolean(options.json),
    requireRunning: Boolean(options["require-running"]),
    strict: Boolean(options.strict),
    serviceProfile,
    apiBaseUrl: trimTrailingSlash(String(options.api || env.LOCAL_API_BASE_URL || origins.apiUrl)),
    adminBaseUrl: trimTrailingSlash(String(options.admin || origins.dashboardUrl)),
    storefrontBaseUrl: trimTrailingSlash(String(options.storefront || origins.storefrontUrl)),
    wranglerState: resolveLocalStatePath(root, options.state || env.SCALIUS_WRANGLER_STATE),
  };
}

export async function runDoctor(config = getDoctorConfig()) {
  const checks = [];

  checkRepoShape(checks);
  checkTooling(checks);
  checkPackageScripts(checks);
  checkLocalEnvFiles(checks);
  checkWranglerState(checks, config.wranglerState);
  checkWranglerMigrationHistory(checks, config.wranglerState);
  checkLocalPlatformOrigins(checks, config);
  await checkServices(checks, config);

  return {
    ok: getExitCode(checks, config) === 0,
    root,
    checkedAt: new Date().toISOString(),
    config: {
      apiBaseUrl: config.apiBaseUrl,
      adminBaseUrl: config.adminBaseUrl,
      storefrontBaseUrl: config.storefrontBaseUrl,
      wranglerState: config.wranglerState,
      serviceProfile: config.serviceProfile,
      requireRunning: config.requireRunning,
      strict: config.strict,
    },
    summary: summarizeChecks(checks),
    checks,
  };
}

export function summarizeChecks(checks) {
  return checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0, skip: 0 },
  );
}

export function getExitCode(checks, config = {}) {
  if (checks.some((check) => check.status === "fail")) return 1;
  if (config.strict && checks.some((check) => check.status === "warn")) return 1;
  return 0;
}

export function formatTextReport(result) {
  const lines = [
    "Scalius local dev doctor",
    `Root: ${result.root}`,
    "",
  ];

  const sortedChecks = [...result.checks].sort((a, b) => {
    const statusDelta = CHECK_ORDER[a.status] - CHECK_ORDER[b.status];
    return statusDelta || a.title.localeCompare(b.title);
  });

  for (const check of sortedChecks) {
    lines.push(`${statusLabel(check.status)} ${check.title}`);
    if (check.detail) lines.push(`    ${check.detail}`);
    if (check.action) lines.push(`    Next: ${check.action}`);
  }

  const { pass, warn, fail, skip } = result.summary;
  lines.push("");
  lines.push(`Summary: ${pass} pass, ${warn} warn, ${fail} fail, ${skip} skip`);
  if (fail > 0) {
    lines.push("Run the listed Next steps, then rerun pnpm dev:doctor.");
  } else if (warn > 0) {
    lines.push("No hard blockers found. Warnings usually mean a dev server is not running yet.");
  } else {
    lines.push("Local development wiring looks ready.");
  }

  return lines.join("\n");
}

function checkRepoShape(checks) {
  const packageJson = readJson(resolve(root, "package.json"));
  if (packageJson?.name === "scalius-commerce") {
    pass(checks, "Repository root", "package.json is the expected Scalius workspace.");
  } else {
    fail(checks, "Repository root", "Could not confirm package.json name is scalius-commerce.", "Run this command from the repo root.");
  }

  if (existsSync(resolve(root, "pnpm-lock.yaml"))) {
    pass(checks, "pnpm lockfile", "pnpm-lock.yaml exists.");
  } else {
    fail(checks, "pnpm lockfile", "pnpm-lock.yaml is missing.", "Restore the lockfile before installing dependencies.");
  }
}

function checkTooling(checks) {
  const expectedNode = readText(resolve(root, ".nvmrc"))?.trim();
  const currentNode = process.versions.node;
  if (expectedNode && !currentNode.startsWith(`${expectedNode}.`)) {
    warn(checks, "Node version", `Running Node ${currentNode}, .nvmrc asks for ${expectedNode}.`, `Use Node ${expectedNode} before debugging runtime issues.`);
  } else {
    pass(checks, "Node version", `Running Node ${currentNode}.`);
  }

  const pnpmExecutable = resolvePnpmExecutable();
  const pnpmVersion = getCommandVersion(pnpmExecutable, ["--version"]);
  if (pnpmVersion) {
    pass(checks, "pnpm", `pnpm ${pnpmVersion} is available (${pnpmExecutable}).`);
  } else {
    fail(checks, "pnpm", "pnpm could not be resolved.", "Install pnpm or enable Corepack, then run pnpm dev:setup.");
  }

  const mailpitVersion = getCommandVersion("mailpit", ["version"]);
  if (mailpitVersion) {
    pass(checks, "Local mailbox tooling", `${mailpitVersion} is available.`);
  } else {
    fail(
      checks,
      "Local mailbox tooling",
      "Mailpit is not available on PATH.",
      "Install it with 'brew install mailpit' on macOS or follow https://mailpit.axllent.org/docs/install/.",
    );
  }

  if (existsSync(resolve(root, "node_modules"))) {
    pass(checks, "Dependencies", "node_modules exists.");
  } else {
    fail(checks, "Dependencies", "node_modules is missing.", "Run pnpm dev:setup or pnpm install.");
  }
}

function checkPackageScripts(checks) {
  const packageJson = readJson(resolve(root, "package.json"));
  const scripts = packageJson?.scripts ?? {};
  const requiredScripts = [
    "dev",
    "dev:api",
    "dev:admin",
    "dev:storefront",
    "dev:setup",
    "dev:reset",
    "dev:admin:create",
    "dev:admin:reset",
    "dev:admin:status",
    "dev:doctor",
    "dev:doctor:api",
    "dev:doctor:admin",
    "dev:doctor:storefront",
    "dev:doctor:all",
  ];
  const missing = requiredScripts.filter((script) => !scripts[script]);
  if (missing.length === 0) {
    pass(checks, "Root dev scripts", "All local-dev scripts are wired in package.json.");
  } else {
    fail(checks, "Root dev scripts", `Missing scripts: ${missing.join(", ")}.`, "Restore package.json local-dev script entries.");
  }

  const apiPackage = readJson(resolve(root, "apps", "api", "package.json"));
  const apiDev = apiPackage?.scripts?.dev ?? "";
  if (apiDev.includes("wrangler.local.jsonc") && apiDev.includes("--local")) {
    pass(checks, "API local dev script", "API dev uses wrangler.local.jsonc and --local.");
  } else {
    fail(checks, "API local dev script", "API dev script is not using the local Wrangler config.", "Keep apps/api/package.json dev on wrangler.local.jsonc --local.");
  }
}

function checkLocalEnvFiles(checks) {
  const paths = {
    api: resolve(root, "apps", "api", ".dev.vars"),
    storefront: resolve(root, "apps", "storefront", ".dev.vars"),
  };
  const missingRuntime = [
    ["apps/api/.dev.vars", paths.api],
    ["apps/storefront/.dev.vars", paths.storefront],
  ].filter(([, path]) => !existsSync(path));
  if (missingRuntime.length === 0) {
    pass(checks, "Runtime env files", "All Worker .dev.vars files exist.");
  } else {
    fail(
      checks,
      "Runtime env files",
      `Missing ${missingRuntime.map(([label]) => label).join(", ")}.`,
      "Run pnpm dev:setup --env-only.",
    );
  }

  const apiVars = readEnvVarsIfExists(paths.api);
  const storefrontVars = readEnvVarsIfExists(paths.storefront);

  // The only installed secrets: SCALIUS_SECRET (>= 32 chars, identical across
  // API/storefront) and CREDENTIAL_ENCRYPTION_KEY (base64 32 bytes, API only).
  // Values are never included in the report.
  const drift = collectLocalSecretSyncIssues({ apiVars, storefrontVars });
  if (drift.length === 0 && missingRuntime.length === 0) {
    pass(
      checks,
      "Installed local secrets",
      "SCALIUS_SECRET is present and identical across API/storefront; CREDENTIAL_ENCRYPTION_KEY is present on the API.",
    );
  } else if (drift.length > 0) {
    fail(
      checks,
      "Installed local secrets",
      drift.join("; "),
      "Run pnpm dev:setup --env-only to append missing keys, or pnpm dev:setup --force --env-only to regenerate all local .dev.vars files.",
    );
  } else {
    skip(checks, "Installed local secrets", "Skipped because runtime env files are missing.", "Run pnpm dev:setup --env-only.");
  }

  // URLs are dashboard Platform settings (local dev falls back to fixed ports
  // in code) and per-purpose secrets are derived from SCALIUS_SECRET, so any
  // leftover entries are ignored by every Worker. Warn so they get cleaned up.
  const staleIssues = collectStaleLocalEnvIssues({ apiVars, storefrontVars });
  const staleBuildEnvFiles = [
    ["apps/admin-v2/.dev.vars", resolve(root, "apps", "admin-v2", ".dev.vars")],
    ["apps/admin-v2/.env.development", resolve(root, "apps", "admin-v2", ".env.development")],
    ["apps/storefront/.env.development", resolve(root, "apps", "storefront", ".env.development")],
  ].filter(([, path]) => existsSync(path)).map(([label]) => `${label} is no longer generated or read`);
  const stale = [...staleIssues, ...staleBuildEnvFiles];
  if (stale.length > 0) {
    warn(
      checks,
      "Retired local env entries",
      `${stale.join("; ")}.`,
      "Run pnpm dev:setup --force --env-only to rewrite .dev.vars with only the installed secrets, and delete the stale files.",
    );
  } else if (missingRuntime.length > 0) {
    skip(checks, "Retired local env entries", "Skipped because runtime env files are missing.", "Run pnpm dev:setup --env-only.");
  } else {
    pass(checks, "Retired local env entries", "No retired secret or URL keys remain in local env files.");
  }
}

function checkWranglerState(checks, wranglerState) {
  if (existsSync(wranglerState)) {
    const stat = statSync(wranglerState);
    if (stat.isDirectory()) {
      pass(checks, "Wrangler local state", `State directory exists at ${wranglerState}.`);
      return;
    }
    fail(checks, "Wrangler local state", `${wranglerState} exists but is not a directory.`, "Pick another --state path or remove the file.");
    return;
  }
  warn(checks, "Wrangler local state", `No state directory at ${wranglerState}.`, "Run pnpm dev:setup or pnpm dev:reset.");
}

export function findRetiredMigrationEntries(appliedNames, currentNames) {
  const current = new Set(currentNames);
  const currentByVersion = new Map(currentNames.map((name) => [
    migrationVersion(name),
    name,
  ]));

  return appliedNames
    .filter((name) => !current.has(name))
    .map((applied) => ({
      applied,
      current: currentByVersion.get(migrationVersion(applied)) ?? null,
    }));
}

function checkWranglerMigrationHistory(checks, wranglerState) {
  const objectDirectory = join(
    wranglerState,
    "v3",
    "d1",
    "miniflare-D1DatabaseObject",
  );
  if (!existsSync(objectDirectory)) {
    pass(checks, "Local D1 migration history", "No applied local migration history yet.");
    return;
  }

  const currentNames = readdirSync(resolve(root, "packages", "database", "migrations"))
    .filter((name) => /^\d+_.+\.sql$/.test(name));
  const databasePaths = readdirSync(objectDirectory)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(objectDirectory, name));
  const retired = [];

  try {
    for (const databasePath of databasePaths) {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const hasHistory = database.prepare(`
          SELECT 1
          FROM sqlite_schema
          WHERE type = 'table' AND name = 'd1_migrations'
        `).get();
        if (!hasHistory) continue;
        const appliedNames = database.prepare(
          "SELECT name FROM d1_migrations ORDER BY id",
        ).all().map((row) => String(row.name));
        retired.push(...findRetiredMigrationEntries(appliedNames, currentNames));
      } finally {
        database.close();
      }
    }
  } catch (error) {
    fail(
      checks,
      "Local D1 migration history",
      `Could not inspect local D1 migration history: ${error instanceof Error ? error.message : String(error)}.`,
      "Run pnpm dev:reset to recreate disposable local state.",
    );
    return;
  }

  if (retired.length === 0) {
    pass(checks, "Local D1 migration history", "Applied migration filenames match the current repository.");
    return;
  }

  const sample = retired.slice(0, 3).map(({ applied, current }) =>
    current ? `${applied} conflicts with ${current}` : `${applied} is no longer present`,
  ).join("; ");
  const remainder = retired.length > 3 ? `; plus ${retired.length - 3} more` : "";
  fail(
    checks,
    "Local D1 migration history",
    `Local D1 uses retired migration filenames: ${sample}${remainder}.`,
    "Run pnpm dev:reset to recreate disposable local state.",
  );
}

const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/;

/**
 * The local Platform document's loopback (or unset) origins against this
 * stack's origins (scripts/dev-ports.mjs). Origins saved as real URLs are the
 * developer's own and are not compared.
 */
export function findPlatformOriginDrift(document, expected) {
  return ["storefrontUrl", "apiUrl", "dashboardUrl", "mediaUrl"]
    .map((field) => ({ field, stored: typeof document?.[field] === "string" ? document[field] : "", expected: expected[field] }))
    .filter(({ stored, expected: want }) => (stored === "" || LOOPBACK_ORIGIN.test(stored)) && stored !== want);
}

function readLocalPlatformDocument(wranglerState) {
  const objectDirectory = join(wranglerState, "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(objectDirectory)) return { found: false, document: null };
  const databasePaths = readdirSync(objectDirectory)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(objectDirectory, name));
  let document = null;
  for (const databasePath of databasePaths) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const hasSettings = database.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'settings'",
      ).get();
      if (!hasSettings) continue;
      const row = database.prepare(
        "SELECT value FROM settings WHERE key = 'document' AND category = 'platform'",
      ).get();
      if (row) document = JSON.parse(String(row.value));
    } finally {
      database.close();
    }
  }
  return { found: databasePaths.length > 0, document };
}

function checkLocalPlatformOrigins(checks, config) {
  const title = "Local Platform origins";
  const expected = {
    apiUrl: config.apiBaseUrl,
    storefrontUrl: config.storefrontBaseUrl,
    dashboardUrl: config.adminBaseUrl,
    mediaUrl: `${config.apiBaseUrl}/api/v1/media`,
  };
  let local;
  try {
    local = readLocalPlatformDocument(config.wranglerState);
  } catch (error) {
    warn(checks, title, `Could not read the local Platform settings: ${error instanceof Error ? error.message : String(error)}.`, "Run node scripts/dev-ports.mjs sync-platform.");
    return;
  }
  if (!local.found) {
    skip(checks, title, "No local D1 database yet.", "Run pnpm dev:setup.");
    return;
  }
  const drift = findPlatformOriginDrift(local.document ?? {}, expected);
  if (drift.length === 0) {
    pass(checks, title, `Local Platform settings point at ${expected.storefrontUrl}, ${expected.apiUrl} and ${expected.dashboardUrl}.`);
    return;
  }
  warn(
    checks,
    title,
    `Local Platform settings differ from this stack's ports: ${drift.map(({ field, stored, expected: want }) => `${field} ${stored || "(unset)"} instead of ${want}`).join("; ")}.`,
    "scripts/dev.sh syncs them on start; otherwise stop the API and run node scripts/dev-ports.mjs sync-platform with the same SCALIUS_DEV_*_PORT values.",
  );
}

function migrationVersion(name) {
  return /^0*(\d+)_/.exec(name)?.[1] ?? null;
}

async function checkServices(checks, config) {
  const services = [
    {
      id: "mailbox",
      title: "Local mailbox",
      url: "http://127.0.0.1:8025/api/v1/info",
      downAction: "Start it with pnpm dev:api, pnpm dev:admin, pnpm dev:storefront, or pnpm dev.",
      validate: async (response) => {
        const data = await safeJson(response);
        if (response.ok && typeof data?.Version === "string") {
          return { ok: true, detail: `Mailpit ${data.Version} responded on loopback.` };
        }
        return { ok: false, detail: `Mailpit info returned ${response.status}, not the expected payload.` };
      },
    },
    {
      id: "api",
      title: "API worker",
      url: `${config.apiBaseUrl}/api/v1/setup`,
      downAction: "Start it with pnpm dev:api, pnpm dev:admin, pnpm dev:storefront, or pnpm dev.",
      validate: async (response) => {
        const data = await safeJson(response);
        const adminExists = data?.data?.adminExists ?? data?.adminExists;
        if (response.ok && typeof adminExists === "boolean") {
          return { ok: true, detail: `GET /api/v1/setup returned adminExists=${adminExists}.` };
        }
        return { ok: false, detail: `GET /api/v1/setup returned ${response.status}, not the expected setup payload.` };
      },
    },
    {
      id: "admin",
      title: "Admin dashboard",
      // Vite answers on :4323 and proxies /api/auth to the API Worker, so this
      // proves the dashboard dev server and its API proxy together.
      url: `${config.adminBaseUrl}/api/auth/dashboard-session`,
      downAction: "Start it with pnpm dev:admin or pnpm dev.",
      validate: async (response) => {
        const data = await safeJson(response);
        if (response.ok && typeof data?.adminExists === "boolean") {
          return { ok: true, detail: `GET /api/auth/dashboard-session returned adminExists=${data.adminExists}.` };
        }
        return { ok: false, detail: `GET /api/auth/dashboard-session returned ${response.status}, not the expected session payload.` };
      },
    },
    {
      id: "storefront",
      title: "Storefront",
      url: `${config.storefrontBaseUrl}/`,
      downAction: "Start it with pnpm dev:storefront or pnpm dev.",
      validate: async (response) => {
        if (response.status < 500) return { ok: true, detail: `/ responded with ${response.status}.` };
        return { ok: false, detail: `/ returned ${response.status}.` };
      },
    },
  ];
  const selected = new Set(getServiceIdsForProfile(config.serviceProfile));

  await Promise.all(
    services
      .filter((service) => selected.has(service.id))
      .map((service) => checkService(checks, service, config.requireRunning)),
  );
}

async function checkService(checks, service, requireRunning) {
  const reachable = await isOriginReachable(service.url);
  if (!reachable) {
    const status = requireRunning ? "fail" : "warn";
    addCheck(checks, status, service.title, "Not running or not reachable.", service.downAction);
    return;
  }

  try {
    const requestTimeoutMs =
      service.id === "admin" || service.id === "storefront" ? 10_000 : 2500;
    const response = await fetch(service.url, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const result = await service.validate(response);
    if (result.ok) {
      pass(checks, service.title, result.detail);
    } else {
      fail(checks, service.title, result.detail, service.downAction);
    }
  } catch (error) {
    fail(checks, service.title, `Request failed: ${error instanceof Error ? error.message : String(error)}.`, service.downAction);
  }
}

async function isOriginReachable(url) {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  return canConnect(parsed.hostname, port, 900);
}

function canConnect(host, port, timeoutMs) {
  return new Promise((resolveConnect) => {
    const socket = net.createConnection({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveConnect(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function safeJson(response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function getCommandVersion(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function addCheck(checks, status, title, detail, action) {
  checks.push({ status, title, detail, action });
}

function pass(checks, title, detail) {
  addCheck(checks, "pass", title, detail);
}

function warn(checks, title, detail, action) {
  addCheck(checks, "warn", title, detail, action);
}

function fail(checks, title, detail, action) {
  addCheck(checks, "fail", title, detail, action);
}

function skip(checks, title, detail, action) {
  addCheck(checks, "skip", title, detail, action);
}

function statusLabel(status) {
  switch (status) {
    case "pass":
      return "[pass]";
    case "warn":
      return "[warn]";
    case "fail":
      return "[fail]";
    case "skip":
      return "[skip]";
    default:
      return "[????]";
  }
}

function normalizeServiceProfile(value) {
  if (value === undefined) return "all";
  const profile = String(value).trim().toLowerCase();
  if (profile in SERVICE_PROFILES) return profile;
  throw new Error(`Unknown --profile "${value}". Use one of: ${Object.keys(SERVICE_PROFILES).join(", ")}.`);
}

function printHelp() {
  console.log(`
Usage: pnpm dev:doctor [options]

Non-mutating local development diagnostics.

Options:
  --json                 Print machine-readable JSON
  --strict               Exit non-zero on warnings as well as failures
  --require-running      Treat selected profile services not running as failures
  --profile <name>       Service profile to check: all, api, admin, storefront
  --api-port <port>      API port (default: SCALIUS_DEV_API_PORT or 8787)
  --storefront-port <p>  Storefront port (default: SCALIUS_DEV_STOREFRONT_PORT or 4322)
  --admin-port <port>    Admin port (default: SCALIUS_DEV_ADMIN_PORT or 4323)
  --api <url>            API origin (overrides the port; also LOCAL_API_BASE_URL)
  --admin <url>          Admin origin (overrides the port)
  --storefront <url>     Storefront origin (overrides the port)
  --state <path>         Wrangler local state path; relative paths resolve from repo root
`);
}

if (resolve(process.argv[1] ?? "") === __filename) {
  try {
    const config = getDoctorConfig();
    if (config.help) {
      printHelp();
      process.exit(0);
    }

    const result = await runDoctor(config);
    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextReport(result));
    }
    process.exit(getExitCode(result.checks, config));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
