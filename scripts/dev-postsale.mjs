#!/usr/bin/env node
/**
 * Local post-sale smoke helper.
 *
 * This script is intentionally local-only. It seeds a tiny checkout-ready
 * catalog in disposable Wrangler D1 state, then exercises the real public
 * cart/order/receipt routes without mutating production data.
 */

import { execFileSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  assertSafeLocalMutationUrl,
  assertStringOptions,
  parseOptions,
  resolveLocalStatePath,
  resolvePnpmExecutable,
  trimTrailingSlash,
} from "./dev-local-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const apiDir = resolve(root, "apps", "api");
const pnpmExecutable = resolvePnpmExecutable();
const validCommands = new Set(["seed", "checkout-smoke", "load", "otp-smoke", "payment-readiness", "help"]);

const fixture = {
  cityId: "ops006_city_dhaka",
  zoneId: "ops006_zone_mirpur",
  areaId: "ops006_area_section_10",
  shippingMethodId: "ops006_shipping_standard",
  categoryId: "ops006_category",
  productId: "ops006_product",
  variantId: "ops006_variant_default",
  productName: "OPS006 Local Smoke Product",
  variantSku: "OPS006-SMOKE-SIMPLE",
  price: 1200,
  shippingCharge: 80,
  partialPaymentAmount: 150,
};

const paymentReadinessGateways = [
  {
    gateway: "stripe",
    orderId: "ops006_order_stripe",
    token: "chk_ops006_stripe",
    path: "/api/v1/payment/stripe/intent",
  },
  {
    gateway: "sslcommerz",
    orderId: "ops006_order_sslcommerz",
    token: "chk_ops006_sslcommerz",
    path: "/api/v1/payment/sslcommerz/session",
  },
  {
    gateway: "polar",
    orderId: "ops006_order_polar",
    token: "chk_ops006_polar",
    path: "/api/v1/payment/polar/session",
  },
];

const defaults = {
  apiBaseUrl: process.env.LOCAL_API_BASE_URL || "http://localhost:8787",
  wranglerState: resolveLocalStatePath(root, process.env.SCALIUS_WRANGLER_STATE),
  orders: 25,
  concurrency: 5,
};

const receiptTokenHeader = "X-Receipt-Token";

let migrationsApplied = false;

export function getPostsaleConfig(rawArgs = process.argv.slice(2), env = process.env) {
  if (rawArgs[0] === "help" || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    return { command: "help" };
  }

  const positionalCommand = rawArgs[0] && !rawArgs[0].startsWith("--") ? rawArgs[0] : undefined;
  const command = positionalCommand || "checkout-smoke";
  const options = parseOptions(positionalCommand ? rawArgs.slice(1) : rawArgs);

  if (!validCommands.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  assertStringOptions(options, [
    "api",
    "state",
    "orders",
    "concurrency",
    "payment",
    "target",
  ]);

  const apiBaseUrl = trimTrailingSlash(options.api || env.LOCAL_API_BASE_URL || defaults.apiBaseUrl);
  const target = options.target || "local";
  if (target !== "local") {
    throw new Error("Post-sale mutation smokes are local-only until an explicit staging test-store policy is wired.");
  }

  assertSafeLocalMutationUrl(apiBaseUrl);

  const orders = parsePositiveInteger(options.orders, defaults.orders, "--orders");
  const concurrency = parsePositiveInteger(options.concurrency, defaults.concurrency, "--concurrency");
  const paymentMethod = options.payment || "cod";
  if (paymentMethod !== "cod") {
    throw new Error("Local post-sale mutation smokes support COD only. Online gateways require staging sandbox policy.");
  }

  return {
    command,
    apiBaseUrl,
    wranglerState: resolveLocalStatePath(root, options.state || env.SCALIUS_WRANGLER_STATE || defaults.wranglerState),
    noStart: Boolean(options["no-start"]),
    skipMigrations: Boolean(options["skip-migrations"] || options["no-migrate"]),
    skipSeed: Boolean(options["skip-seed"]),
    skipSupport: Boolean(options["skip-support"]),
    json: Boolean(options.json),
    orders,
    concurrency,
    paymentMethod,
  };
}

export function buildFixtureSql() {
  const customerAuthPolicy = {
    otpChannels: ["email"],
    requiredContactFields: ["phone"],
    optionalContactFields: [],
    defaultOtpChannel: "email",
  };

  return [
    `INSERT INTO site_settings (
      id, singleton_key, site_name, site_description, header_config, footer_config,
      storefront_url, auth_verification_method, guest_checkout_enabled, checkout_mode,
      partial_payment_enabled, partial_payment_amount, created_at, updated_at
    ) VALUES (
      'ops006_site', 'default', 'Scalius Local Smoke', 'Local disposable smoke store',
      '{}', '{}', 'http://localhost:4322', 'email', 1, 'all', 0, 0, unixepoch(), unixepoch()
    )
    ON CONFLICT(singleton_key) DO UPDATE SET
      site_name = excluded.site_name,
      site_description = excluded.site_description,
      header_config = excluded.header_config,
      footer_config = excluded.footer_config,
      storefront_url = excluded.storefront_url,
      auth_verification_method = excluded.auth_verification_method,
      guest_checkout_enabled = excluded.guest_checkout_enabled,
      checkout_mode = excluded.checkout_mode,
      partial_payment_enabled = excluded.partial_payment_enabled,
      partial_payment_amount = excluded.partial_payment_amount,
      updated_at = unixepoch()`,
    upsertSetting("payment_methods", "enabled_methods", JSON.stringify(["cod"]), "json"),
    upsertSetting("payment_methods", "default_method", "cod", "string"),
    upsertSetting("customer_auth", "policy", JSON.stringify(customerAuthPolicy), "json"),
    upsertSetting("email", "email_provider", "cloudflare", "string"),
    upsertSetting("email", "email_sender", "noreply@local.scalius.test", "string"),
    upsertSetting("phone", "allowed_countries", JSON.stringify({ countries: ["BD"], mode: "include" }), "json"),
    `INSERT INTO shipping_methods (
      id, name, fee, description, is_active, sort_order, created_at, updated_at, deleted_at
    ) VALUES (
      ${sqlString(fixture.shippingMethodId)}, 'OPS006 Standard Delivery', ${fixture.shippingCharge},
      'Disposable local smoke shipping method', 1, 1, unixepoch(), unixepoch(), NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      fee = excluded.fee,
      description = excluded.description,
      is_active = 1,
      sort_order = excluded.sort_order,
      deleted_at = NULL,
      updated_at = unixepoch()`,
    upsertDeliveryLocation(fixture.cityId, "Dhaka", "city", null, 1),
    upsertDeliveryLocation(fixture.zoneId, "Mirpur", "zone", fixture.cityId, 1),
    upsertDeliveryLocation(fixture.areaId, "Section 10", "area", fixture.zoneId, 1),
    `INSERT INTO categories (
      id, name, slug, description, created_at, updated_at, deleted_at
    ) VALUES (
      ${sqlString(fixture.categoryId)}, 'OPS006 Smoke Category', 'ops006-smoke-category',
      'Disposable local smoke category', unixepoch(), unixepoch(), NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      slug = excluded.slug,
      description = excluded.description,
      deleted_at = NULL,
      updated_at = unixepoch()`,
    `INSERT INTO products (
      id, name, description, price, category_id, slug, meta_title, meta_description,
      created_at, updated_at, deleted_at, is_active, discount_percentage,
      discount_type, discount_amount, free_delivery
    ) VALUES (
      ${sqlString(fixture.productId)}, ${sqlString(fixture.productName)},
      'Disposable local smoke product. Safe to recreate.', ${fixture.price},
      ${sqlString(fixture.categoryId)}, 'ops006-smoke-product',
      'OPS006 Smoke Product', 'Disposable local smoke product',
      unixepoch(), unixepoch(), NULL, 1, 0, 'percentage', 0, 0
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      price = excluded.price,
      category_id = excluded.category_id,
      slug = excluded.slug,
      meta_title = excluded.meta_title,
      meta_description = excluded.meta_description,
      deleted_at = NULL,
      is_active = 1,
      discount_percentage = 0,
      discount_type = 'percentage',
      discount_amount = 0,
      free_delivery = 0,
      updated_at = unixepoch()`,
    `INSERT INTO product_variants (
      id, product_id, size, color, weight, sku, price, stock, reserved_stock,
      preorder_stock, is_default, track_inventory, version, stock_version,
      low_stock_threshold, allow_preorder, preorder_date, preorder_message,
      allow_backorder, backorder_limit, discount_percentage, discount_type,
      discount_amount, barcode, barcode_type, color_sort_order, size_sort_order,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${sqlString(fixture.variantId)}, ${sqlString(fixture.productId)}, NULL, NULL, NULL,
      ${sqlString(fixture.variantSku)}, ${fixture.price}, 0, 0, 0, 1, 0, 1, 1,
      NULL, 0, NULL, NULL, 0, 0, 0, 'percentage', 0, NULL, NULL, 0, 0,
      unixepoch(), unixepoch(), NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      product_id = excluded.product_id,
      size = NULL,
      color = NULL,
      weight = NULL,
      sku = excluded.sku,
      price = excluded.price,
      stock = 0,
      reserved_stock = 0,
      preorder_stock = 0,
      is_default = 1,
      track_inventory = 0,
      deleted_at = NULL,
      discount_percentage = 0,
      discount_type = 'percentage',
      discount_amount = 0,
      updated_at = unixepoch()`,
  ].map((statement) => compactSql(statement)).join("; ");
}

export function buildCheckoutPayload({ sequence = 1, checkoutRequestId } = {}) {
  const suffix = String(sequence).padStart(6, "0");
  const phone = `+88017${String(10000000 + sequence).slice(-8)}`;
  return {
    checkoutRequestId: checkoutRequestId || `ops006_${Date.now()}_${suffix}`,
    customerName: `OPS006 Buyer ${suffix}`,
    customerPhone: phone,
    customerEmail: `ops006+${suffix}@example.com`,
    shippingAddress: `House ${sequence}, Road 10, Mirpur DOHS, Dhaka`,
    city: fixture.cityId,
    zone: fixture.zoneId,
    area: fixture.areaId,
    cityName: null,
    zoneName: null,
    areaName: null,
    notes: "Disposable local post-sale smoke order.",
    items: [
      {
        cartKey: `ops006:${sequence}`,
        productId: fixture.productId,
        variantId: fixture.variantId,
        quantity: 1,
        price: fixture.price,
        productName: fixture.productName,
        variantLabel: null,
      },
    ],
    discountAmount: null,
    discountCode: null,
    shippingCharge: fixture.shippingCharge,
    shippingMethodId: fixture.shippingMethodId,
    paymentMethod: "cod",
    inventoryPool: "regular",
  };
}

export function buildCartValidationPayload(orderPayload) {
  return {
    items: orderPayload.items,
    inventoryPool: orderPayload.inventoryPool,
    city: orderPayload.city,
    zone: orderPayload.zone,
    area: orderPayload.area,
    shippingMethodId: orderPayload.shippingMethodId,
  };
}

export function buildReceiptLookupRequest(orderId, receiptToken) {
  return {
    path: `/api/v1/orders/receipt/${encodeURIComponent(orderId)}`,
    headers: { [receiptTokenHeader]: receiptToken },
  };
}

export async function runCommand(config) {
  if (config.command === "help") {
    printHelp();
    return null;
  }
  if (config.command === "seed") {
    return seedFixture(config);
  }
  if (!config.skipSeed) {
    seedFixture(config);
  }
  return withApi(config, async () => {
    if (config.command === "checkout-smoke") return runCheckoutSmoke(config);
    if (config.command === "load") return runLoadSmoke(config);
    if (config.command === "otp-smoke") return runOtpSmoke(config);
    if (config.command === "payment-readiness") return runPaymentReadinessSmoke(config);
    throw new Error(`Unknown command: ${config.command}`);
  });
}

function printHelp() {
  console.log(`
Local post-sale smoke helper

Commands:
  help             Show this help without touching local state
  seed             Seed the local D1 checkout fixture only
  checkout-smoke   Seed, create a COD order, replay it, verify receipt, submit support request
  load             Seed, create bounded concurrent COD orders, print latency/status summary
  otp-smoke        Seed, exercise customer OTP readiness once without provider hammering
  payment-readiness
                   Seed committed local online orders and verify unconfigured gateways fail closed

Options:
  --help, -h           Show this help without touching local state
  --api <url>          Local API origin (default: ${defaults.apiBaseUrl})
  --state <path>       Wrangler local state path; relative paths resolve from repo root
  --orders <n>         Number of disposable orders for load mode (default: ${defaults.orders})
  --concurrency <n>    Load-mode concurrency (default: ${defaults.concurrency})
  --payment cod        COD only for local mutation smokes
  --skip-seed          Do not refresh the local fixture before smoke requests
  --skip-support       Do not submit receipt support request in checkout-smoke
  --no-start           Require API to already be running
  --skip-migrations    Do not apply local D1 migrations before seeding/starting
  --json               Print JSON result for smoke commands

Safety:
  Mutating smokes are loopback-local only. Production smokes must stay read-only.
`);
}

function seedFixture(config) {
  ensureLocalMigrations(config);
  runD1Execute(config, buildFixtureSql());
  const row = readD1FirstRow(config, fixtureStatusSql());
  const result = {
    seeded: true,
    productId: fixture.productId,
    variantId: fixture.variantId,
    shippingMethodId: fixture.shippingMethodId,
    cityId: fixture.cityId,
    zoneId: fixture.zoneId,
    areaId: fixture.areaId,
    fixtureCounts: row,
  };
  printResult(config, result, "Local post-sale fixture seeded.");
  return result;
}

export function buildPaymentReadinessFixtureSql() {
  const orderIds = paymentReadinessGateways.map((item) => sqlString(item.orderId)).join(", ");
  const onlineMethods = ["stripe", "sslcommerz", "polar", "cod"];

  return [
    `DELETE FROM payment_session_attempts WHERE order_id IN (${orderIds})`,
    `DELETE FROM payment_plans WHERE order_id IN (${orderIds})`,
    `DELETE FROM order_payments WHERE order_id IN (${orderIds})`,
    `DELETE FROM order_items WHERE order_id IN (${orderIds})`,
    `DELETE FROM checkout_attempts WHERE order_id IN (${orderIds})`,
    `DELETE FROM orders WHERE id IN (${orderIds})`,
    `DELETE FROM settings WHERE category IN ('stripe', 'sslcommerz', 'polar')`,
    `UPDATE site_settings SET
      checkout_mode = 'all',
      partial_payment_enabled = 1,
      partial_payment_amount = ${fixture.partialPaymentAmount},
      updated_at = unixepoch()
      WHERE singleton_key = 'default'`,
    upsertSetting("payment_methods", "enabled_methods", JSON.stringify(onlineMethods), "json"),
    upsertSetting("payment_methods", "default_method", "cod", "string"),
    ...paymentReadinessGateways.flatMap((gateway, index) => {
      const totalAmount = fixture.price + fixture.shippingCharge;
      const requestKey = `ops006_payment_readiness:${gateway.gateway}`;
      const responsePayload = JSON.stringify({
        success: true,
        data: {
          id: gateway.orderId,
          orderId: gateway.orderId,
          checkoutToken: gateway.token,
          receiptToken: gateway.token,
        },
      });
      return [
        `INSERT INTO orders (
          id, customer_name, customer_phone, customer_email, shipping_address,
          city, zone, area, city_name, zone_name, area_name,
          total_amount, shipping_charge, discount_amount, status, notes,
          payment_method, payment_status, paid_amount, balance_due,
          fulfillment_status, inventory_pool, inventory_action, version,
          created_at, updated_at, deleted_at
        ) VALUES (
          ${sqlString(gateway.orderId)}, ${sqlString(`OPS006 ${gateway.gateway} Buyer`)},
          ${sqlString(`+88017${String(20000000 + index).slice(-8)}`)},
          ${sqlString(`ops006-${gateway.gateway}@example.com`)},
          'House 1, Road 10, Mirpur DOHS, Dhaka',
          ${sqlString(fixture.cityId)}, ${sqlString(fixture.zoneId)}, ${sqlString(fixture.areaId)},
          'Dhaka', 'Mirpur', 'Section 10',
          ${totalAmount}, ${fixture.shippingCharge}, 0, 'pending',
          'Disposable local payment readiness smoke order.',
          ${sqlString(gateway.gateway)}, 'unpaid', 0, ${totalAmount},
          'pending', 'regular', 'none', 1, unixepoch(), unixepoch(), NULL
        )`,
        `INSERT INTO order_items (
          id, order_id, product_id, variant_id, quantity, price,
          product_name, variant_label, inventory_tracked, fulfillment_status, created_at
        ) VALUES (
          ${sqlString(`ops006_item_${gateway.gateway}`)}, ${sqlString(gateway.orderId)},
          ${sqlString(fixture.productId)}, ${sqlString(fixture.variantId)},
          1, ${fixture.price}, ${sqlString(fixture.productName)}, NULL, 0, 'pending', unixepoch()
        )`,
        `INSERT INTO checkout_attempts (
          id, request_key, request_hash, checkout_token, order_id, status,
          payment_method, total_amount, response_payload, attempts,
          claim_id, claim_expires_at, last_error, created_at, updated_at
        ) VALUES (
          ${sqlString(`ops006_attempt_${gateway.gateway}`)}, ${sqlString(requestKey)},
          ${sqlString(`${requestKey}:hash`)}, ${sqlString(gateway.token)},
          ${sqlString(gateway.orderId)}, 'committed', ${sqlString(gateway.gateway)},
          ${totalAmount}, ${sqlString(responsePayload)}, 1,
          NULL, NULL, NULL, unixepoch(), unixepoch()
        )`,
      ];
    }),
  ].map((statement) => compactSql(statement)).join("; ");
}

async function runCheckoutSmoke(config) {
  const payload = buildCheckoutPayload({ sequence: 1 });
  const cart = await requestJson(config, "POST", "/api/v1/orders/cart-validation", buildCartValidationPayload(payload));
  const cartData = unwrapData(cart.body);
  assertCondition(cartData?.valid === true, "Cart validation did not return valid=true.");

  const order = await requestJson(config, "POST", "/api/v1/orders", payload, [201]);
  const orderData = unwrapData(order.body);
  assertCondition(orderData?.orderId, "Order create did not return orderId.");
  assertCondition(orderData?.receiptToken, "Order create did not return receiptToken.");

  const replay = await requestJson(config, "POST", "/api/v1/orders", payload, [201]);
  const replayData = unwrapData(replay.body);
  assertCondition(replayData?.orderId === orderData.orderId, "Committed checkout replay returned a different orderId.");

  const receiptRequest = buildReceiptLookupRequest(orderData.orderId, orderData.receiptToken);
  const receipt = await requestJson(config, "GET", receiptRequest.path, undefined, [200], receiptRequest.headers);
  const receiptOrder = unwrapData(receipt.body)?.order;
  assertCondition(receiptOrder?.id === orderData.orderId, "Receipt token lookup did not return the created order.");
  assertCondition(Array.isArray(receiptOrder?.items) && receiptOrder.items.length === 1, "Receipt did not include the order item.");

  let supportRequest = null;
  if (!config.skipSupport) {
    const support = await requestJson(
      config,
      "POST",
      `/api/v1/orders/receipt/${encodeURIComponent(orderData.orderId)}/support-requests`,
      {
        token: orderData.receiptToken,
        type: "cancel_pre_shipment",
        reason: "Local smoke support request",
        message: "Disposable local support request created by OPS-006 smoke.",
      },
      [201],
    );
    supportRequest = unwrapData(support.body)?.request ?? unwrapData(support.body);
    assertCondition(supportRequest?.id, "Support request smoke did not return a request id.");
  }

  const result = {
    cartValid: true,
    orderId: orderData.orderId,
    receiptProof: "received",
    replayedOrderId: replayData.orderId,
    receiptItems: receiptOrder.items.length,
    supportRequestId: supportRequest?.id ?? null,
  };
  printResult(config, result, "Checkout, receipt, replay, and support smoke passed.");
  return result;
}

async function runLoadSmoke(config) {
  const total = config.orders;
  const concurrency = Math.min(config.concurrency, total);
  const statusCounts = new Map();
  const durations = [];
  const failures = [];
  let next = 1;

  async function worker() {
    while (next <= total) {
      const sequence = next++;
      const startedAt = performance.now();
      try {
        const payload = buildCheckoutPayload({ sequence });
        const response = await requestJson(config, "POST", "/api/v1/orders", payload, [201, 202, 409, 429, 500, 503]);
        const elapsed = performance.now() - startedAt;
        durations.push(elapsed);
        increment(statusCounts, response.status);
        if (response.status !== 201) {
          failures.push({ sequence, status: response.status, message: response.errorMessage });
        }
      } catch (error) {
        const elapsed = performance.now() - startedAt;
        durations.push(elapsed);
        increment(statusCounts, "error");
        failures.push({ sequence, status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const summary = summarizeDurations(durations);
  const result = {
    requested: total,
    concurrency,
    statusCounts: Object.fromEntries(statusCounts),
    latencyMs: summary,
    failureCount: failures.length,
    failures: failures.slice(0, 10),
  };

  if (failures.length > 0) {
    printResult(config, result, "Load smoke completed with failures.");
    throw new Error(`Load smoke had ${failures.length} non-201/error responses.`);
  }

  printResult(config, result, "Load smoke passed.");
  return result;
}

async function runOtpSmoke(config) {
  const payload = {
    method: "email",
    channel: "email",
    intent: "sign_up",
    identifier: "ops006-otp@example.com",
    name: "OPS006 OTP Buyer",
    phone: "+8801712345678",
    email: "ops006-otp@example.com",
  };

  const response = await requestJson(
    config,
    "POST",
    "/api/v1/customer-auth/send-otp",
    payload,
    [200, 503],
  );

  const challengeRow = readD1FirstRow(config, `
    SELECT COUNT(*) AS pending_challenges
    FROM customer_auth_otp_challenges
    WHERE status = 'pending'
      AND created_at >= unixepoch() - 300
  `);

  const result = {
    status: response.status,
    ready: response.status === 200,
    expectedLocalProviderBlock: response.status === 503,
    message: response.errorMessage || unwrapData(response.body)?.message || null,
    pendingChallengesLastFiveMinutes: Number(challengeRow?.pending_challenges ?? 0),
  };

  if (![200, 503].includes(response.status)) {
    throw new Error(`Unexpected OTP smoke status ${response.status}.`);
  }

  printResult(
    config,
    result,
    response.status === 200
      ? "OTP send smoke passed with a configured local provider."
      : "OTP readiness smoke passed: local provider is unavailable and failed closed once.",
  );
  return result;
}

async function runPaymentReadinessSmoke(config) {
  runD1Execute(config, buildPaymentReadinessFixtureSql());
  const results = [];

  for (const gateway of paymentReadinessGateways) {
    const response = await requestJson(
      config,
      "POST",
      gateway.path,
      {
        orderId: gateway.orderId,
        receiptToken: gateway.token,
        paymentType: "deposit",
        depositAmount: fixture.partialPaymentAmount,
      },
      [503],
    );
    results.push({
      gateway: gateway.gateway,
      status: response.status,
      message: response.errorMessage,
    });
  }

  const sideEffects = readD1FirstRow(config, `
    SELECT
      (SELECT COUNT(*) FROM payment_plans WHERE order_id IN (${paymentReadinessGateways.map((item) => sqlString(item.orderId)).join(", ")})) AS payment_plans,
      (SELECT COUNT(*) FROM payment_session_attempts WHERE order_id IN (${paymentReadinessGateways.map((item) => sqlString(item.orderId)).join(", ")})) AS payment_session_attempts
  `);
  const paymentPlanCount = Number(sideEffects?.payment_plans ?? 0);
  const attemptCount = Number(sideEffects?.payment_session_attempts ?? 0);
  assertCondition(paymentPlanCount === 0, `Expected zero payment plans, found ${paymentPlanCount}.`);
  assertCondition(attemptCount === 0, `Expected zero payment session attempts, found ${attemptCount}.`);

  const result = {
    gateways: results,
    sideEffects: {
      paymentPlans: paymentPlanCount,
      paymentSessionAttempts: attemptCount,
    },
  };
  printResult(config, result, "Payment gateway readiness smoke passed: unconfigured local gateways failed closed without payment side effects.");
  return result;
}

async function withApi(config, work) {
  const alreadyRunning = await isApiReady(config);
  let child = null;

  if (!alreadyRunning) {
    if (config.noStart) {
      throw new Error(`API is not running at ${config.apiBaseUrl}. Start it with pnpm --filter @scalius/api dev.`);
    }
    if (config.apiBaseUrl !== defaults.apiBaseUrl) {
      throw new Error(
        `Custom --api ${config.apiBaseUrl} requires --no-start with an already running API worker. ` +
        `The bundled API dev script starts on ${defaults.apiBaseUrl}.`,
      );
    }

    ensureLocalMigrations(config);
    console.log(`Starting temporary API worker at ${config.apiBaseUrl}...`);
    child = spawn(pnpmExecutable, ["--filter", "@scalius/api", "dev"], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        SCALIUS_WRANGLER_STATE: config.wranglerState,
      },
    });

    let childStatus = null;
    child.once("exit", (code, signal) => {
      childStatus = { code, signal };
    });
    const stop = () => {
      if (child && !child.killed) child.kill("SIGTERM");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      await waitForApi(config, () => childStatus);
    } catch (error) {
      stop();
      throw error;
    }
  }

  try {
    return await work();
  } finally {
    if (child && !child.killed) {
      console.log("Stopping temporary API worker...");
      child.kill("SIGTERM");
    }
  }
}

async function isApiReady(config) {
  try {
    const response = await fetch(`${config.apiBaseUrl}/api/v1/health`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForApi(config, getChildStatus = () => null) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isApiReady(config)) return;
    const childStatus = getChildStatus();
    if (childStatus) {
      const reason = childStatus.signal ? `signal ${childStatus.signal}` : `exit code ${childStatus.code}`;
      throw new Error(`Temporary API worker exited before it was ready (${reason}).`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for API at ${config.apiBaseUrl}.`);
}

function ensureLocalMigrations(config) {
  if (config.skipMigrations || migrationsApplied) return;
  console.log("Ensuring local D1 migrations are applied...");
  execFileSync("node", ["scripts/deploy.mjs", "--migrate-only", "--local"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      SCALIUS_WRANGLER_STATE: config.wranglerState,
    },
  });
  migrationsApplied = true;
}

function runD1Execute(config, sql, { json = false } = {}) {
  const args = [
    "exec",
    "wrangler",
    "d1",
    "execute",
    readLocalD1DatabaseName(),
    "--local",
    "--persist-to",
    config.wranglerState,
    "--command",
    compactSql(sql),
  ];
  if (json) args.push("--json");

  const output = execFileSync(pnpmExecutable, args, {
    cwd: apiDir,
    stdio: json ? ["ignore", "pipe", "inherit"] : ["ignore", "ignore", "inherit"],
    encoding: json ? "utf8" : undefined,
  });
  return json ? output : "";
}

function readD1FirstRow(config, sql) {
  const output = runD1Execute(config, sql, { json: true });
  const parsed = JSON.parse(output);
  const result = Array.isArray(parsed) ? parsed[0] : parsed?.result?.[0];
  const rows = result?.results || result?.rows || result?.result || [];
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

function readLocalD1DatabaseName() {
  const raw = readFileSync(resolve(apiDir, "wrangler.jsonc"), "utf8");
  const stripped = raw.replace(/(?<!https?:)\/\/[^\n]*/g, "");
  const configJson = JSON.parse(stripped);
  const dbName = configJson.d1_databases?.[0]?.database_name;
  if (!dbName) {
    throw new Error("Could not find d1_databases[0].database_name in apps/api/wrangler.jsonc.");
  }
  return dbName;
}

async function requestJson(config, method, path, body, expectedStatuses = [200], headers = {}) {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers: body
      ? { "content-type": "application/json", accept: "application/json", ...headers }
      : { accept: "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  const errorMessage = parsed?.error?.message || parsed?.message || text || response.statusText;
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${method} ${path} failed (${response.status}): ${errorMessage}`);
  }
  return {
    status: response.status,
    body: parsed,
    errorMessage: response.ok ? null : errorMessage,
  };
}

function unwrapData(body) {
  return body?.data ?? body;
}

function upsertSetting(category, key, value, type) {
  const id = `ops006_${category}_${key}`.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return `INSERT INTO settings (id, key, value, type, category, updated_at)
    VALUES (${sqlString(id)}, ${sqlString(key)}, ${sqlString(value)}, ${sqlString(type)}, ${sqlString(category)}, unixepoch())
    ON CONFLICT(key, category) DO UPDATE SET
      value = excluded.value,
      type = excluded.type,
      updated_at = unixepoch()`;
}

function upsertDeliveryLocation(id, name, type, parentId, sortOrder) {
  return `INSERT INTO delivery_locations (
      id, name, type, parent_id, external_ids, metadata, is_active, sort_order,
      created_at, updated_at, deleted_at
    ) VALUES (
      ${sqlString(id)}, ${sqlString(name)}, ${sqlString(type)}, ${parentId ? sqlString(parentId) : "NULL"},
      '{}', '{}', 1, ${sortOrder}, unixepoch(), unixepoch(), NULL
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      parent_id = excluded.parent_id,
      external_ids = excluded.external_ids,
      metadata = excluded.metadata,
      is_active = 1,
      sort_order = excluded.sort_order,
      deleted_at = NULL,
      updated_at = unixepoch()`;
}

function fixtureStatusSql() {
  return `
    SELECT
      (SELECT COUNT(*) FROM products WHERE id = ${sqlString(fixture.productId)} AND is_active = 1 AND deleted_at IS NULL) AS products,
      (SELECT COUNT(*) FROM product_variants WHERE id = ${sqlString(fixture.variantId)} AND product_id = ${sqlString(fixture.productId)} AND is_default = 1 AND track_inventory = 0 AND deleted_at IS NULL) AS variants,
      (SELECT COUNT(*) FROM shipping_methods WHERE id = ${sqlString(fixture.shippingMethodId)} AND is_active = 1 AND deleted_at IS NULL) AS shipping_methods,
      (SELECT COUNT(*) FROM delivery_locations WHERE id IN (${sqlString(fixture.cityId)}, ${sqlString(fixture.zoneId)}, ${sqlString(fixture.areaId)}) AND is_active = 1 AND deleted_at IS NULL) AS delivery_locations
  `;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function compactSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function parsePositiveInteger(value, fallback, flagName) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function summarizeDurations(values) {
  if (values.length === 0) return { min: 0, p50: 0, p95: 0, max: 0, avg: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min: roundMs(sorted[0]),
    p50: roundMs(percentile(sorted, 0.5)),
    p95: roundMs(percentile(sorted, 0.95)),
    max: roundMs(sorted[sorted.length - 1]),
    avg: roundMs(avg),
  };
}

function percentile(sortedValues, ratio) {
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index] ?? 0;
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function increment(map, key) {
  map.set(String(key), (map.get(String(key)) ?? 0) + 1);
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function printResult(config, result, message) {
  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(message);
  console.log(JSON.stringify(result, null, 2));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main() {
  let config;
  try {
    config = getPostsaleConfig();
    await runCommand(config);
  } catch (error) {
    console.error("\nLocal post-sale smoke failed.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
