#!/usr/bin/env node
/**
 * deploy.mjs — Full deploy pipeline for Cloudflare Workers
 *
 * Usage:
 *   node scripts/deploy.mjs                  # full deploy (build + migrate + deploy all workers)
 *   node scripts/deploy.mjs --only api       # typecheck + build/deploy API and migrate D1
 *   node scripts/deploy.mjs --only admin     # typecheck + build/deploy admin
 *   node scripts/deploy.mjs --only storefront # typecheck + build/deploy storefront
 *   node scripts/deploy.mjs --only api --dry-run # typecheck + build + dist checks only
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
import { delimiter, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { resolvePnpmExecutable, shellQuote } from "./dev-local-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const apiDir = resolve(root, "apps", "api");
const args = process.argv.slice(2);
const migrateOnly = args.includes("--migrate-only");
const local = args.includes("--local");
const dryRun = args.includes("--dry-run");
const localPersistPath = process.env.SCALIUS_WRANGLER_STATE || "../../.wrangler/state";
const onlyArgIndex = args.indexOf("--only");
const onlyTarget = onlyArgIndex >= 0 ? args[onlyArgIndex + 1] : null;
const deployTargets = ["api", "admin", "storefront"];
const appDirsByTarget = {
  api: "apps/api",
  admin: "apps/admin-v2",
  storefront: "apps/storefront",
};
const storefrontStaticPostDeployWarmPaths = ["/", "/search"];
const STOREFRONT_DYNAMIC_WARM_LIMIT = 4;
const STOREFRONT_DYNAMIC_WARM_TIMEOUT_MS = 8_000;
const STOREFRONT_WARM_CONCURRENCY = 4;
const pnpmExecutable = resolvePnpmExecutable();
process.env.SCALIUS_PNPM_BIN = pnpmExecutable;
process.env.PATH = `${dirname(pnpmExecutable)}${delimiter}${process.env.PATH || ""}`;
const pnpm = shellQuote(pnpmExecutable);

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

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runJson(cmd, label, cwd = root) {
  console.log(`\n▶ ${label}`);
  console.log(`  $ ${cmd}\n`);
  const output = execSync(cmd, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

// ── Run a shell command with retries for transient Cloudflare API errors
function runWithRetry(cmd, label, cwd = root, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      run(cmd, attempt > 1 ? `${label} (attempt ${attempt}/${maxRetries})` : label, cwd);
      return;
    } catch (err) {
      if (attempt === maxRetries) {
        throw err;
      }
      const delaySec = attempt * 5;
      console.log(`\n⚠ ${label} failed (attempt ${attempt}/${maxRetries}). Retrying in ${delaySec}s...`);
      execSync(`sleep ${delaySec}`);
    }
  }
}

function validateOnlyTarget() {
  if (onlyArgIndex === -1) return null;
  if (!onlyTarget || onlyTarget.startsWith("--") || !deployTargets.includes(onlyTarget)) {
    console.error(`✗ Invalid --only target. Use one of: ${deployTargets.join(", ")}`);
    process.exit(1);
  }
  return onlyTarget;
}

function buildTarget(target) {
  switch (target) {
    case "api":
      run(`${pnpm} --filter @scalius/api build`, "Build API workspace");
      break;
    case "admin":
      run(`${pnpm} --filter @scalius/admin-v2 build`, "Build Admin V2 workspace");
      break;
    case "storefront":
      run(`${pnpm} --filter @scalius/storefront build`, "Build Storefront workspace");
      break;
  }
}

function deployTarget(target) {
  switch (target) {
    case "api":
      runWithRetry(`${pnpm} exec wrangler deploy`, "Deploy API Worker", apiDir);
      break;
    case "admin":
      runWithRetry(`${pnpm} exec wrangler deploy`, "Deploy Admin V2 Worker", resolve(root, "apps", "admin-v2"));
      break;
    case "storefront":
      runWithRetry(
        `${pnpm} exec wrangler deploy --config dist/server/wrangler.json`,
        "Deploy Storefront Worker",
        resolve(root, "apps", "storefront"),
      );
      break;
  }
}

function getLatestDeployment(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) return null;
  return deployments.reduce((latest, deployment) => {
    if (!latest) return deployment;
    return new Date(deployment.created_on).getTime() > new Date(latest.created_on).getTime()
      ? deployment
      : latest;
  }, null);
}

async function verifyHttpOk(url, label) {
  console.log(`\n▶ ${label}`);
  console.log(`  GET ${url}\n`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${label} returned ${response.status}: ${body.slice(0, 200)}`);
    }
    console.log(`✓ ${label} returned ${response.status}.`);
  } finally {
    clearTimeout(timeout);
  }
}

async function warmStorefrontPath(url, path) {
  const warmUrl = new URL(path, url).toString();
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(warmUrl, {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache",
        "X-Cache-Warm": "deploy",
      },
      signal: controller.signal,
    });
    await response.arrayBuffer();
    const durationMs = Date.now() - startedAt;
    const cacheStatus = response.headers.get("X-Cache-Status") ?? "unknown";

    if (!response.ok) {
      console.warn(
        `⚠ Warm ${path} returned ${response.status} in ${durationMs}ms (${cacheStatus}).`,
      );
      return;
    }

    console.log(`✓ Warmed ${path} in ${durationMs}ms (${cacheStatus}).`);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`⚠ Warm ${path} failed after ${durationMs}ms: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function buildApiUrl(apiBaseUrl, path) {
  const baseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  return new URL(path.replace(/^\//, ""), baseUrl).toString();
}

function getPayloadCollection(payload, keys) {
  const unwrapped = payload?.data ?? payload;
  if (Array.isArray(unwrapped)) {
    return unwrapped;
  }

  for (const key of keys) {
    const value = unwrapped?.[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function appendSlugPaths(paths, items, prefix, limit) {
  for (const item of items) {
    if (paths.size >= limit) {
      return;
    }

    const slug = typeof item?.slug === "string" ? item.slug.trim() : "";
    if (!slug) {
      continue;
    }

    paths.add(`${prefix}/${encodeURIComponent(slug)}`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function collectDynamicWarmPaths(apiBaseUrl) {
  const paths = new Set();

  if (!apiBaseUrl) {
    return paths;
  }

  const [productsResult, categoriesResult] = await Promise.allSettled([
    fetchJsonWithTimeout(
      buildApiUrl(apiBaseUrl, `/products?limit=${STOREFRONT_DYNAMIC_WARM_LIMIT}`),
      STOREFRONT_DYNAMIC_WARM_TIMEOUT_MS,
    ),
    fetchJsonWithTimeout(
      buildApiUrl(apiBaseUrl, "/categories"),
      STOREFRONT_DYNAMIC_WARM_TIMEOUT_MS,
    ),
  ]);

  if (productsResult.status === "fulfilled") {
    appendSlugPaths(
      paths,
      getPayloadCollection(productsResult.value, ["products", "items"]),
      "/products",
      STOREFRONT_DYNAMIC_WARM_LIMIT,
    );
  } else {
    console.warn(`⚠ Could not discover product warm paths: ${errorMessage(productsResult.reason)}`);
  }

  const categoryPathLimit = STOREFRONT_DYNAMIC_WARM_LIMIT * 2;
  if (categoriesResult.status === "fulfilled") {
    appendSlugPaths(
      paths,
      getPayloadCollection(categoriesResult.value, ["categories", "items"]),
      "/categories",
      categoryPathLimit,
    );
  } else {
    console.warn(`⚠ Could not discover category warm paths: ${errorMessage(categoriesResult.reason)}`);
  }

  return paths;
}

async function collectStorefrontWarmPaths(generatedConfig) {
  const paths = new Set(storefrontStaticPostDeployWarmPaths);
  const apiBaseUrl = generatedConfig.vars?.PUBLIC_API_URL;
  const dynamicPaths = await collectDynamicWarmPaths(apiBaseUrl);
  for (const path of dynamicPaths) {
    paths.add(path);
  }
  return [...paths];
}

async function warmStorefrontAfterDeploy(storefrontUrl, generatedConfig) {
  const warmPaths = await collectStorefrontWarmPaths(generatedConfig);

  console.log("\n▶ Warm Storefront critical HTML caches");
  console.log(`  ${warmPaths.join(", ")}\n`);

  for (let index = 0; index < warmPaths.length; index += STOREFRONT_WARM_CONCURRENCY) {
    const chunk = warmPaths.slice(index, index + STOREFRONT_WARM_CONCURRENCY);
    await Promise.all(
      chunk.map((path) =>
        warmStorefrontPath(storefrontUrl, path),
      ),
    );
  }
}

async function verifyStorefrontDeploy() {
  const storefrontDir = resolve(root, "apps", "storefront");
  const generatedConfigPath = resolve(storefrontDir, "dist", "server", "wrangler.json");
  const generatedConfig = readJsonFile(generatedConfigPath);

  const deployments = runJson(
    `${pnpm} exec wrangler deployments list --config dist/server/wrangler.json --json`,
    "Verify latest Storefront Worker deployment",
    storefrontDir,
  );
  const latest = getLatestDeployment(deployments);
  const deployedVersion = latest?.versions?.find((version) => version.percentage === 100);
  if (!latest || !deployedVersion?.version_id) {
    throw new Error("Could not prove the latest Storefront Worker deployment is serving one version at 100%.");
  }
  console.log(`✓ Latest Storefront deployment serves ${deployedVersion.version_id} at 100%.`);

  const storefrontUrl = generatedConfig.vars?.STOREFRONT_URL;
  if (!storefrontUrl) {
    throw new Error("Could not verify live storefront: STOREFRONT_URL is missing from generated Wrangler config.");
  }
  await verifyHttpOk(new URL("/health", storefrontUrl).toString(), "Verify live Storefront /health");
  await warmStorefrontAfterDeploy(storefrontUrl, generatedConfig);
}

async function verifyPostDeployTarget(target) {
  if (target === "storefront") {
    await verifyStorefrontDeploy();
  }
}

function checkDistEnvFiles(targets = deployTargets) {
  const appDirs = targets.map((target) => appDirsByTarget[target]).join(" ");
  run(
    `node scripts/clean-dist-env-files.mjs --check ${appDirs}`,
    "Verify app dist outputs do not contain local env files",
  );
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
  const persistFlag = local ? ` --persist-to ${shellQuote(localPersistPath)}` : "";
  const requestedTarget = validateOnlyTarget();

  if (migrateOnly) {
    console.log(`\n🗄  Applying D1 migrations → "${dbName}" (${target})\n`);
    if (dryRun) {
      console.log(`DRY RUN: would apply D1 migrations to ${dbName} (${target}).`);
      console.log("\n✓ Migration dry run complete.");
      return;
    }

    try {
      runWithRetry(
        `${pnpm} exec wrangler d1 migrations apply ${dbName} --${target}${persistFlag}`,
        `Apply migrations → ${dbName} (${target})`,
        apiDir
      );
      console.log("\n✓ Migrations applied.");
    } catch {
      console.error("\n✗ Migration failed after retries. See errors above.");
      process.exit(1);
    }
    return;
  }

  console.log(`\n🚀 ${dryRun ? "Validating deploy for" : "Deploying"} "${config.name}"${requestedTarget ? ` (${requestedTarget} only)` : ""} → D1: "${dbName}"\n`);
  console.log("=".repeat(60));

  try {
    // 1. Typecheck first — catches type mismatches esbuild ignores
    run(`${pnpm} typecheck`, "Typecheck all workspaces");

    if (requestedTarget) {
      buildTarget(requestedTarget);
      checkDistEnvFiles([requestedTarget]);

      if (dryRun) {
        console.log("\nDRY RUN: skipping D1 migrations and Worker deploy.");
        console.log(`\n✓ Deploy dry run complete (${requestedTarget}).`);
        return;
      }

      if (requestedTarget === "api") {
        runWithRetry(
          `${pnpm} exec wrangler d1 migrations apply ${dbName} --remote`,
          `Apply D1 migrations → ${dbName}`,
          apiDir
        );
      }

      deployTarget(requestedTarget);
      await verifyPostDeployTarget(requestedTarget);
      console.log(`\n✓ Deploy complete (${requestedTarget}).`);
      return;
    }

    // 2. Build: all workspaces via Turbo
    run(`${pnpm} build`, "Build all workspaces");
    checkDistEnvFiles();

    if (dryRun) {
      console.log("\nDRY RUN: skipping D1 migrations and Worker deploys.");
      console.log("\n✓ Deploy dry run complete (API + Admin V2 + Storefront).");
      return;
    }

    // 3. Apply all pending D1 migrations (no-op if schema is up to date)
    runWithRetry(
      `${pnpm} exec wrangler d1 migrations apply ${dbName} --remote`,
      `Apply D1 migrations → ${dbName}`,
      apiDir
    );

    // 4. Deploy all three workers (admin-v2 replaces the old Astro admin)
    deployTarget("api");
    deployTarget("admin");
    deployTarget("storefront");
    await verifyPostDeployTarget("storefront");

    console.log("\n✓ Deploy complete (API + Admin V2 + Storefront).");
  } catch {
    console.error("\n✗ Deploy failed after retries. See errors above.");
    process.exit(1);
  }
})();
