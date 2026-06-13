#!/usr/bin/env node
/**
 * Non-mutating local development diagnostics.
 *
 * Usage:
 *   pnpm dev:doctor
 *   pnpm dev:doctor --require-running
 *   pnpm dev:doctor --json
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import net from "net";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  collectLocalSecretSyncIssues,
  parseOptions,
  readEnvVarsIfExists,
  resolveLocalStatePath,
  trimTrailingSlash,
} from "./dev-local-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..");

const CHECK_ORDER = { fail: 0, warn: 1, skip: 2, pass: 3 };

export function getDoctorConfig(rawArgs = process.argv.slice(2), env = process.env) {
  const options = parseOptions(rawArgs);
  return {
    help: Boolean(options.help || rawArgs.includes("-h")),
    json: Boolean(options.json),
    requireRunning: Boolean(options["require-running"]),
    strict: Boolean(options.strict),
    apiBaseUrl: trimTrailingSlash(String(options.api || env.LOCAL_API_BASE_URL || "http://localhost:8787")),
    adminBaseUrl: trimTrailingSlash(String(options.admin || "http://localhost:4323")),
    storefrontBaseUrl: trimTrailingSlash(String(options.storefront || "http://localhost:4322")),
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

  const pnpmVersion = getCommandVersion("pnpm", ["--version"]);
  if (pnpmVersion) {
    pass(checks, "pnpm", `pnpm ${pnpmVersion} is available.`);
  } else {
    fail(checks, "pnpm", "pnpm is not available on PATH.", "Install pnpm, then run pnpm dev:setup.");
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
    "dev:admin",
    "dev:storefront",
    "dev:setup",
    "dev:reset",
    "dev:admin:create",
    "dev:admin:reset",
    "dev:admin:status",
    "dev:doctor",
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
    admin: resolve(root, "apps", "admin-v2", ".dev.vars"),
    storefront: resolve(root, "apps", "storefront", ".dev.vars"),
    adminBuild: resolve(root, "apps", "admin-v2", ".env.development"),
    storefrontBuild: resolve(root, "apps", "storefront", ".env.development"),
  };
  const missingRuntime = [
    ["apps/api/.dev.vars", paths.api],
    ["apps/admin-v2/.dev.vars", paths.admin],
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

  const missingBuild = [
    ["apps/admin-v2/.env.development", paths.adminBuild],
    ["apps/storefront/.env.development", paths.storefrontBuild],
  ].filter(([, path]) => !existsSync(path));
  if (missingBuild.length === 0) {
    pass(checks, "Build-time env files", "Admin and storefront .env.development files exist.");
  } else {
    fail(
      checks,
      "Build-time env files",
      `Missing ${missingBuild.map(([label]) => label).join(", ")}.`,
      "Run pnpm dev:setup --env-only.",
    );
  }

  const apiVars = readEnvVarsIfExists(paths.api);
  const adminVars = readEnvVarsIfExists(paths.admin);
  const storefrontVars = readEnvVarsIfExists(paths.storefront);
  const drift = collectLocalSecretSyncIssues({ apiVars, adminVars, storefrontVars });
  if (drift.length === 0 && missingRuntime.length === 0) {
    pass(checks, "Shared local secrets", "API/admin/storefront shared secrets are present and aligned.");
  } else if (drift.length > 0) {
    fail(checks, "Shared local secrets", drift.join("; "), "Run pnpm dev:setup --env-only to repair missing keys, or pnpm dev:setup --force --env-only to regenerate all local env files.");
  } else {
    skip(checks, "Shared local secrets", "Skipped because runtime env files are missing.", "Run pnpm dev:setup --env-only.");
  }

  const apiRequired = ["CREDENTIAL_ENCRYPTION_KEY", "PURGE_TOKEN", "PURGE_URL"];
  const missingApi = apiRequired.filter((key) => !apiVars?.[key]);
  if (!apiVars) {
    skip(checks, "API local env completeness", "Skipped because apps/api/.dev.vars is missing.", "Run pnpm dev:setup --env-only.");
  } else if (missingApi.length === 0) {
    pass(checks, "API local env completeness", "API has credential encryption and purge config.");
  } else {
    fail(checks, "API local env completeness", `Missing ${missingApi.join(", ")}.`, "Run pnpm dev:setup --env-only to append missing local keys.");
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

async function checkServices(checks, config) {
  const services = [
    {
      title: "API worker",
      url: `${config.apiBaseUrl}/api/v1/setup`,
      downAction: "Start it with pnpm --filter @scalius/api dev, pnpm dev:admin, pnpm dev:storefront, or pnpm dev.",
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
      title: "Admin dashboard",
      url: `${config.adminBaseUrl}/admin`,
      downAction: "Start it with pnpm dev:admin or pnpm dev.",
      validate: async (response) => {
        if (response.status < 500) return { ok: true, detail: `/admin responded with ${response.status}.` };
        return { ok: false, detail: `/admin returned ${response.status}.` };
      },
    },
    {
      title: "Storefront",
      url: `${config.storefrontBaseUrl}/`,
      downAction: "Start it with pnpm dev:storefront or pnpm dev.",
      validate: async (response) => {
        if (response.status < 500) return { ok: true, detail: `/ responded with ${response.status}.` };
        return { ok: false, detail: `/ returned ${response.status}.` };
      },
    },
  ];

  await Promise.all(services.map((service) => checkService(checks, service, config.requireRunning)));
}

async function checkService(checks, service, requireRunning) {
  const reachable = await isOriginReachable(service.url);
  if (!reachable) {
    const status = requireRunning ? "fail" : "warn";
    addCheck(checks, status, service.title, "Not running or not reachable.", service.downAction);
    return;
  }

  try {
    const response = await fetch(service.url, { signal: AbortSignal.timeout(2500) });
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

function printHelp() {
  console.log(`
Usage: pnpm dev:doctor [options]

Non-mutating local development diagnostics.

Options:
  --json                 Print machine-readable JSON
  --strict               Exit non-zero on warnings as well as failures
  --require-running      Treat API/admin/storefront not running as failures
  --api <url>            API origin (default: http://localhost:8787)
  --admin <url>          Admin origin (default: http://localhost:4323)
  --storefront <url>     Storefront origin (default: http://localhost:4322)
  --state <path>         Wrangler local state path; relative paths resolve from repo root
`);
}

if (resolve(process.argv[1] ?? "") === __filename) {
  const config = getDoctorConfig();
  if (config.help) {
    printHelp();
    process.exit(0);
  }

  try {
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
