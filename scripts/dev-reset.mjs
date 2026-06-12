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
 * After reset, navigate to /admin to create a new admin account.
 */

import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const args = process.argv.slice(2);
const skipAdmin = args.includes("--skip-admin");
const showHelp = args.includes("--help") || args.includes("-h");
const localAdminEmail = getArgValue("--admin-email") || process.env.LOCAL_ADMIN_EMAIL || "admin@local.scalius.test";
const localAdminPassword = getArgValue("--admin-password") || process.env.LOCAL_ADMIN_PASSWORD || "ScaliusLocal123!";
const localAdminName = getArgValue("--admin-name") || process.env.LOCAL_ADMIN_NAME || "Local Admin";
const wranglerStateOverride = getArgValue("--state") || process.env.SCALIUS_WRANGLER_STATE;

if (wranglerStateOverride) {
  process.env.SCALIUS_WRANGLER_STATE = wranglerStateOverride;
}

if (showHelp) {
  console.log(`
Usage: pnpm dev:reset [options]

Options:
  --skip-admin               Do not create the default local admin after reset
  --admin-email <email>      Local admin email (default: ${localAdminEmail})
  --admin-password <value>   Local admin password, 12+ chars (default: ${localAdminPassword})
  --admin-name <name>        Local admin name (default: ${localAdminName})
  --state <path>             Wrangler local state path for disposable resets
`);
  process.exit(0);
}

function run(cmd, label) {
  console.log(`\n▶ ${label}`);
  console.log(`  $ ${cmd}\n`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

function getArgValue(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

console.log("\n🔄 Scalius Commerce — Database Reset\n");
console.log("=".repeat(50));

// 1. Delete ALL local D1/KV/R2 state (root + admin-v2's Cloudflare Vite plugin)
const wranglerState = wranglerStateOverride
  ? resolve(root, wranglerStateOverride)
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
      `--email ${shellQuote(localAdminEmail)}`,
      `--password ${shellQuote(localAdminPassword)}`,
      `--name ${shellQuote(localAdminName)}`,
      ...(wranglerStateOverride ? [`--state ${shellQuote(wranglerStateOverride)}`] : []),
    ].join(" "),
    "Creating default local admin",
  );
}

console.log("\n" + "=".repeat(50));
console.log("✅ Database reset complete!");
console.log("   Start fresh with: pnpm dev");
if (skipAdmin) {
  console.log("   Then visit http://localhost:4323/admin to create a new admin account.\n");
} else {
  console.log(`   Admin login: ${localAdminEmail} / ${localAdminPassword}\n`);
}
