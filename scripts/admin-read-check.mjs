#!/usr/bin/env node

import { spawn } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";
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
const PRODUCTS_PATH = "/api/v1/admin/products?page=1&limit=1&sort=updatedAt&order=desc&trashed=false";
const CUSTOMERS_PATH = "/api/v1/admin/customers?page=1&limit=1&sort=updatedAt&order=desc&trashed=false";
const SIGN_IN_PATH = "/api/auth/sign-in/email";
const SIGN_OUT_PATH = "/api/auth/sign-out";
const BROWSER_SETTLE_MS = 1_250;

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
    if (arg.startsWith("--browser=")) {
      options.browserExecutable = arg.slice("--browser=".length);
      continue;
    }
    if (arg === "--browser") {
      const next = rawArgs[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Option --browser requires a value.");
      }
      options.browserExecutable = next;
      index += 1;
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
    browserExecutable:
      options.browserExecutable ||
      env.SCALIUS_ADMIN_READ_BROWSER ||
      env.CHROME_BIN ||
      env.CHROMIUM_BIN ||
      null,
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

function requireOrderFormData(payload) {
  const data = requireObject(unwrapData(payload), "Order form-data GET");
  if (!Array.isArray(data.productsWithVariants)) {
    throw new Error("Order form-data GET response did not include productsWithVariants.");
  }
  if (!data.productsWithVariants.every((product) => Array.isArray(product?.variants))) {
    throw new Error("Order form-data GET response included a product without variants.");
  }
  if (!data.productsWithVariants.every((product) =>
    product.variants.every((variant) => Array.isArray(variant?.selectedOptions)))) {
    throw new Error("Order form-data GET response included a variant without selectedOptions.");
  }
  const defaultValues = requireObject(data.defaultValues, "Order form-data defaults");
  if (!Array.isArray(defaultValues.items)) {
    throw new Error("Order form-data GET response did not include default order items.");
  }
  return {
    productCount: data.productsWithVariants.length,
    itemCount: defaultValues.items.length,
  };
}

function requireCustomerHistory(payload, candidateId) {
  const data = requireObject(unwrapData(payload), "Customer history GET");
  const customer = requireObject(data.customer, "Customer history customer");
  if (customer.id !== candidateId) {
    throw new Error("Customer history GET returned a different customer than the bounded list candidate.");
  }
  if (!Array.isArray(data.history) || !Array.isArray(data.orders)) {
    throw new Error("Customer history GET response did not include history and orders collections.");
  }
  return {
    historyCount: data.history.length,
    orderCount: data.orders.length,
  };
}

function normalizePathname(pathname) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

export function buildAdminRoutePlan({ orderId, productId, customerId } = {}) {
  const routes = [
    { label: "dashboard", path: "/admin", titleIncludes: "Dashboard | Scalius Admin" },
    { label: "products_list", path: "/admin/products", titleIncludes: "Products | Scalius Admin" },
    { label: "products_new", path: "/admin/products/new", titleIncludes: "New Product | Scalius Admin" },
    { label: "orders_list", path: "/admin/orders", titleIncludes: "Orders | Scalius Admin" },
    { label: "orders_new", path: "/admin/orders/new", titleIncludes: "New Order | Scalius Admin" },
    { label: "customers_list", path: "/admin/customers", titleIncludes: "Customers | Scalius Admin" },
    { label: "inventory", path: "/admin/inventory", titleIncludes: "Inventory | Scalius Admin" },
    { label: "media", path: "/admin/media", titleIncludes: "Media | Scalius Admin" },
    { label: "discounts", path: "/admin/discounts", titleIncludes: "Discounts | Scalius Admin" },
    { label: "analytics", path: "/admin/analytics", titleIncludes: "Analytics | Scalius Admin" },
    {
      label: "settings_seo",
      path: "/admin/settings?section=seo",
      titleIncludes: "General settings | Scalius Admin",
      expectedSearch: { section: "seo" },
    },
    {
      label: "settings_security",
      path: "/admin/settings?section=security",
      titleIncludes: "General settings | Scalius Admin",
      expectedSearch: { section: "security" },
    },
    { label: "settings_account", path: "/admin/settings/account", titleIncludes: "Account | Scalius Admin" },
    { label: "settings_theme", path: "/admin/settings/theme", titleIncludes: "Theme | Scalius Admin" },
    {
      label: "settings_notifications",
      path: "/admin/settings/notifications",
      titleIncludes: "Notifications | Scalius Admin",
    },
    {
      label: "settings_checkout",
      path: "/admin/settings/checkout",
      titleIncludes: "Checkout Settings | Scalius Admin",
    },
    { label: "settings_taxes", path: "/admin/settings/taxes", titleIncludes: "Taxes | Scalius Admin" },
  ];
  const skipped = [];

  if (typeof productId === "string" && productId.length > 0) {
    const encodedProductId = encodeURIComponent(productId);
    routes.push(
      { label: "product_view", path: `/admin/products/${encodedProductId}`, titleIncludes: "Product | Scalius Admin" },
      { label: "product_edit", path: `/admin/products/${encodedProductId}/edit`, titleIncludes: "Edit Product | Scalius Admin" },
    );
  } else {
    skipped.push({ label: "product_view", reason: "empty_products" });
    skipped.push({ label: "product_edit", reason: "empty_products" });
  }

  if (typeof orderId === "string" && orderId.length > 0) {
    const encodedOrderId = encodeURIComponent(orderId);
    routes.push(
      { label: "order_view", path: `/admin/orders/${encodedOrderId}`, titleIncludes: "Order #" },
      { label: "order_edit", path: `/admin/orders/${encodedOrderId}/edit`, titleIncludes: "Edit Order #" },
    );
  } else {
    skipped.push({ label: "order_view", reason: "empty_orders" });
    skipped.push({ label: "order_edit", reason: "empty_orders" });
  }

  if (typeof customerId === "string" && customerId.length > 0) {
    const encodedCustomerId = encodeURIComponent(customerId);
    routes.push(
      { label: "customer_edit", path: `/admin/customers/${encodedCustomerId}/edit`, titleIncludes: "Edit Customer | Scalius Admin" },
      { label: "customer_history", path: `/admin/customers/${encodedCustomerId}/history`, titleIncludes: "Customer History | Scalius Admin" },
    );
  } else {
    skipped.push({ label: "customer_edit", reason: "empty_customers" });
    skipped.push({ label: "customer_history", reason: "empty_customers" });
  }

  return { routes, skipped };
}

const ROUTE_ERROR_PATTERNS = [
  /cannot read properties of (?:undefined|null)/i,
  /internal server error/i,
  /order editor could not be loaded/i,
  /new order form could not be loaded/i,
  /order could not be loaded/i,
  /analytics integrations could not be loaded/i,
  /media could not be loaded/i,
  /inventory could not be loaded/i,
  /something went wrong loading (?:this page|the product form|the order|the dashboard|settings|quick actions|recent orders)/i,
];

export function classifyAdminRouteState({
  expectedPathname,
  actualPathname,
  expectedSearch = {},
  actualSearch = "",
  expectedTitle,
  actualTitle,
  bodyText = "",
  hasGenericRouteError = false,
  consoleErrorCount = 0,
  pageErrorCount = 0,
}) {
  if (normalizePathname(actualPathname) !== normalizePathname(expectedPathname)) {
    return "unexpected_redirect";
  }
  const search = new URLSearchParams(actualSearch);
  if (Object.entries(expectedSearch).some(([key, value]) => search.get(key) !== value)) {
    return "unexpected_redirect";
  }
  if (typeof expectedTitle === "string" && !String(actualTitle).includes(expectedTitle)) {
    return "unexpected_document";
  }
  if (hasGenericRouteError || ROUTE_ERROR_PATTERNS.some((pattern) => pattern.test(bodyText))) {
    return "error_fallback";
  }
  if (pageErrorCount > 0) return "page_exception";
  if (consoleErrorCount > 0) return "console_error";
  return null;
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
    setCookieHeaders,
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
          "content-type": "application/json",
          cookie: cookieHeader,
          origin: config.dashboardBaseUrl,
        },
        body: "{}",
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

function findExecutable(command, pathValue = process.env.PATH) {
  if (!pathValue) return null;
  for (const directory of pathValue.split(":")) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBrowserExecutable(explicit) {
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    const found = findExecutable(explicit);
    if (found) return found;
    throw new Error("Configured Chrome/Chromium executable was not found.");
  }
  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const found = findExecutable(command);
    if (found) return found;
  }
  const home = process.env.HOME;
  for (const candidate of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    home ? join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome") : null,
  ].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!port) throw new Error("Could not allocate a browser debugging port.");
  return port;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    sleep(1_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      sleep(500),
    ]);
  }
}

async function waitForChrome(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Headless browser exited before it was ready (exit code ${child.exitCode}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The bounded startup poll continues until Chrome exposes DevTools.
    }
    await sleep(200);
  }
  throw new Error("Timed out waiting for the headless browser.");
}

async function launchReadOnlyBrowser(config) {
  const executable = resolveBrowserExecutable(config.browserExecutable);
  if (!executable) {
    throw new Error(
      "Authenticated admin route checks require Chrome/Chromium. Set SCALIUS_ADMIN_READ_BROWSER or CHROME_BIN.",
    );
  }
  const port = await getFreePort();
  const userDataDir = mkdtempSync(join(tmpdir(), "scalius-admin-read-check-"));
  const child = spawn(executable, [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--window-size=1440,1000",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    await waitForChrome(port, child, config.timeoutMs);
  } catch (error) {
    await stopProcess(child);
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    port,
    async close() {
      await stopProcess(child);
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

async function createBrowserTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Headless browser target creation failed with HTTP ${response.status}.`);
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Headless browser target did not expose a debugging endpoint.");
  }
  return target;
}

class CdpClient {
  static connect(webSocketUrl) {
    return new CdpClient(webSocketUrl).open();
  }

  constructor(webSocketUrl) {
    this.nextId = 1;
    this.callbacks = new Map();
    this.handlers = new Map();
    this.ws = new WebSocket(webSocketUrl);
  }

  open() {
    return new Promise((resolveOpen, rejectOpen) => {
      const cleanup = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        this.ws.addEventListener("message", (event) => this.handleMessage(event));
        resolveOpen(this);
      };
      const onError = () => {
        cleanup();
        rejectOpen(new Error("Could not connect to the headless browser debugging endpoint."));
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
    });
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        rejectSend(new Error(`Headless browser command timed out: ${method}.`));
      }, 30_000);
      this.callbacks.set(id, { resolve: resolveSend, reject: rejectSend, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  handleMessage(event) {
    const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    const message = JSON.parse(raw);
    if (message.id) {
      const callback = this.callbacks.get(message.id);
      if (!callback) return;
      this.callbacks.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) callback.reject(new Error("Headless browser command failed."));
      else callback.resolve(message.result ?? {});
      return;
    }
    for (const handler of this.handlers.get(message.method) ?? []) {
      handler(message.params ?? {});
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // The process-level cleanup below remains authoritative.
    }
  }
}

function parseCookieNameValue(value) {
  const pair = String(value).split(";")[0]?.trim();
  if (!pair) return null;
  const equalsIndex = pair.indexOf("=");
  if (equalsIndex <= 0) return null;
  return { name: pair.slice(0, equalsIndex), value: pair.slice(equalsIndex + 1) };
}

async function setBrowserCookies(cdp, dashboardOrigin, setCookieHeaders) {
  const cookies = setCookieHeaders.map(parseCookieNameValue).filter(Boolean);
  if (cookies.length === 0) {
    throw new Error("Admin sign-in did not provide a browser session cookie.");
  }
  for (const cookie of cookies) {
    const result = await cdp.send("Network.setCookie", {
      ...cookie,
      url: dashboardOrigin,
      path: "/",
    });
    if (result.success !== true) {
      throw new Error("The authenticated browser session could not be initialized.");
    }
  }
}

async function waitForDocument(cdp, timeoutMs, previousHref) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `document.readyState === "complete" && location.href !== ${JSON.stringify(previousHref)}`,
        returnByValue: true,
      });
      if (result.result?.value === true) return;
    } catch {
      // A direct navigation can briefly replace the execution context.
    }
    await sleep(200);
  }
  throw new Error("Timed out waiting for an authenticated admin route document.");
}

async function inspectCurrentRoute(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `
      (() => {
        const retryButton = Array.from(document.querySelectorAll("button"))
          .some((button) => /^try again$/i.test(button.textContent?.trim() || ""));
        const genericErrorTitle = Array.from(document.querySelectorAll("h1,h2,h3,p"))
          .some((node) => /^error$/i.test(node.textContent?.trim() || ""));
        return {
          pathname: location.pathname,
          search: location.search,
          title: document.title,
          bodyText: (document.body?.innerText || "").slice(0, 250000),
          hasGenericRouteError: retryButton && genericErrorTitle,
        };
      })()
    `,
  });
  return result.result?.value ?? {};
}

export async function runAuthenticatedAdminRouteChecks({ config, setCookieHeaders, routePlan }) {
  const browser = await launchReadOnlyBrowser(config);
  let cdp;
  let activeErrors = null;
  try {
    const target = await createBrowserTarget(browser.port);
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", () => {
      if (activeErrors) activeErrors.page += 1;
    });
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (activeErrors && event.type === "error") activeErrors.console += 1;
    });
    cdp.on("Log.entryAdded", (event) => {
      if (activeErrors && event.entry?.level === "error") activeErrors.console += 1;
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await setBrowserCookies(cdp, config.dashboardBaseUrl, setCookieHeaders);

    const checks = [];
    for (const route of routePlan.routes) {
      activeErrors = { console: 0, page: 0 };
      const targetUrl = new URL(route.path, config.dashboardBaseUrl);
      const beforeNavigation = await cdp.send("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      const previousHref = beforeNavigation.result?.value ?? "about:blank";
      const navigation = await cdp.send("Page.navigate", { url: targetUrl.href });
      if (navigation.errorText) {
        throw new Error(`Authenticated admin route ${route.label} could not be navigated.`);
      }
      await waitForDocument(cdp, config.timeoutMs, previousHref);
      await sleep(BROWSER_SETTLE_MS);
      const snapshot = await inspectCurrentRoute(cdp);
      const failure = classifyAdminRouteState({
        expectedPathname: targetUrl.pathname,
        actualPathname: snapshot.pathname,
        expectedSearch: route.expectedSearch,
        actualSearch: snapshot.search,
        expectedTitle: route.titleIncludes,
        actualTitle: snapshot.title,
        bodyText: snapshot.bodyText,
        hasGenericRouteError: snapshot.hasGenericRouteError,
        consoleErrorCount: activeErrors.console,
        pageErrorCount: activeErrors.page,
      });
      if (failure) {
        throw new Error(`Authenticated admin route ${route.label} failed: ${failure}.`);
      }
      checks.push({ label: route.label, status: "passed" });
    }
    activeErrors = null;
    return {
      status: "passed",
      checkedCount: checks.length,
      skippedCount: routePlan.skipped.length,
      checks,
      skipped: routePlan.skipped,
      consoleErrorCount: 0,
      pageErrorCount: 0,
    };
  } finally {
    activeErrors = null;
    cdp?.close();
    await browser.close();
  }
}

export async function runAdminReadCheck(config, {
  fetchImpl = fetch,
  browserRouteCheckImpl = runAuthenticatedAdminRouteChecks,
} = {}) {
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

    let orderCandidateId = null;
    let detailEvidence;
    let orderFormEvidence;
    if (orders.rows.length === 0) {
      detailEvidence = {
        status: "skipped_empty_orders",
        reason: "The active order catalog is truthfully empty.",
      };
      orderFormEvidence = {
        status: "skipped_empty_orders",
        reason: "The active order catalog is truthfully empty.",
      };
    } else {
      const candidateId = orders.rows[0]?.id;
      if (typeof candidateId !== "string" || candidateId.length === 0) {
        throw new Error("Orders list GET returned a candidate without an ID.");
      }
      orderCandidateId = candidateId;
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

      const formDataResponse = await getAdminJson(
        config,
        fetchImpl,
        signedIn.cookieHeader,
        `/api/v1/admin/orders/${encodeURIComponent(candidateId)}/form-data`,
        "Order form-data GET",
      );
      orderFormEvidence = {
        status: "passed",
        statusCode: formDataResponse.statusCode,
        ...requireOrderFormData(formDataResponse.body),
      };
    }

    const productsResponse = await getAdminJson(
      config,
      fetchImpl,
      signedIn.cookieHeader,
      PRODUCTS_PATH,
      "Products list GET",
    );
    const products = requireBoundedCollection(productsResponse.body, "products", "Products list GET");
    const productCandidateId = products.rows[0]?.id ?? null;
    if (productCandidateId !== null && (typeof productCandidateId !== "string" || productCandidateId.length === 0)) {
      throw new Error("Products list GET returned a candidate without an ID.");
    }

    const customersResponse = await getAdminJson(
      config,
      fetchImpl,
      signedIn.cookieHeader,
      CUSTOMERS_PATH,
      "Customers list GET",
    );
    const customers = requireBoundedCollection(customersResponse.body, "customers", "Customers list GET");
    const customerCandidateId = customers.rows[0]?.id ?? null;
    if (customerCandidateId !== null && (typeof customerCandidateId !== "string" || customerCandidateId.length === 0)) {
      throw new Error("Customers list GET returned a candidate without an ID.");
    }

    let customerHistoryEvidence;
    if (!customerCandidateId) {
      customerHistoryEvidence = {
        status: "skipped_empty_customers",
        reason: "The active customer catalog is truthfully empty.",
      };
    } else {
      const historyResponse = await getAdminJson(
        config,
        fetchImpl,
        signedIn.cookieHeader,
        `/api/v1/admin/customers/${encodeURIComponent(customerCandidateId)}/history`,
        "Customer history GET",
      );
      customerHistoryEvidence = {
        status: "passed",
        statusCode: historyResponse.statusCode,
        ...requireCustomerHistory(historyResponse.body, customerCandidateId),
      };
    }

    const routePlan = buildAdminRoutePlan({
      orderId: orderCandidateId,
      productId: productCandidateId,
      customerId: customerCandidateId,
    });
    const browser = await browserRouteCheckImpl({
      config,
      setCookieHeaders: signedIn.setCookieHeaders,
      routePlan,
    });

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
      products: {
        status: "passed",
        statusCode: productsResponse.statusCode,
        returnedCount: products.rows.length,
        totalCount: products.total,
        empty: products.total === 0,
      },
      customers: {
        status: "passed",
        statusCode: customersResponse.statusCode,
        returnedCount: customers.rows.length,
        totalCount: customers.total,
        empty: customers.total === 0,
      },
      detail: detailEvidence,
      orderForm: orderFormEvidence,
      customerHistory: customerHistoryEvidence,
      browser,
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
  --browser <path>               Chrome/Chromium executable (or use SCALIUS_ADMIN_READ_BROWSER)
  --json                         Emit safe aggregate JSON evidence
  -h, --help                     Show this help

The smoke creates an authentication session, keeps cookies in memory, issues
bounded GET requests, and opens representative list/view/edit routes in a fresh
headless browser without submitting forms. It rejects route error fallbacks,
unexpected redirects, console errors, and page exceptions, then attempts
authenticated sign-out. It never prints credentials, cookies, resource IDs,
SKUs, customer data, response bodies, or browser error payloads.
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
        `order form ${result.orderForm.status}, browser routes ${result.browser.checkedCount}, ` +
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
