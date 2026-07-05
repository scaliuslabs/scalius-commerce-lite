#!/usr/bin/env node

import { execFile as execFileCallback } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { promisify } from "util";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";

const execFileAsync = promisify(execFileCallback);
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(__dirname, "..");
const defaultApiDir = "apps/api";
const defaultApiConfigPath = resolve(defaultRootDir, defaultApiDir, "wrangler.jsonc");

const DEFAULT_API_BASE_URL = "https://api.scalius.com";
const DEFAULT_READYZ_SAMPLES = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const READYZ_SAMPLE_DELAY_MS = 1_000;
const MAX_BODY_PREVIEW_LENGTH = 240;

const booleanOptions = new Set(["help", "json", "skip-wrangler", "queues"]);
const stringOptions = new Set(["api-base-url", "samples", "timeout-ms"]);
const knownOptions = new Set([...booleanOptions, ...stringOptions]);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function stripJsonComments(raw) {
  return raw.replace(/(?<!https?:)\/\/[^\n]*/g, "");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parsePositiveInteger(value, optionName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Option --${optionName} must be a positive integer.`);
  }
  return number;
}

function parseRawOptions(rawArgs) {
  const options = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown positional argument: ${arg}`);
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    if (!knownOptions.has(name)) {
      throw new Error(`Unknown option --${name}.`);
    }

    if (booleanOptions.has(name)) {
      if (equalsIndex >= 0) {
        throw new Error(`Option --${name} does not take a value.`);
      }
      options[name] = true;
      continue;
    }

    const value = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : rawArgs[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option --${name} requires a value.`);
    }
    options[name] = value;
    if (equalsIndex < 0) index += 1;
  }

  return options;
}

export function normalizeApiBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`API base URL must use http or https: ${value}`);
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function parseOpsCheckArgs(rawArgs, {
  defaultApiBaseUrl = DEFAULT_API_BASE_URL,
} = {}) {
  const rawOptions = parseRawOptions(rawArgs);
  if (rawOptions.help) return { help: true };

  const samples = rawOptions.samples === undefined
    ? DEFAULT_READYZ_SAMPLES
    : parsePositiveInteger(rawOptions.samples, "samples");
  const timeoutMs = rawOptions["timeout-ms"] === undefined
    ? DEFAULT_TIMEOUT_MS
    : parsePositiveInteger(rawOptions["timeout-ms"], "timeout-ms");
  const skipWrangler = rawOptions["skip-wrangler"] === true;
  const queues = rawOptions.queues === true;
  if (skipWrangler && queues) {
    throw new Error("Options --skip-wrangler and --queues cannot be combined.");
  }

  return {
    help: false,
    json: rawOptions.json === true,
    apiBaseUrl: normalizeApiBaseUrl(rawOptions["api-base-url"] ?? defaultApiBaseUrl),
    samples,
    timeoutMs,
    skipWrangler,
    queues,
  };
}

export function buildApiV1Url(apiBaseUrl, path) {
  const url = new URL(apiBaseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const basePath = url.pathname.replace(/\/+$/, "");
  const apiPrefix = basePath.endsWith("/api/v1") ? basePath : `${basePath}/api/v1`;
  url.pathname = `${apiPrefix}${normalizedPath}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function readApiWranglerConfig(configPath = defaultApiConfigPath) {
  return JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
}

export function getKnownQueueNames(config) {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    if (typeof name !== "string" || !name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  for (const consumer of config?.queues?.consumers ?? []) {
    add(consumer.queue);
    add(consumer.dead_letter_queue);
  }
  for (const producer of config?.queues?.producers ?? []) {
    add(producer.queue);
  }

  return names;
}

function createRequestId() {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "t").replace("Z", "z");
  return `ops-check-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function buildRequestHeaders(requestId) {
  return {
    Accept: "application/json",
    "Cache-Control": "no-cache",
    "X-Request-Id": requestId,
  };
}

async function fetchText(url, {
  fetchImpl,
  requestId,
  timeoutMs,
}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: buildRequestHeaders(requestId),
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      ok: response.ok,
      body,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonBody(body, label) {
  try {
    return body ? JSON.parse(body) : null;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${errorMessage(error)}`);
  }
}

function requireOkResponse(response, label) {
  if (!response.ok) {
    const preview = response.body.slice(0, MAX_BODY_PREVIEW_LENGTH);
    throw new Error(`${label} returned HTTP ${response.statusCode}: ${preview}`);
  }
}

export function getReadinessCheckSummary(payload) {
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

export function isReadyzPayloadReady(statusCode, payload) {
  if (statusCode !== 200 || payload?.success !== true || payload?.status !== "ready") {
    return false;
  }

  const checks = payload?.checks;
  if (!checks || typeof checks !== "object") return false;
  return Object.values(checks).every((check) => check?.status === "ok");
}

export function evaluateReadinessSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("At least one readiness sample is required.");
  }

  const sampleCount = samples.length;
  const readyCount = samples.filter((sample) => sample.ready).length;
  const finalSample = samples.at(-1);
  const requiredReadyCount = Math.min(2, sampleCount);
  const ok = finalSample?.ready === true && readyCount >= requiredReadyCount;
  const message = ok
    ? `API /readyz ${readyCount === sampleCount ? "ready" : "recovered"} (${readyCount}/${sampleCount} ready).`
    : `API /readyz remained degraded: ${readyCount}/${sampleCount} ready; final=${finalSample?.statusCode ?? "none"} (${finalSample?.summary ?? "missing sample"}).`;

  return {
    ok,
    readyCount,
    sampleCount,
    requiredReadyCount,
    finalReady: finalSample?.ready === true,
    transientRecovery: ok && readyCount < sampleCount,
    message,
  };
}

async function fetchReadinessSample(apiBaseUrl, {
  fetchImpl,
  requestId,
  timeoutMs,
}) {
  const url = buildApiV1Url(apiBaseUrl, "/readyz");

  try {
    const response = await fetchText(url, { fetchImpl, requestId, timeoutMs });
    let payload = null;
    try {
      payload = response.body ? JSON.parse(response.body) : null;
    } catch {
      payload = null;
    }

    return {
      ready: isReadyzPayloadReady(response.statusCode, payload),
      statusCode: response.statusCode,
      durationMs: response.durationMs,
      summary: getReadinessCheckSummary(payload),
    };
  } catch (error) {
    return {
      ready: false,
      statusCode: 0,
      durationMs: 0,
      summary: errorMessage(error),
    };
  }
}

async function runReadinessSamples(options, {
  fetchImpl,
  requestId,
  sleepImpl,
  logger,
}) {
  const samples = [];
  const readyzUrl = buildApiV1Url(options.apiBaseUrl, "/readyz");
  logger?.log(`▶ API /readyz (${options.samples} samples)`);
  logger?.log(`  GET ${readyzUrl}`);

  for (let index = 0; index < options.samples; index += 1) {
    const sample = await fetchReadinessSample(options.apiBaseUrl, {
      fetchImpl,
      requestId,
      timeoutMs: options.timeoutMs,
    });
    samples.push(sample);

    const prefix = sample.ready ? "✓" : "⚠";
    logger?.log(
      `${prefix} /readyz sample ${index + 1}/${options.samples}: ` +
      `${sample.statusCode || "error"} in ${sample.durationMs}ms (${sample.summary})`,
    );

    if (index < options.samples - 1 && READYZ_SAMPLE_DELAY_MS > 0) {
      await sleepImpl(READYZ_SAMPLE_DELAY_MS);
    }
  }

  const evaluation = evaluateReadinessSamples(samples);
  if (!evaluation.ok) {
    throw new Error(evaluation.message);
  }

  if (evaluation.transientRecovery) {
    logger?.warn(`⚠ ${evaluation.message}`);
  } else {
    logger?.log(`✓ ${evaluation.message}`);
  }

  return {
    status: evaluation.transientRecovery ? "warning" : "passed",
    readyCount: evaluation.readyCount,
    sampleCount: evaluation.sampleCount,
    requiredReadyCount: evaluation.requiredReadyCount,
    transientRecovery: evaluation.transientRecovery,
    samples,
  };
}

async function checkHealth(options, {
  fetchImpl,
  requestId,
  logger,
}) {
  const url = buildApiV1Url(options.apiBaseUrl, "/health");
  const response = await fetchText(url, {
    fetchImpl,
    requestId,
    timeoutMs: options.timeoutMs,
  });
  requireOkResponse(response, "API /health");
  logger?.log(`✓ API /health ${response.statusCode} in ${response.durationMs}ms`);

  return {
    url,
    statusCode: response.statusCode,
    durationMs: response.durationMs,
  };
}

export function getOpenApiPathCount(payload) {
  if (!payload || typeof payload !== "object" || !payload.paths || typeof payload.paths !== "object") {
    throw new Error("API /openapi.json returned JSON without an object paths map.");
  }
  return Object.keys(payload.paths).length;
}

async function checkOpenApi(options, {
  fetchImpl,
  requestId,
  logger,
}) {
  const url = buildApiV1Url(options.apiBaseUrl, "/openapi.json");
  const response = await fetchText(url, {
    fetchImpl,
    requestId,
    timeoutMs: options.timeoutMs,
  });
  requireOkResponse(response, "API /openapi.json");
  const payload = parseJsonBody(response.body, "API /openapi.json");
  const pathCount = getOpenApiPathCount(payload);
  logger?.log(`✓ API /openapi.json ${response.statusCode} (${pathCount} paths)`);

  return {
    url,
    statusCode: response.statusCode,
    durationMs: response.durationMs,
    pathCount,
  };
}

export function buildWranglerDeploymentsCommand({
  pnpmExecutable = "pnpm",
  rootDir = defaultRootDir,
} = {}) {
  return {
    command: pnpmExecutable,
    args: ["--dir", defaultApiDir, "exec", "wrangler", "deployments", "list", "--json"],
    cwd: rootDir,
    display: "pnpm --dir apps/api exec wrangler deployments list --json",
  };
}

export function buildWranglerQueueInfoCommand(queueName, {
  pnpmExecutable = "pnpm",
  rootDir = defaultRootDir,
} = {}) {
  return {
    command: pnpmExecutable,
    args: ["--dir", defaultApiDir, "exec", "wrangler", "queues", "info", queueName],
    cwd: rootDir,
    display: `pnpm --dir apps/api exec wrangler queues info ${queueName}`,
  };
}

function withWranglerEnv(env = process.env) {
  const nodeOptions = env.NODE_OPTIONS || "";
  const warningFlag = "--no-warnings=DEP0040";
  return {
    ...env,
    NODE_OPTIONS: nodeOptions.includes(warningFlag)
      ? nodeOptions
      : `${nodeOptions} ${warningFlag}`.trim(),
  };
}

async function execText(commandSpec, {
  execFileImpl,
  timeoutMs,
}) {
  const result = await execFileImpl(commandSpec.command, commandSpec.args, {
    cwd: commandSpec.cwd,
    encoding: "utf8",
    env: withWranglerEnv(),
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (typeof result === "string") return result;
  return result?.stdout ?? "";
}

function formatWranglerFailure(label, commandDisplay, error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
  const detail = (stderr || stdout || errorMessage(error)).slice(0, MAX_BODY_PREVIEW_LENGTH);
  return (
    `${label} failed while running \`${commandDisplay}\`. ` +
    "Confirm Cloudflare auth with `pnpm --dir apps/api exec wrangler whoami`, " +
    "or pass `--skip-wrangler` for an HTTP-only smoke. " +
    detail
  );
}

function normalizeDeploymentsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.deployments)) return payload.deployments;
  return [];
}

export function getLatestDeployment(deploymentsPayload) {
  const deployments = normalizeDeploymentsPayload(deploymentsPayload);
  if (deployments.length === 0) return null;

  return deployments.reduce((latest, deployment) => {
    if (!latest) return deployment;
    const latestTime = new Date(latest.created_on ?? latest.createdAt ?? 0).getTime();
    const candidateTime = new Date(deployment.created_on ?? deployment.createdAt ?? 0).getTime();
    return candidateTime > latestTime ? deployment : latest;
  }, null);
}

export function evaluateLatestDeployment(deploymentsPayload) {
  const latest = getLatestDeployment(deploymentsPayload);
  const versions = Array.isArray(latest?.versions) ? latest.versions : [];
  const fullyServedVersions = versions.filter((version) => Number(version.percentage) === 100);
  const deployedVersion = fullyServedVersions[0];
  const versionId = deployedVersion?.version_id ?? deployedVersion?.id ?? null;

  return {
    ok: Boolean(latest && fullyServedVersions.length === 1 && versionId),
    latestCreatedOn: latest?.created_on ?? latest?.createdAt ?? null,
    versionId,
    versionCount: versions.length,
    fullyServedVersionCount: fullyServedVersions.length,
  };
}

async function checkDeployment(options, {
  execFileImpl,
  pnpmExecutable,
  rootDir,
  logger,
}) {
  const commandSpec = buildWranglerDeploymentsCommand({ pnpmExecutable, rootDir });
  let stdout;
  try {
    stdout = await execText(commandSpec, {
      execFileImpl,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw new Error(formatWranglerFailure("Wrangler deployment proof", commandSpec.display, error));
  }

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Wrangler deployment proof returned invalid JSON from \`${commandSpec.display}\`: ${errorMessage(error)}`);
  }

  const proof = evaluateLatestDeployment(payload);
  if (!proof.ok) {
    throw new Error(
      "Latest API Worker deployment does not prove exactly one 100% version " +
      `(latest=${proof.latestCreatedOn ?? "none"}, 100% versions=${proof.fullyServedVersionCount}).`,
    );
  }

  logger?.log(`✓ Latest API Worker deployment ${proof.versionId} at 100% (${proof.latestCreatedOn ?? "created_on unknown"})`);

  return {
    command: commandSpec.display,
    latestCreatedOn: proof.latestCreatedOn,
    versionId: proof.versionId,
    versionCount: proof.versionCount,
    fullyServedVersionCount: proof.fullyServedVersionCount,
  };
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

export function summarizeQueueInfoOutput(queueName, output) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const compact = lines.slice(0, 4).join(" | ");
  return compact ? compact.slice(0, 220) : `${queueName}: info returned no output`;
}

async function checkQueues(options, {
  execFileImpl,
  pnpmExecutable,
  rootDir,
  queueNames,
  logger,
}) {
  const queues = [];
  for (const queueName of queueNames) {
    const commandSpec = buildWranglerQueueInfoCommand(queueName, { pnpmExecutable, rootDir });
    let stdout;
    try {
      stdout = await execText(commandSpec, {
        execFileImpl,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      throw new Error(formatWranglerFailure(`Queue info check for ${queueName}`, commandSpec.display, error));
    }

    const summary = summarizeQueueInfoOutput(queueName, stdout);
    logger?.log(`✓ queue ${queueName}: ${summary}`);
    queues.push({
      name: queueName,
      command: commandSpec.display,
      summary,
    });
  }

  return {
    queueCount: queues.length,
    queues,
  };
}

function createCheckError(message, result) {
  const error = new Error(message);
  error.result = result;
  return error;
}

async function runStep(result, name, fn) {
  try {
    const stepResult = await fn();
    const { status = "passed", ...rest } = stepResult ?? {};
    result.checks[name] = { status, ...rest };
    return result.checks[name];
  } catch (error) {
    const message = errorMessage(error);
    result.checks[name] = { status: "failed", error: message };
    throw createCheckError(message, result);
  }
}

export async function runOpsCheck(options, {
  apiConfig = {},
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  sleepImpl = sleep,
  logger = console,
  pnpmExecutable = resolvePnpmExecutable(),
  rootDir = defaultRootDir,
  requestId = createRequestId(),
} = {}) {
  const result = {
    status: "running",
    apiBaseUrl: options.apiBaseUrl,
    requestId,
    checks: {},
    warnings: [],
  };

  logger?.log("▶ Production ops check");
  logger?.log(`  API base: ${options.apiBaseUrl}`);
  logger?.log(`  Request ID: ${requestId}`);

  await runStep(result, "health", () =>
    checkHealth(options, { fetchImpl, requestId, logger }));

  const readiness = await runStep(result, "readyz", () =>
    runReadinessSamples(options, { fetchImpl, requestId, sleepImpl, logger }));
  if (readiness.transientRecovery) {
    result.warnings.push("API /readyz recovered after transient degraded samples.");
  }

  await runStep(result, "openapi", () =>
    checkOpenApi(options, { fetchImpl, requestId, logger }));

  if (options.skipWrangler) {
    result.checks.deployment = {
      status: "skipped",
      reason: "Skipped by --skip-wrangler.",
    };
    logger?.warn("⚠ Skipped Wrangler deployment proof (--skip-wrangler).");
  } else {
    await runStep(result, "deployment", () =>
      checkDeployment(options, { execFileImpl, pnpmExecutable, rootDir, logger }));
  }

  if (options.queues) {
    const queueNames = getKnownQueueNames(apiConfig);
    if (queueNames.length === 0) {
      throw createCheckError("No API queues found in apps/api/wrangler.jsonc.", result);
    }
    await runStep(result, "queues", () =>
      checkQueues(options, { execFileImpl, pnpmExecutable, rootDir, queueNames, logger }));
  } else {
    result.checks.queues = {
      status: "skipped",
      reason: "Pass --queues to read Cloudflare queue info.",
    };
  }

  result.status = "passed";
  logger?.log("✓ Production ops check passed.");
  return result;
}

function printUsage() {
  console.log(`Usage: pnpm ops:check [options]

Read-only production ops smoke checks.

Options:
  --api-base-url <url>  API base URL (default from apps/api/wrangler.jsonc)
  --samples <count>     /readyz sample count (default ${DEFAULT_READYZ_SAMPLES})
  --timeout-ms <ms>     Per-request/per-command timeout (default ${DEFAULT_TIMEOUT_MS})
  --skip-wrangler       Skip Cloudflare Wrangler deployment proof
  --queues              Also read known Cloudflare queue info
  --json                Emit JSON
  -h, --help            Show this help
`);
}

export async function main(rawArgs = process.argv.slice(2), {
  configPath = defaultApiConfigPath,
  stdout = console.log,
  stderr = console.error,
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  sleepImpl = sleep,
  pnpmExecutable = resolvePnpmExecutable(),
  rootDir = defaultRootDir,
} = {}) {
  const wantsJson = rawArgs.includes("--json");
  let options;

  try {
    const rawOptions = parseRawOptions(rawArgs);
    if (rawOptions.help) {
      printUsage();
      return 0;
    }

    const apiConfig = readApiWranglerConfig(configPath);
    options = parseOpsCheckArgs(rawArgs, {
      defaultApiBaseUrl: apiConfig.vars?.PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    });

    const result = await runOpsCheck(options, {
      apiConfig,
      fetchImpl,
      execFileImpl,
      sleepImpl,
      pnpmExecutable,
      rootDir,
      logger: options.json ? null : console,
    });

    if (options.json) {
      stdout(JSON.stringify(result, null, 2));
    }
    return 0;
  } catch (error) {
    const message = errorMessage(error);
    const result = error?.result
      ? { ...error.result, status: "failed", error: message }
      : { status: "failed", error: message };

    if (wantsJson || options?.json) {
      stdout(JSON.stringify(result, null, 2));
    } else {
      stderr(`✗ ${message}`);
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
