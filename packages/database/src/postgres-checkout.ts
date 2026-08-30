import {
  CHECKOUT_COMMIT_HARD_MAX_JSON_BYTES,
  CHECKOUT_COMMIT_HARD_MAX_ORDERS,
  buildCheckoutCommitStatements,
  type PortableSqlStatement,
  type PreparedCheckoutCommit,
} from "./checkout-commit";
import { compileSqliteStatementForPostgres } from "./postgres-sqlite-profile";

export const POSTGRES_CHECKOUT_COMMIT_FUNCTION =
  "scalius_compat.checkout_commit_v1" as const;

const purposeOrder = [
  "checkout-commit-validate",
  "checkout-commit-orders",
  "checkout-commit-lanes",
  "checkout-commit-postcondition",
  "checkout-commit-outbox",
] as const;

function replaceParameters(sql: string, replacements: readonly string[]): string {
  return sql.replace(/\$(\d+)/g, (_match, rawIndex: string) => {
    const replacement = replacements[Number(rawIndex) - 1];
    if (!replacement) throw new Error(`Missing PostgreSQL checkout function parameter ${rawIndex}.`);
    return replacement;
  });
}

function compiledByPurpose(): Map<string, string> {
  const order = {
    id: "order",
    customerName: "Customer",
    customerPhone: "+8801700000000",
    customerEmail: null,
    shippingAddress: "Address",
    city: "city",
    zone: "zone",
    area: null,
    cityName: null,
    zoneName: null,
    areaName: null,
    totalAmount: 1,
    shippingCharge: 0,
    discountAmount: 0,
    currencyCode: "BDT",
    currencyDecimalPlaces: 2,
    subtotalAmountMinor: 1,
    shippingAmountMinor: 0,
    shippingMethodId: "shipping_standard",
    shippingMethodName: "Standard delivery",
    shippingMethodDescription: "Delivered within 2–3 business days",
    shippingMethodBaseAmountMinor: 0,
    shippingFeeWaived: false,
    discountAmountMinor: 0,
    taxAmountMinor: 0,
    totalAmountMinor: 1,
    taxLabel: "Tax",
    pricesIncludeTax: false,
    status: "pending",
    notes: null,
    paymentMethod: "cod",
    paymentStatus: "pending",
    paidAmount: 0,
    balanceDue: 1,
    fulfillmentStatus: "unfulfilled",
    inventoryPool: "regular",
    inventoryAction: "reserved",
    customerId: null,
    accountOwnerCustomerId: null,
  } as const;
  const commit: PreparedCheckoutCommit<Record<string, unknown>, Record<string, unknown>> = {
    requestKey: "request",
    requestHash: "hash",
    receiptHash: "receipt",
    authorityRevision: 1,
    lane: 0,
    order,
    aggregate: {
      schemaVersion: 1,
      checkout: {
        requestKey: "request",
        requestHash: "hash",
        receiptHash: "receipt",
        authorityRevision: 1,
        response: {},
      },
      payload: { orderData: { ...order, id: "order", totalAmountMinor: 1 } },
    },
    response: {},
    edges: [{
      variantId: "variant",
      pool: "regular",
      lane: 0,
      quantity: 1,
      capacity: 1,
      reservedBefore: 0,
      reservedAfter: 1,
      laneVersionBefore: 0,
      laneVersionAfter: 1,
      sourceStockVersion: 1,
    }],
  };
  const statements = buildCheckoutCommitStatements([commit], "outbox", {
    maxOrders: CHECKOUT_COMMIT_HARD_MAX_ORDERS,
    maxJsonBytes: CHECKOUT_COMMIT_HARD_MAX_JSON_BYTES,
  });
  const compiled = new Map<string, string>();
  for (const statement of statements) {
    if (!statement.purpose) throw new Error("PostgreSQL checkout statement purpose is missing.");
    compiled.set(
      statement.purpose,
      compileSqliteStatementForPostgres(statement.sql, statement.args.length).sql,
    );
  }
  if (purposeOrder.some((purpose) => !compiled.has(purpose))) {
    throw new Error("PostgreSQL checkout function statement set is incomplete.");
  }
  return compiled;
}

/** Build the canonical one-round-trip PostgreSQL checkout authority function. */
export function buildPostgresCheckoutCommitFunctionSql(): string {
  const statements = compiledByPurpose();
  const validation = replaceParameters(statements.get(purposeOrder[0])!, [
    "p_edge_payload",
    "p_authority_revision",
  ]);
  const orders = replaceParameters(statements.get(purposeOrder[1])!, ["p_order_payload"]);
  const lanes = replaceParameters(statements.get(purposeOrder[2])!, ["p_edge_payload"]);
  const postcondition = replaceParameters(statements.get(purposeOrder[3])!, ["p_edge_payload"]);
  const outbox = replaceParameters(statements.get(purposeOrder[4])!, [
    "p_outbox_id",
    "p_order_ids",
  ]);
  return `CREATE OR REPLACE FUNCTION ${POSTGRES_CHECKOUT_COMMIT_FUNCTION}(
      p_edge_payload jsonb,
      p_authority_revision bigint,
      p_order_payload jsonb,
      p_outbox_id text,
      p_order_ids text
    ) RETURNS bigint
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      PERFORM * FROM (${validation}) AS validation_result;
      ${orders};
      ${lanes};
      PERFORM * FROM (${postcondition}) AS postcondition_result;
      ${outbox};
      RETURN 1;
    END
    $function$;`;
}

export interface PostgresCheckoutCommitArguments {
  edgePayload: unknown;
  authorityRevision: unknown;
  orderPayload: unknown;
  outboxId: unknown;
  orderIds: unknown;
}

/** Recognize only the tagged statement set emitted by the checkout kernel. */
export function readPostgresCheckoutCommitArguments(
  statements: readonly PortableSqlStatement[],
): PostgresCheckoutCommitArguments | null {
  const byPurpose = new Map(statements.map((statement) => [statement.purpose, statement]));
  const allowedLengths = statements.length === 5 || statements.length === 3;
  const validation = byPurpose.get("checkout-commit-validate");
  const orders = byPurpose.get("checkout-commit-orders");
  const lanes = byPurpose.get("checkout-commit-lanes");
  const postcondition = byPurpose.get("checkout-commit-postcondition");
  const outbox = byPurpose.get("checkout-commit-outbox");
  if (
    !allowedLengths
    || !validation
    || !orders
    || !outbox
    || validation.args.length !== 2
    || orders.args.length !== 1
    || outbox.args.length !== 2
    || (statements.length === 5 && (!lanes || !postcondition))
    || (statements.length === 3 && (lanes || postcondition))
  ) return null;
  const edgePayload = validation.args[0];
  if (
    lanes && lanes.args[0] !== edgePayload
    || postcondition && postcondition.args[0] !== edgePayload
  ) return null;
  return {
    edgePayload,
    authorityRevision: validation.args[1],
    orderPayload: orders.args[0],
    outboxId: outbox.args[0],
    orderIds: outbox.args[1],
  };
}
