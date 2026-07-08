#!/usr/bin/env node
/**
 * Local authenticated admin browser smoke for the product rich-text save path.
 *
 * This helper is intentionally loopback-local only. It starts local API/admin
 * workers against disposable Wrangler state when needed, signs in as a local
 * first admin, creates/reuses a non-discoverable product fixture, then opens
 * the real admin product edit page in Chrome/Chromium and verifies a rich-text
 * description edit persists.
 */

import { execFileSync, spawn } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { createServer } from "net";
import { fileURLToPath, pathToFileURL } from "url";
import {
  assertPassword,
  assertSafeLocalMutationUrl,
  assertStringOptions,
  parseOptions,
  resolveLocalStatePath,
  resolvePnpmExecutable,
  trimTrailingSlash,
} from "./dev-local-utils.mjs";
import {
  buildCookieHeader,
  extractSetCookieHeaders,
} from "./dev-admin-smoke.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pnpmExecutable = resolvePnpmExecutable();
const validCommands = new Set(["smoke", "help"]);

const defaults = {
  apiBaseUrl: "http://localhost:8787",
  adminBaseUrl: "http://localhost:4323",
  email: "admin@local.scalius.test",
  password: "ScaliusLocal123!",
  name: "Local Admin",
  wranglerState: resolve(tmpdir(), "scalius-admin-browser-smoke-state"),
  categorySlug: "scalius-browser-smoke-category",
  productSlug: "scalius-browser-smoke-product",
};

let migrationsApplied = false;

export function getAdminBrowserSmokeConfig(rawArgs = process.argv.slice(2), env = process.env) {
  const positionalCommand = rawArgs[0] && !rawArgs[0].startsWith("--") ? rawArgs[0] : undefined;
  const command = positionalCommand || "smoke";
  const options = parseOptions(positionalCommand ? rawArgs.slice(1) : rawArgs);

  if (options.help) {
    return { command: "help" };
  }
  if (!validCommands.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  if (command === "help") {
    return { command };
  }

  assertStringOptions(options, [
    "api",
    "admin",
    "email",
    "password",
    "name",
    "state",
    "browser",
    "category-slug",
    "product-slug",
  ]);

  const apiBaseUrl = normalizeBrowserSmokeOrigin(
    options.api || env.LOCAL_API_BASE_URL || defaults.apiBaseUrl,
    "API URL",
  );
  const adminBaseUrl = normalizeBrowserSmokeOrigin(
    options.admin || env.LOCAL_ADMIN_BASE_URL || defaults.adminBaseUrl,
    "admin URL",
  );
  assertSafeLocalMutationUrl(apiBaseUrl, "API URL");
  assertSafeLocalMutationUrl(adminBaseUrl, "admin URL");

  const password = options.password || env.LOCAL_ADMIN_PASSWORD || defaults.password;
  assertPassword(password);

  return {
    command,
    apiBaseUrl,
    adminBaseUrl,
    email: options.email || env.LOCAL_ADMIN_EMAIL || defaults.email,
    password,
    name: options.name || env.LOCAL_ADMIN_NAME || defaults.name,
    wranglerState: resolveLocalStatePath(
      root,
      options.state || env.SCALIUS_ADMIN_BROWSER_SMOKE_STATE || defaults.wranglerState,
    ),
    categorySlug: options["category-slug"] || env.SCALIUS_ADMIN_BROWSER_SMOKE_CATEGORY_SLUG || defaults.categorySlug,
    productSlug: options["product-slug"] || env.SCALIUS_ADMIN_BROWSER_SMOKE_PRODUCT_SLUG || defaults.productSlug,
    browserExecutable: options.browser || env.CHROME_BIN || env.CHROMIUM_BIN || null,
    headless: !options.headed,
    keepBrowserProfile: Boolean(options["keep-browser-profile"]),
    noStart: Boolean(options["no-start"]),
    skipMigrations: Boolean(options["skip-migrations"] || options["no-migrate"]),
    skipSetup: Boolean(options["skip-setup"]),
    resetAdmin: Boolean(options["reset-admin"]),
  };
}

export function normalizeBrowserSmokeOrigin(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a URL.`);
  }

  let url;
  try {
    url = new URL(trimTrailingSlash(value.trim()));
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an origin without a path, query, or fragment.`);
  }

  return url.origin;
}

export function buildCategoryFixturePayload({ slug = defaults.categorySlug } = {}) {
  return {
    name: "Scalius Browser Smoke Category",
    description: "Disposable local browser smoke category.",
    slug,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: true,
    excludeFromSitemap: true,
    image: null,
  };
}

export function buildProductFixturePayload({
  slug = defaults.productSlug,
  categoryId,
  description = "<p>Scalius admin browser smoke fixture.</p>",
} = {}) {
  if (!categoryId) {
    throw new Error("Product fixture requires a categoryId.");
  }

  return {
    name: "Scalius Browser Smoke Product",
    description,
    price: 123,
    categoryId,
    isActive: false,
    discountType: "percentage",
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: true,
    excludeFromSitemap: true,
    excludeFromProductFeed: true,
    productCondition: "new",
    variantOption1Label: "Size",
    variantOption2Label: "Color",
    variantOption1Schema: "size",
    variantOption2Schema: "color",
    slug,
    images: [],
    attributes: [],
    additionalInfo: [],
  };
}

export function findItemBySlug(items, slug) {
  if (!Array.isArray(items)) return null;
  return items.find((item) => item?.slug === slug) ?? null;
}

export async function ensureCategoryFixture({
  config,
  cookieHeader,
  requestAdmin = requestAdminJson,
}) {
  const existing = await findCategoryFixture(config, cookieHeader, requestAdmin);
  if (existing) {
    return { id: existing.id, slug: existing.slug, created: false };
  }

  const payload = buildCategoryFixturePayload({ slug: config.categorySlug });
  const created = await requestAdmin(
    config,
    "POST",
    "/api/v1/admin/categories",
    payload,
    cookieHeader,
    [201, 409],
  );

  if (created.status === 409) {
    const afterConflict = await findCategoryFixture(config, cookieHeader, requestAdmin);
    if (afterConflict) {
      return { id: afterConflict.id, slug: afterConflict.slug, created: false };
    }
    throw new Error(`Category fixture slug conflict could not be resolved: ${config.categorySlug}`);
  }

  const data = unwrapData(created.body);
  if (!data?.id) {
    throw new Error("Category fixture create did not return an id.");
  }
  return { id: data.id, slug: config.categorySlug, created: true };
}

export async function ensureProductFixture({
  config,
  cookieHeader,
  categoryId,
  requestAdmin = requestAdminJson,
}) {
  const existing = await findProductFixture(config, cookieHeader, requestAdmin);
  if (existing) {
    return { id: existing.id, slug: existing.slug, created: false };
  }

  const payload = buildProductFixturePayload({
    slug: config.productSlug,
    categoryId,
  });
  const created = await requestAdmin(
    config,
    "POST",
    "/api/v1/admin/products",
    payload,
    cookieHeader,
    [201, 409],
  );

  if (created.status === 409) {
    const afterConflict = await findProductFixture(config, cookieHeader, requestAdmin);
    if (afterConflict) {
      return { id: afterConflict.id, slug: afterConflict.slug, created: false };
    }
    throw new Error(`Product fixture slug conflict could not be resolved: ${config.productSlug}`);
  }

  const data = unwrapData(created.body);
  if (!data?.id) {
    throw new Error("Product fixture create did not return an id.");
  }
  return { id: data.id, slug: config.productSlug, created: true };
}

export async function runAdminBrowserSmoke(config) {
  if (config.command === "help") {
    printHelp();
    return null;
  }

  assertSafeLocalMutationUrl(config.apiBaseUrl, "API URL");
  assertSafeLocalMutationUrl(config.adminBaseUrl, "admin URL");

  return withLocalWorkers(config, async (workers) => {
    let setup;
    if (config.resetAdmin) {
      setup = resetLocalAdmin(config);
    } else if (config.skipSetup) {
      setup = { skipped: true, adminExistsBefore: null, created: false };
    } else {
      setup = await ensureLocalAdmin(config);
    }

    const signIn = await signInAdmin(config);
    const accountSecurity = await requestAdminJson(
      config,
      "GET",
      "/api/v1/admin/auth/account-security",
      undefined,
      signIn.cookieHeader,
    );
    const accountSecurityData = unwrapData(accountSecurity.body);
    assertCondition(
      accountSecurityData?.isSuperAdmin === true || typeof accountSecurityData?.isSuperAdmin === "boolean",
      "Account security response did not include isSuperAdmin.",
    );

    const category = await ensureCategoryFixture({
      config,
      cookieHeader: signIn.cookieHeader,
    });
    const product = await ensureProductFixture({
      config,
      cookieHeader: signIn.cookieHeader,
      categoryId: category.id,
    });
    const marker = `rt-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const browser = await runBrowserRichTextEdit({
      config,
      cookieHeader: signIn.cookieHeader,
      setCookieHeaders: signIn.setCookieHeaders,
      productId: product.id,
      marker,
    });

    const result = {
      success: true,
      localOnly: true,
      targets: {
        api: config.apiBaseUrl,
        admin: config.adminBaseUrl,
      },
      wranglerState: config.wranglerState,
      workers,
      setup,
      signIn: {
        status: signIn.status,
        setCookieCount: signIn.setCookieHeaders.length,
        twoFactorRedirect: false,
      },
      fixture: {
        category,
        product,
      },
      browser,
      productDescription: {
        productId: product.id,
        marker,
        persisted: browser.persisted,
      },
    };

    console.log(JSON.stringify(result, null, 2));
    return result;
  });
}

async function findCategoryFixture(config, cookieHeader, requestAdmin) {
  const response = await requestAdmin(
    config,
    "GET",
    "/api/v1/admin/categories?limit=500&sort=updatedAt&order=desc",
    undefined,
    cookieHeader,
  );
  return findItemBySlug(unwrapData(response.body)?.categories, config.categorySlug);
}

async function findProductFixture(config, cookieHeader, requestAdmin) {
  const params = new URLSearchParams({
    limit: "100",
    search: "Scalius Browser Smoke Product",
    sort: "updatedAt",
    order: "desc",
  });
  const response = await requestAdmin(
    config,
    "GET",
    `/api/v1/admin/products?${params.toString()}`,
    undefined,
    cookieHeader,
  );
  return findItemBySlug(unwrapData(response.body)?.products, config.productSlug);
}

async function runBrowserRichTextEdit({ config, cookieHeader, setCookieHeaders, productId, marker }) {
  const chrome = await launchChrome(config);
  let cdp = null;
  const consoleErrors = [];
  const pageErrors = [];
  const editUrl = `${config.adminBaseUrl}/admin/products/${encodeURIComponent(productId)}/edit`;

  try {
    const target = await createChromeTarget(chrome.port);
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    cdp.on("Runtime.exceptionThrown", (event) => {
      pageErrors.push(formatRuntimeException(event));
    });
    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error") {
        consoleErrors.push(`console.error: ${formatRemoteArgs(event.args)}`);
      }
    });
    cdp.on("Log.entryAdded", (event) => {
      const entry = event.entry;
      if (entry?.level === "error") {
        consoleErrors.push(`browser log error: ${entry.text || entry.url || "unknown error"}`);
      }
    });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await setBrowserCookies(cdp, config.adminBaseUrl, setCookieHeaders);

    await cdp.send("Page.navigate", { url: editUrl });
    await waitForPageExpression(
      cdp,
      `document.readyState === "interactive" || document.readyState === "complete"`,
      30_000,
      "product edit document",
    );
    await waitForPageExpression(
      cdp,
      `location.pathname === ${JSON.stringify(`/admin/products/${productId}/edit`)}`,
      30_000,
      "authenticated product edit route",
    );
    await waitForPageExpression(
      cdp,
      `Boolean(document.querySelector(".ProseMirror[contenteditable='true']"))`,
      60_000,
      "rich-text editor",
    );

    await focusEditorAtEnd(cdp);
    await cdp.send("Input.insertText", { text: ` ${marker}` });
    await waitForPageExpression(
      cdp,
      `document.querySelector(".ProseMirror")?.textContent?.includes(${JSON.stringify(marker)}) === true`,
      10_000,
      "inserted rich-text marker",
    );
    await clickSaveProduct(cdp);
    const persisted = await waitForPersistedDescription({
      config,
      cookieHeader,
      productId,
      marker,
    });

    await sleep(750);
    const browserErrors = [...pageErrors, ...consoleErrors];
    if (browserErrors.length > 0) {
      throw new Error(`Browser reported errors:\n${browserErrors.map((error) => `- ${error}`).join("\n")}`);
    }

    return {
      editUrl,
      markerInserted: true,
      persisted,
      consoleErrorCount: consoleErrors.length,
      pageErrorCount: pageErrors.length,
      browserExecutable: chrome.executable,
      headless: config.headless,
    };
  } finally {
    if (cdp) {
      cdp.close();
    }
    await chrome.close();
  }
}

async function setBrowserCookies(cdp, adminBaseUrl, setCookieHeaders) {
  const cookies = setCookieHeaders
    .map(parseSetCookieNameValue)
    .filter(Boolean)
    .map(({ name, value }) => ({
      name,
      value,
      url: adminBaseUrl,
      path: "/",
    }));

  if (cookies.length === 0) {
    throw new Error("No sign-in cookies were available for the browser session.");
  }

  for (const cookie of cookies) {
    const result = await cdp.send("Network.setCookie", cookie);
    if (result.success !== true) {
      throw new Error(`Failed to set browser cookie ${cookie.name}.`);
    }
  }
}

function parseSetCookieNameValue(value) {
  const pair = String(value).split(";")[0]?.trim();
  if (!pair) return null;
  const equalsIndex = pair.indexOf("=");
  if (equalsIndex <= 0) return null;
  return {
    name: pair.slice(0, equalsIndex),
    value: pair.slice(equalsIndex + 1),
  };
}

async function focusEditorAtEnd(cdp) {
  await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `
      (() => {
        const editor = document.querySelector(".ProseMirror[contenteditable='true']");
        if (!editor) throw new Error("Rich-text editor was not found.");
        editor.scrollIntoView({ block: "center", inline: "nearest" });
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()
    `,
    returnByValue: true,
  });
}

async function clickSaveProduct(cdp) {
  await waitForPageExpression(
    cdp,
    `
      Array.from(document.querySelectorAll("button"))
        .some((button) => button.textContent?.includes("Save Product") && !button.disabled)
    `,
    15_000,
    "enabled Save Product button",
  );

  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `
      (() => {
        const button = Array.from(document.querySelectorAll("button"))
          .find((candidate) => candidate.textContent?.includes("Save Product") && !candidate.disabled);
        if (!button) throw new Error("Save Product button was not found.");
        button.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = button.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()
    `,
    returnByValue: true,
  });
  const point = result.result.value;
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function waitForPersistedDescription({ config, cookieHeader, productId, marker }) {
  const deadline = Date.now() + 45_000;
  let lastDescription = "";
  while (Date.now() < deadline) {
    const response = await requestAdminJson(
      config,
      "GET",
      `/api/v1/admin/products/${encodeURIComponent(productId)}`,
      undefined,
      cookieHeader,
    );
    const product = unwrapData(response.body);
    lastDescription = product?.description ?? "";
    if (typeof lastDescription === "string" && lastDescription.includes(marker)) {
      return true;
    }
    await sleep(1000);
  }

  throw new Error(
    `Timed out waiting for product description to persist marker ${marker}. ` +
    `Last description length: ${lastDescription.length}.`,
  );
}

async function launchChrome(config) {
  const executable = resolveBrowserExecutable(config.browserExecutable);
  if (!executable) {
    throw new Error(
      "No Chrome/Chromium executable found. Install Chrome/Chromium or pass --browser/CHROME_BIN. " +
      "This repo does not currently install Playwright or Puppeteer.",
    );
  }

  const port = await getFreePort();
  const userDataDir = mkdtempSync(join(tmpdir(), "scalius-admin-browser-smoke-chrome-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--window-size=1280,900",
    "about:blank",
  ];
  if (config.headless) {
    args.unshift("--headless=new", "--disable-gpu");
  }

  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stderr.write(`[chrome] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[chrome] ${chunk}`));

  try {
    await waitForChrome(port, child);
  } catch (error) {
    await stopProcess(child);
    if (!config.keepBrowserProfile) {
      rmSync(userDataDir, { recursive: true, force: true });
    } else {
      log(`Keeping browser profile at ${userDataDir}`);
    }
    throw error;
  }

  return {
    executable,
    port,
    userDataDir,
    async close() {
      await stopProcess(child);
      if (!config.keepBrowserProfile) {
        rmSync(userDataDir, { recursive: true, force: true });
      } else {
        log(`Keeping browser profile at ${userDataDir}`);
      }
    },
  };
}

export function resolveBrowserExecutable(explicit, {
  env = process.env,
  platform = process.platform,
} = {}) {
  if (explicit) {
    return existsSync(explicit) ? explicit : explicit;
  }

  const fromEnv = env.CHROME_BIN || env.CHROMIUM_BIN;
  if (fromEnv) {
    return existsSync(fromEnv) ? fromEnv : fromEnv;
  }

  const pathCandidates = platform === "win32"
    ? ["chrome.exe", "msedge.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
  for (const command of pathCandidates) {
    const found = findCommand(command, env.PATH);
    if (found) return found;
  }

  const home = env.HOME;
  const macCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    home ? join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome") : null,
  ].filter(Boolean);
  for (const candidate of macCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function findCommand(command, pathValue) {
  if (!pathValue) return null;
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
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
  if (!port) throw new Error("Could not allocate a Chrome remote debugging port.");
  return port;
}

async function waitForChrome(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited before DevTools was ready (exit code ${child.exitCode}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      // Keep polling until Chrome opens the debugging endpoint.
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for Chrome DevTools endpoint.");
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    sleep(1000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
      sleep(500),
    ]);
  }
}

async function createChromeTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Chrome target create failed (${response.status}).`);
  }
  const target = await response.json();
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Chrome target did not expose a webSocketDebuggerUrl.");
  }
  return target;
}

class CdpClient {
  static connect(webSocketUrl) {
    const client = new CdpClient(webSocketUrl);
    return client.open();
  }

  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.callbacks = new Map();
    this.handlers = new Map();
    this.ws = new WebSocket(webSocketUrl);
  }

  open() {
    return new Promise((resolveOpen, rejectOpen) => {
      const onOpen = () => {
        cleanup();
        this.ws.addEventListener("message", (event) => this.handleMessage(event));
        resolveOpen(this);
      };
      const onError = () => {
        cleanup();
        rejectOpen(new Error(`Failed to connect to Chrome DevTools: ${this.webSocketUrl}`));
      };
      const cleanup = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
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
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        rejectSend(new Error(`Chrome DevTools command timed out: ${method}`));
      }, 30_000);
      this.callbacks.set(id, { resolve: resolveSend, reject: rejectSend, timer });
      this.ws.send(payload);
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
      if (message.error) {
        callback.reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`.trim()));
      } else {
        callback.resolve(message.result ?? {});
      }
      return;
    }

    const handlers = this.handlers.get(message.method) ?? [];
    for (const handler of handlers) {
      handler(message.params ?? {});
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Nothing else to do; the Chrome process is cleaned up separately.
    }
  }
}

async function waitForPageExpression(cdp, expression, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `Boolean((() => { return (${expression}); })())`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.result?.value === true) return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` Last error: ${lastError}` : ""}`);
}

function formatRuntimeException(event) {
  const details = event.exceptionDetails;
  const text = details?.exception?.description || details?.text || "unknown exception";
  const url = details?.url ? ` at ${details.url}` : "";
  return `page exception: ${text}${url}`;
}

function formatRemoteArgs(args = []) {
  return args.map((arg) => {
    if ("value" in arg) {
      return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
    }
    return arg.description || arg.type || "unknown";
  }).join(" ");
}

async function withLocalWorkers(config, work) {
  const apiWasRunning = await isApiReady(config);
  const adminWasRunning = await isAdminReady(config);
  const workers = {
    apiStarted: false,
    adminStarted: false,
  };
  const children = [];

  assertBrowserSmokeWorkerStartupPolicy({
    apiWasRunning,
    adminWasRunning,
    noStart: config.noStart,
    apiBaseUrl: config.apiBaseUrl,
    adminBaseUrl: config.adminBaseUrl,
  });

  if (!apiWasRunning || !adminWasRunning) {
    ensureLocalMigrations(config);
  }

  try {
    if (!apiWasRunning) {
      assertDefaultDevPort(config.apiBaseUrl, 8787, "API");
      log(`Starting temporary API worker at ${config.apiBaseUrl} with state ${config.wranglerState}...`);
      const child = spawnWorker("api", ["--filter", "@scalius/api", "dev"], config);
      children.push(child);
      workers.apiStarted = true;
      await waitForService("API", () => isApiReady(config), () => getChildStatus(child));
    }

    if (!adminWasRunning) {
      assertDefaultDevPort(config.adminBaseUrl, 4323, "admin");
      log(`Starting temporary admin worker at ${config.adminBaseUrl} with state ${config.wranglerState}...`);
      const child = spawnWorker("admin", ["--filter", "@scalius/admin-v2", "dev"], config);
      children.push(child);
      workers.adminStarted = true;
      await waitForService("admin", () => isAdminReady(config), () => getChildStatus(child));
    }

    return await work(workers);
  } finally {
    for (const child of children.reverse()) {
      if (!child.killed) {
        log(`Stopping temporary ${child.__scaliusLabel} worker...`);
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        child.kill("SIGTERM");
      }
    }
  }
}

export function assertBrowserSmokeWorkerStartupPolicy({
  apiWasRunning,
  adminWasRunning,
  noStart,
  apiBaseUrl,
  adminBaseUrl,
}) {
  if ((!apiWasRunning || !adminWasRunning) && noStart) {
    const missing = [
      !apiWasRunning ? `API at ${apiBaseUrl}` : null,
      !adminWasRunning ? `admin at ${adminBaseUrl}` : null,
    ].filter(Boolean).join(" and ");
    throw new Error(`${missing} is not running. Start local dev workers with pnpm dev:admin.`);
  }

  if (!noStart && (apiWasRunning || adminWasRunning)) {
    const running = [
      apiWasRunning ? `API at ${apiBaseUrl}` : null,
      adminWasRunning ? `admin at ${adminBaseUrl}` : null,
    ].filter(Boolean).join(" and ");
    throw new Error(
      `Refusing to reuse already-running ${running}. ` +
      "Stop the existing local workers for a fresh disposable smoke, or pass --no-start when you intentionally " +
      "want to mutate the currently running local stack.",
    );
  }
}

function spawnWorker(label, args, config) {
  const child = spawn(pnpmExecutable, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SCALIUS_WRANGLER_STATE: config.wranglerState,
    },
  });
  child.__scaliusLabel = label;
  child.__scaliusStatus = null;
  child.once("exit", (code, signal) => {
    child.__scaliusStatus = { code, signal };
  });
  child.stdout.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  return child;
}

function getChildStatus(child) {
  return child.__scaliusStatus;
}

async function isApiReady(config) {
  try {
    const response = await fetch(`${config.apiBaseUrl}/api/v1/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function isAdminReady(config) {
  try {
    const sessionResponse = await fetch(`${config.adminBaseUrl}/api/auth/get-session`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(1200),
    });
    if (![200, 401].includes(sessionResponse.status)) return false;
    const contentType = sessionResponse.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return false;
    try {
      const text = await sessionResponse.text();
      if (text) JSON.parse(text);
    } catch {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForService(label, isReady, getChildStatus = () => null) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isReady()) return;
    const childStatus = getChildStatus();
    if (childStatus) {
      const reason = childStatus.signal ? `signal ${childStatus.signal}` : `exit code ${childStatus.code}`;
      throw new Error(`Temporary ${label} worker exited before it was ready (${reason}).`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label} worker.`);
}

function ensureLocalMigrations(config) {
  if (config.skipMigrations || migrationsApplied) return;
  log("Ensuring local D1 migrations are applied...");
  execFileSyncToStderr("node", ["scripts/deploy.mjs", "--migrate-only", "--local"], {
    cwd: root,
    env: {
      ...process.env,
      SCALIUS_WRANGLER_STATE: config.wranglerState,
    },
  });
  migrationsApplied = true;
}

function execFileSyncToStderr(file, args, options) {
  try {
    execFileSync(file, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error?.stdout) process.stderr.write(String(error.stdout));
    if (error?.stderr) process.stderr.write(String(error.stderr));
    throw error;
  }
}

async function ensureLocalAdmin(config) {
  const status = await requestApiJson(config, "GET", "/api/v1/setup");
  const statusData = unwrapData(status.body);
  if (statusData?.adminExists) {
    return {
      skipped: false,
      adminExistsBefore: true,
      created: false,
    };
  }

  const created = await requestApiJson(config, "POST", "/api/v1/setup", {
    name: config.name,
    email: config.email,
    password: config.password,
  }, [201]);
  const createdData = unwrapData(created.body);

  return {
    skipped: false,
    adminExistsBefore: false,
    created: true,
    userId: createdData?.userId ?? null,
  };
}

function resetLocalAdmin(config) {
  const args = [
    "scripts/dev-admin.mjs",
    "reset",
    "--api",
    config.apiBaseUrl,
    "--email",
    config.email,
    "--password",
    config.password,
    "--name",
    config.name,
    "--state",
    config.wranglerState,
    "--no-start",
  ];
  if (config.skipMigrations) {
    args.push("--skip-migrations");
  }

  log("Resetting local admin through scripts/dev-admin.mjs...");
  execFileSyncToStderr("node", args, {
    cwd: root,
    env: {
      ...process.env,
      SCALIUS_WRANGLER_STATE: config.wranglerState,
    },
  });

  return {
    skipped: false,
    reset: true,
    adminExistsBefore: null,
    created: true,
  };
}

async function signInAdmin(config) {
  const response = await fetch(`${config.adminBaseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: config.adminBaseUrl,
    },
    body: JSON.stringify({
      email: config.email,
      password: config.password,
      rememberMe: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await parseJsonResponse(response);
  const errorMessage = getResponseErrorMessage(body, response);

  if (!response.ok) {
    throw new Error(
      `POST /api/auth/sign-in/email failed (${response.status}): ${errorMessage}. ` +
      "If local D1 already has a different admin password, rerun with --reset-admin or use a fresh --state path.",
    );
  }
  if (body?.twoFactorRedirect) {
    throw new Error(
      "Local admin sign-in requires two-factor verification. Rerun with --reset-admin " +
      "or pass credentials for a local admin session that does not require 2FA.",
    );
  }

  const setCookieHeaders = extractSetCookieHeaders(response.headers);
  const cookieHeader = buildCookieHeader(setCookieHeaders);
  if (!cookieHeader) {
    throw new Error("Admin sign-in succeeded but did not return a Set-Cookie session.");
  }

  return {
    status: response.status,
    body,
    cookieHeader,
    setCookieHeaders,
  };
}

async function requestApiJson(config, method, path, body, expectedStatuses = [200]) {
  return requestJson(config.apiBaseUrl, method, path, body, expectedStatuses);
}

async function requestAdminJson(config, method, path, body, cookieHeader, expectedStatuses = [200]) {
  return requestJson(config.adminBaseUrl, method, path, body, expectedStatuses, {
    cookie: cookieHeader,
    origin: config.adminBaseUrl,
  });
}

async function requestJson(baseUrl, method, path, body, expectedStatuses = [200], extraHeaders = {}) {
  const headers = {
    accept: "application/json",
    ...extraHeaders,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = await parseJsonResponse(response);
  const errorMessage = getResponseErrorMessage(parsed, response);
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${method} ${path} failed (${response.status}): ${errorMessage}`);
  }
  return {
    status: response.status,
    body: parsed,
    errorMessage: response.ok ? null : errorMessage,
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getResponseErrorMessage(body, response) {
  return body?.error?.message || body?.message || body?.error || body?.raw || response.statusText;
}

function unwrapData(body) {
  return body?.data ?? body;
}

function assertDefaultDevPort(value, port, label) {
  const url = new URL(value);
  const actualPort = url.port || (url.protocol === "http:" ? "80" : "443");
  if (url.protocol !== "http:" || actualPort !== String(port)) {
    throw new Error(
      `Custom ${label} URL ${value} requires --no-start with an already running local worker. ` +
      `The bundled dev script starts ${label} on http://localhost:${port}.`,
    );
  }
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function log(message) {
  console.error(message);
}

function printHelp() {
  console.log(`
Local admin product rich-text browser smoke

Usage:
  pnpm dev:admin:browser-smoke
  node scripts/dev-admin-browser-smoke.mjs smoke --state /tmp/scalius-admin-browser-smoke-state --reset-admin

Options:
  --api <url>             Local API origin (default: ${defaults.apiBaseUrl})
  --admin <url>           Local admin origin (default: ${defaults.adminBaseUrl})
  --email <email>         Local admin email (default: ${defaults.email})
  --password <value>      Local admin password, 12+ chars (default: ${defaults.password})
  --name <name>           First-admin setup name (default: ${defaults.name})
  --state <path>          Disposable Wrangler local state path (default: ${defaults.wranglerState})
  --browser <path>        Chrome/Chromium executable path; CHROME_BIN is also honored
  --category-slug <slug>  Disposable category fixture slug
  --product-slug <slug>   Disposable product fixture slug
  --reset-admin           Reset local auth tables through scripts/dev-admin.mjs first
  --skip-setup            Do not create the first local admin when none exists
  --no-start              Intentionally reuse already-running local API/admin workers
  --skip-migrations       Do not apply local D1 migrations before starting workers
  --headed                Run Chrome with a visible window instead of headless mode

Safety:
  This smoke refuses known production and non-local API/admin targets before
  starting workers or mutating data. By default it uses disposable Wrangler
  state under /tmp, creates inactive/noindex/feed-excluded local fixtures, and
  verifies only the product edit rich-text description save path. If local
  workers are already running, stop them first or pass --no-start to explicitly
  mutate that existing local stack.
`);
}

async function main() {
  try {
    const config = getAdminBrowserSmokeConfig();
    await runAdminBrowserSmoke(config);
  } catch (error) {
    console.error("\nLocal admin product rich-text browser smoke failed.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
