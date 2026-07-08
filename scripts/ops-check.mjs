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
const defaultOpsMonitorDir = "apps/ops-monitor";
const defaultApiConfigPath = resolve(defaultRootDir, defaultApiDir, "wrangler.jsonc");
const defaultOpsMonitorConfigPath = resolve(defaultRootDir, defaultOpsMonitorDir, "wrangler.jsonc");

const DEFAULT_API_BASE_URL = "https://api.scalius.com";
const DEFAULT_READYZ_SAMPLES = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const READYZ_SAMPLE_DELAY_MS = 1_000;
const MAX_BODY_PREVIEW_LENGTH = 240;
const EXPECTED_API_CRON = "*/15 * * * *";
const EXPECTED_OPS_MONITOR_CRON = "*/2 * * * *";
const OPS_MONITOR_STATE_BINDING = "OPS_MONITOR_STATE";
const OPS_MONITOR_ALERT_EMAIL_BINDING = "ALERT_EMAIL";
const ALLOWED_QUEUE_ACTORS = new Set(["worker:scalius-ops-monitor"]);

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

export function readOpsMonitorWranglerConfig(configPath = defaultOpsMonitorConfigPath) {
  return JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
}

export function getKnownQueueNames(config) {
  return getQueueMonitoringExpectations(config).map((queue) => queue.name);
}

function addUnique(list, value) {
  if (typeof value !== "string" || !value || list.includes(value)) return;
  list.push(value);
}

function getQueueMonitoringExpectations(config) {
  const workerName = typeof config?.name === "string" ? config.name.trim() : "";
  const workerActor = workerName ? `worker:${workerName}` : "";
  const byName = new Map();

  const ensureQueue = (name) => {
    if (typeof name !== "string" || !name) return null;
    const existing = byName.get(name);
    if (existing) return existing;
    const expectation = {
      name,
      expectedProducers: [],
      expectedConsumers: [],
      deadLetterQueue: null,
      deadLetterFor: [],
    };
    byName.set(name, expectation);
    return expectation;
  };

  for (const consumer of config?.queues?.consumers ?? []) {
    const expectation = ensureQueue(consumer.queue);
    if (!expectation) continue;
    if (workerActor) addUnique(expectation.expectedConsumers, workerActor);

    if (typeof consumer.dead_letter_queue === "string" && consumer.dead_letter_queue) {
      expectation.deadLetterQueue = consumer.dead_letter_queue;
      const deadLetterExpectation = ensureQueue(consumer.dead_letter_queue);
      if (deadLetterExpectation) addUnique(deadLetterExpectation.deadLetterFor, consumer.queue);
    }
  }

  for (const producer of config?.queues?.producers ?? []) {
    const expectation = ensureQueue(producer.queue);
    if (expectation && workerActor) addUnique(expectation.expectedProducers, workerActor);
  }

  return [...byName.values()].map((expectation) => ({
    ...expectation,
    kind: expectation.deadLetterFor.length > 0 ? "dead_letter" : "normal",
  }));
}

export function evaluateMonitoringConfig(config) {
  const errors = [];
  const workerName = typeof config?.name === "string" ? config.name.trim() : "";
  const crons = Array.isArray(config?.triggers?.crons)
    ? config.triggers.crons.filter((cron) => typeof cron === "string")
    : [];
  const observabilityEnabled = config?.observability?.enabled === true;
  const requiredCronPresent = crons.includes(EXPECTED_API_CRON);
  const queues = getQueueMonitoringExpectations(config);

  if (!workerName) {
    errors.push("apps/api/wrangler.jsonc must declare the API Worker name.");
  }
  if (!observabilityEnabled) {
    errors.push("apps/api/wrangler.jsonc must keep observability.enabled true for Worker logs/alerts.");
  }
  if (!requiredCronPresent) {
    errors.push(`apps/api/wrangler.jsonc must keep the scheduled maintenance cron ${EXPECTED_API_CRON}.`);
  }
  if (queues.length === 0) {
    errors.push("apps/api/wrangler.jsonc must declare API queues for provider-side queue monitoring.");
  }

  for (const queue of queues) {
    if (queue.expectedProducers.length > 0 && queue.expectedConsumers.length === 0) {
      errors.push(`queue ${queue.name} is produced by ${workerName || "the API Worker"} but has no API consumer.`);
    }
    if (queue.expectedProducers.length > 0 && !queue.deadLetterQueue) {
      errors.push(`queue ${queue.name} must declare a dead_letter_queue for alertable failure handling.`);
    }
    if (queue.deadLetterFor.length > 0 && queue.expectedConsumers.length === 0) {
      errors.push(`DLQ ${queue.name} must have an API consumer so terminal failures are visible outside Cloudflare.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    workerName,
    workerActor: workerName ? `worker:${workerName}` : null,
    observabilityEnabled,
    requiredCron: EXPECTED_API_CRON,
    requiredCronPresent,
    crons,
    queueCount: queues.length,
    normalQueueCount: queues.filter((queue) => queue.expectedProducers.length > 0).length,
    deadLetterQueueCount: queues.filter((queue) => queue.deadLetterFor.length > 0).length,
    queues,
  };
}

function getBindingByName(bindings, bindingName, nameKey = "binding") {
  if (!Array.isArray(bindings)) return null;
  return bindings.find((binding) =>
    typeof binding?.[nameKey] === "string" && binding[nameKey].trim() === bindingName) ?? null;
}

function getTrimmedVar(config, name) {
  return typeof config?.vars?.[name] === "string" ? config.vars[name].trim() : "";
}

function splitCommaList(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function getStringListCount(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).length
    : 0;
}

function getEmailBindingRestriction(binding) {
  const hasDestinationAddress =
    typeof binding?.destination_address === "string" && Boolean(binding.destination_address.trim());
  const allowedDestinationAddressCount = getStringListCount(binding?.allowed_destination_addresses);
  const allowedSenderAddressCount = getStringListCount(binding?.allowed_sender_addresses);

  const restrictionTypes = [];
  if (hasDestinationAddress) restrictionTypes.push("destination_address");
  if (allowedDestinationAddressCount > 0) restrictionTypes.push("allowed_destination_addresses");
  if (allowedSenderAddressCount > 0) restrictionTypes.push("allowed_sender_addresses");

  return {
    emailBindingRestricted: restrictionTypes.length > 0,
    restrictionTypes,
    hasDestinationAddress,
    allowedDestinationAddressCount,
    allowedSenderAddressCount,
  };
}

export function evaluateOpsMonitorAlertConfig(config) {
  const errors = [];
  const warnings = [];
  const requiredActions = [];
  const workerName = typeof config?.name === "string" ? config.name.trim() : "";
  const crons = Array.isArray(config?.triggers?.crons)
    ? config.triggers.crons.filter((cron) => typeof cron === "string")
    : [];
  const observabilityEnabled = config?.observability?.enabled === true;
  const requiredCronPresent = crons.includes(EXPECTED_OPS_MONITOR_CRON);
  const stateKvBinding = getBindingByName(config?.kv_namespaces, OPS_MONITOR_STATE_BINDING);
  const alertEmailBinding = getBindingByName(config?.send_email, OPS_MONITOR_ALERT_EMAIL_BINDING, "name");
  const fromConfigured = Boolean(getTrimmedVar(config, "ALERT_EMAIL_FROM"));
  const recipientCount = splitCommaList(getTrimmedVar(config, "ALERT_EMAIL_TO")).slice(0, 50).length;
  const toConfigured = recipientCount > 0;
  const bindingRestriction = getEmailBindingRestriction(alertEmailBinding);
  const routedEmailReady = Boolean(alertEmailBinding && fromConfigured && toConfigured);

  if (!workerName) {
    errors.push("apps/ops-monitor/wrangler.jsonc must declare the ops-monitor Worker name.");
  }
  if (!observabilityEnabled) {
    errors.push("apps/ops-monitor/wrangler.jsonc must keep observability.enabled true for Worker logs/alerts.");
  }
  if (!requiredCronPresent) {
    errors.push(`apps/ops-monitor/wrangler.jsonc must keep the scheduled monitor cron ${EXPECTED_OPS_MONITOR_CRON}.`);
  }
  if (!stateKvBinding) {
    errors.push(`apps/ops-monitor/wrangler.jsonc must bind KV ${OPS_MONITOR_STATE_BINDING} for alert streak/cooldown state.`);
  }
  if (!alertEmailBinding) {
    errors.push(`apps/ops-monitor/wrangler.jsonc must bind Cloudflare Email Service send_email ${OPS_MONITOR_ALERT_EMAIL_BINDING}.`);
  }

  if (!routedEmailReady) {
    warnings.push("Routed Cloudflare Email alerts are not configured; ops-monitor remains logs-only.");
  }
  if (!fromConfigured) {
    warnings.push("ALERT_EMAIL_FROM is empty.");
    requiredActions.push("Set ALERT_EMAIL_FROM to a verified Cloudflare Email Service sender.");
  }
  if (!toConfigured) {
    warnings.push("ALERT_EMAIL_TO is empty.");
    requiredActions.push("Set ALERT_EMAIL_TO to one or more verified Cloudflare Email Service destinations.");
  }
  if (alertEmailBinding && !bindingRestriction.emailBindingRestricted) {
    warnings.push("ALERT_EMAIL send_email binding is unrestricted.");
    requiredActions.push(
      "Restrict ALERT_EMAIL with destination_address, allowed_destination_addresses, or allowed_sender_addresses once verified aliases are known.",
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    workerName,
    workerActor: workerName ? `worker:${workerName}` : null,
    observabilityEnabled,
    requiredCron: EXPECTED_OPS_MONITOR_CRON,
    requiredCronPresent,
    crons,
    stateKvBindingPresent: Boolean(stateKvBinding),
    requiredStateKvBinding: OPS_MONITOR_STATE_BINDING,
    alertEmailBindingPresent: Boolean(alertEmailBinding),
    requiredAlertEmailBinding: OPS_MONITOR_ALERT_EMAIL_BINDING,
    routedEmailReady,
    alertMode: routedEmailReady ? "routed_email" : "logs_only",
    fromConfigured,
    toConfigured,
    recipientCount,
    ...bindingRestriction,
    warnings,
    requiredActions,
  };
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

const REQUIRED_OPENAPI_PATHS = [
  "/api/v1/admin/analytics/health",
];

export function getMissingRequiredOpenApiPaths(payload) {
  if (!payload || typeof payload !== "object" || !payload.paths || typeof payload.paths !== "object") {
    throw new Error("API /openapi.json returned JSON without an object paths map.");
  }
  return REQUIRED_OPENAPI_PATHS.filter((path) => !Object.prototype.hasOwnProperty.call(payload.paths, path));
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
  const missingRequiredPaths = getMissingRequiredOpenApiPaths(payload);
  if (missingRequiredPaths.length > 0) {
    throw new Error(`API /openapi.json missing required paths: ${missingRequiredPaths.join(", ")}`);
  }
  logger?.log(`✓ API /openapi.json ${response.statusCode} (${pathCount} paths)`);

  return {
    url,
    statusCode: response.statusCode,
    durationMs: response.durationMs,
    pathCount,
    requiredPaths: REQUIRED_OPENAPI_PATHS,
  };
}

function checkMonitoringConfig(apiConfig, {
  logger,
}) {
  const evaluation = evaluateMonitoringConfig(apiConfig);
  if (!evaluation.ok) {
    throw new Error(`Monitoring config contract failed: ${evaluation.errors.join("; ")}`);
  }

  logger?.log(
    "✓ Monitoring config: observability enabled, " +
    `${evaluation.crons.length} cron(s), ${evaluation.queueCount} queue(s) ` +
    `(${evaluation.deadLetterQueueCount} DLQ).`,
  );

  return {
    workerName: evaluation.workerName,
    workerActor: evaluation.workerActor,
    observabilityEnabled: evaluation.observabilityEnabled,
    requiredCron: evaluation.requiredCron,
    requiredCronPresent: evaluation.requiredCronPresent,
    crons: evaluation.crons,
    queueCount: evaluation.queueCount,
    normalQueueCount: evaluation.normalQueueCount,
    deadLetterQueueCount: evaluation.deadLetterQueueCount,
    queues: evaluation.queues,
  };
}

function checkOpsMonitorAlertChannel(opsMonitorConfig, {
  logger,
}) {
  const evaluation = evaluateOpsMonitorAlertConfig(opsMonitorConfig);
  if (!evaluation.ok) {
    throw new Error(`Ops-monitor alert-channel config contract failed: ${evaluation.errors.join("; ")}`);
  }

  const status = evaluation.warnings.length > 0 ? "warning" : "passed";
  const modeLabel = evaluation.routedEmailReady ? "routed Email ready" : "logs-only";
  const restrictionLabel = evaluation.emailBindingRestricted ? "restricted" : "unrestricted";

  if (status === "warning") {
    logger?.warn(
      `⚠ Ops-monitor alert channel: ${modeLabel}; ` +
      `ALERT_EMAIL binding ${restrictionLabel}.`,
    );
    for (const warning of evaluation.warnings) {
      logger?.warn(`  ⚠ ${warning}`);
    }
  } else {
    logger?.log(
      `✓ Ops-monitor alert channel: ${modeLabel}; ` +
      `ALERT_EMAIL binding ${restrictionLabel}.`,
    );
  }

  return {
    status,
    workerName: evaluation.workerName,
    workerActor: evaluation.workerActor,
    observabilityEnabled: evaluation.observabilityEnabled,
    requiredCron: evaluation.requiredCron,
    requiredCronPresent: evaluation.requiredCronPresent,
    crons: evaluation.crons,
    stateKvBindingPresent: evaluation.stateKvBindingPresent,
    requiredStateKvBinding: evaluation.requiredStateKvBinding,
    alertEmailBindingPresent: evaluation.alertEmailBindingPresent,
    requiredAlertEmailBinding: evaluation.requiredAlertEmailBinding,
    routedEmailReady: evaluation.routedEmailReady,
    alertMode: evaluation.alertMode,
    fromConfigured: evaluation.fromConfigured,
    toConfigured: evaluation.toConfigured,
    recipientCount: evaluation.recipientCount,
    emailBindingRestricted: evaluation.emailBindingRestricted,
    restrictionTypes: evaluation.restrictionTypes,
    hasDestinationAddress: evaluation.hasDestinationAddress,
    allowedDestinationAddressCount: evaluation.allowedDestinationAddressCount,
    allowedSenderAddressCount: evaluation.allowedSenderAddressCount,
    warnings: evaluation.warnings,
    requiredActions: evaluation.requiredActions,
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

function parseActorList(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalInteger(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function getUnexpectedActors(actualActors, expectedActors, allowedActors = ALLOWED_QUEUE_ACTORS) {
  return actualActors.filter((actor) => !expectedActors.includes(actor) && !allowedActors.has(actor));
}

export function parseWranglerQueueInfoOutput(output) {
  const fields = new Map();
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) continue;
    const label = trimmed.slice(0, separatorIndex).trim().toLowerCase();
    const value = trimmed.slice(separatorIndex + 1).trim();
    fields.set(label, value);
  }

  return {
    name: fields.get("queue name") ?? null,
    id: fields.get("queue id") ?? null,
    producerCount: parseOptionalInteger(fields.get("number of producers")),
    consumerCount: parseOptionalInteger(fields.get("number of consumers")),
    producers: parseActorList(fields.get("producers")),
    consumers: parseActorList(fields.get("consumers")),
  };
}

export function summarizeQueueInfoOutput(queueName, output) {
  const info = parseWranglerQueueInfoOutput(output);
  const producers = info.producers.length > 0 ? info.producers.join(", ") : "none";
  const consumers = info.consumers.length > 0 ? info.consumers.join(", ") : "none";
  return `${info.name ?? queueName}: producers=${producers}; consumers=${consumers}`.slice(0, 220);
}

export function evaluateQueueInfoOutput(queueName, output, expectation = {}) {
  const info = parseWranglerQueueInfoOutput(output);
  const expectedProducers = expectation.expectedProducers ?? [];
  const expectedConsumers = expectation.expectedConsumers ?? [];
  const allowedActors = expectation.allowedActors instanceof Set
    ? expectation.allowedActors
    : new Set(expectation.allowedActors ?? ALLOWED_QUEUE_ACTORS);
  const unexpectedProducers = getUnexpectedActors(info.producers, expectedProducers, allowedActors);
  const unexpectedConsumers = getUnexpectedActors(info.consumers, expectedConsumers, allowedActors);
  const errors = [];
  const warnings = [];

  if (info.name && info.name !== queueName) {
    errors.push(`expected queue name ${queueName}, got ${info.name}`);
  }
  for (const producer of expectedProducers) {
    if (!info.producers.includes(producer)) {
      errors.push(`missing expected producer ${producer}`);
    }
  }
  for (const consumer of expectedConsumers) {
    if (!info.consumers.includes(consumer)) {
      errors.push(`missing expected consumer ${consumer}`);
    }
  }
  for (const producer of unexpectedProducers) {
    warnings.push(`unexpected producer ${producer}`);
  }
  for (const consumer of unexpectedConsumers) {
    errors.push(`unexpected consumer ${consumer}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: summarizeQueueInfoOutput(queueName, output),
    name: info.name ?? queueName,
    producerCount: info.producerCount,
    consumerCount: info.consumerCount,
    producers: info.producers,
    consumers: info.consumers,
    expectedProducers,
    expectedConsumers,
    unexpectedProducers,
    unexpectedConsumers,
  };
}

async function checkQueues(options, {
  execFileImpl,
  pnpmExecutable,
  rootDir,
  queueExpectations,
  logger,
}) {
  const queues = [];
  const warnings = [];
  const requiredActions = [];
  for (const expectation of queueExpectations) {
    const queueName = expectation.name;
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

    const queueInfo = evaluateQueueInfoOutput(queueName, stdout, expectation);
    if (!queueInfo.ok) {
      throw new Error(
        `Queue provider wiring for ${queueName} did not match apps/api/wrangler.jsonc: ` +
        queueInfo.errors.join("; "),
      );
    }

    const summary = queueInfo.summary;
    if (queueInfo.warnings.length > 0) {
      for (const warning of queueInfo.warnings) {
        const message = `Queue ${queueName}: ${warning}`;
        warnings.push(message);
        logger?.warn(`⚠ ${message}`);
      }
    }
    for (const producer of queueInfo.unexpectedProducers) {
      requiredActions.push(
        `Queue ${queueName}: migrate or redeploy ${producer} without this production queue producer binding; do not allowlist it unless it is intentionally source-owned.`,
      );
    }
    logger?.log(`✓ queue ${queueName}: ${summary}`);
    queues.push({
      name: queueName,
      command: commandSpec.display,
      summary,
      kind: expectation.kind,
      deadLetterQueue: expectation.deadLetterQueue,
      deadLetterFor: expectation.deadLetterFor,
      producerCount: queueInfo.producerCount,
      consumerCount: queueInfo.consumerCount,
      producers: queueInfo.producers,
      consumers: queueInfo.consumers,
      expectedProducers: queueInfo.expectedProducers,
      expectedConsumers: queueInfo.expectedConsumers,
      unexpectedProducers: queueInfo.unexpectedProducers,
      unexpectedConsumers: queueInfo.unexpectedConsumers,
      warnings: queueInfo.warnings,
    });
  }

  return {
    queueCount: queues.length,
    queues,
    warnings,
    requiredActions,
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
  opsMonitorConfig = readOpsMonitorWranglerConfig(),
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
    requiredActions: [],
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

  const monitoringConfig = await runStep(result, "monitoringConfig", () =>
    checkMonitoringConfig(apiConfig, { logger }));

  const opsMonitorAlertChannel = await runStep(result, "opsMonitorAlertChannel", () =>
    checkOpsMonitorAlertChannel(opsMonitorConfig, { logger }));
  result.warnings.push(
    ...opsMonitorAlertChannel.warnings.map((warning) => `Ops-monitor alert channel: ${warning}`),
  );
  result.requiredActions.push(
    ...opsMonitorAlertChannel.requiredActions.map((action) => `Ops-monitor alert channel: ${action}`),
  );

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
    const queueExpectations = monitoringConfig.queues;
    if (queueExpectations.length === 0) {
      throw createCheckError("No API queues found in apps/api/wrangler.jsonc.", result);
    }
    const queueCheck = await runStep(result, "queues", () =>
      checkQueues(options, { execFileImpl, pnpmExecutable, rootDir, queueExpectations, logger }));
    result.warnings.push(...queueCheck.warnings);
    result.requiredActions.push(...queueCheck.requiredActions);
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
  --queues              Also verify Cloudflare queue provider wiring
  --json                Emit JSON
  -h, --help            Show this help
`);
}

export async function main(rawArgs = process.argv.slice(2), {
  configPath = defaultApiConfigPath,
  opsMonitorConfigPath = defaultOpsMonitorConfigPath,
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
    const opsMonitorConfig = readOpsMonitorWranglerConfig(opsMonitorConfigPath);
    options = parseOpsCheckArgs(rawArgs, {
      defaultApiBaseUrl: apiConfig.vars?.PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    });

    const result = await runOpsCheck(options, {
      apiConfig,
      opsMonitorConfig,
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
