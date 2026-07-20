#!/usr/bin/env node
/**
 * dev-reset.mjs — Reset local D1 database and reinitialise from scratch
 *
 * Usage: pnpm dev:reset
 *
 * 1. Deletes shared local D1 database files (.wrangler/state/)
 * 2. Re-applies all migrations from scratch
 * 3. Creates the default local admin account unless --skip-admin is passed
 *
 * After reset, sign in with the printed local admin credentials unless
 * --skip-admin was passed.
 */

import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  assertPassword,
  getArgValue,
  resolveLocalStatePath,
  shellQuote,
} from "./dev-local-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const args = process.argv.slice(2);
const skipAdmin = args.includes("--skip-admin");
const showHelp = args.includes("--help") || args.includes("-h");

let localAdminEmail;
let localAdminPassword;
let localAdminName;
let wranglerStateOverride;
try {
  localAdminEmail = getArgValue(args, "--admin-email") || process.env.LOCAL_ADMIN_EMAIL || "admin@local.scalius.test";
  localAdminPassword = getArgValue(args, "--admin-password") || process.env.LOCAL_ADMIN_PASSWORD || "ScaliusLocal123!";
  localAdminName = getArgValue(args, "--admin-name") || process.env.LOCAL_ADMIN_NAME || "Local Admin";
  wranglerStateOverride = getArgValue(args, "--state") || process.env.SCALIUS_WRANGLER_STATE;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const resolvedWranglerStateOverride = wranglerStateOverride ? resolveLocalStatePath(root, wranglerStateOverride) : null;

if (resolvedWranglerStateOverride) {
  process.env.SCALIUS_WRANGLER_STATE = resolvedWranglerStateOverride;
}

if (showHelp) {
  console.log(`
Usage: pnpm dev:reset [options]

Options:
  --skip-admin               Do not create the default local admin after reset
  --admin-email <email>      Local admin email (default: ${localAdminEmail})
  --admin-password <value>   Local admin password, 12+ chars (or LOCAL_ADMIN_PASSWORD)
  --admin-name <name>        Local admin name (default: ${localAdminName})
  --state <path>             Wrangler local state path; relative paths resolve from repo root
`);
  process.exit(0);
}

if (!skipAdmin) {
  try {
    assertPassword(localAdminPassword);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function run(cmd, label, options = {}) {
  console.log(`\n▶ ${label}`);
  console.log(`  $ ${options.displayCommand ?? cmd}\n`);
  execSync(cmd, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
}

console.log("\n🔄 Scalius Commerce — Database Reset\n");
console.log("=".repeat(50));

// 1. Delete ALL local D1/KV/R2 state (root + admin-v2's Cloudflare Vite plugin)
const wranglerState = resolvedWranglerStateOverride
  ? resolvedWranglerStateOverride
  : resolve(root, ".wrangler", "state");
const adminV2State = resolve(root, "apps", "admin-v2", ".wrangler", "state");

const paths = [
  { path: wranglerState, label: ".wrangler/state/ (API + storefront)" },
  ...(wranglerStateOverride ? [] : [{ path: adminV2State, label: "apps/admin-v2/.wrangler/state/ (admin)" }]),
];

let deleted = false;
for (const { path, label } of paths) {
  if (existsSync(path)) {
    if (!deleted) console.log("\n▶ Deleting local database state");
    rmSync(path, { recursive: true, force: true });
    console.log(`  ✓ Deleted ${label}`);
    deleted = true;
  }
}
if (!deleted) {
  console.log("\n⚡ No local database state found — clean start");
}

// 2. Re-apply all migrations from scratch
run(
  "node scripts/deploy.mjs --migrate-only --local",
  "Applying all D1 migrations from scratch"
);

if (skipAdmin) {
  console.log("\n⚡ Skipping local admin creation");
} else {
  run(
    [
      "node scripts/dev-admin.mjs create",
      "--skip-migrations",
      ...(resolvedWranglerStateOverride ? [`--state ${shellQuote(resolvedWranglerStateOverride)}`] : []),
    ].join(" "),
    "Creating default local admin",
    {
      displayCommand: "node scripts/dev-admin.mjs create --skip-migrations (credentials via environment)",
      env: {
        LOCAL_ADMIN_EMAIL: localAdminEmail,
        LOCAL_ADMIN_PASSWORD: localAdminPassword,
        LOCAL_ADMIN_NAME: localAdminName,
      },
    },
  );
}

console.log("\n" + "=".repeat(50));
console.log("✅ Database reset complete!");
console.log("   Start fresh with: pnpm dev");
if (skipAdmin) {
  console.log("   Then visit http://localhost:4323/admin to create a new admin account.\n");
} else {
  console.log(`   Admin login: ${localAdminEmail} with the configured local admin password.\n`);
}
