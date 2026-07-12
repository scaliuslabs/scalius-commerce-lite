#!/usr/bin/env node

import { pathToFileURL } from "url";
import {
  buildCookieHeader,
  extractSetCookieHeaders,
} from "./admin-session-cookie.mjs";

const DEFAULT_DASHBOARD_BASE_URL = "https://dashboard.scalius.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_000_000;

const INVENTORY_PATH = "/api/v1/admin/inventory?section=variants&page=1&limit=1&status=all&sort=available&order=asc";
const ORDERS_PATH = "/api/v1/admin/orders?page=1&limit=1&sort=updatedAt&order=desc&trashed=false";
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const SIGN_OUT_PATH = "/api/auth/sign-out";

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function normalizeDashboardOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Dashboard base URL must be a URL origin.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Dashboard base URL must be a valid URL origin.");
  }

  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Dashboard base URL must be an origin without credentials, path, query, or fragment.");
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(isLoopback && url.protocol === "http:")) {
    throw new Error("Dashboard base URL must use HTTPS (HTTP is allowed only for loopback testing).");
  }
  return url.origin;
}

function parseRawArgs(rawArgs) {
  const options = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg.startsWith("--dashboard-base-url=")) {
      options.dashboardBaseUrl = arg.slice("--dashboard-base-url=".length);
      continue;
    }
    if (arg === "--dashboard-base-url") {
      const next = rawArgs[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Option --dashboard-base-url requires a value.");
      }
      options.dashboardBaseUrl = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = arg.slice("--timeout-ms=".length);
      continue;
    }
    if (arg === "--timeout-ms") {
      const next = rawArgs[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Option --timeout-ms requires a value.");
      }
      options.timeoutMs = next;
      index += 1;
      continue;
    }
    if (arg === "--email" || arg === "--password" || arg.startsWith("--email=") || arg.startsWith("--password=")) {
      throw new Error("Admin read-check credentials are accepted only through process environment variables.");
    }
    throw new Error("Unknown option. Use --help to list supported options.");
  }
  return options;
}

export function getAdminReadCheckConfig(rawArgs = process.argv.slice(2), env = process.env) {
  const options = parseRawArgs(rawArgs);
  if (options.help) return { help: true, json: Boolean(options.json) };

  const email = env.SCALIUS_ADMIN_READ_EMAIL?.trim();
  const password = env.SCALIUS_ADMIN_READ_PASSWORD;
  if (!email) {
    throw new Error("SCALIUS_ADMIN_READ_EMAIL is required.");
  }
  if (!password) {
    throw new Error("SCALIUS_ADMIN_READ_PASSWORD is required.");
  }

  return {
    help: false,
    json: Boolean(options.json),
    dashboardBaseUrl: normalizeDashboardOrigin(
      options.dashboardBaseUrl || env.SCALIUS_DASHBOARD_BASE_URL || DEFAULT_DASHBOARD_BASE_URL,
    ),
    timeoutMs: parsePositiveInteger(
      options.timeoutMs || env.SCALIUS_ADMIN_READ_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
      "timeout-ms",
    ),
    email,
    password,
  };
}

function unwrapData(body) {
  return body?.data ?? body;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} response did not include an object payload.`);
  }
  return value;
}

function requireBoundedCollection(payload, collectionKey, label) {
  const data = requireObject(unwrapData(payload), label);
  const rows = data[collectionKey];
  const pagination = data.pagination;
  if (!Array.isArray(rows)) {
    throw new Error(`${label} response did not include ${collectionKey}.`);
  }
  if (rows.length > 1) {
    throw new Error(`${label} response ignored the limit=1 bound.`);
  }
  if (!pagination || typeof pagination !== "object") {
    throw new Error(`${label} response did not include pagination.`);
  }
  const total = Number(pagination.total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`${label} response included an invalid pagination total.`);
  }
  if ((total === 0) !== (rows.length === 0)) {
    throw new Error(`${label} response pagination and first page disagree about emptiness.`);
  }
  return { rows, total };
}

async function parseBoundedJson(response, label) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await discardResponseBody(response);
    throw new Error(`${label} response exceeded the safe size limit.`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the safe size limit.`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} response was not valid JSON.`);
  }
}

async function discardResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup evidence must never expose or depend on an error response body.
  }
}

async function fetchForCheck(fetchImpl, url, init, label, timeoutMs) {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`${label} request timed out.`, { cause: error });
    }
    throw new Error(`${label} request failed before receiving an HTTP response.`, { cause: error });
  }
}

async function signIn(config, fetchImpl) {
  const response = await fetchForCheck(
    fetchImpl,
    `${config.dashboardBaseUrl}${SIGN_IN_PATH}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: config.dashboardBaseUrl,
      },
      body: JSON.stringify({
        email: config.email,
        password: config.password,
        rememberMe: false,
      }),
    },
    "Admin sign-in",
    config.timeoutMs,
  );

  if (response.status !== 200) {
    await discardResponseBody(response);
    throw new Error(`Admin sign-in failed with HTTP ${response.status}.`);
  }
  const setCookieHeaders = extractSetCookieHeaders(response.headers);
  const cookieHeader = buildCookieHeader(setCookieHeaders);
  let validationError = null;
  let body;
  try {
    body = await parseBoundedJson(response, "Admin sign-in");
  } catch (error) {
    validationError = error instanceof Error
      ? error
      : new Error("Admin sign-in response was unusable.");
  }
  if (!validationError && body?.twoFactorRedirect) {
    validationError = new Error(
      "Admin sign-in requires interactive two-factor verification; the read check cannot continue.",
    );
  }
  if (!cookieHeader) {
    validationError ??= new Error("Admin sign-in succeeded without a session cookie.");
  }
  return {
    cookieHeader,
    validationError,
    evidence: {
      statusCode: response.status,
      sessionCookieCount: setCookieHeaders.length,
      twoFactorRedirect: false,
    },
  };
}

async function getAdminJson(config, fetchImpl, cookieHeader, path, label) {
  const response = await fetchForCheck(
    fetchImpl,
    `${config.dashboardBaseUrl}${path}`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        cookie: cookieHeader,
        origin: config.dashboardBaseUrl,
      },
    },
    label,
    config.timeoutMs,
  );
  if (response.status !== 200) {
    await discardResponseBody(response);
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  return {
    statusCode: response.status,
    body: await parseBoundedJson(response, label),
  };
}

async function signOutBestEffort(config, fetchImpl, cookieHeader) {
  let response;
  try {
    response = await fetchForCheck(
      fetchImpl,
      `${config.dashboardBaseUrl}${SIGN_OUT_PATH}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache",
          cookie: cookieHeader,
          origin: config.dashboardBaseUrl,
        },
      },
      "Admin sign-out",
      config.timeoutMs,
    );
  } catch (error) {
    return {
      status: "warning",
      statusCode: null,
      acknowledged: false,
      message: error instanceof Error
        ? error.message
        : "Admin sign-out failed before receiving an HTTP response.",
    };
  }

  if (response.status !== 200) {
    await discardResponseBody(response);
    return {
      status: "warning",
      statusCode: response.status,
      acknowledged: false,
      message: `Admin sign-out returned HTTP ${response.status}.`,
    };
  }

  try {
    const body = await parseBoundedJson(response, "Admin sign-out");
    if (body?.success !== true) {
      return {
        status: "warning",
        statusCode: response.status,
        acknowledged: false,
        message: "Admin sign-out did not acknowledge session cleanup.",
      };
    }
  } catch (error) {
    return {
      status: "warning",
      statusCode: response.status,
      acknowledged: false,
      message: error instanceof Error
        ? error.message
        : "Admin sign-out response was unusable.",
    };
  }

  return {
    status: "passed",
    statusCode: response.status,
    acknowledged: true,
  };
}

export async function runAdminReadCheck(config, { fetchImpl = fetch } = {}) {
  let signedIn;
  let result;
  let primaryError;
  let sessionCleanup;

  try {
    signedIn = await signIn(config, fetchImpl);
    if (signedIn.validationError) {
      throw signedIn.validationError;
    }
    const inventoryResponse = await getAdminJson(
      config,
      fetchImpl,
      signedIn.cookieHeader,
      INVENTORY_PATH,
      "Inventory variants GET",
    );
    const inventory = requireBoundedCollection(
      inventoryResponse.body,
      "variants",
      "Inventory variants GET",
    );

    const ordersResponse = await getAdminJson(
      config,
      fetchImpl,
      signedIn.cookieHeader,
      ORDERS_PATH,
      "Orders list GET",
    );
    const orders = requireBoundedCollection(ordersResponse.body, "orders", "Orders list GET");

    let detailEvidence;
    if (orders.rows.length === 0) {
      detailEvidence = {
        status: "skipped_empty_orders",
        reason: "The active order catalog is truthfully empty.",
      };
    } else {
      const candidateId = orders.rows[0]?.id;
      if (typeof candidateId !== "string" || candidateId.length === 0) {
        throw new Error("Orders list GET returned a candidate without an ID.");
      }
      const detailResponse = await getAdminJson(
        config,
        fetchImpl,
        signedIn.cookieHeader,
        `/api/v1/admin/orders/${encodeURIComponent(candidateId)}`,
        "Order detail GET",
      );
      const detail = requireObject(unwrapData(detailResponse.body), "Order detail GET");
      if (detail.id !== candidateId) {
        throw new Error("Order detail GET returned a different order than the bounded list candidate.");
      }
      if (!Array.isArray(detail.items)) {
        throw new Error("Order detail GET response did not include items.");
      }
      detailEvidence = {
        status: "passed",
        statusCode: detailResponse.statusCode,
        itemCount: detail.items.length,
        hasPaymentRecovery: Boolean(
          detail.paymentRecovery?.state && detail.paymentRecovery.state !== "none",
        ),
        hasShipmentRecoveryLock: detail.shipmentRecovery?.activeLock === true,
        hasActiveRefundOperation: detail.activeRefundOperation?.active === true,
      };
    }

    result = {
      status: "passed",
      readOnly: true,
      dashboardOrigin: config.dashboardBaseUrl,
      auth: signedIn.evidence,
      inventory: {
        status: "passed",
        statusCode: inventoryResponse.statusCode,
        returnedCount: inventory.rows.length,
        totalCount: inventory.total,
      },
      orders: {
        status: "passed",
        statusCode: ordersResponse.statusCode,
        returnedCount: orders.rows.length,
        totalCount: orders.total,
        empty: orders.total === 0,
      },
      detail: detailEvidence,
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error("Authenticated admin read check failed.");
  } finally {
    if (signedIn?.cookieHeader) {
      sessionCleanup = await signOutBestEffort(
        config,
        fetchImpl,
        signedIn.cookieHeader,
      );
    }
  }

  if (primaryError) {
    primaryError.sessionCleanup = sessionCleanup ?? {
      status: "not_attempted",
      statusCode: null,
      acknowledged: false,
    };
    throw primaryError;
  }

  result.sessionCleanup = sessionCleanup;
  if (sessionCleanup?.status === "warning") {
    result.status = "passed_with_warning";
    result.warnings = [sessionCleanup.message];
  }
  return result;
}

function printUsage(stdout = console.log) {
  stdout(`Usage: pnpm admin:read:check [options]

Authenticated read-only admin regression smoke.

Required process environment:
  SCALIUS_ADMIN_READ_EMAIL       Admin account email
  SCALIUS_ADMIN_READ_PASSWORD    Admin account password

Options:
  --dashboard-base-url <origin>  Dashboard origin (default ${DEFAULT_DASHBOARD_BASE_URL})
  --timeout-ms <ms>              Per-request timeout (default ${DEFAULT_TIMEOUT_MS})
  --json                         Emit safe aggregate JSON evidence
  -h, --help                     Show this help

The smoke creates an authentication session, keeps cookies in memory, issues
bounded GET requests, and then attempts authenticated sign-out. It never prints
credentials, cookies, order IDs, SKUs, customer data, or response bodies.
`);
}

export async function main(rawArgs = process.argv.slice(2), {
  env = process.env,
  fetchImpl = fetch,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  try {
    const config = getAdminReadCheckConfig(rawArgs, env);
    if (config.help) {
      printUsage(stdout);
      return 0;
    }
    const result = await runAdminReadCheck(config, { fetchImpl });
    if (config.json) {
      stdout(JSON.stringify(result, null, 2));
    } else {
      stdout(
        `PASS authenticated admin reads: inventory ${result.inventory.returnedCount}/${result.inventory.totalCount}, ` +
        `orders ${result.orders.returnedCount}/${result.orders.totalCount}, detail ${result.detail.status}, ` +
        `session cleanup ${result.sessionCleanup.status}.`,
      );
      if (result.sessionCleanup.status === "warning") {
        stderr(`WARN authenticated admin session cleanup: ${result.sessionCleanup.message}`);
      }
    }
    return 0;
  } catch (error) {
    const cleanup = error?.sessionCleanup;
    const cleanupEvidence = cleanup
      ? ` Session cleanup ${cleanup.status}${cleanup.statusCode ? ` (HTTP ${cleanup.statusCode})` : ""}.`
      : "";
    stderr(
      `FAIL authenticated admin reads: ${error instanceof Error ? error.message : "Unknown failure."}` +
      cleanupEvidence,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
