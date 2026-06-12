#!/usr/bin/env node
/**
 * Local admin helper.
 *
 * Usage:
 *   pnpm dev:admin:create
 *   pnpm dev:admin:reset
 *   pnpm dev:admin:status
 *
 * This is intentionally local-only. It creates admins through the real
 * /api/v1/setup endpoint so Better Auth owns password hashing.
 */

import { execFileSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const apiDir = resolve(root, "apps", "api");
const args = process.argv.slice(2);

const command = args.find((arg) => !arg.startsWith("-")) || "create";
const options = parseOptions(args.filter((arg) => arg !== command));

const defaults = {
  apiBaseUrl: process.env.LOCAL_API_BASE_URL || "http://localhost:8787",
  email: process.env.LOCAL_ADMIN_EMAIL || "admin@local.scalius.test",
  password: process.env.LOCAL_ADMIN_PASSWORD || "ScaliusLocal123!",
  name: process.env.LOCAL_ADMIN_NAME || "Local Admin",
  wranglerState: process.env.SCALIUS_WRANGLER_STATE || "../../.wrangler/state",
};

if (options.help || command === "help") {
  printHelp();
  process.exit(0);
}

const config = {
  apiBaseUrl: trimTrailingSlash(options.api || defaults.apiBaseUrl),
  email: options.email || defaults.email,
  password: options.password || defaults.password,
  name: options.name || defaults.name,
  noStart: Boolean(options["no-start"]),
  wranglerState: options.state || defaults.wranglerState,
};

assertLocalUrl(config.apiBaseUrl);
assertPassword(config.password);

try {
  if (command === "status") {
    await withApi(async () => {
      const status = await getSetupStatus();
      console.log(status.adminExists ? "Local admin exists." : "No local admin exists.");
    });
  } else if (command === "create") {
    await withApi(async () => {
      await createAdmin({ allowExisting: true });
    });
  } else if (command === "reset") {
    resetLocalAuthTables();
    await withApi(async () => {
      await createAdmin({ allowExisting: false });
    });
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
} catch (error) {
  console.error(`\nLocal admin ${command} failed.`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseOptions(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (!arg.startsWith("--")) continue;
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      parsed[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = rawArgs[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[withoutPrefix] = next;
      i++;
    } else {
      parsed[withoutPrefix] = true;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`
Local admin helper

Commands:
  create   Create the first local admin if none exists
  reset    Delete local auth/session data, then create a fresh local admin
  status   Print whether a local admin exists

Options:
  --email <email>       Admin email (default: ${defaults.email})
  --password <value>    Admin password, 12+ chars (default: ${defaults.password})
  --name <name>         Admin name (default: ${defaults.name})
  --api <url>           Local API origin (default: ${defaults.apiBaseUrl})
  --state <path>        Wrangler local state path (default: ${defaults.wranglerState})
  --no-start            Require API to already be running

Environment overrides:
  LOCAL_ADMIN_EMAIL, LOCAL_ADMIN_PASSWORD, LOCAL_ADMIN_NAME, LOCAL_API_BASE_URL,
  SCALIUS_WRANGLER_STATE
`);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function assertLocalUrl(value) {
  const url = new URL(value);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error(`Refusing to run against non-local API URL: ${value}`);
  }
}

function assertPassword(password) {
  if (password.length < 12) {
    throw new Error("Local admin password must be at least 12 characters.");
  }
}

async function withApi(work) {
  const alreadyRunning = await isApiReady();
  let child = null;

  if (!alreadyRunning) {
    if (config.noStart) {
      throw new Error(`API is not running at ${config.apiBaseUrl}. Start it with pnpm --filter @scalius/api dev.`);
    }

    console.log(`Starting temporary API worker at ${config.apiBaseUrl}...`);
    child = spawn("pnpm", ["--filter", "@scalius/api", "dev"], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        SCALIUS_WRANGLER_STATE: config.wranglerState,
      },
    });
    let childStatus = null;
    child.once("exit", (code, signal) => {
      childStatus = { code, signal };
    });

    const stop = () => {
      if (child && !child.killed) child.kill("SIGTERM");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      await waitForApi(() => childStatus);
    } catch (error) {
      stop();
      throw error;
    }
  }

  try {
    await work();
  } finally {
    if (child && !child.killed) {
      console.log("Stopping temporary API worker...");
      child.kill("SIGTERM");
    }
  }
}

async function isApiReady() {
  try {
    const response = await fetch(`${config.apiBaseUrl}/api/v1/setup`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForApi(getChildStatus = () => null) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isApiReady()) return;
    const childStatus = getChildStatus();
    if (childStatus) {
      const reason = childStatus.signal ? `signal ${childStatus.signal}` : `exit code ${childStatus.code}`;
      throw new Error(`Temporary API worker exited before it was ready (${reason}).`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for API at ${config.apiBaseUrl}.`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function getSetupStatus() {
  return requestJson("GET", "/api/v1/setup");
}

async function createAdmin({ allowExisting }) {
  const status = await getSetupStatus();
  if (status.adminExists) {
    if (allowExisting) {
      console.log("Local admin already exists; leaving credentials unchanged.");
      console.log("Use pnpm dev:admin:reset to recreate the local admin account.");
      return;
    }
    throw new Error("Admin still exists after auth reset.");
  }

  await requestJson("POST", "/api/v1/setup", {
    name: config.name,
    email: config.email,
    password: config.password,
  });

  console.log("\nLocal admin ready:");
  console.log(`  Admin URL: http://localhost:4323/admin`);
  console.log(`  Email:     ${config.email}`);
  console.log(`  Password:  ${config.password}`);
}

async function requestJson(method, path, body) {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.error?.message || data?.message || text || response.statusText;
    throw new Error(`${method} ${path} failed (${response.status}): ${message}`);
  }
  return data?.data ?? data;
}

function resetLocalAuthTables() {
  const dbName = readLocalD1DatabaseName();
  const sql = [
    "DELETE FROM admin_fcm_tokens",
    "DELETE FROM session",
    "DELETE FROM account",
    "DELETE FROM verification",
    "DELETE FROM two_factor",
    "DELETE FROM user_roles",
    "DELETE FROM user_permissions",
    'DELETE FROM "user"',
  ].join("; ");

  console.log(`Resetting local auth tables in D1 database "${dbName}"...`);
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      dbName,
      "--local",
      "--persist-to",
      config.wranglerState,
      "--command",
      sql,
    ],
    { cwd: apiDir, stdio: "inherit" },
  );
}

function readLocalD1DatabaseName() {
  const raw = readFileSync(resolve(apiDir, "wrangler.jsonc"), "utf8");
  const stripped = raw.replace(/(?<!https?:)\/\/[^\n]*/g, "");
  const configJson = JSON.parse(stripped);
  const dbName = configJson.d1_databases?.[0]?.database_name;
  if (!dbName) {
    throw new Error("Could not find d1_databases[0].database_name in apps/api/wrangler.jsonc.");
  }
  return dbName;
}
