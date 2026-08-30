/**
 * Provider-neutral SQLite checkout commit kernel.
 *
 * Domain code prepares immutable order facts; one per-merchant coordinator
 * assigns exact reservation-lane counters. This module validates that compact
 * boundary and emits five bound statements for one atomic database commit.
 * It intentionally has no Cloudflare, HTTP, or domain-service dependencies.
 */

export const CHECKOUT_AGGREGATE_VERSION = 1 as const;
export const CHECKOUT_RESERVATION_LANE_COUNT = 2 as const;
export const CHECKOUT_COMMIT_MAX_ORDERS = 280;
export const CHECKOUT_COMMIT_MAX_JSON_BYTES = 1_500_000;
export const CHECKOUT_COMMIT_HARD_MAX_ORDERS = 1_000;
export const CHECKOUT_COMMIT_HARD_MAX_JSON_BYTES = 8_000_000;

export interface CheckoutCommitLimits {
  maxOrders: number;
  maxJsonBytes: number;
}

const DEFAULT_CHECKOUT_COMMIT_LIMITS: CheckoutCommitLimits = {
  maxOrders: CHECKOUT_COMMIT_MAX_ORDERS,
  maxJsonBytes: CHECKOUT_COMMIT_MAX_JSON_BYTES,
};

function normalizeCheckoutCommitLimits(
  limits: CheckoutCommitLimits = DEFAULT_CHECKOUT_COMMIT_LIMITS,
): CheckoutCommitLimits {
  if (
    !Number.isSafeInteger(limits.maxOrders)
    || limits.maxOrders < 1
    || limits.maxOrders > CHECKOUT_COMMIT_HARD_MAX_ORDERS
    || !Number.isSafeInteger(limits.maxJsonBytes)
    || limits.maxJsonBytes < 1
    || limits.maxJsonBytes > CHECKOUT_COMMIT_HARD_MAX_JSON_BYTES
  ) {
    throw new Error("Checkout commit limits are invalid or exceed the hard safety ceiling.");
  }
  return limits;
}

export type CheckoutReservationPool = "regular" | "preorder" | "backorder";

export interface PortableSqlStatement {
  sql: string;
  args: readonly unknown[];
  purpose?:
    | "checkout-commit-validate"
    | "checkout-commit-orders"
    | "checkout-commit-lanes"
    | "checkout-commit-postcondition"
    | "checkout-commit-outbox";
}

export interface CheckoutCommittedOrderRow {
  id: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  city: string;
  zone: string;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  totalAmount: number;
  shippingCharge: number;
  discountAmount: number;
  currencyCode: string;
  currencyDecimalPlaces: number;
  subtotalAmountMinor: number;
  shippingAmountMinor: number;
  shippingMethodId: string;
  shippingMethodName: string;
  shippingMethodDescription: string | null;
  shippingMethodBaseAmountMinor: number;
  shippingFeeWaived: boolean;
  discountAmountMinor: number;
  taxAmountMinor: number;
  totalAmountMinor: number;
  taxLabel: string;
  pricesIncludeTax: boolean;
  status: string;
  notes: string | null;
  paymentMethod: string;
  paymentStatus: string;
  paidAmount: number;
  balanceDue: number;
  fulfillmentStatus: string;
  inventoryPool: string;
  inventoryAction: string;
  customerId: string | null;
  accountOwnerCustomerId: string | null;
}

export interface CheckoutReservationEdge {
  variantId: string;
  pool: CheckoutReservationPool;
  lane: number;
  quantity: number;
  capacity: number | null;
  reservedBefore: number;
  reservedAfter: number;
  laneVersionBefore: number;
  laneVersionAfter: number;
  sourceStockVersion: number;
}

export interface CheckoutAggregateEnvelope<TPayload = unknown, TResponse = unknown> {
  schemaVersion: typeof CHECKOUT_AGGREGATE_VERSION;
  checkout: {
    requestKey: string;
    requestHash: string;
    receiptHash: string;
    authorityRevision: number;
    response: TResponse;
  };
  payload: TPayload;
  projection?: {
    checkoutAttemptId: string;
    guestCustomerId: string | null;
    customerHistoryId: string | null;
    codTrackingId: string;
    notificationOutboxId: string | null;
    metaPurchaseOutboxId: string | null;
  };
}

export interface CheckoutReservationRequest {
  variantId: string;
  pool: CheckoutReservationPool;
  quantity: number;
}

/** Immutable domain command before the coordinator assigns one exact lane. */
export interface CheckoutCommitCommand<TPayload = unknown, TResponse = unknown> {
  requestKey: string;
  requestHash: string;
  receiptHash: string;
  authorityRevision: number;
  order: CheckoutCommittedOrderRow;
  aggregate: CheckoutAggregateEnvelope<TPayload, TResponse>;
  response: TResponse;
  reservations: CheckoutReservationRequest[];
}

export interface PreparedCheckoutCommit<TPayload = unknown, TResponse = unknown> {
  requestKey: string;
  requestHash: string;
  receiptHash: string;
  authorityRevision: number;
  lane: number;
  order: CheckoutCommittedOrderRow;
  aggregate: CheckoutAggregateEnvelope<TPayload, TResponse>;
  response: TResponse;
  edges: CheckoutReservationEdge[];
}

export interface CheckoutReservationLaneSnapshotRow {
  variantId: string;
  stock: number;
  legacyReservedStock: number;
  trackInventory: number | boolean;
  lowStockThreshold: number | null;
  stockVersion: number;
  lane: number | null;
  capacity: number | null;
  reservedQuantity: number | null;
  laneVersion: number | null;
  sourceStockVersion: number | null;
}

export interface CheckoutReservationLaneRebalance {
  variantId: string;
  targetLane: number;
  sourceStockVersion: number;
  lanes: readonly [{
    capacity: number;
    reservedQuantity: number;
    laneVersion: number;
  }, {
    capacity: number;
    reservedQuantity: number;
    laneVersion: number;
  }];
}

export interface ExistingCheckoutIdentityRow {
  requestKey: string;
  requestHash: string;
  receiptHash: string;
  orderId: string;
  responsePayload: string;
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
}

function assertNonEmptyString(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string no longer than ${maxLength} characters.`);
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function assertJsonObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function keyForEdge(edge: Pick<CheckoutReservationEdge, "variantId" | "pool" | "lane">): string {
  return `${edge.variantId}\0${edge.pool}\0${edge.lane}`;
}

function validatePreparedCheckoutCommit(
  commit: PreparedCheckoutCommit,
  index: number,
): void {
  const prefix = `checkout commit ${index + 1}`;
  assertNonEmptyString(commit.requestKey, `${prefix} requestKey`, 320);
  assertNonEmptyString(commit.requestHash, `${prefix} requestHash`, 320);
  assertNonEmptyString(commit.receiptHash, `${prefix} receiptHash`, 320);
  assertSafeInteger(commit.authorityRevision, `${prefix} authorityRevision`, 1);
  assertSafeInteger(commit.lane, `${prefix} lane`);
  if (commit.lane >= CHECKOUT_RESERVATION_LANE_COUNT) {
    throw new Error(`${prefix} lane is outside the configured reservation-lane range.`);
  }

  const order = commit.order;
  assertNonEmptyString(order.id, `${prefix} order id`, 180);
  assertNonEmptyString(order.customerName, `${prefix} customer name`, 500);
  assertNonEmptyString(order.customerPhone, `${prefix} customer phone`, 180);
  assertNonEmptyString(order.shippingAddress, `${prefix} shipping address`, 4_000);
  assertNonEmptyString(order.city, `${prefix} city`, 180);
  assertNonEmptyString(order.zone, `${prefix} zone`, 180);
  assertFiniteNumber(order.totalAmount, `${prefix} total amount`);
  assertFiniteNumber(order.shippingCharge, `${prefix} shipping charge`);
  assertNonEmptyString(order.shippingMethodId, `${prefix} shipping method id`, 180);
  assertNonEmptyString(order.shippingMethodName, `${prefix} shipping method name`, 100);
  if (
    order.shippingMethodDescription !== null
    && (
      typeof order.shippingMethodDescription !== "string"
      || order.shippingMethodDescription.length > 255
    )
  ) {
    throw new Error(`${prefix} shipping method description must be null or no longer than 255 characters.`);
  }
  if (typeof order.shippingFeeWaived !== "boolean") {
    throw new Error(`${prefix} shipping fee waiver must be a boolean.`);
  }
  assertFiniteNumber(order.discountAmount, `${prefix} discount amount`);
  assertFiniteNumber(order.paidAmount, `${prefix} paid amount`);
  assertFiniteNumber(order.balanceDue, `${prefix} balance due`);
  for (const [label, value] of Object.entries({
    currencyDecimalPlaces: order.currencyDecimalPlaces,
    subtotalAmountMinor: order.subtotalAmountMinor,
    shippingAmountMinor: order.shippingAmountMinor,
    shippingMethodBaseAmountMinor: order.shippingMethodBaseAmountMinor,
    discountAmountMinor: order.discountAmountMinor,
    taxAmountMinor: order.taxAmountMinor,
    totalAmountMinor: order.totalAmountMinor,
  })) {
    assertSafeInteger(value, `${prefix} ${label}`);
  }

  assertJsonObject(commit.aggregate, `${prefix} aggregate`);
  assertJsonObject(commit.response, `${prefix} response`);
  if (commit.aggregate.schemaVersion !== CHECKOUT_AGGREGATE_VERSION) {
    throw new Error(`${prefix} aggregate version is unsupported.`);
  }
  if (
    commit.aggregate.checkout.requestKey !== commit.requestKey
    || commit.aggregate.checkout.requestHash !== commit.requestHash
    || commit.aggregate.checkout.receiptHash !== commit.receiptHash
    || commit.aggregate.checkout.authorityRevision !== commit.authorityRevision
  ) {
    throw new Error(`${prefix} aggregate checkout identity does not match its indexed identity.`);
  }
  const aggregatePayload = commit.aggregate.payload as {
    orderData?: {
      id?: unknown;
      totalAmountMinor?: unknown;
      shippingMethodId?: unknown;
      shippingMethodName?: unknown;
      shippingMethodDescription?: unknown;
      shippingMethodBaseAmountMinor?: unknown;
      shippingFeeWaived?: unknown;
    };
  } | null;
  if (
    !aggregatePayload
    || aggregatePayload.orderData?.id !== order.id
    || aggregatePayload.orderData.totalAmountMinor !== order.totalAmountMinor
    || aggregatePayload.orderData.shippingMethodId !== order.shippingMethodId
    || aggregatePayload.orderData.shippingMethodName !== order.shippingMethodName
    || aggregatePayload.orderData.shippingMethodDescription !== order.shippingMethodDescription
    || aggregatePayload.orderData.shippingMethodBaseAmountMinor !== order.shippingMethodBaseAmountMinor
    || aggregatePayload.orderData.shippingFeeWaived !== order.shippingFeeWaived
  ) {
    throw new Error(`${prefix} aggregate order facts do not match the indexed order row.`);
  }

  const edgeKeys = new Set<string>();
  for (const [edgeIndex, edge] of commit.edges.entries()) {
    const edgePrefix = `${prefix} edge ${edgeIndex + 1}`;
    assertNonEmptyString(edge.variantId, `${edgePrefix} variantId`, 180);
    if (edge.pool !== "regular") {
      throw new Error(`${edgePrefix} uses a pool not supported by checkout aggregate version 1.`);
    }
    if (edge.lane !== commit.lane) {
      throw new Error(`${edgePrefix} must use its commit's assigned lane.`);
    }
    assertSafeInteger(edge.quantity, `${edgePrefix} quantity`, 1);
    assertSafeInteger(edge.reservedBefore, `${edgePrefix} reservedBefore`);
    assertSafeInteger(edge.reservedAfter, `${edgePrefix} reservedAfter`);
    assertSafeInteger(edge.laneVersionBefore, `${edgePrefix} laneVersionBefore`);
    assertSafeInteger(edge.laneVersionAfter, `${edgePrefix} laneVersionAfter`);
    assertSafeInteger(edge.sourceStockVersion, `${edgePrefix} sourceStockVersion`, 1);
    if (edge.capacity !== null) assertSafeInteger(edge.capacity, `${edgePrefix} capacity`);
    if (
      edge.capacity === null
      || edge.reservedAfter !== edge.reservedBefore + edge.quantity
      || edge.laneVersionAfter !== edge.laneVersionBefore + 1
      || edge.reservedAfter > edge.capacity
    ) {
      throw new Error(`${edgePrefix} is not one exact finite reservation edge.`);
    }
    const edgeKey = keyForEdge(edge);
    if (edgeKeys.has(edgeKey)) {
      throw new Error(`${prefix} contains duplicate edges for one reservation lane.`);
    }
    edgeKeys.add(edgeKey);
  }

  if (commit.edges.length > 0 && order.inventoryAction !== "reserved") {
    throw new Error(`${prefix} has inventory edges but is not marked reserved.`);
  }
  if (commit.edges.length === 0 && order.inventoryAction === "reserved") {
    throw new Error(`${prefix} is marked reserved without an inventory edge.`);
  }
}

function validateBatchContinuity(commits: readonly PreparedCheckoutCommit[]): void {
  const lastByLane = new Map<string, CheckoutReservationEdge>();
  for (const commit of commits) {
    for (const edge of commit.edges) {
      const key = keyForEdge(edge);
      const previous = lastByLane.get(key);
      if (
        previous
        && (
          edge.reservedBefore !== previous.reservedAfter
          || edge.laneVersionBefore !== previous.laneVersionAfter
          || edge.capacity !== previous.capacity
          || edge.sourceStockVersion !== previous.sourceStockVersion
        )
      ) {
        throw new Error("Checkout batch reservation edges are not one contiguous lane sequence.");
      }
      lastByLane.set(key, edge);
    }
  }
}

function validateUniqueBatchIdentities(commits: readonly PreparedCheckoutCommit[]): void {
  for (const [label, values] of [
    ["request key", commits.map((commit) => commit.requestKey)],
    ["receipt hash", commits.map((commit) => commit.receiptHash)],
    ["order id", commits.map((commit) => commit.order.id)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new Error(`Checkout batch contains a duplicate ${label}.`);
    }
  }
}

function serializeCheckoutCommits(
  commits: readonly PreparedCheckoutCommit[],
  requestedLimits?: CheckoutCommitLimits,
): {
  authorityRevision: number;
  edgePayload: string;
  orderPayload: string;
} {
  const limits = normalizeCheckoutCommitLimits(requestedLimits);
  if (commits.length < 1 || commits.length > limits.maxOrders) {
    throw new Error(
      `Checkout commit batch must contain between 1 and ${limits.maxOrders} orders.`,
    );
  }
  for (const [index, commit] of commits.entries()) {
    validatePreparedCheckoutCommit(commit, index);
  }
  validateUniqueBatchIdentities(commits);
  validateBatchContinuity(commits);

  const lanes = new Set(commits.map((commit) => commit.lane));
  if (lanes.size !== 1) {
    throw new Error("One atomic checkout batch must target exactly one reservation lane.");
  }
  const authorityRevisions = new Set(commits.map((commit) => commit.authorityRevision));
  if (authorityRevisions.size !== 1) {
    throw new Error("One atomic checkout batch must use exactly one authority revision.");
  }

  // Persistence needs the immutable aggregate once. Inventory guards need
  // only the much smaller edge envelope; binding and reparsing the aggregate
  // for every lane statement dominates hosted SQLite transaction time.
  const orderPayload = JSON.stringify(commits.map((commit) => ({
    aggregate: commit.aggregate,
    edges: commit.edges,
  })));
  const edgePayload = JSON.stringify(commits.map((commit) => ({
    edges: commit.edges,
  })));
  const byteLength = new TextEncoder().encode(orderPayload).byteLength;
  if (byteLength > limits.maxJsonBytes) {
    throw new Error(
      `Checkout commit JSON is ${byteLength} bytes; maximum is ${limits.maxJsonBytes}.`,
    );
  }
  return {
    authorityRevision: commits[0]!.authorityRevision,
    edgePayload,
    orderPayload,
  };
}

const EDGE_CTES = `commands AS MATERIALIZED (
    SELECT CAST(key AS INTEGER) AS command_index, value
    FROM json_each(?1 /* scalius:postgres-jsonb */)
  ),
  edges AS MATERIALIZED (
    SELECT
      command.command_index,
      CAST(edge.key AS INTEGER) AS edge_index,
      CAST(json_extract(edge.value, '$.variantId') AS TEXT) AS variant_id,
      CAST(json_extract(edge.value, '$.pool') AS TEXT) AS pool,
      CAST(json_extract(edge.value, '$.lane') AS INTEGER) AS lane,
      CAST(json_extract(edge.value, '$.quantity') AS INTEGER) AS quantity,
      CAST(json_extract(edge.value, '$.capacity') AS INTEGER) AS capacity,
      CAST(json_extract(edge.value, '$.reservedBefore') AS INTEGER) AS reserved_before,
      CAST(json_extract(edge.value, '$.reservedAfter') AS INTEGER) AS reserved_after,
      CAST(json_extract(edge.value, '$.laneVersionBefore') AS INTEGER) AS version_before,
      CAST(json_extract(edge.value, '$.laneVersionAfter') AS INTEGER) AS version_after,
      CAST(json_extract(edge.value, '$.sourceStockVersion') AS INTEGER) AS source_stock_version
    FROM commands AS command
    CROSS JOIN json_each(command.value, '$.edges' /* scalius:postgres-jsonb */) AS edge
  ),
  lane_updates AS MATERIALIZED (
    SELECT
      variant_id,
      pool,
      lane,
      MIN(reserved_before) AS reserved_before,
      MAX(reserved_after) AS reserved_after,
      MIN(version_before) AS version_before,
      MAX(version_after) AS version_after,
      MIN(capacity) AS capacity,
      MIN(source_stock_version) AS source_stock_version,
      COUNT(*) AS edge_count,
      COUNT(DISTINCT reserved_before) AS distinct_reserved_before,
      COUNT(DISTINCT version_before) AS distinct_version_before,
      SUM(quantity) AS quantity
    FROM edges
    GROUP BY variant_id, pool, lane
  ),
  requested_authorities AS MATERIALIZED (
    SELECT DISTINCT variant_id, pool, source_stock_version
    FROM edges
  )`;

/** Build the one atomic authority transaction for a prepared microbatch. */
export function buildCheckoutCommitStatements(
  commits: readonly PreparedCheckoutCommit[],
  outboxId: string,
  requestedLimits?: CheckoutCommitLimits,
): PortableSqlStatement[] {
  assertNonEmptyString(outboxId, "checkout batch outbox id", 180);
  const limits = normalizeCheckoutCommitLimits(requestedLimits);
  const { authorityRevision, edgePayload, orderPayload } = serializeCheckoutCommits(
    commits,
    limits,
  );
  const orderIds = JSON.stringify(commits.map((commit) => commit.order.id));
  const hasInventoryEdges = commits.some((commit) => commit.edges.length > 0);

  const statements: PortableSqlStatement[] = [{
    purpose: "checkout-commit-validate",
    sql: `WITH ${EDGE_CTES},
      actual_authorities AS MATERIALIZED (
        SELECT
          requested.variant_id,
          requested.pool,
          COUNT(lane.lane) AS lane_count,
          SUM(lane.capacity) AS total_capacity,
          MIN(lane.source_stock_version) AS min_source_stock_version,
          MAX(lane.source_stock_version) AS max_source_stock_version
        FROM requested_authorities AS requested
        LEFT JOIN inventory_reservation_lanes AS lane
          ON lane.variant_id = requested.variant_id
         AND lane.pool = requested.pool
        GROUP BY requested.variant_id, requested.pool
      )
    SELECT CASE
      WHEN NOT EXISTS (
        SELECT 1
        FROM checkout_authority AS authority
        WHERE authority.id = 'default'
          AND authority.revision IS ?2
      )
      THEN json_extract('{}', 'CHECKOUT_AUTHORITY_CHANGED')
      WHEN json_array_length(?1) BETWEEN 1 AND ${limits.maxOrders}
      AND NOT EXISTS (
        SELECT 1
        FROM edges
        WHERE pool <> 'regular'
           OR lane NOT BETWEEN 0 AND ${CHECKOUT_RESERVATION_LANE_COUNT - 1}
           OR quantity < 1
           OR capacity IS NULL
           OR reserved_before < 0
           OR reserved_after <> reserved_before + quantity
           OR version_before < 0
           OR version_after <> version_before + 1
           OR source_stock_version < 1
      )
      AND NOT EXISTS (
        SELECT 1
        FROM lane_updates
        WHERE reserved_after - reserved_before <> quantity
           OR version_after - version_before <> edge_count
           OR distinct_reserved_before <> edge_count
           OR distinct_version_before <> edge_count
           OR reserved_after > capacity
      )
      AND NOT EXISTS (
        SELECT 1
        FROM lane_updates AS requested
        LEFT JOIN inventory_reservation_lanes AS lane
          ON lane.variant_id = requested.variant_id
         AND lane.pool = requested.pool
         AND lane.lane = requested.lane
        WHERE lane.variant_id IS NULL
           OR lane.capacity IS NOT requested.capacity
           OR lane.reserved_quantity IS NOT requested.reserved_before
           OR lane.version IS NOT requested.version_before
           OR lane.source_stock_version IS NOT requested.source_stock_version
      )
      AND NOT EXISTS (
        SELECT 1
        FROM requested_authorities AS requested
        LEFT JOIN actual_authorities AS authority
          ON authority.variant_id = requested.variant_id
         AND authority.pool = requested.pool
        LEFT JOIN product_variants AS variant
          ON variant.id = requested.variant_id
        LEFT JOIN products AS product
          ON product.id = variant.product_id
        WHERE variant.id IS NULL
           OR variant.deleted_at IS NOT NULL
           OR variant.track_inventory <> 1
           OR product.id IS NULL
           OR product.deleted_at IS NOT NULL
           OR product.is_active <> 1
           OR variant.stock_version IS NOT requested.source_stock_version
           OR authority.lane_count <> ${CHECKOUT_RESERVATION_LANE_COUNT}
           OR authority.total_capacity IS NOT MAX(
                COALESCE((
                  SELECT SUM(reserved_quantity)
                  FROM inventory_reservation_lanes AS reserved_lane
                  WHERE reserved_lane.variant_id = variant.id
                    AND reserved_lane.pool = requested.pool
                ), 0),
                MAX(0, variant.stock - variant.reserved_stock)
              )
           OR authority.min_source_stock_version IS NOT requested.source_stock_version
           OR authority.max_source_stock_version IS NOT requested.source_stock_version
      )
      THEN 1
      ELSE json_extract('{}', 'CHECKOUT_RESERVATION_CONFLICT')
    END`,
    args: [edgePayload, authorityRevision],
  }, {
    purpose: "checkout-commit-orders",
    sql: `INSERT INTO orders (
        id, customer_name, customer_phone, customer_email,
        shipping_address, city, zone, area, city_name, zone_name, area_name,
        total_amount, shipping_charge, discount_amount,
        currency_code, currency_decimal_places, subtotal_amount_minor,
        shipping_amount_minor, shipping_method_id, shipping_method_name,
        shipping_method_description, shipping_method_base_amount_minor,
        shipping_fee_waived, discount_amount_minor, tax_amount_minor,
        total_amount_minor, tax_label, prices_include_tax,
        status, notes, payment_method, payment_status, paid_amount, balance_due,
        fulfillment_status, inventory_pool, inventory_action,
        inventory_authority, version,
        customer_id, account_owner_customer_id,
        checkout_request_key, checkout_request_hash, checkout_receipt_hash,
        checkout_aggregate_version, checkout_aggregate_payload,
        checkout_inventory_edges, checkout_response_payload,
        checkout_projection_status, checkout_projection_attempts,
        created_at, updated_at
      )
      SELECT
        json_extract(value, '$.aggregate.payload.orderData.id'),
        json_extract(value, '$.aggregate.payload.orderData.customerName'),
        json_extract(value, '$.aggregate.payload.orderData.customerPhone'),
        json_extract(value, '$.aggregate.payload.orderData.customerEmail'),
        json_extract(value, '$.aggregate.payload.orderData.shippingAddress'),
        json_extract(value, '$.aggregate.payload.orderData.city'),
        json_extract(value, '$.aggregate.payload.orderData.zone'),
        json_extract(value, '$.aggregate.payload.orderData.area'),
        json_extract(value, '$.aggregate.payload.orderData.cityName'),
        json_extract(value, '$.aggregate.payload.orderData.zoneName'),
        json_extract(value, '$.aggregate.payload.orderData.areaName'),
        CAST(json_extract(value, '$.aggregate.payload.orderData.totalAmount') AS REAL),
        CAST(json_extract(value, '$.aggregate.payload.orderData.shippingCharge') AS REAL),
        CAST(json_extract(value, '$.aggregate.payload.orderData.discountAmount') AS REAL),
        json_extract(value, '$.aggregate.payload.orderData.currencyCode'),
        CAST(json_extract(value, '$.aggregate.payload.orderData.currencyDecimalPlaces') AS INTEGER),
        CAST(json_extract(value, '$.aggregate.payload.orderData.subtotalAmountMinor') AS INTEGER),
        CAST(json_extract(value, '$.aggregate.payload.orderData.shippingAmountMinor') AS INTEGER),
        json_extract(value, '$.aggregate.payload.orderData.shippingMethodId'),
        json_extract(value, '$.aggregate.payload.orderData.shippingMethodName'),
        json_extract(value, '$.aggregate.payload.orderData.shippingMethodDescription'),
        CAST(json_extract(value, '$.aggregate.payload.orderData.shippingMethodBaseAmountMinor') AS INTEGER),
        CAST(json_extract(value, '$.aggregate.payload.orderData.shippingFeeWaived') AS INTEGER),
        CAST(json_extract(value, '$.aggregate.payload.orderData.discountAmountMinor') AS INTEGER),
        CAST(json_extract(value, '$.aggregate.payload.orderData.taxAmountMinor') AS INTEGER),
        CAST(json_extract(value, '$.aggregate.payload.orderData.totalAmountMinor') AS INTEGER),
        json_extract(value, '$.aggregate.payload.orderData.taxLabel'),
        CAST(json_extract(value, '$.aggregate.payload.orderData.pricesIncludeTax') AS INTEGER),
        json_extract(value, '$.aggregate.payload.orderData.status'),
        json_extract(value, '$.aggregate.payload.orderData.notes'),
        json_extract(value, '$.aggregate.payload.orderData.paymentMethod'),
        json_extract(value, '$.aggregate.payload.orderData.paymentStatus'),
        CAST(json_extract(value, '$.aggregate.payload.orderData.paidAmount') AS REAL),
        CAST(json_extract(value, '$.aggregate.payload.orderData.balanceDue') AS REAL),
        json_extract(value, '$.aggregate.payload.orderData.fulfillmentStatus'),
        json_extract(value, '$.aggregate.payload.orderData.inventoryPool'),
        json_extract(value, '$.aggregate.payload.orderData.inventoryAction'),
        CASE
          WHEN json_array_length(value, '$.edges') > 0
          THEN 'checkout_lane_v1'
          ELSE 'legacy_counter'
        END,
        1,
        json_extract(value, '$.aggregate.payload.orderData.customerId'),
        json_extract(value, '$.aggregate.payload.orderData.accountOwnerCustomerId'),
        json_extract(value, '$.aggregate.checkout.requestKey'),
        json_extract(value, '$.aggregate.checkout.requestHash'),
        json_extract(value, '$.aggregate.checkout.receiptHash'),
        ${CHECKOUT_AGGREGATE_VERSION},
        json_extract(value, '$.aggregate'),
        json_extract(value, '$.edges'),
        json_extract(value, '$.aggregate.checkout.response'),
        'pending', 0, unixepoch(), unixepoch()
      FROM json_each(?1 /* scalius:postgres-jsonb */)
      ORDER BY CAST(key AS INTEGER)`,
    args: [orderPayload],
  }, {
    purpose: "checkout-commit-lanes",
    sql: `WITH ${EDGE_CTES}
      UPDATE inventory_reservation_lanes AS lane
      SET
        reserved_quantity = (
          SELECT requested.reserved_after
          FROM lane_updates AS requested
          WHERE requested.variant_id = lane.variant_id
            AND requested.pool = lane.pool
            AND requested.lane = lane.lane
        ),
        version = (
          SELECT requested.version_after
          FROM lane_updates AS requested
          WHERE requested.variant_id = lane.variant_id
            AND requested.pool = lane.pool
            AND requested.lane = lane.lane
        ),
        updated_at = unixepoch()
      WHERE EXISTS (
        SELECT 1
        FROM lane_updates AS requested
        WHERE requested.variant_id = lane.variant_id
          AND requested.pool = lane.pool
          AND requested.lane = lane.lane
          AND lane.capacity IS requested.capacity
          AND lane.reserved_quantity IS requested.reserved_before
          AND lane.version IS requested.version_before
          AND lane.source_stock_version IS requested.source_stock_version
      )`,
    args: [edgePayload],
  }, {
    purpose: "checkout-commit-postcondition",
    sql: `WITH ${EDGE_CTES}
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM lane_updates AS requested
        LEFT JOIN inventory_reservation_lanes AS lane
          ON lane.variant_id = requested.variant_id
         AND lane.pool = requested.pool
         AND lane.lane = requested.lane
        WHERE lane.variant_id IS NULL
           OR lane.reserved_quantity IS NOT requested.reserved_after
           OR lane.version IS NOT requested.version_after
      )
      THEN 1
      ELSE json_extract('{}', 'CHECKOUT_RESERVATION_POSTCONDITION_FAILED')
      END`,
    args: [edgePayload],
  }, {
    purpose: "checkout-commit-outbox",
    sql: `INSERT INTO checkout_batch_outbox (
        id, order_ids, status, attempts, created_at, updated_at
      ) VALUES (?1, ?2, 'pending', 0, unixepoch(), unixepoch())`,
    args: [outboxId, orderIds],
  }];
  return hasInventoryEdges
    ? statements
    : [statements[0]!, statements[1]!, statements[4]!];
}

/**
 * Lazily creates two lanes for coordinated reservations. The legacy
 * `reserved_stock` counter remains a separate compatibility authority; a
 * database trigger shrinks/expands lane capacity whenever that counter or
 * physical stock changes. This lets legacy and coordinated orders coexist
 * without double-counting either reservation family.
 */
export function buildEnsureCheckoutReservationLanesStatement(
  variantIds: readonly string[],
): PortableSqlStatement {
  const uniqueIds = [...new Set(variantIds)];
  if (uniqueIds.length < 1 || uniqueIds.length > 99) {
    throw new Error("Reservation-lane initialization requires between 1 and 99 variants.");
  }
  for (const id of uniqueIds) assertNonEmptyString(id, "reservation variant id", 180);

  return {
    sql: `INSERT INTO inventory_reservation_lanes (
        variant_id, pool, lane, capacity, reserved_quantity, version,
        source_stock_version, created_at, updated_at
      )
      SELECT
        variant.id,
        'regular',
        CAST(lane.value AS INTEGER),
        CASE CAST(lane.value AS INTEGER)
          WHEN 0 THEN (MAX(0, variant.stock - variant.reserved_stock) + 1) / 2
          ELSE MAX(0, variant.stock - variant.reserved_stock) / 2
        END,
        0,
        0,
        variant.stock_version,
        unixepoch(),
        unixepoch()
      FROM product_variants AS variant
      JOIN products AS product ON product.id = variant.product_id
      JOIN json_each(?1) AS requested
        ON variant.id = CAST(requested.value AS TEXT)
      CROSS JOIN json_each('[0,1]') AS lane
      WHERE variant.deleted_at IS NULL
        AND variant.track_inventory = 1
        AND product.deleted_at IS NULL
        AND product.is_active = 1
        AND NOT EXISTS (
          SELECT 1
          FROM inventory_reservation_lanes AS existing
          WHERE existing.variant_id = variant.id
            AND existing.pool = 'regular'
        )
      ORDER BY variant.id, CAST(lane.value AS INTEGER)`,
    args: [JSON.stringify(uniqueIds)],
  };
}

export function buildCheckoutReservationLaneSnapshotStatement(
  variantIds: readonly string[],
): PortableSqlStatement {
  const uniqueIds = [...new Set(variantIds)];
  if (uniqueIds.length < 1 || uniqueIds.length > 99) {
    throw new Error("Reservation-lane snapshot requires between 1 and 99 variants.");
  }
  for (const id of uniqueIds) assertNonEmptyString(id, "reservation variant id", 180);

  return {
    sql: `SELECT
        variant.id AS variantId,
        variant.stock AS stock,
        variant.reserved_stock AS legacyReservedStock,
        variant.track_inventory AS trackInventory,
        variant.low_stock_threshold AS lowStockThreshold,
        variant.stock_version AS stockVersion,
        lane.lane AS lane,
        lane.capacity AS capacity,
        lane.reserved_quantity AS reservedQuantity,
        lane.version AS laneVersion,
        lane.source_stock_version AS sourceStockVersion
      FROM product_variants AS variant
      JOIN products AS product ON product.id = variant.product_id
      JOIN json_each(?1) AS requested
        ON variant.id = CAST(requested.value AS TEXT)
      LEFT JOIN inventory_reservation_lanes AS lane
        ON lane.variant_id = variant.id
       AND lane.pool = 'regular'
      WHERE variant.deleted_at IS NULL
        AND product.deleted_at IS NULL
        AND product.is_active = 1
      ORDER BY variant.id, lane.lane`,
    args: [JSON.stringify(uniqueIds)],
  };
}

/**
 * Move only free capacity between the two lanes. Existing reservations and
 * their immutable historical edges stay on their original lane; this merely
 * prevents a larger valid cart from seeing a false out-of-stock result when
 * free units are split across both lanes.
 */
export function buildRebalanceCheckoutReservationLanesStatements(
  changes: readonly CheckoutReservationLaneRebalance[],
): PortableSqlStatement[] {
  if (changes.length < 1 || changes.length > 99) {
    throw new Error("Reservation-lane rebalance requires between 1 and 99 variants.");
  }
  const seen = new Set<string>();
  const payload = changes.map((change) => {
    assertNonEmptyString(change.variantId, "rebalance variant id", 180);
    if (seen.has(change.variantId)) {
      throw new Error("Reservation-lane rebalance contains a duplicate variant.");
    }
    seen.add(change.variantId);
    assertSafeInteger(change.targetLane, "rebalance target lane");
    if (change.targetLane >= CHECKOUT_RESERVATION_LANE_COUNT) {
      throw new Error("Reservation-lane rebalance target is outside the configured lane range.");
    }
    assertSafeInteger(change.sourceStockVersion, "rebalance source stock version", 1);
    for (const [lane, state] of change.lanes.entries()) {
      assertSafeInteger(state.capacity, `rebalance lane ${lane} capacity`);
      assertSafeInteger(state.reservedQuantity, `rebalance lane ${lane} reserved quantity`);
      assertSafeInteger(state.laneVersion, `rebalance lane ${lane} version`);
      if (state.reservedQuantity > state.capacity) {
        throw new Error(`Reservation-lane rebalance lane ${lane} exceeds its capacity.`);
      }
    }
    const totalCapacity = change.lanes[0].capacity + change.lanes[1].capacity;
    assertSafeInteger(totalCapacity, "rebalance total capacity");
    const donorLane = change.targetLane === 0 ? 1 : 0;
    const donorReserved = change.lanes[donorLane].reservedQuantity;
    const newTargetCapacity = totalCapacity - donorReserved;
    const newCapacities = change.targetLane === 0
      ? [newTargetCapacity, donorReserved]
      : [donorReserved, newTargetCapacity];
    if (
      newCapacities[0]! < change.lanes[0].reservedQuantity
      || newCapacities[1]! < change.lanes[1].reservedQuantity
    ) {
      throw new Error("Reservation-lane rebalance cannot preserve existing reservations.");
    }
    return {
      variantId: change.variantId,
      targetLane: change.targetLane,
      sourceStockVersion: change.sourceStockVersion,
      lane0Capacity: change.lanes[0].capacity,
      lane0Reserved: change.lanes[0].reservedQuantity,
      lane0Version: change.lanes[0].laneVersion,
      lane1Capacity: change.lanes[1].capacity,
      lane1Reserved: change.lanes[1].reservedQuantity,
      lane1Version: change.lanes[1].laneVersion,
      newLane0Capacity: newCapacities[0],
      newLane1Capacity: newCapacities[1],
    };
  });
  const json = JSON.stringify(payload);
  const requestedCte = `requested AS MATERIALIZED (
      SELECT
        CAST(json_extract(value, '$.variantId') AS TEXT) AS variant_id,
        CAST(json_extract(value, '$.targetLane') AS INTEGER) AS target_lane,
        CAST(json_extract(value, '$.sourceStockVersion') AS INTEGER) AS source_stock_version,
        CAST(json_extract(value, '$.lane0Capacity') AS INTEGER) AS lane0_capacity,
        CAST(json_extract(value, '$.lane0Reserved') AS INTEGER) AS lane0_reserved,
        CAST(json_extract(value, '$.lane0Version') AS INTEGER) AS lane0_version,
        CAST(json_extract(value, '$.lane1Capacity') AS INTEGER) AS lane1_capacity,
        CAST(json_extract(value, '$.lane1Reserved') AS INTEGER) AS lane1_reserved,
        CAST(json_extract(value, '$.lane1Version') AS INTEGER) AS lane1_version,
        CAST(json_extract(value, '$.newLane0Capacity') AS INTEGER) AS new_lane0_capacity,
        CAST(json_extract(value, '$.newLane1Capacity') AS INTEGER) AS new_lane1_capacity
      FROM json_each(?1)
    )`;

  return [{
    sql: `WITH ${requestedCte}
      SELECT CASE WHEN
        json_array_length(?1) BETWEEN 1 AND 99
        AND NOT EXISTS (
          SELECT 1
          FROM requested AS request
          LEFT JOIN product_variants AS variant
            ON variant.id = request.variant_id
          LEFT JOIN inventory_reservation_lanes AS lane0
            ON lane0.variant_id = request.variant_id
           AND lane0.pool = 'regular'
           AND lane0.lane = 0
          LEFT JOIN inventory_reservation_lanes AS lane1
            ON lane1.variant_id = request.variant_id
           AND lane1.pool = 'regular'
           AND lane1.lane = 1
          WHERE request.target_lane NOT IN (0, 1)
             OR variant.id IS NULL
             OR variant.stock_version IS NOT request.source_stock_version
             OR request.lane0_capacity + request.lane1_capacity IS NOT MAX(
                  request.lane0_reserved + request.lane1_reserved,
                  MAX(0, variant.stock - variant.reserved_stock)
                )
             OR lane0.capacity IS NOT request.lane0_capacity
             OR lane0.reserved_quantity IS NOT request.lane0_reserved
             OR lane0.version IS NOT request.lane0_version
             OR lane0.source_stock_version IS NOT request.source_stock_version
             OR lane1.capacity IS NOT request.lane1_capacity
             OR lane1.reserved_quantity IS NOT request.lane1_reserved
             OR lane1.version IS NOT request.lane1_version
             OR lane1.source_stock_version IS NOT request.source_stock_version
             OR request.new_lane0_capacity < request.lane0_reserved
             OR request.new_lane1_capacity < request.lane1_reserved
             OR request.new_lane0_capacity + request.new_lane1_capacity
                IS NOT request.lane0_capacity + request.lane1_capacity
        )
        THEN 1
        ELSE json_extract('{}', 'CHECKOUT_RESERVATION_REBALANCE_PRECONDITION_FAILED')
      END`,
    args: [json],
  }, {
    sql: `WITH ${requestedCte}
      UPDATE inventory_reservation_lanes AS lane
      SET
        capacity = CASE lane.lane
          WHEN 0 THEN (SELECT request.new_lane0_capacity FROM requested AS request
                       WHERE request.variant_id = lane.variant_id)
          ELSE (SELECT request.new_lane1_capacity FROM requested AS request
                WHERE request.variant_id = lane.variant_id)
        END,
        updated_at = unixepoch()
      WHERE lane.pool = 'regular'
        AND lane.lane IN (0, 1)
        AND EXISTS (
          SELECT 1 FROM requested AS request
          WHERE request.variant_id = lane.variant_id
        )`,
    args: [json],
  }, {
    sql: `WITH ${requestedCte}
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM requested AS request
        LEFT JOIN inventory_reservation_lanes AS lane0
          ON lane0.variant_id = request.variant_id
         AND lane0.pool = 'regular'
         AND lane0.lane = 0
        LEFT JOIN inventory_reservation_lanes AS lane1
          ON lane1.variant_id = request.variant_id
         AND lane1.pool = 'regular'
         AND lane1.lane = 1
        WHERE lane0.capacity IS NOT request.new_lane0_capacity
           OR lane0.reserved_quantity IS NOT request.lane0_reserved
           OR lane0.version IS NOT request.lane0_version
           OR lane1.capacity IS NOT request.new_lane1_capacity
           OR lane1.reserved_quantity IS NOT request.lane1_reserved
           OR lane1.version IS NOT request.lane1_version
      )
      THEN 1
      ELSE json_extract('{}', 'CHECKOUT_RESERVATION_REBALANCE_POSTCONDITION_FAILED')
      END`,
    args: [json],
  }];
}

export function buildExistingCheckoutIdentityStatement(
  requestKeys: readonly string[],
  maxOrders = CHECKOUT_COMMIT_MAX_ORDERS,
): PortableSqlStatement {
  const uniqueKeys = [...new Set(requestKeys)];
  if (
    !Number.isSafeInteger(maxOrders)
    || maxOrders < 1
    || maxOrders > CHECKOUT_COMMIT_HARD_MAX_ORDERS
    || uniqueKeys.length < 1
    || uniqueKeys.length > maxOrders
  ) {
    throw new Error("Checkout replay lookup requires a bounded non-empty request-key set.");
  }
  for (const key of uniqueKeys) assertNonEmptyString(key, "checkout request key", 320);

  return {
    sql: `SELECT
        checkout_request_key AS requestKey,
        checkout_request_hash AS requestHash,
        checkout_receipt_hash AS receiptHash,
        id AS orderId,
        checkout_response_payload AS responsePayload
      FROM orders
      WHERE checkout_request_key IN (
        SELECT CAST(value AS TEXT) FROM json_each(?1)
      )`,
    args: [JSON.stringify(uniqueKeys)],
  };
}
