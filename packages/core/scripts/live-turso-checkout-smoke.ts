import {
  getDatabaseProviderForClient,
  getDb,
} from "@scalius/database/client";
import {
  checkoutAttempts,
  codTracking,
  customers,
  inventoryMovements,
  orderItems,
  orderItemTaxSnapshots,
  orderReceipts,
  orders,
  orderTaxSnapshots,
  products,
  productVariants,
} from "@scalius/database/schema";
import {
  claimCheckoutAttempt,
  commitStorefrontOrderPayload,
  type ClaimedCheckoutAttempt,
  type StorefrontOrderCommitPayload,
} from "@scalius/core/modules/orders";
import {
  createNavigationMenu,
  createNavigationMenuItem,
  deleteNavigationMenuItem,
  listNavigationMenuItems,
} from "@scalius/core/modules/navigation";
import { ftsMatch } from "@scalius/core/search";
import { and, eq, sql } from "drizzle-orm";

const CHECKOUT_CONCURRENCY = 12;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertDisposableTarget(databaseUrl: string, expectedName: string): void {
  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  const normalizedName = expectedName.trim().toLowerCase();
  if (
    !normalizedName.startsWith("scalius-") ||
    !normalizedName.includes("test") ||
    !hostname.startsWith(`${normalizedName}-`)
  ) {
    throw new Error(
      "Refusing live checkout smoke: expected a disposable scalius-*test* Turso database hostname.",
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function randomDigits(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => String(byte % 10)).join("");
}

function createPayload(
  attempt: ClaimedCheckoutAttempt,
  productId: string,
  variantId: string,
  phone: string,
  quantity = 2,
): StorefrontOrderCommitPayload {
  const unitPriceMinor = 125_000;
  const totalAmountMinor = unitPriceMinor * quantity;
  const totalAmount = totalAmountMinor / 100;
  const lineId = `line_${variantId}`;

  return {
    checkoutToken: attempt.checkoutToken,
    existingCustomer: null,
    orderData: {
      id: attempt.orderId,
      customerName: "Disposable Turso Smoke",
      customerPhone: phone,
      customerEmail: null,
      shippingAddress: "Disposable test address",
      city: "dhaka",
      zone: "test-zone",
      area: null,
      cityName: "Dhaka",
      zoneName: "Test Zone",
      areaName: null,
      notes: "Disposable database checkout smoke",
      totalAmount,
      shippingCharge: 0,
      discountAmount: 0,
      currencyCode: "BDT",
      currencyDecimalPlaces: 2,
      subtotalAmountMinor: totalAmountMinor,
      shippingAmountMinor: 0,
      discountAmountMinor: 0,
      taxAmountMinor: 0,
      totalAmountMinor,
      taxLabel: "Tax",
      pricesIncludeTax: false,
      status: "incomplete",
      paymentMethod: "cod",
      paymentStatus: "unpaid",
      paidAmount: 0,
      balanceDue: totalAmount,
      fulfillmentStatus: "pending",
      inventoryPool: "regular",
      inventoryAction: "reserved",
    },
    items: [{
      id: `item_${variantId}`,
      taxAllocationLineId: lineId,
      cartKey: variantId,
      productId,
      variantId,
      quantity,
      price: unitPriceMinor / 100,
      productName: "Disposable Turso Product",
      variantLabel: "Default",
      inventoryTracked: true,
      productImageMediaId: null,
      unitPriceMinor,
      lineSubtotalMinor: totalAmountMinor,
      discountAmountMinor: 0,
      taxableAmountMinor: totalAmountMinor,
      taxAmountMinor: 0,
    }],
    discountUsage: null,
    promotion: null,
    requestUrl: "https://checkout-smoke.invalid/checkout",
    taxQuote: {
      schemaVersion: 1,
      calculationVersion: "tax-v1",
      enabled: false,
      currencyCode: "BDT",
      decimalPlaces: 2,
      displayLabel: "Tax",
      pricesIncludeTax: false,
      shippingTaxed: false,
      settingsVersion: 1,
      subtotalMinor: totalAmountMinor,
      shippingMinor: 0,
      discountMinor: 0,
      taxableMinor: totalAmountMinor,
      taxMinor: 0,
      totalMinor: totalAmountMinor,
      destination: {
        city: "dhaka",
        zone: "test-zone",
        area: null,
        cityName: "Dhaka",
        zoneName: "Test Zone",
        areaName: null,
      },
      lines: [{
        lineId,
        productId,
        variantId,
        taxClassId: null,
        taxClassName: null,
        unitPriceMinor,
        quantity,
        grossAmountMinor: totalAmountMinor,
        discountMinor: 0,
        taxableAmountMinor: totalAmountMinor,
        taxMinor: 0,
        totalMinor: totalAmountMinor,
        components: [],
      }],
      shipping: {
        taxClassId: null,
        taxClassName: null,
        grossAmountMinor: 0,
        discountMinor: 0,
        taxableAmountMinor: 0,
        taxMinor: 0,
        totalMinor: 0,
        components: [],
      },
    },
  };
}

async function main(): Promise<void> {
  const databaseUrl = requiredEnvironment("TURSO_DATABASE_URL");
  const authToken = requiredEnvironment("TURSO_AUTH_TOKEN");
  const expectedDatabaseName = requiredEnvironment("SCALIUS_TEST_DATABASE_NAME");
  assertDisposableTarget(databaseUrl, expectedDatabaseName);

  const db = getDb({
    DATABASE_PROVIDER: "turso",
    TURSO_DATABASE_URL: databaseUrl,
    TURSO_AUTH_TOKEN: authToken,
  });
  assert(getDatabaseProviderForClient(db) === "turso", "Expected the Turso adapter.");

  const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const cases = Array.from({ length: CHECKOUT_CONCURRENCY }, (_, index) => {
    const suffix = `${runId}_${index}`;
    return {
      productId: `live_product_${suffix}`,
      variantId: `live_variant_${suffix}`,
      sku: `LIVE-${runId}-${index}`,
      slug: `live-product-${runId}-${index}`,
      phone: `+8801${randomDigits(10)}`,
    };
  });

  await db.insert(products).values(cases.map((testCase) => ({
    id: testCase.productId,
    name: "Disposable Turso Product",
    description: "Created only in a disposable live-test database.",
    price: 1_250,
    slug: testCase.slug,
    isActive: true,
  })));
  await db.insert(productVariants).values(cases.map((testCase) => ({
    id: testCase.variantId,
    productId: testCase.productId,
    optionCombinationKey: null,
    sku: testCase.sku,
    price: 1_250,
    stock: 10,
    reservedStock: 0,
    preorderStock: 0,
    isDefault: true,
    trackInventory: true,
    stockVersion: 1,
  })));

  const claims = await Promise.all(cases.map(async (testCase, index) => {
    const seed = `${runId}:${index}:${testCase.variantId}`;
    const requestHash = await sha256Hex(`payload:${seed}`);
    const requestKeyHash = await sha256Hex(`key:${seed}`);
    const claim = await claimCheckoutAttempt(db, {
      requestKey: `checkout_submit:v1:${requestKeyHash}`,
      requestHash,
      checkoutRequestId: `live_${seed}`,
      statusToken: `cst_${requestKeyHash}`,
    });
    assert(claim.status === "claimed", "A unique live checkout attempt was not claimed.");
    return claim.attempt;
  }));

  const payloads = claims.map((attempt, index) => createPayload(
    attempt,
    cases[index]!.productId,
    cases[index]!.variantId,
    cases[index]!.phone,
  ));
  const startedAt = performance.now();
  const results = await Promise.all(payloads.map((payload, index) =>
    commitStorefrontOrderPayload(db, payload, {
      attempt: claims[index]!,
      response: {
        success: true,
        orderId: claims[index]!.orderId,
        statusToken: claims[index]!.statusToken,
      },
    }),
  ));
  const elapsedMs = Math.round(performance.now() - startedAt);

  assert(results.every((result) => !result.alreadyCommitted), "A first commit replayed unexpectedly.");
  const orderIds = new Set(claims.map((attempt) => attempt.orderId));

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index]!;
    const attempt = claims[index]!;
    const [variant, movement, checkout, order, item, lineTax, orderTax, receipt, cod, customer] =
      await Promise.all([
        db.select().from(productVariants).where(eq(productVariants.id, testCase.variantId)).get(),
        db.select().from(inventoryMovements).where(and(
          eq(inventoryMovements.orderId, attempt.orderId),
          eq(inventoryMovements.variantId, testCase.variantId),
        )).get(),
        db.select().from(checkoutAttempts).where(eq(checkoutAttempts.id, attempt.id)).get(),
        db.select().from(orders).where(eq(orders.id, attempt.orderId)).get(),
        db.select().from(orderItems).where(eq(orderItems.orderId, attempt.orderId)).get(),
        db.select().from(orderItemTaxSnapshots).where(eq(orderItemTaxSnapshots.orderId, attempt.orderId)).get(),
        db.select().from(orderTaxSnapshots).where(eq(orderTaxSnapshots.orderId, attempt.orderId)).get(),
        db.select().from(orderReceipts).where(eq(orderReceipts.orderId, attempt.orderId)).get(),
        db.select().from(codTracking).where(eq(codTracking.orderId, attempt.orderId)).get(),
        db.select().from(customers).where(eq(customers.phone, testCase.phone)).get(),
      ]);

    assert(order?.id === attempt.orderId, "Order was not committed.");
    assert(item?.variantId === testCase.variantId, "Order item was not committed.");
    assert(lineTax?.orderItemId === item.id, "Order-item tax snapshot was not committed.");
    assert(orderTax?.orderId === attempt.orderId, "Order tax snapshot was not committed.");
    assert(cod?.orderId === attempt.orderId, "COD lifecycle row was not committed.");
    assert(customer?.totalOrders === 1, "Customer aggregate was not committed.");
    assert(variant?.reservedStock === 2 && variant.stockVersion === 2, "Inventory counters are incorrect.");
    assert(
      movement?.ledgerVersion === 2 &&
      movement.reservedStockDelta === 2 &&
      movement.stockVersionBefore === 1 &&
      movement.stockVersionAfter === 2,
      "Inventory ledger-v2 edge is incomplete.",
    );
    assert(checkout?.status === "committed" && checkout.claimId === null, "Checkout claim was not committed.");
    assert(receipt?.orderId === attempt.orderId, "Durable receipt was not committed.");
  }

  const beforeReplay = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(inventoryMovements)
    .where(sql`${inventoryMovements.orderId} IN (${sql.join([...orderIds].map((id) => sql`${id}`), sql`, `)})`)
    .get();
  const replayResults = await Promise.all(payloads.map((payload, index) =>
    commitStorefrontOrderPayload(db, payload, {
      attempt: claims[index]!,
      response: { success: true, orderId: claims[index]!.orderId },
    }),
  ));
  const afterReplay = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(inventoryMovements)
    .where(sql`${inventoryMovements.orderId} IN (${sql.join([...orderIds].map((id) => sql`${id}`), sql`, `)})`)
    .get();
  assert(replayResults.every((result) => result.alreadyCommitted), "Committed checkout did not replay.");
  assert(beforeReplay?.count === cases.length, "Unexpected reservation movement count before replay.");
  assert(afterReplay?.count === beforeReplay.count, "Replay reserved stock more than once.");

  const failureCase = cases[0]!;
  const failureKeyHash = await sha256Hex(`failure-key:${runId}`);
  const failedClaimResult = await claimCheckoutAttempt(db, {
    requestKey: `checkout_submit:v1:${failureKeyHash}`,
    requestHash: await sha256Hex(`failure-payload:${runId}`),
    checkoutRequestId: `failure_${runId}`,
    statusToken: `cst_${failureKeyHash}`,
  });
  assert(failedClaimResult.status === "claimed", "Failure-case attempt was not claimed.");
  const failedPayload = createPayload(
    failedClaimResult.attempt,
    failureCase.productId,
    failureCase.variantId,
    `+8801${randomDigits(10)}`,
    100,
  );
  let failedAsExpected = false;
  try {
    await commitStorefrontOrderPayload(db, failedPayload, {
      attempt: failedClaimResult.attempt,
      response: { success: true, orderId: failedClaimResult.attempt.orderId },
    });
  } catch {
    failedAsExpected = true;
  }
  assert(failedAsExpected, "Insufficient-stock checkout unexpectedly committed.");
  const [failedOrder, failedReceipt, failedAttempt, unchangedVariant] = await Promise.all([
    db.select().from(orders).where(eq(orders.id, failedClaimResult.attempt.orderId)).get(),
    db.select().from(orderReceipts).where(eq(orderReceipts.orderId, failedClaimResult.attempt.orderId)).get(),
    db.select().from(checkoutAttempts).where(eq(checkoutAttempts.id, failedClaimResult.attempt.id)).get(),
    db.select().from(productVariants).where(eq(productVariants.id, failureCase.variantId)).get(),
  ]);
  assert(!failedOrder && !failedReceipt, "Failed checkout leaked order or receipt state.");
  assert(failedAttempt?.status === "processing", "Failed checkout mutated its claim inside a rolled-back batch.");
  assert(unchangedVariant?.reservedStock === 2, "Failed checkout leaked an inventory reservation.");

  const searchCondition = ftsMatch(
    db,
    "products_fts",
    "products",
    "disposable turso",
  );
  assert(searchCondition, "Turso fallback search did not produce a condition.");
  const searchRows = await db
    .select({ id: products.id })
    .from(products)
    .where(searchCondition)
    .limit(CHECKOUT_CONCURRENCY)
    .all();
  assert(
    searchRows.length === CHECKOUT_CONCURRENCY,
    "Turso ordinary-SQL fallback search did not match every live product.",
  );

  const menu = await createNavigationMenu(db, {
    name: `Live delete tree ${runId}`,
  });
  const root = await createNavigationMenuItem(db, menu.id, {
    expectedRevision: menu.revision,
    label: "Root",
    labelMode: "custom",
    target: { type: "label" },
  });
  const rootId = (root.item as { id: string }).id;
  const child = await createNavigationMenuItem(db, menu.id, {
    expectedRevision: root.revision,
    parentId: rootId,
    label: "Child",
    labelMode: "custom",
    target: { type: "label" },
  });
  const childId = (child.item as { id: string }).id;
  const grandchild = await createNavigationMenuItem(db, menu.id, {
    expectedRevision: child.revision,
    parentId: childId,
    label: "Grandchild",
    labelMode: "custom",
    target: { type: "internal_path", path: "/search" },
  });
  const deleted = await deleteNavigationMenuItem(
    db,
    menu.id,
    rootId,
    grandchild.revision,
  );
  const remainingRoots = await listNavigationMenuItems(db, menu.id, {
    parentId: null,
  });
  assert(
    deleted.deletedCount === 3 && remainingRoots.items.length === 0,
    "Turso non-recursive navigation subtree deletion failed.",
  );

  process.stdout.write(`${JSON.stringify({
    provider: "turso",
    concurrentCheckouts: cases.length,
    committedOrders: results.length,
    elapsedMs,
    idempotentReplays: replayResults.length,
    rollbackVerified: true,
    fallbackSearchMatches: searchRows.length,
    navigationSubtreeDeleteVerified: true,
  })}\n`);
}

await main();
