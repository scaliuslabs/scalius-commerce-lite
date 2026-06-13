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
import {
  assertLocalUrl,
  assertPassword,
  parseOptions,
  resolveLocalStatePath,
  trimTrailingSlash,
} from "./dev-local-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const apiDir = resolve(root, "apps", "api");
const args = process.argv.slice(2);
const validCommands = new Set(["create", "reset", "status", "help"]);

const positionalCommand = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
const command = positionalCommand || "create";
const options = parseOptions(positionalCommand ? args.slice(1) : args);

const defaults = {
  apiBaseUrl: process.env.LOCAL_API_BASE_URL || "http://localhost:8787",
  email: process.env.LOCAL_ADMIN_EMAIL || "admin@local.scalius.test",
  password: process.env.LOCAL_ADMIN_PASSWORD || "ScaliusLocal123!",
  name: process.env.LOCAL_ADMIN_NAME || "Local Admin",
  wranglerState: resolveLocalStatePath(root, process.env.SCALIUS_WRANGLER_STATE),
};

if (options.help || command === "help") {
  printHelp();
  process.exit(0);
}

if (!validCommands.has(command)) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

const config = {
  apiBaseUrl: trimTrailingSlash(options.api || defaults.apiBaseUrl),
  email: options.email || defaults.email,
  password: options.password || defaults.password,
  name: options.name || defaults.name,
  noStart: Boolean(options["no-start"]),
  skipMigrations: Boolean(options["skip-migrations"] || options["no-migrate"]),
  wranglerState: resolveLocalStatePath(root, options.state || defaults.wranglerState),
};

try {
  assertLocalUrl(config.apiBaseUrl);
  if (command !== "status") {
    assertPassword(config.password);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let migrationsApplied = false;

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
    ensureLocalMigrations();
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
  --state <path>        Wrangler local state path; relative paths resolve from repo root
  --no-start            Require API to already be running
  --skip-migrations     Do not apply local D1 migrations before starting/resetting

Environment overrides:
  LOCAL_ADMIN_EMAIL, LOCAL_ADMIN_PASSWORD, LOCAL_ADMIN_NAME, LOCAL_API_BASE_URL,
  SCALIUS_WRANGLER_STATE
`);
}

async function withApi(work) {
  const alreadyRunning = await isApiReady();
  let child = null;

  if (!alreadyRunning) {
    if (config.noStart) {
      throw new Error(`API is not running at ${config.apiBaseUrl}. Start it with pnpm --filter @scalius/api dev.`);
    }
    if (config.apiBaseUrl !== defaults.apiBaseUrl) {
      throw new Error(
        `Custom --api ${config.apiBaseUrl} requires --no-start with an already running API worker. ` +
        `The bundled API dev script starts on ${defaults.apiBaseUrl}.`,
      );
    }

    ensureLocalMigrations();
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

function ensureLocalMigrations() {
  if (config.skipMigrations || migrationsApplied) return;

  console.log("Ensuring local D1 migrations are applied...");
  execFileSync("node", ["scripts/deploy.mjs", "--migrate-only", "--local"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      SCALIUS_WRANGLER_STATE: config.wranglerState,
    },
  });
  migrationsApplied = true;
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
