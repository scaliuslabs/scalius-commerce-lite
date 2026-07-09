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
 *   node scripts/deploy.mjs --only admin-agent # typecheck + build/deploy internal Admin Agent
 *   node scripts/deploy.mjs --only storefront-agent # typecheck + build/deploy public Storefront Agent
 *   node scripts/deploy.mjs --only api --dry-run # typecheck + build + dist checks only
 *   node scripts/deploy.mjs --migrate-only   # apply migrations to remote D1 only
 *   node scripts/deploy.mjs --migrate-only --local  # apply migrations to local D1 only
 *
 * Runs in order (full deploy):
 *   1. turbo build       — builds all workspaces
 *   2. wrangler d1 migrations apply --remote  — applies pending migrations to D1
 *   3. wrangler deploy   — deploys the two Agent Workers, API, Admin, Storefront, and Ops Monitor
 *
 * The database name is read from apps/api/wrangler.jsonc (API worker owns D1).
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { delimiter, resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { resolvePnpmExecutable, shellQuote } from "./dev-local-utils.mjs";
import {
  DEFAULT_DASHBOARD_URL,
  normalizeHttpBaseUrl,
  smokeAdminMcpUnauthenticated,
  smokeAgentWorker,
} from "./release-check.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const apiDir = resolve(root, "apps", "api");
const adminV2Dir = resolve(root, "apps", "admin-v2");
const opsMonitorDir = resolve(root, "apps", "ops-monitor");
const adminAgentDir = resolve(root, "apps", "admin-agent");
const storefrontAgentDir = resolve(root, "apps", "storefront-agent");
const args = process.argv.slice(2);
const migrateOnly = args.includes("--migrate-only");
const local = args.includes("--local");
const dryRun = args.includes("--dry-run");
const localPersistPath = process.env.SCALIUS_WRANGLER_STATE || "../../.wrangler/state";
const deployTargets = [
  "admin-agent",
  "storefront-agent",
  "api",
  "admin",
  "storefront",
  "ops-monitor",
];
const appDirsByTarget = {
  api: "apps/api",
  admin: "apps/admin-v2",
  storefront: "apps/storefront",
  "ops-monitor": "apps/ops-monitor",
  "admin-agent": "apps/admin-agent",
  "storefront-agent": "apps/storefront-agent",
};
const storefrontStaticPostDeployWarmPaths = ["/", "/search"];
const STOREFRONT_DYNAMIC_WARM_LIMIT = 4;
const STOREFRONT_DYNAMIC_WARM_TIMEOUT_MS = 8_000;
const STOREFRONT_WARM_CONCURRENCY = 4;
const API_READYZ_SAMPLE_COUNT = 4;
const API_READYZ_SAMPLE_DELAY_MS = 1_000;
const API_READYZ_TIMEOUT_MS = 10_000;
const AGENT_DEPLOY_TIMEOUT_MS = 10_000;
const DEFAULT_STOREFRONT_AGENT_URL =
  "https://scalius-storefront-agent.abnidaala.workers.dev";
const pnpmExecutable = resolvePnpmExecutable();
process.env.SCALIUS_PNPM_BIN = pnpmExecutable;
process.env.PATH = `${dirname(pnpmExecutable)}${delimiter}${process.env.PATH || ""}`;
const pnpm = shellQuote(pnpmExecutable);

// Suppress punycode deprecation warnings which corrupt Wrangler's STDOUT API payloads on Node >= 21
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || "") + " --no-warnings=DEP0040";

function readJsoncFile(path) {
  const raw = readFileSync(path, "utf8");
  // Strip single-line // comments to turn JSONC into valid JSON, ignoring http:// and https://
  const stripped = raw.replace(/(?<!https?:)\/\/[^\n]*/g, "");
  return JSON.parse(stripped);
}

// ── Read wrangler.jsonc from apps/api/ (strip // comments so JSON.parse works)
function readWranglerConfig() {
  return readJsoncFile(resolve(apiDir, "wrangler.jsonc"));
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
  const result = parseOnlyTarget(args);
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
    case "admin-agent":
      return `${pnpm} --filter @scalius/admin-agent build`;
    case "storefront-agent":
      return `${pnpm} --filter @scalius/storefront-agent build`;
    default:
      throw new Error(`Unknown deploy target: ${target}`);
  }
}

export function getTypecheckCommandForTarget(target) {
  if (target === "admin-agent") {
    return (
      `${pnpm} --filter @scalius/agent-runtime ` +
      `--filter @scalius/admin-agent typecheck`
    );
  }
  if (target === "storefront-agent") {
    return (
      `${pnpm} --filter @scalius/agent-runtime ` +
      `--filter @scalius/storefront-agent typecheck`
    );
  }
  return `${pnpm} typecheck`;
}

export function getDeployCommandForTarget(target) {
  switch (target) {
    case "api":
      return { cmd: `${pnpm} exec wrangler deploy`, label: "Deploy API Worker", cwd: apiDir };
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
    case "admin-agent":
      return {
        cmd: `${pnpm} exec wrangler deploy`,
        label: "Deploy Admin Agent Worker",
        cwd: adminAgentDir,
      };
    case "storefront-agent":
      return {
        cmd: `${pnpm} exec wrangler deploy`,
        label: "Deploy Storefront Agent Worker",
        cwd: storefrontAgentDir,
      };
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
    "admin-agent": "Build Admin Agent workspace",
    "storefront-agent": "Build Storefront Agent workspace",
  };
  run(getBuildCommandForTarget(target), labels[target]);
}

function deployTarget(target) {
  const { cmd, label, cwd } = getDeployCommandForTarget(target);
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

async function verifyApiDeploy(config) {
  const deployments = runJson(
    `${pnpm} exec wrangler deployments list --json`,
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
  await sampleApiReadiness(apiBaseUrl);
}

function getStorefrontAgentDeployUrl() {
  return normalizeHttpBaseUrl(
    process.env.SCALIUS_STOREFRONT_AGENT_URL ?? DEFAULT_STOREFRONT_AGENT_URL,
    "Storefront Agent URL",
  );
}

function getDashboardDeployUrl() {
  if (process.env.SCALIUS_DASHBOARD_URL) {
    return normalizeHttpBaseUrl(process.env.SCALIUS_DASHBOARD_URL, "Dashboard URL");
  }

  const adminConfig = readJsoncFile(resolve(adminV2Dir, "wrangler.jsonc"));
  return normalizeHttpBaseUrl(
    adminConfig.vars?.BETTER_AUTH_URL ?? DEFAULT_DASHBOARD_URL,
    "Dashboard URL",
  );
}

export async function verifyAdminDeploy({
  dashboardUrl = getDashboardDeployUrl(),
  fetchImpl = fetch,
  timeoutMs = AGENT_DEPLOY_TIMEOUT_MS,
} = {}) {
  console.log("\n▶ Verify live Admin MCP auth gate");
  console.log(`  ${dashboardUrl}\n`);
  const result = await smokeAdminMcpUnauthenticated({
    dashboardUrl,
    fetchImpl,
    timeoutMs,
    logger: null,
  });
  console.log(
    `✓ Admin MCP rejected unauthenticated request with ${result.statusCode}; ` +
    `Cache-Control: ${result.cacheControl || "missing"}.`,
  );
  return result;
}

function verifyLatestWorkerDeployment(cwd, label) {
  const deployments = runJson(
    `${pnpm} exec wrangler deployments list --json`,
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

export async function verifyStorefrontAgentDeploy({
  agentUrl = getStorefrontAgentDeployUrl(),
  storefrontUrl,
  fetchImpl = fetch,
  timeoutMs = AGENT_DEPLOY_TIMEOUT_MS,
} = {}) {
  console.log("\n▶ Verify live Storefront Agent Worker /health and MCP read tools");
  console.log(`  ${agentUrl}\n`);
  const result = await smokeAgentWorker({
    agentUrl,
    storefrontUrl,
    catalogToolSmoke: true,
    fetchImpl,
    timeoutMs,
    logger: null,
  });
  const publicConversationUrl = new URL(
    "/internal/conversations/conv_abcdefghijklmnopqrstuv/events?after=0",
    agentUrl,
  ).toString();
  const isolationController = new AbortController();
  const isolationTimeout = setTimeout(
    () => isolationController.abort(),
    timeoutMs,
  );
  let isolationResponse;
  try {
    isolationResponse = await fetchImpl(publicConversationUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: isolationController.signal,
    });
  } finally {
    clearTimeout(isolationTimeout);
  }
  if (
    isolationResponse.status !== 404 ||
    !/\bno-store\b/i.test(isolationResponse.headers.get("Cache-Control") ?? "")
  ) {
    throw new Error(
      "Storefront Agent public conversation transcript route must return a no-store 404.",
    );
  }
  const catalogTool = result.mcp.catalogTool;
  const catalogProfile = catalogTool?.profile;
  const cartValidationTool = result.mcp.cartValidationTool;
  const profileSummary = catalogProfile?.endpoint
    ? `; ${catalogTool.name} call ok (` +
      `${catalogProfile.capabilities.length} catalog capabilities, ` +
      `endpoint ${catalogProfile.endpoint})`
    : catalogTool
      ? `; ${catalogTool.name} call ok`
      : "";
  const cartValidationSummary = cartValidationTool
    ? `; ${cartValidationTool.name} call ok`
    : "";
  console.log(
    `✓ Storefront Agent /health returned ${result.health.statusCode}; ` +
    `MCP tools: ${result.mcp.tools.toolNames.join(", ")}${profileSummary}${cartValidationSummary}; ` +
    "public conversation transcripts hidden.",
  );
  return result;
}

async function verifyPostDeployTarget(target, apiConfig) {
  if (target === "api") {
    await verifyApiDeploy(apiConfig);
  }
  if (target === "admin") {
    await verifyAdminDeploy();
  }
  if (target === "storefront") {
    await verifyStorefrontDeploy();
  }
  if (target === "admin-agent") {
    verifyLatestWorkerDeployment(adminAgentDir, "Admin Agent Worker");
  }
  if (target === "storefront-agent") {
    verifyLatestWorkerDeployment(storefrontAgentDir, "Storefront Agent Worker");
    await verifyStorefrontAgentDeploy({
      storefrontUrl: apiConfig.vars?.STOREFRONT_URL,
    });
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
    run(
      requestedTarget
        ? getTypecheckCommandForTarget(requestedTarget)
        : `${pnpm} typecheck`,
      requestedTarget === "admin-agent" || requestedTarget === "storefront-agent"
        ? `Typecheck ${requestedTarget} workspace and shared runtime`
        : "Typecheck all workspaces",
    );

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
      await verifyPostDeployTarget(requestedTarget, config);
      console.log(`\n✓ Deploy complete (${requestedTarget}).`);
      return;
    }

    // 2. Build: all workspaces via Turbo
    run(`${pnpm} build`, "Build all workspaces");
    checkDistEnvFiles(deployTargets);

    if (dryRun) {
      console.log("\nDRY RUN: skipping D1 migrations and Worker deploys.");
      console.log(`\n✓ Deploy dry run complete (${deployTargets.join(" + ")}).`);
      return;
    }

    // 3. Apply all pending D1 migrations (no-op if schema is up to date)
    runWithRetry(
      `${pnpm} exec wrangler d1 migrations apply ${dbName} --remote`,
      `Apply D1 migrations → ${dbName}`,
      apiDir
    );

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
