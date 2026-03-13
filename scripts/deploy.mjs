#!/usr/bin/env node
/**
 * deploy.mjs — Full deploy pipeline for Cloudflare Workers
 *
 * Usage:
 *   node scripts/deploy.mjs                  # full deploy (build + migrate + deploy all workers)
 *   node scripts/deploy.mjs --migrate-only   # apply migrations to remote D1 only
 *   node scripts/deploy.mjs --migrate-only --local  # apply migrations to local D1 only
 *
 * Runs in order (full deploy):
 *   1. turbo build       — builds all workspaces
 *   2. wrangler d1 migrations apply --remote  — applies pending migrations to D1
 *   3. wrangler deploy   — deploys all three workers (API, Admin, Storefront)
 *
 * The database name is read from apps/api/wrangler.jsonc (API worker owns D1).
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const apiDir = resolve(root, "apps", "api");
const args = process.argv.slice(2);
const migrateOnly = args.includes("--migrate-only");
const local = args.includes("--local");

// Suppress punycode deprecation warnings which corrupt Wrangler's STDOUT API payloads on Node >= 21
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || "") + " --no-warnings=DEP0040";

// ── Read wrangler.jsonc from apps/api/ (strip // comments so JSON.parse works)
function readWranglerConfig() {
  const raw = readFileSync(resolve(apiDir, "wrangler.jsonc"), "utf8");
  // Strip single-line // comments to turn JSONC into valid JSON, ignoring http:// and https://
  const stripped = raw.replace(/(?<!https?:)\/\/[^\n]*/g, "");
  return JSON.parse(stripped);
}

// ── Run a shell command, streaming output, throwing on failure
function run(cmd, label, cwd = root) {
  console.log(`\n▶ ${label}`);
  console.log(`  $ ${cmd}\n`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// ── Main
(async () => {
  let config;
  try {
    config = readWranglerConfig();
  } catch (e) {
    console.error("✗ Could not parse apps/api/wrangler.jsonc:", e.message);
    process.exit(1);
  }

  const d1 = config.d1_databases?.[0];
  if (!d1?.database_name) {
    console.error(
      "✗ No d1_databases[0].database_name found in apps/api/wrangler.jsonc.\n" +
      "  Add a D1 database binding before deploying."
    );
    process.exit(1);
  }

  const dbName = d1.database_name;
  const target = local ? "local" : "remote";
  const persistFlag = local ? " --persist-to ../../.wrangler/state" : "";

  if (migrateOnly) {
    console.log(`\n🗄  Applying D1 migrations → "${dbName}" (${target})\n`);
    try {
      run(
        `pnpm exec wrangler d1 migrations apply ${dbName} --${target}${persistFlag}`,
        `Apply migrations → ${dbName} (${target})`,
        apiDir
      );
      console.log("\n✓ Migrations applied.");
    } catch {
      console.error("\n✗ Migration failed. See error above.");
      process.exit(1);
    }
    return;
  }

  console.log(`\n🚀 Deploying "${config.name}" → D1: "${dbName}"\n`);
  console.log("=".repeat(60));

  try {
    // 1. Build: all workspaces via Turbo
    run("pnpm build", "Build all workspaces");

    // 2. Apply all pending D1 migrations (no-op if schema is up to date)
    run(
      `pnpm exec wrangler d1 migrations apply ${dbName} --remote`,
      `Apply D1 migrations → ${dbName}`,
      apiDir
    );

    // 3. Deploy all three workers
    run("pnpm exec wrangler deploy", "Deploy API Worker", apiDir);
    run("pnpm exec wrangler deploy", "Deploy Admin Worker", resolve(root, "apps", "admin"));
    run("pnpm exec wrangler deploy", "Deploy Storefront Worker", resolve(root, "apps", "storefront"));

    console.log("\n✓ Deploy complete (API + Admin + Storefront).");
  } catch {
    console.error("\n✗ Deploy failed. See error above.");
    process.exit(1);
  }
})();
