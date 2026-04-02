#!/usr/bin/env node
/**
 * dev-reset.mjs — Reset local D1 database and reinitialise from scratch
 *
 * Usage: pnpm dev:reset
 *
 * 1. Deletes shared local D1 database files (.wrangler/state/)
 * 2. Re-applies all migrations from scratch
 *
 * After reset, navigate to /admin to create a new admin account.
 */

import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function run(cmd, label) {
  console.log(`\n▶ ${label}`);
  console.log(`  $ ${cmd}\n`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

console.log("\n🔄 Scalius Commerce — Database Reset\n");
console.log("=".repeat(50));

// 1. Delete ALL local D1/KV/R2 state (root + admin-v2's Cloudflare Vite plugin)
const wranglerState = resolve(root, ".wrangler", "state");
const adminV2State = resolve(root, "apps", "admin-v2", ".wrangler", "state");

const paths = [
  { path: wranglerState, label: ".wrangler/state/ (API + storefront)" },
  { path: adminV2State, label: "apps/admin-v2/.wrangler/state/ (admin)" },
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

console.log("\n" + "=".repeat(50));
console.log("✅ Database reset complete!");
console.log("   Start fresh with: pnpm dev");
console.log("   Then visit http://localhost:4323/admin to create a new admin account.\n");
