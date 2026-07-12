#!/usr/bin/env node
/**
 * Local admin settings smoke helper.
 *
 * This script is intentionally loopback-local only. It can start the local API
 * and admin workers, ensures a first local admin when none exists, signs in
 * through the dashboard worker's same-origin Better Auth route, then proves the
 * admin proxy session can read account security and save business settings.
 */

import { execFileSync, spawn } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  assertPassword,
  assertSafeLocalMutationUrl,
  assertStringOptions,
  parseOptions,
  resolveLocalStatePath,
  resolvePnpmExecutable,
  trimTrailingSlash,
} from "./dev-local-utils.mjs";
import {
  buildCookieHeader,
  extractSetCookieHeaders,
} from "./admin-session-cookie.mjs";
export {
  buildCookieHeader,
  extractSetCookieHeaders,
  splitCombinedSetCookieHeader,
} from "./admin-session-cookie.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pnpmExecutable = resolvePnpmExecutable();
const validCommands = new Set(["smoke", "help"]);

const defaults = {
  apiBaseUrl: "http://localhost:8787",
  adminBaseUrl: "http://localhost:4323",
  email: "admin@local.scalius.test",
  password: "ScaliusLocal123!",
  name: "Local Admin",
  wranglerState: resolveLocalStatePath(root, undefined),
};

let migrationsApplied = false;

export function getAdminSmokeConfig(rawArgs = process.argv.slice(2), env = process.env) {
  const positionalCommand = rawArgs[0] && !rawArgs[0].startsWith("--") ? rawArgs[0] : undefined;
  const command = positionalCommand || "smoke";
  const options = parseOptions(positionalCommand ? rawArgs.slice(1) : rawArgs);

  if (options.help) {
    return { command: "help" };
  }
  if (!validCommands.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (command === "help") {
    return { command };
  }

  assertStringOptions(options, ["api", "admin", "email", "password", "name", "state"]);

  const apiBaseUrl = normalizeSmokeOrigin(
    options.api || env.LOCAL_API_BASE_URL || defaults.apiBaseUrl,
    "API URL",
  );
  const adminBaseUrl = normalizeSmokeOrigin(
    options.admin || env.LOCAL_ADMIN_BASE_URL || defaults.adminBaseUrl,
    "admin URL",
  );
  assertSafeLocalMutationUrl(apiBaseUrl, "API URL");
  assertSafeLocalMutationUrl(adminBaseUrl, "admin URL");

  const password = options.password || env.LOCAL_ADMIN_PASSWORD || defaults.password;
  assertPassword(password);

  return {
    command,
    apiBaseUrl,
    adminBaseUrl,
    email: options.email || env.LOCAL_ADMIN_EMAIL || defaults.email,
    password,
    name: options.name || env.LOCAL_ADMIN_NAME || defaults.name,
    wranglerState: resolveLocalStatePath(
      root,
      options.state || env.SCALIUS_WRANGLER_STATE || defaults.wranglerState,
    ),
    noStart: Boolean(options["no-start"]),
    skipMigrations: Boolean(options["skip-migrations"] || options["no-migrate"]),
    skipSetup: Boolean(options["skip-setup"]),
    resetAdmin: Boolean(options["reset-admin"]),
  };
}

export function normalizeSmokeOrigin(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a URL.`);
  }

  let url;
  try {
    url = new URL(trimTrailingSlash(value.trim()));
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an origin without a path, query, or fragment.`);
  }

  return url.origin;
}

export function buildBusinessSettingsSmokePayload(settings) {
  if (!settings || typeof settings !== "object") {
    throw new Error("Business settings response did not include an object payload.");
  }
  if (typeof settings.invoicePrefix !== "string") {
    throw new Error("Business settings response did not include invoicePrefix.");
  }
  return { invoicePrefix: settings.invoicePrefix };
}

export async function runAdminSmoke(config) {
  if (config.command === "help") {
    printHelp();
    return null;
  }

  return withLocalWorkers(config, async (workers) => {
    let setup;
    if (config.resetAdmin) {
      setup = resetLocalAdmin(config);
    } else if (config.skipSetup) {
      setup = { skipped: true, adminExistsBefore: null, created: false };
    } else {
      setup = await ensureLocalAdmin(config);
    }

    const signIn = await signInAdmin(config);
    const accountSecurity = await requestAdminJson(
      config,
      "GET",
      "/api/v1/admin/auth/account-security",
      undefined,
      signIn.cookieHeader,
    );
    const accountSecurityData = unwrapData(accountSecurity.body);
    assertCondition(
      typeof accountSecurityData?.isSuperAdmin === "boolean",
      "Account security response did not include isSuperAdmin.",
    );

    const businessSettingsBefore = await requestAdminJson(
      config,
      "GET",
      "/api/v1/admin/settings/business",
      undefined,
      signIn.cookieHeader,
    );
    const businessSettingsBeforeData = unwrapData(businessSettingsBefore.body);
    const savePayload = buildBusinessSettingsSmokePayload(businessSettingsBeforeData);
    const save = await requestAdminJson(
      config,
      "POST",
      "/api/v1/admin/settings/business",
      savePayload,
      signIn.cookieHeader,
    );
    const businessSettingsAfter = await requestAdminJson(
      config,
      "GET",
      "/api/v1/admin/settings/business",
      undefined,
      signIn.cookieHeader,
    );
    const businessSettingsAfterData = unwrapData(businessSettingsAfter.body);
    assertCondition(
      businessSettingsAfterData?.invoicePrefix === savePayload.invoicePrefix,
      "Business settings read-after-write did not preserve invoicePrefix.",
    );

    const result = {
      success: true,
      localOnly: true,
      targets: {
        api: config.apiBaseUrl,
        admin: config.adminBaseUrl,
      },
      workers,
      setup,
      signIn: {
        status: signIn.status,
        setCookieCount: signIn.setCookieCount,
        twoFactorRedirect: false,
      },
      accountSecurity: {
        status: accountSecurity.status,
        isSuperAdmin: accountSecurityData.isSuperAdmin,
        twoFactorMethod: accountSecurityData.twoFactorMethod ?? null,
      },
      businessSettings: {
        getBeforeStatus: businessSettingsBefore.status,
        postStatus: save.status,
        getAfterStatus: businessSettingsAfter.status,
        savedKeys: Object.keys(savePayload),
        invoicePrefixBefore: businessSettingsBeforeData.invoicePrefix,
        invoicePrefixAfter: businessSettingsAfterData.invoicePrefix,
      },
    };

    console.log(JSON.stringify(result, null, 2));
    return result;
  });
}

function printHelp() {
  console.log(`
Local admin settings smoke

Usage:
  pnpm dev:admin:smoke
  node scripts/dev-admin-smoke.mjs smoke --no-start

Options:
  --api <url>           Local API origin (default: ${defaults.apiBaseUrl})
  --admin <url>         Local admin origin (default: ${defaults.adminBaseUrl})
  --email <email>       Local admin email (default: ${defaults.email})
  --password <value>    Local admin password, 12+ chars (default: ${defaults.password})
  --name <name>         First-admin setup name (default: ${defaults.name})
  --state <path>        Wrangler local state path; relative paths resolve from repo root
  --reset-admin         Reset local auth tables through scripts/dev-admin.mjs first
  --skip-setup          Do not create the first local admin when none exists
  --no-start            Require API and admin workers to already be running
  --skip-migrations     Do not apply local D1 migrations before starting workers

Safety:
  This smoke refuses known production and non-loopback URLs. It never writes
  secrets and only POSTs the current invoicePrefix value back to the local
  admin business settings endpoint.
`);
}

async function withLocalWorkers(config, work) {
  const apiWasRunning = await isApiReady(config);
  const adminWasRunning = await isAdminReady(config);
  const workers = {
    apiStarted: false,
    adminStarted: false,
  };
  const children = [];

  if ((!apiWasRunning || !adminWasRunning) && config.noStart) {
    const missing = [
      !apiWasRunning ? `API at ${config.apiBaseUrl}` : null,
      !adminWasRunning ? `admin at ${config.adminBaseUrl}` : null,
    ].filter(Boolean).join(" and ");
    throw new Error(`${missing} is not running. Start local dev workers with pnpm dev:admin.`);
  }

  if (!apiWasRunning || !adminWasRunning) {
    ensureLocalMigrations(config);
  }

  try {
    if (!apiWasRunning) {
      assertDefaultDevPort(config.apiBaseUrl, 8787, "API");
      log(`Starting temporary API worker at ${config.apiBaseUrl}...`);
      const child = spawnWorker("api", ["--filter", "@scalius/api", "dev"], config);
      children.push(child);
      workers.apiStarted = true;
      await waitForService("API", () => isApiReady(config), () => getChildStatus(child));
    }

    if (!adminWasRunning) {
      assertDefaultDevPort(config.adminBaseUrl, 4323, "admin");
      log(`Starting temporary admin worker at ${config.adminBaseUrl}...`);
      const child = spawnWorker("admin", ["--filter", "@scalius/admin-v2", "dev"], config);
      children.push(child);
      workers.adminStarted = true;
      await waitForService("admin", () => isAdminReady(config), () => getChildStatus(child));
    }

    return await work(workers);
  } finally {
    for (const child of children.reverse()) {
      if (!child.killed) {
        log(`Stopping temporary ${child.__scaliusLabel} worker...`);
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        child.kill("SIGTERM");
      }
    }
  }
}

function spawnWorker(label, args, config) {
  const child = spawn(pnpmExecutable, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SCALIUS_WRANGLER_STATE: config.wranglerState,
    },
  });
  child.__scaliusLabel = label;
  child.__scaliusStatus = null;
  child.once("exit", (code, signal) => {
    child.__scaliusStatus = { code, signal };
  });
  child.stdout.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  return child;
}

function getChildStatus(child) {
  return child.__scaliusStatus;
}

async function isApiReady(config) {
  try {
    const response = await fetch(`${config.apiBaseUrl}/api/v1/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isAdminReady(config) {
  try {
    const response = await fetch(`${config.adminBaseUrl}/api/auth/get-session`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1200),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitForService(label, isReady, getChildStatus = () => null) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isReady()) return;
    const childStatus = getChildStatus();
    if (childStatus) {
      const reason = childStatus.signal ? `signal ${childStatus.signal}` : `exit code ${childStatus.code}`;
      throw new Error(`Temporary ${label} worker exited before it was ready (${reason}).`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label} worker.`);
}

function ensureLocalMigrations(config) {
  if (config.skipMigrations || migrationsApplied) return;
  log("Ensuring local D1 migrations are applied...");
  execFileSyncToStderr("node", ["scripts/deploy.mjs", "--migrate-only", "--local"], {
    cwd: root,
    env: {
      ...process.env,
      SCALIUS_WRANGLER_STATE: config.wranglerState,
    },
  });
  migrationsApplied = true;
}

function execFileSyncToStderr(file, args, options) {
  try {
    execFileSync(file, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.stdout) process.stderr.write(String(error.stdout));
    if (error?.stderr) process.stderr.write(String(error.stderr));
    throw error;
  }
}

async function ensureLocalAdmin(config) {
  const status = await requestApiJson(config, "GET", "/api/v1/setup");
  const statusData = unwrapData(status.body);
  if (statusData?.adminExists) {
    return {
      skipped: false,
      adminExistsBefore: true,
      created: false,
    };
  }

  const created = await requestApiJson(config, "POST", "/api/v1/setup", {
    name: config.name,
    email: config.email,
    password: config.password,
  }, [201]);
  const createdData = unwrapData(created.body);

  return {
    skipped: false,
    adminExistsBefore: false,
    created: true,
    userId: createdData?.userId ?? null,
  };
}

function resetLocalAdmin(config) {
  const args = [
    "scripts/dev-admin.mjs",
    "reset",
    "--api",
    config.apiBaseUrl,
    "--email",
    config.email,
    "--password",
    config.password,
    "--name",
    config.name,
    "--state",
    config.wranglerState,
    "--no-start",
  ];
  if (config.skipMigrations) {
    args.push("--skip-migrations");
  }

  log("Resetting local admin through scripts/dev-admin.mjs...");
  execFileSyncToStderr("node", args, {
    cwd: root,
    env: {
      ...process.env,
      SCALIUS_WRANGLER_STATE: config.wranglerState,
    },
  });

  return {
    skipped: false,
    reset: true,
    adminExistsBefore: null,
    created: true,
  };
}

async function signInAdmin(config) {
  const response = await fetch(`${config.adminBaseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: config.adminBaseUrl,
    },
    body: JSON.stringify({
      email: config.email,
      password: config.password,
      rememberMe: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await parseJsonResponse(response);
  const errorMessage = getResponseErrorMessage(body, response);

  if (!response.ok) {
    throw new Error(
      `POST /api/auth/sign-in/email failed (${response.status}): ${errorMessage}. ` +
      "If local D1 already has a different admin password, run pnpm dev:admin:reset first.",
    );
  }
  if (body?.twoFactorRedirect) {
    throw new Error(
      "Local admin sign-in requires two-factor verification. Reset the local admin with pnpm dev:admin:reset " +
      "or pass credentials for a local admin session that does not require 2FA.",
    );
  }

  const setCookieHeaders = extractSetCookieHeaders(response.headers);
  const cookieHeader = buildCookieHeader(setCookieHeaders);
  if (!cookieHeader) {
    throw new Error("Admin sign-in succeeded but did not return a Set-Cookie session.");
  }

  return {
    status: response.status,
    body,
    cookieHeader,
    setCookieCount: setCookieHeaders.length,
  };
}

async function requestApiJson(config, method, path, body, expectedStatuses = [200]) {
  return requestJson(config.apiBaseUrl, method, path, body, expectedStatuses);
}

async function requestAdminJson(config, method, path, body, cookieHeader, expectedStatuses = [200]) {
  return requestJson(config.adminBaseUrl, method, path, body, expectedStatuses, {
    cookie: cookieHeader,
    origin: config.adminBaseUrl,
  });
}

async function requestJson(baseUrl, method, path, body, expectedStatuses = [200], extraHeaders = {}) {
  const headers = {
    accept: "application/json",
    ...extraHeaders,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = await parseJsonResponse(response);
  const errorMessage = getResponseErrorMessage(parsed, response);
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${method} ${path} failed (${response.status}): ${errorMessage}`);
  }
  return {
    status: response.status,
    body: parsed,
    errorMessage: response.ok ? null : errorMessage,
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getResponseErrorMessage(body, response) {
  return body?.error?.message || body?.message || body?.error || body?.raw || response.statusText;
}

function unwrapData(body) {
  return body?.data ?? body;
}

function assertDefaultDevPort(value, port, label) {
  const url = new URL(value);
  const actualPort = url.port || (url.protocol === "http:" ? "80" : "443");
  if (url.protocol !== "http:" || actualPort !== String(port)) {
    throw new Error(
      `Custom ${label} URL ${value} requires --no-start with an already running local worker. ` +
      `The bundled dev script starts ${label} on http://localhost:${port}.`,
    );
  }
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function log(message) {
  console.error(message);
}

async function main() {
  try {
    const config = getAdminSmokeConfig();
    await runAdminSmoke(config);
  } catch (error) {
    console.error("\nLocal admin settings smoke failed.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
