#!/usr/bin/env node
/**
 * deploy.mjs — Full deploy pipeline for Cloudflare Workers
 *
 * Usage:
 *   node scripts/deploy.mjs                  # full deploy (build + migrate + deploy all workers)
 *   node scripts/deploy.mjs --only api       # typecheck + build/deploy API and migrate D1
 *   node scripts/deploy.mjs --only admin     # typecheck + build/deploy admin
 *   node scripts/deploy.mjs --only storefront # typecheck + build/deploy storefront
 *   node scripts/deploy.mjs --only ops-monitor # typecheck + build/deploy ops monitor
 *   node scripts/deploy.mjs --only api --dry-run # typecheck + build + dist checks only
 *   node scripts/deploy.mjs --only api --wrangler-config path/to/wrangler.jsonc
 *     --health-only # isolated custom config: verify deployment + /health, not production bindings
 *   node scripts/deploy.mjs --migrate-only   # apply remote D1 migrations
 *   node scripts/deploy.mjs --migrate-only --local  # apply local D1 migrations only
 *   # External provider upgrades are an explicit frozen control-plane step:
 *   pnpm --filter @scalius/database upgrade:schema --provider <provider> ...
 *
 * Runs in order (full deploy):
 *   1. turbo build       — builds all workspaces
 *   2. D1 migration, or read-only external schema compatibility preflight
 *   3. wrangler deploy   — deploys the API, Admin, Storefront, and Ops Monitor Workers
 *
 * The database name is read from apps/api/wrangler.jsonc (API worker owns D1).
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { delimiter, resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { resolvePnpmExecutable, shellQuote } from "./dev-local-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const apiDir = resolve(root, "apps", "api");
const adminV2Dir = resolve(root, "apps", "admin-v2");
const opsMonitorDir = resolve(root, "apps", "ops-monitor");
const args = process.argv.slice(2);
const migrateOnly = args.includes("--migrate-only");
const local = args.includes("--local");
const dryRun = args.includes("--dry-run");
const healthOnly = args.includes("--health-only");
const wranglerConfigArgIndex = args.indexOf("--wrangler-config");
const customWranglerConfigPath = wranglerConfigArgIndex === -1
  ? null
  : resolve(root, args[wranglerConfigArgIndex + 1] || "");
const databaseTargetHostArgIndex = args.indexOf("--database-target-host");
const databaseTargetHost = databaseTargetHostArgIndex === -1
  ? null
  : args[databaseTargetHostArgIndex + 1] || null;
const localPersistPath = process.env.SCALIUS_WRANGLER_STATE || "../../.wrangler/state";
const deployTargets = ["api", "admin", "storefront", "ops-monitor"];
const selectableDeployTargets = deployTargets;
const appDirsByTarget = {
  api: "apps/api",
  admin: "apps/admin-v2",
  storefront: "apps/storefront",
  "ops-monitor": "apps/ops-monitor",
};
const storefrontStaticPostDeployWarmPaths = ["/", "/search"];
const STOREFRONT_DYNAMIC_WARM_LIMIT = 4;
const STOREFRONT_DYNAMIC_WARM_TIMEOUT_MS = 8_000;
const STOREFRONT_WARM_CONCURRENCY = 4;
// Worker versions own isolated caches, so a new deployment cannot serve HTML
// produced by the superseded version. Hosted deployments may still seed their
// bounded critical route set after rollout; this verifier is the deterministic
// OSS fallback for direct deployments.
const STOREFRONT_WARM_MAX_ATTEMPTS = 220;
const STOREFRONT_WARM_RETRY_DELAY_MS = 1_500;
const API_READYZ_SAMPLE_COUNT = 4;
const API_READYZ_SAMPLE_DELAY_MS = 1_000;
const API_READYZ_TIMEOUT_MS = 10_000;
const pnpmExecutable = resolvePnpmExecutable();
process.env.SCALIUS_PNPM_BIN = pnpmExecutable;
process.env.PATH = `${dirname(pnpmExecutable)}${delimiter}${process.env.PATH || ""}`;
const pnpm = shellQuote(pnpmExecutable);

// Suppress punycode deprecation warnings which corrupt Wrangler's STDOUT API payloads on Node >= 21
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || "") + " --no-warnings=DEP0040";

export function parseJsoncText(raw) {
  let stripped = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    const next = raw[index + 1];

    if (inString) {
      stripped += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      stripped += character;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < raw.length && raw[index] !== "\n") index += 1;
      if (raw[index] === "\n") stripped += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < raw.length) {
        if (raw[index] === "\n") stripped += "\n";
        if (raw[index] === "*" && raw[index + 1] === "/") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    stripped += character;
  }

  return JSON.parse(stripped);
}

function readJsoncFile(path) {
  return parseJsoncText(readFileSync(path, "utf8"));
}

// ── Read wrangler.jsonc from apps/api/ (strip // comments so JSON.parse works)
function readWranglerConfig(path = resolve(apiDir, "wrangler.jsonc")) {
  return readJsoncFile(path);
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
  const result = parseOnlyTarget(args, selectableDeployTargets);
  if (result.ok) return result.target;

  console.error(result.message);
  process.exit(1);
}

export function parseOnlyTarget(inputArgs, targets = deployTargets) {
  const inputOnlyArgIndex = inputArgs.indexOf("--only");
  if (inputOnlyArgIndex === -1) return { ok: true, target: null };

  const target = inputArgs[inputOnlyArgIndex + 1] ?? null;
  if (!target || target.startsWith("--") || !targets.includes(target)) {
    return {
      ok: false,
      message: `✗ Invalid --only target. Use one of: ${targets.join(", ")}`,
    };
  }

  return { ok: true, target };
}

export function getBuildCommandForTarget(target) {
  switch (target) {
    case "api":
      return `${pnpm} --filter @scalius/api build`;
    case "admin":
      return `${pnpm} --filter @scalius/admin-v2 build`;
    case "storefront":
      return `${pnpm} --filter @scalius/storefront build`;
    case "ops-monitor":
      return `${pnpm} --filter @scalius/ops-monitor build`;
    default:
      throw new Error(`Unknown deploy target: ${target}`);
  }
}

export function getTypecheckCommandForTarget(target) {
  const workspace = {
    api: "@scalius/api",
    admin: "@scalius/admin-v2",
    storefront: "@scalius/storefront",
    "ops-monitor": "@scalius/ops-monitor",
  }[target];
  if (!workspace) throw new Error(`Unknown deploy target: ${target}`);
  return `${pnpm} --filter ${workspace} typecheck`;
}

export function getSequentialWorkspaceCommand(task) {
  return `${pnpm} exec turbo run ${task} --concurrency=1`;
}

export function resolveDeploymentDatabaseProvider(config) {
  const explicit = typeof config?.vars?.DATABASE_PROVIDER === "string"
    ? config.vars.DATABASE_PROVIDER.trim().toLowerCase()
    : "";
  if (explicit) {
    if (!["d1", "turso", "postgres"].includes(explicit)) {
      throw new Error(`Unsupported DATABASE_PROVIDER ${JSON.stringify(explicit)}.`);
    }
    return explicit;
  }
  if (config?.d1_databases?.[0]) return "d1";
  throw new Error(
    "API Wrangler config must select DATABASE_PROVIDER or contain a D1 binding.",
  );
}

export function getExternalSchemaPreflightCommand(provider, targetHost) {
  if (provider !== "turso" && provider !== "postgres") {
    throw new Error("External schema upgrades require turso or postgres.");
  }
  if (typeof targetHost !== "string" || !targetHost.trim()) {
    throw new Error("External schema upgrades require --database-target-host.");
  }
  return `${pnpm} --filter @scalius/database upgrade:schema --provider ${provider}`
    + ` --acknowledge-target-host ${shellQuote(targetHost.trim())}`
    + " --dry-run --require-current";
}

export function getDeployCommandForTarget(target, apiWranglerConfigPath = null) {
  switch (target) {
    case "api":
      return {
        cmd: `${pnpm} exec wrangler deploy${apiWranglerConfigPath ? ` --config ${shellQuote(apiWranglerConfigPath)}` : ""}`,
        label: "Deploy API Worker",
        cwd: apiDir,
      };
    case "admin":
      return {
        cmd: `${pnpm} exec wrangler deploy`,
        label: "Deploy Admin V2 Worker",
        cwd: adminV2Dir,
      };
    case "storefront":
      return {
        cmd: `${pnpm} exec wrangler deploy --config dist/server/wrangler.json`,
        label: "Deploy Storefront Worker",
        cwd: resolve(root, "apps", "storefront"),
      };
    case "ops-monitor":
      return { cmd: `${pnpm} exec wrangler deploy`, label: "Deploy Ops Monitor Worker", cwd: opsMonitorDir };
    default:
      throw new Error(`Unknown deploy target: ${target}`);
  }
}

function buildTarget(target) {
  const labels = {
    api: "Build API workspace",
    admin: "Build Admin V2 workspace",
    storefront: "Build Storefront workspace",
    "ops-monitor": "Build Ops Monitor workspace",
  };
  run(getBuildCommandForTarget(target), labels[target]);
}

function deployTarget(target, apiWranglerConfigPath = null) {
  const { cmd, label, cwd } = getDeployCommandForTarget(target, apiWranglerConfigPath);
  runWithRetry(cmd, label, cwd);
}

export function getLatestDeployment(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) return null;
  return deployments.reduce((latest, deployment) => {
    if (!latest) return deployment;
    return new Date(deployment.created_on).getTime() > new Date(latest.created_on).getTime()
      ? deployment
      : latest;
  }, null);
}

function getFullyServedVersion(deployment) {
  return deployment?.versions?.find((version) => version.percentage === 100);
}

function buildApiV1Url(apiBaseUrl, path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(`/api/v1${normalizedPath}`, apiBaseUrl).toString();
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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function getReadinessCheckSummary(payload) {
  const checks = payload?.checks;
  if (!checks || typeof checks !== "object") return "no checks payload";

  return Object.entries(checks)
    .map(([name, check]) => {
      const status = typeof check?.status === "string" ? check.status : "unknown";
      const latency = typeof check?.latencyMs === "number" ? ` ${check.latencyMs}ms` : "";
      return `${name}:${status}${latency}`;
    })
    .join(", ");
}

function isReadyzPayloadReady(status, payload) {
  if (status !== 200 || payload?.success !== true || payload?.status !== "ready") {
    return false;
  }

  const checks = payload?.checks;
  if (!checks || typeof checks !== "object") return false;
  return Object.values(checks).every((check) => check?.status === "ok");
}

async function fetchReadinessSample(url, {
  fetchImpl = fetch,
  timeoutMs = API_READYZ_TIMEOUT_MS,
} = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    return {
      ok: isReadyzPayloadReady(response.status, payload),
      status: response.status,
      payload,
      durationMs: Date.now() - startedAt,
      summary: getReadinessCheckSummary(payload),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      durationMs: Date.now() - startedAt,
      summary: errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sampleApiReadiness(apiBaseUrl, {
  sampleCount = API_READYZ_SAMPLE_COUNT,
  delayMs = API_READYZ_SAMPLE_DELAY_MS,
  timeoutMs = API_READYZ_TIMEOUT_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  const readyzUrl = buildApiV1Url(apiBaseUrl, "/readyz");
  const samples = [];

  console.log(`\n▶ Verify live API /readyz recovery window`);
  console.log(`  GET ${readyzUrl} (${sampleCount} samples)\n`);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = await fetchReadinessSample(readyzUrl, { fetchImpl, timeoutMs });
    samples.push(sample);
    const prefix = sample.ok ? "✓" : "⚠";
    console.log(
      `${prefix} /readyz sample ${index + 1}/${sampleCount}: ` +
      `${sample.status || "error"} in ${sample.durationMs}ms (${sample.summary})`,
    );

    if (index < sampleCount - 1 && delayMs > 0) {
      await sleepImpl(delayMs);
    }
  }

  const readyCount = samples.filter((sample) => sample.ok).length;
  const finalSample = samples.at(-1);
  const requiredReadyCount = Math.min(2, sampleCount);

  if (!finalSample?.ok || readyCount < requiredReadyCount) {
    throw new Error(
      `API /readyz did not recover during deploy verification: ` +
      `${readyCount}/${sampleCount} ready; final=${finalSample?.status ?? "none"} ` +
      `(${finalSample?.summary ?? "missing sample"})`,
    );
  }

  if (readyCount < sampleCount) {
    console.warn(`⚠ API /readyz recovered after transient degraded samples (${readyCount}/${sampleCount} ready).`);
  } else {
    console.log(`✓ API /readyz returned ready for all ${sampleCount} samples.`);
  }

  return { readyCount, samples };
}

export function parseStorefrontBuildId(source) {
  const match = source.match(/export const BUILD_ID = ["']([^"']+)["'];/);
  if (!match?.[1]) {
    throw new Error("Could not read the generated Storefront BUILD_ID.");
  }
  return match[1];
}

export function cacheStatusBuildId(cacheStatus) {
  return cacheStatus.match(/(?:^|[;,\s])build=([^;,\s]+)/i)?.[1] ?? null;
}

export async function warmStorefrontPath(url, path, {
  expectedBuildId,
  maxAttempts = STOREFRONT_WARM_MAX_ATTEMPTS,
  retryDelayMs = STOREFRONT_WARM_RETRY_DELAY_MS,
  timeoutMs = 20_000,
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  if (!expectedBuildId) {
    throw new Error(`Cannot verify ${path} without the expected Storefront build ID.`);
  }

  const warmUrl = new URL(path, url).toString();
  let lastFailure = "no response";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(warmUrl, {
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
      const servedBuildId = cacheStatusBuildId(cacheStatus)
        ?? response.headers.get("X-Storefront-Build");

      if (response.ok && servedBuildId === expectedBuildId) {
        console.log(
          `✓ Warmed ${path} in ${durationMs}ms (${cacheStatus})${
            attempt > 1 ? ` after ${attempt} attempts` : ""
          }.`,
        );
        return { attempt, cacheStatus, servedBuildId };
      }

      lastFailure = response.ok
        ? `served build ${servedBuildId ?? "unknown"}; expected ${expectedBuildId} (${cacheStatus})`
        : `returned HTTP ${response.status} (${cacheStatus})`;
      console.warn(`⚠ Warm ${path} attempt ${attempt}/${maxAttempts}: ${lastFailure}.`);
    } catch (error) {
      lastFailure = errorMessage(error);
      console.warn(`⚠ Warm ${path} attempt ${attempt}/${maxAttempts}: ${lastFailure}.`);
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < maxAttempts && retryDelayMs > 0) {
      await sleepImpl(retryDelayMs);
    }
  }

  throw new Error(
    `Storefront warm verification failed for ${path}: ${lastFailure}`,
  );
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

async function warmStorefrontAfterDeploy(storefrontUrl, generatedConfig, expectedBuildId) {
  const warmPaths = await collectStorefrontWarmPaths(generatedConfig);

  console.log("\n▶ Warm Storefront critical HTML caches");
  console.log(`  ${warmPaths.join(", ")}\n`);

  for (let index = 0; index < warmPaths.length; index += STOREFRONT_WARM_CONCURRENCY) {
    const chunk = warmPaths.slice(index, index + STOREFRONT_WARM_CONCURRENCY);
    await Promise.all(
      chunk.map((path) =>
        warmStorefrontPath(storefrontUrl, path, { expectedBuildId }),
      ),
    );
  }
}

async function verifyStorefrontDeploy() {
  const storefrontDir = resolve(root, "apps", "storefront");
  const generatedConfigPath = resolve(storefrontDir, "dist", "server", "wrangler.json");
  const generatedConfig = readJsonFile(generatedConfigPath);
  const expectedBuildId = parseStorefrontBuildId(
    readFileSync(resolve(storefrontDir, "src", "config", "build-id.ts"), "utf8"),
  );

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
  console.log("\n▶ Verify live Storefront build propagation");
  await warmStorefrontPath(storefrontUrl, "/health", { expectedBuildId });
  await warmStorefrontAfterDeploy(storefrontUrl, generatedConfig, expectedBuildId);
}

async function verifyApiDeploy(config, apiWranglerConfigPath = null, options = {}) {
  const configFlag = apiWranglerConfigPath
    ? ` --config ${shellQuote(apiWranglerConfigPath)}`
    : "";
  const deployments = runJson(
    `${pnpm} exec wrangler deployments list --json${configFlag}`,
    "Verify latest API Worker deployment",
    apiDir,
  );
  const latest = getLatestDeployment(deployments);
  const deployedVersion = getFullyServedVersion(latest);
  if (!latest || !deployedVersion?.version_id) {
    throw new Error("Could not prove the latest API Worker deployment is serving one version at 100%.");
  }
  console.log(`✓ Latest API deployment serves ${deployedVersion.version_id} at 100%.`);

  const apiBaseUrl = config.vars?.PUBLIC_API_BASE_URL;
  if (!apiBaseUrl) {
    throw new Error("Could not verify live API: PUBLIC_API_BASE_URL is missing from API Wrangler config.");
  }

  await verifyHttpOk(buildApiV1Url(apiBaseUrl, "/health"), "Verify live API /health");
  if (options.healthOnly) {
    console.log("✓ Custom API health-only verification skipped production binding readiness checks.");
    return;
  }
  await sampleApiReadiness(apiBaseUrl);
}

function verifyLatestWorkerDeployment(cwd, label, configPath = null) {
  const configFlag = configPath ? ` --config ${shellQuote(configPath)}` : "";
  const deployments = runJson(
    `${pnpm} exec wrangler deployments list --json${configFlag}`,
    `Verify latest ${label} deployment`,
    cwd,
  );
  const latest = getLatestDeployment(deployments);
  const deployedVersion = getFullyServedVersion(latest);
  if (!latest || !deployedVersion?.version_id) {
    throw new Error(
      `Could not prove the latest ${label} deployment is serving one version at 100%.`,
    );
  }
  console.log(
    `✓ Latest ${label} deployment serves ${deployedVersion.version_id} at 100%.`,
  );
  return deployedVersion.version_id;
}

async function verifyPostDeployTarget(
  target,
  apiConfig,
  apiWranglerConfigPath = null,
  options = {},
) {
  if (target === "api") {
    await verifyApiDeploy(apiConfig, apiWranglerConfigPath, options);
  }
  if (target === "admin") {
    verifyLatestWorkerDeployment(adminV2Dir, "Admin V2 Worker");
  }
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
export async function main() {
  if (wranglerConfigArgIndex !== -1 && !args[wranglerConfigArgIndex + 1]) {
    console.error("✗ --wrangler-config requires a path.");
    process.exit(1);
  }
  if (
    databaseTargetHostArgIndex !== -1
    && (!databaseTargetHost || databaseTargetHost.startsWith("--"))
  ) {
    console.error("✗ --database-target-host requires an exact hostname.");
    process.exit(1);
  }
  let config;
  try {
    config = readWranglerConfig(customWranglerConfigPath ?? undefined);
  } catch (e) {
    console.error(`✗ Could not parse ${customWranglerConfigPath ?? "apps/api/wrangler.jsonc"}:`, e.message);
    process.exit(1);
  }

  let databaseProvider;
  try {
    databaseProvider = resolveDeploymentDatabaseProvider(config);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
  const d1 = config.d1_databases?.[0];
  if (
    (!d1?.database_name && migrateOnly)
    || (databaseProvider === "d1" && !d1?.database_name && !customWranglerConfigPath)
  ) {
    console.error(
      "✗ No d1_databases[0].database_name found in apps/api/wrangler.jsonc.\n" +
      "  Add a D1 database binding before deploying."
    );
    process.exit(1);
  }

  const dbName = d1?.database_name ?? null;
  const target = local ? "local" : "remote";
  const persistFlag = local ? ` --persist-to ${shellQuote(localPersistPath)}` : "";
  const requestedTarget = validateOnlyTarget();
  if (customWranglerConfigPath && (requestedTarget !== "api" || migrateOnly)) {
    console.error("✗ --wrangler-config is supported only with --only api deploys.");
    process.exit(1);
  }
  if (healthOnly && !customWranglerConfigPath) {
    console.error("✗ --health-only is allowed only with an explicit --wrangler-config API deploy.");
    process.exit(1);
  }
  if (
    !dryRun
    && databaseProvider !== "d1"
    && !databaseTargetHost
    && !migrateOnly
    && (requestedTarget === null || requestedTarget === "api")
  ) {
    console.error(
      `✗ ${databaseProvider} deploys require --database-target-host so the `
      + "selected database can pass a read-only schema preflight.",
    );
    process.exit(1);
  }

  const prepareSelectedProviderSchema = () => {
    if (databaseProvider === "d1") {
      const migrationTarget = customWranglerConfigPath ? "DB" : dbName;
      const migrationConfigFlag = customWranglerConfigPath
        ? ` --config ${shellQuote(customWranglerConfigPath)}`
        : "";
      runWithRetry(
        `${pnpm} exec wrangler d1 migrations apply ${migrationTarget} --${target}`
          + `${persistFlag}${migrationConfigFlag}`,
        `Apply D1 migrations → ${dbName ?? migrationTarget} (${target})`,
        apiDir,
      );
      return;
    }
    runWithRetry(
      getExternalSchemaPreflightCommand(databaseProvider, databaseTargetHost),
      `Verify current ${databaseProvider} schema → ${databaseTargetHost}`,
      root,
    );
  };

  if (migrateOnly) {
    console.log(`\n🗄  Applying D1 schema migrations → "${dbName}" (${target})\n`);
    if (dryRun) {
      console.log("DRY RUN: would apply D1 schema migrations.");
      console.log("\n✓ Migration dry run complete.");
      return;
    }

    try {
      const migrationTarget = dbName;
      runWithRetry(
        `${pnpm} exec wrangler d1 migrations apply ${migrationTarget} --${target}${persistFlag}`,
        `Apply D1 migrations → ${migrationTarget} (${target})`,
        apiDir,
      );
      console.log("\n✓ Migrations applied.");
    } catch {
      console.error("\n✗ Migration failed after retries. See errors above.");
      process.exit(1);
    }
    return;
  }

  console.log(
    `\n🚀 ${dryRun ? "Validating deploy for" : "Deploying"} "${config.name}"${requestedTarget ? ` (${requestedTarget} only)` : ""}`
    + (databaseProvider === "d1" ? ` → D1: "${dbName}"` : ` → ${databaseProvider}`)
    + "\n",
  );
  console.log("=".repeat(60));

  try {
    // 1. Typecheck first — catches type mismatches esbuild ignores
    run(
      requestedTarget
        ? getTypecheckCommandForTarget(requestedTarget)
        : getSequentialWorkspaceCommand("typecheck"),
      requestedTarget ? `Typecheck ${requestedTarget} workspace` : "Typecheck all workspaces sequentially",
    );

    if (requestedTarget) {
      buildTarget(requestedTarget);
      checkDistEnvFiles([requestedTarget]);

      if (dryRun) {
        console.log("\nDRY RUN: skipping database migrations and Worker deploy.");
        console.log(`\n✓ Deploy dry run complete (${requestedTarget}).`);
        return;
      }

      if (requestedTarget === "api") prepareSelectedProviderSchema();

      deployTarget(requestedTarget, customWranglerConfigPath);
      await verifyPostDeployTarget(requestedTarget, config, customWranglerConfigPath, { healthOnly });
      console.log(`\n✓ Deploy complete (${requestedTarget}).`);
      return;
    }

    // 2. Build: all workspaces via Turbo
    run(getSequentialWorkspaceCommand("build"), "Build all workspaces sequentially");
    checkDistEnvFiles(deployTargets);

    if (dryRun) {
      console.log("\nDRY RUN: skipping database migrations and Worker deploys.");
      console.log(`\n✓ Deploy dry run complete (${deployTargets.join(" + ")}).`);
      return;
    }

    // 3. D1 is upgraded locally by Wrangler. External authorities are upgraded
    // only by the frozen control-plane workflow; ordinary deploys prove they
    // are already current without mutating them.
    prepareSelectedProviderSchema();

    // 4. Deploy all workers (admin-v2 replaces the old Astro admin)
    for (const targetName of deployTargets) {
      deployTarget(targetName);
      await verifyPostDeployTarget(targetName, config);
    }

    console.log(`\n✓ Deploy complete (${deployTargets.join(" + ")}).`);
  } catch {
    console.error("\n✗ Deploy failed after retries. See errors above.");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
