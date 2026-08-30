import type { Database } from "@scalius/database/client";
import {
  agentStorefrontContexts,
  agentStorefrontContinuations,
  customers,
  customerSessions,
  productVariants,
} from "@scalius/database/schema";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { validateStorefrontCartItems, validateStorefrontDeliveryPreflight } from "@scalius/core/modules/orders";
import { getCurrencySettings } from "@scalius/core/modules/settings";
import {
  calculateDiscountAmount,
  isDiscountValid,
} from "@scalius/core/modules/discounts/discounts.eligibility";
import {
  evaluateStorefrontPromotionCode,
  resolvePromotionCustomerIdByPhone,
} from "@scalius/core/modules/promotions";
import {
  buildStorefrontTaxAllocationLineId,
  calculateStorefrontTaxQuote,
  fromMinorUnits,
  toMinorUnits,
  type StorefrontDiscountType,
  type TaxDiscountAllocationInput,
} from "@scalius/core/modules/tax";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { roundPrice } from "@scalius/shared/price-utils";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  addAgentStorefrontCartLine,
  normalizeAgentStorefrontDeliverySelection,
  normalizeAgentStorefrontDiscountCode,
  parseAgentStorefrontCartJson,
  removeAgentStorefrontCartLine,
  serializeAgentStorefrontCart,
  setAgentStorefrontCartLineQuantity,
  type AgentStorefrontCartLine,
  type AgentStorefrontDeliverySelection,
} from "./state";
import { buildAgentStorefrontCheckoutQuoteFingerprint } from "./quote-fingerprint";

export const AGENT_STOREFRONT_CONTEXT_TTL_SECONDS = 24 * 60 * 60;

type ContextRow = typeof agentStorefrontContexts.$inferSelect;
type ContinuationRow = typeof agentStorefrontContinuations.$inferSelect;

export class AgentStorefrontContextRevisionConflictError extends AppError {
  constructor(contextId: string, expectedRevision: number, currentRevision: number | null) {
    super(
      409,
      "AGENT_STOREFRONT_CONTEXT_REVISION_CONFLICT",
      "This storefront context changed. Reload it and retry with the current revision.",
      { contextId, expectedRevision, currentRevision },
    );
    this.name = "AgentStorefrontContextRevisionConflictError";
  }
}

export interface AgentStorefrontContextView {
  id: string;
  status: ContextRow["status"];
  revision: number;
  cart: AgentStorefrontCartLine[];
  discountCode: string | null;
  delivery: AgentStorefrontDeliverySelection;
  customerAuthorized: boolean;
  expiresAt: string;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStorefrontCartProjection {
  context: AgentStorefrontContextView;
  valid: boolean;
  issues: Awaited<ReturnType<typeof validateStorefrontCartItems>>["issues"];
  items: Awaited<ReturnType<typeof validateStorefrontCartItems>>["items"];
  subtotal: number;
  hasFreeDeliveryProduct: boolean;
  delivery?: Awaited<ReturnType<typeof validateStorefrontDeliveryPreflight>>;
}

export interface AgentStorefrontCheckoutQuote {
  valid: true;
  contextRevision: number;
  quoteFingerprint: string;
  displayLabel: string;
  pricesIncludeTax: boolean;
  shippingTaxed: boolean;
  currencyCode: string;
  decimalPlaces: number;
  settingsVersion: number;
  subtotalMinor: number;
  subtotalAmount: number;
  shippingMinor: number;
  shippingAmount: number;
  discountMinor: number;
  discountAmount: number;
  taxMinor: number;
  taxAmount: number;
  totalMinor: number;
  totalAmount: number;
  items: Array<{
    productId: string;
    variantId: string;
    quantity: number;
    unitPrice: number;
    productName: string;
    variantLabel: string | null;
  }>;
}


function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}

function expiresFromNow(now: Date, maximumExpiresAt?: Date): Date {
  const desired = new Date(now.getTime() + AGENT_STOREFRONT_CONTEXT_TTL_SECONDS * 1_000);
  if (!maximumExpiresAt || maximumExpiresAt.getTime() >= desired.getTime()) return desired;
  if (toEpochSeconds(maximumExpiresAt) <= toEpochSeconds(now)) {
    throw new ForbiddenError("The storefront agent grant expired.");
  }
  return maximumExpiresAt;
}

function iso(value: Date): string {
  return value.toISOString();
}

function projectContext(
  row: ContextRow,
  customerAuthorized = false,
): AgentStorefrontContextView {
  return {
    id: row.id,
    status: row.status,
    revision: row.revision,
    cart: parseAgentStorefrontCartJson(row.cartJson),
    discountCode: row.discountCode,
    delivery: {
      cityId: row.cityId,
      zoneId: row.zoneId,
      areaId: row.areaId,
      shippingMethodId: row.shippingMethodId,
    },
    customerAuthorized,
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt ?? row.updatedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function projectLiveContext(
  db: Database,
  row: ContextRow,
): Promise<AgentStorefrontContextView> {
  const customerAuthorized = row.customerSessionTokenHash
    ? await getLiveContextCustomerId(db, row) !== null
    : false;
  return projectContext(row, customerAuthorized);
}

function assertExpectedRevision(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError("A positive current context revision is required.");
  }
}

async function loadOwnedContext(
  db: Database,
  grantId: string,
  contextId: string,
): Promise<ContextRow> {
  const row = await db.select().from(agentStorefrontContexts)
    .where(eq(agentStorefrontContexts.id, contextId))
    .get();
  if (!row) throw new NotFoundError("Storefront context not found.");
  if (row.grantId !== grantId) throw new ForbiddenError("This connection does not own the storefront context.");
  return row;
}

async function loadActiveOwnedContext(
  db: Database,
  grantId: string,
  contextId: string,
  now: Date,
): Promise<ContextRow> {
  const row = await loadOwnedContext(db, grantId, contextId);
  if (row.status !== "active" || row.closedAt !== null) {
    throw new ConflictError("This storefront context is closed.");
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.update(agentStorefrontContexts)
      .set({ status: "expired", closedAt: now, updatedAt: now })
      .where(and(
        eq(agentStorefrontContexts.id, row.id),
        eq(agentStorefrontContexts.grantId, grantId),
        eq(agentStorefrontContexts.status, "active"),
      ))
      .run();
    throw new ConflictError("This storefront context expired. Start a new context.");
  }
  return row;
}

async function throwMutationConflict(
  db: Database,
  grantId: string,
  contextId: string,
  expectedRevision: number,
  now: Date,
): Promise<never> {
  const current = await loadOwnedContext(db, grantId, contextId);
  if (current.revision !== expectedRevision) {
    throw new AgentStorefrontContextRevisionConflictError(
      contextId,
      expectedRevision,
      current.revision,
    );
  }
  if (current.status !== "active" || current.closedAt !== null) {
    throw new ConflictError("This storefront context is closed.");
  }
  if (current.expiresAt.getTime() <= now.getTime()) {
    throw new ConflictError("This storefront context expired. Start a new context.");
  }
  throw new ConflictError("The storefront context could not be updated. Reload it and try again.");
}

async function mutateContext(
  db: Database,
  input: {
    grantId: string;
    contextId: string;
    expectedRevision: number;
    now?: Date;
    current?: ContextRow;
    buildUpdate: (current: ContextRow) => Partial<typeof agentStorefrontContexts.$inferInsert>;
  },
): Promise<ContextRow> {
  assertExpectedRevision(input.expectedRevision);
  const now = input.now ?? new Date();
  const current = input.current
    ?? await loadActiveOwnedContext(db, input.grantId, input.contextId, now);
  if (current.revision !== input.expectedRevision) {
    throw new AgentStorefrontContextRevisionConflictError(
      current.id,
      input.expectedRevision,
      current.revision,
    );
  }
  const updated = await db.update(agentStorefrontContexts)
    .set({
      ...input.buildUpdate(current),
      revision: sql`${agentStorefrontContexts.revision} + 1`,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(agentStorefrontContexts.id, input.contextId),
      eq(agentStorefrontContexts.grantId, input.grantId),
      eq(agentStorefrontContexts.status, "active"),
      isNull(agentStorefrontContexts.closedAt),
      eq(agentStorefrontContexts.revision, input.expectedRevision),
      gt(agentStorefrontContexts.expiresAt, now),
    ))
    .returning()
    .get();
  if (!updated) {
    return throwMutationConflict(
      db,
      input.grantId,
      input.contextId,
      input.expectedRevision,
      now,
    );
  }
  return updated;
}

export async function createAgentStorefrontContext(
  db: Database,
  grantId: string,
  options: { now?: Date; maximumExpiresAt?: Date } = {},
): Promise<AgentStorefrontContextView> {
  const now = options.now ?? new Date();
  const [row] = await db.insert(agentStorefrontContexts).values({
    id: `asc_${nanoid(20)}`,
    grantId,
    status: "active",
    revision: 1,
    cartJson: "[]",
    expiresAt: expiresFromNow(now, options.maximumExpiresAt),
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (!row) throw new ConflictError("The storefront context could not be created.");
  return projectLiveContext(db, row);
}

export async function getAgentStorefrontContext(
  db: Database,
  grantId: string,
  contextId: string,
  options: { now?: Date; touch?: boolean } = {},
): Promise<AgentStorefrontContextView> {
  const now = options.now ?? new Date();
  let row = await loadActiveOwnedContext(db, grantId, contextId, now);
  if (options.touch !== false) {
    const touched = await db.update(agentStorefrontContexts)
      .set({ lastUsedAt: now })
      .where(and(
        eq(agentStorefrontContexts.id, contextId),
        eq(agentStorefrontContexts.grantId, grantId),
        eq(agentStorefrontContexts.status, "active"),
        gt(agentStorefrontContexts.expiresAt, now),
      ))
      .returning()
      .get();
    if (touched) row = touched;
  }
  return projectLiveContext(db, row);
}

export async function closeAgentStorefrontContext(
  db: Database,
  grantId: string,
  contextId: string,
  expectedRevision: number,
  options: { now?: Date } = {},
): Promise<AgentStorefrontContextView> {
  const now = options.now ?? new Date();
  const row = await mutateContext(db, {
    grantId,
    contextId,
    expectedRevision,
    now,
    buildUpdate: () => ({ status: "closed", closedAt: now }),
  });
  return projectLiveContext(db, row);
}

type CartMutation =
  | { kind: "add"; variantId: string; quantity: number }
  | { kind: "set"; variantId: string; quantity: number }
  | { kind: "remove"; variantId: string }
  | { kind: "clear" };

export async function mutateAgentStorefrontCart(
  db: Database,
  grantId: string,
  contextId: string,
  expectedRevision: number,
  mutation: CartMutation,
  options: { now?: Date } = {},
): Promise<AgentStorefrontCartProjection> {
  assertExpectedRevision(expectedRevision);
  const now = options.now ?? new Date();
  const current = await loadActiveOwnedContext(db, grantId, contextId, now);
  if (current.revision !== expectedRevision) {
    throw new AgentStorefrontContextRevisionConflictError(contextId, expectedRevision, current.revision);
  }
  const currentLines = parseAgentStorefrontCartJson(current.cartJson);
  const nextLines = mutation.kind === "add"
    ? addAgentStorefrontCartLine(currentLines, mutation)
    : mutation.kind === "set"
      ? setAgentStorefrontCartLineQuantity(currentLines, mutation.variantId, mutation.quantity)
      : mutation.kind === "remove"
        ? removeAgentStorefrontCartLine(currentLines, mutation.variantId)
        : [];
  if (mutation.kind === "add" || mutation.kind === "set") {
    const proposedIdentity = await resolveProductIdsForCart(db, nextLines);
    const currency = await getCurrencySettings(db);
    const proposedValidation = await validateStorefrontCartItems(db, proposedIdentity, {
      currencyCode: currency.currencyCode,
    });
    if (!proposedValidation.valid) {
      throw new ValidationError("The proposed storefront cart is not currently valid.", {
        itemIssues: proposedValidation.issues,
      });
    }
  }
  const row = await mutateContext(db, {
    grantId,
    contextId,
    expectedRevision,
    now,
    current,
    buildUpdate: () => ({
      cartJson: serializeAgentStorefrontCart(nextLines),
      // A cart edit always invalidates previously accepted discount state.
      discountCode: null,
    }),
  });
  return rehydrateAgentStorefrontCart(db, row);
}

export async function setAgentStorefrontDiscount(
  db: Database,
  grantId: string,
  contextId: string,
  expectedRevision: number,
  code: string | null,
  options: { now?: Date; customerPhone?: string | null } = {},
): Promise<AgentStorefrontCartProjection> {
  assertExpectedRevision(expectedRevision);
  const now = options.now ?? new Date();
  const normalizedCode = code === null ? null : normalizeAgentStorefrontDiscountCode(code);
  const current = await loadActiveOwnedContext(db, grantId, contextId, now);
  if (current.revision !== expectedRevision) {
    throw new AgentStorefrontContextRevisionConflictError(contextId, expectedRevision, current.revision);
  }
  if (normalizedCode) {
    await assertAgentStorefrontDiscountValid(
      db,
      current,
      normalizedCode,
      options.customerPhone?.trim() || undefined,
    );
  }
  const row = await mutateContext(db, {
    grantId,
    contextId,
    expectedRevision,
    now,
    current,
    buildUpdate: () => ({
      discountCode: normalizedCode,
    }),
  });
  return rehydrateAgentStorefrontCart(db, row);
}

export async function setAgentStorefrontDelivery(
  db: Database,
  grantId: string,
  contextId: string,
  expectedRevision: number,
  delivery: AgentStorefrontDeliverySelection,
  options: { now?: Date } = {},
): Promise<AgentStorefrontCartProjection> {
  assertExpectedRevision(expectedRevision);
  const now = options.now ?? new Date();
  const normalized = normalizeAgentStorefrontDeliverySelection(delivery);
  const current = await loadActiveOwnedContext(db, grantId, contextId, now);
  if (current.revision !== expectedRevision) {
    throw new AgentStorefrontContextRevisionConflictError(contextId, expectedRevision, current.revision);
  }
  const projection = await rehydrateAgentStorefrontCart(db, current);
  if (!projection.valid) {
    throw new ValidationError("Some items in the storefront cart need attention.", {
      itemIssues: projection.issues,
    });
  }
  if (normalized.cityId && normalized.zoneId) {
    const currency = await getCurrencySettings(db);
    await validateStorefrontDeliveryPreflight(db, {
      city: normalized.cityId,
      zone: normalized.zoneId,
      area: normalized.areaId,
      shippingMethodId: normalized.shippingMethodId,
      currencyCode: currency.currencyCode,
    }, projection);
  }
  const row = await mutateContext(db, {
    grantId,
    contextId,
    expectedRevision,
    now,
    current,
    buildUpdate: () => ({
      cityId: normalized.cityId,
      zoneId: normalized.zoneId,
      areaId: normalized.areaId,
      shippingMethodId: normalized.shippingMethodId,
    }),
  });
  return rehydrateAgentStorefrontCart(db, row);
}

async function resolveProductIdsForCart(
  db: Database,
  lines: readonly AgentStorefrontCartLine[],
): Promise<Array<{ variantId: string; productId: string; quantity: number }>> {
  if (lines.length === 0) return [];
  const idsJson = JSON.stringify(lines.map((line) => line.variantId));
  const rows = await db.select({
    variantId: productVariants.id,
    productId: productVariants.productId,
  }).from(productVariants)
    .where(sql`${productVariants.id} IN (
      SELECT CAST(value AS TEXT) FROM json_each(${idsJson})
    )`);
  const productsByVariant = new Map(rows.map((row) => [row.variantId, row.productId]));
  return lines.map((line) => ({
    variantId: line.variantId,
    productId: productsByVariant.get(line.variantId) ?? `unavailable:${line.variantId}`,
    quantity: line.quantity,
  }));
}

async function rehydrateAgentStorefrontCart(
  db: Database,
  row: ContextRow,
): Promise<AgentStorefrontCartProjection> {
  const cart = parseAgentStorefrontCartJson(row.cartJson);
  const identityLines = await resolveProductIdsForCart(db, cart);
  const currency = await getCurrencySettings(db);
  const validation = await validateStorefrontCartItems(db, identityLines, {
    currencyCode: currency.currencyCode,
  });

  let delivery: Awaited<ReturnType<typeof validateStorefrontDeliveryPreflight>> | undefined;
  if (
    validation.valid
    && row.cityId
    && row.zoneId
    && row.shippingMethodId
  ) {
    delivery = await validateStorefrontDeliveryPreflight(db, {
      city: row.cityId,
      zone: row.zoneId,
      area: row.areaId,
      shippingMethodId: row.shippingMethodId,
      currencyCode: currency.currencyCode,
    }, validation);
  }

  return {
    context: await projectLiveContext(db, row),
    valid: validation.valid,
    issues: validation.issues,
    items: validation.items,
    subtotal: validation.subtotal,
    hasFreeDeliveryProduct: validation.hasFreeDeliveryProduct,
    ...(delivery ? { delivery } : {}),
  };
}

async function getLiveContextCustomerId(db: Database, row: ContextRow): Promise<string | null> {
  if (!row.customerSessionTokenHash) return null;
  const now = new Date();
  const session = await db.select({ customerId: customerSessions.customerId })
    .from(customerSessions)
    .where(and(
      eq(customerSessions.tokenHash, row.customerSessionTokenHash),
      isNull(customerSessions.revokedAt),
      gt(customerSessions.expiresAt, toEpochSeconds(now)),
    ))
    .get();
  return session?.customerId ?? null;
}

async function getLiveContextCustomerPhone(db: Database, row: ContextRow): Promise<string | null> {
  if (!row.customerSessionTokenHash) return null;
  const now = new Date();
  const session = await db.select({ phone: customers.phone })
    .from(customerSessions)
    .innerJoin(customers, eq(customerSessions.customerId, customers.id))
    .where(and(
      eq(customerSessions.tokenHash, row.customerSessionTokenHash),
      isNull(customerSessions.revokedAt),
      gt(customerSessions.expiresAt, toEpochSeconds(now)),
      isNull(customers.deletedAt),
    ))
    .get();
  return session?.phone ?? null;
}

async function assertAgentStorefrontDiscountValid(
  db: Database,
  row: ContextRow,
  normalizedCode: string,
  customerPhone?: string,
  currentProjection?: AgentStorefrontCartProjection,
): Promise<void> {
  const projection = currentProjection ?? await rehydrateAgentStorefrontCart(db, row);
  if (!projection.valid || projection.items.length === 0) {
    throw new ValidationError("Add valid available items before applying a discount.", {
      itemIssues: projection.issues,
    });
  }
  const currency = await getCurrencySettings(db);
  const decimalPlaces = getDecimalPlaces(currency.currencyCode);
  const shippingAmount = projection.delivery?.shippingCharge ?? 0;
  const effectiveCustomerPhone = customerPhone?.trim()
    || await getLiveContextCustomerPhone(db, row)
    || undefined;
  const contextCustomerId = await getLiveContextCustomerId(db, row);
  const customerId = contextCustomerId
    ?? (effectiveCustomerPhone
      ? await resolvePromotionCustomerIdByPhone(db, effectiveCustomerPhone)
      : null);
  const promotion = await evaluateStorefrontPromotionCode(db, {
    code: normalizedCode,
    customerId,
    cart: {
      currencyCode: currency.currencyCode,
      lines: projection.items.map((item) => ({
        id: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
        productId: item.productId,
        variantId: item.variantId,
        unitPriceMinor: toMinorUnits(item.unitPrice, decimalPlaces),
        quantity: item.quantity,
      })),
      shippingAmountMinor: toMinorUnits(shippingAmount, decimalPlaces),
      evaluatedAtEpochSeconds: Math.floor(Date.now() / 1_000),
    },
  });
  if (promotion.matched) {
    if (!promotion.valid) throw new ValidationError(promotion.message);
    return;
  }
  const items = projection.items.map((item) => ({
    id: item.productId,
    price: item.unitPrice,
    quantity: item.quantity,
    variantId: item.variantId,
  }));
  const legacy = await isDiscountValid(
    db,
    normalizedCode,
    projection.subtotal,
    items,
    effectiveCustomerPhone,
    currency.currencySymbol,
    currency.currencyCode,
    customerId,
  );
  if (!legacy.valid) {
    throw new ValidationError(legacy.error ?? "This discount is invalid or unavailable.");
  }
}

export async function getAgentStorefrontCart(
  db: Database,
  grantId: string,
  contextId: string,
  options: { now?: Date } = {},
): Promise<AgentStorefrontCartProjection> {
  const row = await loadActiveOwnedContext(db, grantId, contextId, options.now ?? new Date());
  return rehydrateAgentStorefrontCart(db, row);
}

export async function validateAgentStorefrontCheckout(
  db: Database,
  grantId: string,
  contextId: string,
  options: { now?: Date; customerPhone?: string | null } = {},
): Promise<AgentStorefrontCartProjection> {
  const now = options.now ?? new Date();
  const row = await loadActiveOwnedContext(db, grantId, contextId, now);
  const projection = await rehydrateAgentStorefrontCart(db, row);
  assertAgentStorefrontCheckoutProjection(projection);
  if (row.discountCode) {
    await assertAgentStorefrontDiscountValid(
      db,
      row,
      row.discountCode,
      options.customerPhone?.trim() || undefined,
      projection,
    );
  }
  return projection;
}

function assertAgentStorefrontCheckoutProjection(
  projection: AgentStorefrontCartProjection,
): void {
  if (projection.context.cart.length === 0) {
    throw new ValidationError("Add at least one item before checkout.");
  }
  if (!projection.valid) {
    throw new ValidationError("Some items in the storefront cart need attention.", {
      itemIssues: projection.issues,
    });
  }
  const delivery = projection.context.delivery;
  if (!delivery.cityId || !delivery.zoneId || !delivery.shippingMethodId) {
    throw new ValidationError("Select a city, zone, and shipping method before checkout.");
  }
  if (!projection.delivery) {
    throw new ValidationError("The delivery selection could not be validated.");
  }
}

function buildPromotionAllocation(
  allocations: Array<{
    target: string;
    lineId?: string | null;
    discountAmountMinor: number;
  }>,
): TaxDiscountAllocationInput {
  const lines = new Map<string, number>();
  let shippingMinor = 0;
  for (const allocation of allocations) {
    if (allocation.target === "shipping") {
      shippingMinor += allocation.discountAmountMinor;
    } else if (allocation.lineId) {
      lines.set(
        allocation.lineId,
        (lines.get(allocation.lineId) ?? 0) + allocation.discountAmountMinor,
      );
    }
  }
  return {
    lines: [...lines.entries()].map(([lineId, amountMinor]) => ({ lineId, amountMinor })),
    shippingMinor,
  };
}

export async function quoteAgentStorefrontCheckout(
  db: Database,
  grantId: string,
  contextId: string,
  input: { customerPhone?: string | null; now?: Date } = {},
): Promise<AgentStorefrontCheckoutQuote> {
  const row = await loadActiveOwnedContext(db, grantId, contextId, input.now ?? new Date());
  const projection = await rehydrateAgentStorefrontCart(db, row);
  assertAgentStorefrontCheckoutProjection(projection);
  const delivery = projection.delivery!;
  const destination = projection.context.delivery;
  const currency = await getCurrencySettings(db);
  const decimalPlaces = getDecimalPlaces(currency.currencyCode);
  const discountCode = row.discountCode?.trim().toUpperCase() ?? null;
  let discountAmount = 0;
  let discountType: StorefrontDiscountType | null = null;
  let applicableProductIds: string[] | undefined;
  let promotionDiscountAllocation: TaxDiscountAllocationInput | undefined;

  if (discountCode) {
    const customerPhone = input.customerPhone?.trim()
      || await getLiveContextCustomerPhone(db, row)
      || undefined;
    const contextCustomerId = await getLiveContextCustomerId(db, row);
    const promotionCustomerId = contextCustomerId
      ?? (customerPhone
        ? await resolvePromotionCustomerIdByPhone(db, customerPhone)
        : null);
    const promotion = await evaluateStorefrontPromotionCode(db, {
      code: discountCode,
      customerId: promotionCustomerId,
      cart: {
        currencyCode: currency.currencyCode,
        lines: projection.items.map((item) => ({
          id: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
          productId: item.productId,
          variantId: item.variantId,
          unitPriceMinor: toMinorUnits(item.unitPrice, decimalPlaces),
          quantity: item.quantity,
        })),
        shippingAmountMinor: toMinorUnits(delivery.shippingCharge, decimalPlaces),
        evaluatedAtEpochSeconds: Math.floor(Date.now() / 1_000),
      },
    });
    if (promotion.matched) {
      if (!promotion.valid) throw new ValidationError(promotion.message);
      promotionDiscountAllocation = buildPromotionAllocation(
        promotion.evaluation.applied.allocations,
      );
      discountAmount = fromMinorUnits(
        promotion.evaluation.applied.totalDiscountMinor,
        decimalPlaces,
      );
    } else {
      const items = projection.items.map((item) => ({
        id: item.productId,
        price: item.unitPrice,
        quantity: item.quantity,
        variantId: item.variantId,
      }));
      const validation = await isDiscountValid(
        db,
        discountCode,
        projection.subtotal,
        items,
        customerPhone,
        currency.currencySymbol,
        currency.currencyCode,
        promotionCustomerId,
      );
      if (!validation.valid || !validation.discount) {
        throw new ValidationError(validation.error ?? "This discount is invalid or unavailable.");
      }
      if (!(["amount_off_products", "amount_off_order", "free_shipping"] as const)
        .includes(validation.discount.type as StorefrontDiscountType)) {
        throw new ValidationError("The discount configuration is invalid.");
      }
      discountType = validation.discount.type as StorefrontDiscountType;
      if (discountType === "amount_off_products") {
        if (
          validation.hasProductRestrictions !== true
          || !(validation.applicableProductIds instanceof Set)
        ) {
          throw new ValidationError("The product discount scope could not be verified.");
        }
        applicableProductIds = [...validation.applicableProductIds];
      }
      discountAmount = await calculateDiscountAmount(
        db,
        validation.discount,
        roundPrice(projection.subtotal + delivery.shippingCharge, currency.currencyCode),
        items,
        delivery.shippingCharge,
        validation.applicableProductIds,
        currency.currencyCode,
        Boolean(validation.hasProductRestrictions),
      );
    }
  }

  const quote = await calculateStorefrontTaxQuote(db, {
    destination: {
      city: destination.cityId!,
      zone: destination.zoneId!,
      area: destination.areaId,
      cityName: delivery.cityName,
      zoneName: delivery.zoneName,
      areaName: delivery.areaName,
    },
    lines: projection.items.map((item) => ({
      lineId: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
      productId: item.productId,
      variantId: item.variantId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      taxClassId: item.taxClassId,
    })),
    shippingAmount: delivery.shippingCharge,
    discountAmount: roundPrice(discountAmount, currency.currencyCode),
    discountType,
    applicableProductIds,
    promotionDiscountAllocation,
    currency: { code: currency.currencyCode, decimalPlaces },
  });
  const toAmount = (minor: number) => fromMinorUnits(minor, quote.decimalPlaces);
  const currentQuoteFingerprint = await buildAgentStorefrontCheckoutQuoteFingerprint({
    contextRevision: row.revision,
    shippingMethodId: destination.shippingMethodId!,
    discountCode,
    quote,
  });
  return {
    valid: true,
    contextRevision: row.revision,
    quoteFingerprint: currentQuoteFingerprint,
    displayLabel: quote.displayLabel,
    pricesIncludeTax: quote.pricesIncludeTax,
    shippingTaxed: quote.shippingTaxed,
    currencyCode: quote.currencyCode,
    decimalPlaces: quote.decimalPlaces,
    settingsVersion: quote.settingsVersion,
    subtotalMinor: quote.subtotalMinor,
    subtotalAmount: toAmount(quote.subtotalMinor),
    shippingMinor: quote.shippingMinor,
    shippingAmount: toAmount(quote.shippingMinor),
    discountMinor: quote.discountMinor,
    discountAmount: toAmount(quote.discountMinor),
    taxMinor: quote.taxMinor,
    taxAmount: toAmount(quote.taxMinor),
    totalMinor: quote.totalMinor,
    totalAmount: toAmount(quote.totalMinor),
    items: projection.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      productName: item.productName,
      variantLabel: item.variantLabel,
    })),
  };
}

const SECRET_KEY_PATTERN = /(?:otp|token|proof|secret|client.?secret|session.?key|redirect.?url|receipt|cs_tok|chk_|cst_)/iu;
const SECRET_VALUE_PATTERN = /(?:\bcs_tok\b|\bchk_[A-Za-z0-9_-]+|\bcst_[A-Za-z0-9_-]+|client.?secret|receipt.?proof|session.?key|one.?time.?code)/iu;

export function parseSafeAgentStorefrontContinuationResult(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (
      typeof entry === "string"
      || typeof entry === "number"
      || typeof entry === "boolean"
      || entry === null
    ) {
      if (typeof entry === "string" && SECRET_VALUE_PATTERN.test(entry)) continue;
      result[key] = entry;
    }
  }
  return result;
}

export async function getAgentStorefrontContinuationStatus(
  db: Database,
  grantId: string,
  contextId: string,
  continuationId: string,
  options: { now?: Date } = {},
): Promise<{
  id: string;
  kind: ContinuationRow["kind"];
  status: ContinuationRow["status"];
  expiresAt: string;
  result: Record<string, unknown> | null;
  message: string;
}> {
  const now = options.now ?? new Date();
  await loadActiveOwnedContext(db, grantId, contextId, now);
  let row = await db.select().from(agentStorefrontContinuations)
    .where(and(
      eq(agentStorefrontContinuations.id, continuationId),
      eq(agentStorefrontContinuations.contextId, contextId),
    ))
    .get();
  if (!row) throw new NotFoundError("Storefront continuation not found.");
  if (row.status === "pending" && row.expiresAt.getTime() <= now.getTime()) {
    const expired = await db.update(agentStorefrontContinuations)
      .set({ status: "expired", bootstrapCodeHash: null, completedAt: now, updatedAt: now })
      .where(and(
        eq(agentStorefrontContinuations.id, row.id),
        eq(agentStorefrontContinuations.contextId, contextId),
        eq(agentStorefrontContinuations.status, "pending"),
      ))
      .returning()
      .get();
    if (expired) row = expired;
  }
  const message = row.status === "pending"
    ? "Complete this step in the secure storefront tab."
    : row.status === "complete"
      ? "The secure storefront step is complete."
      : row.status === "expired"
        ? "This secure storefront step expired. Start it again."
        : "The secure storefront step failed. Start it again.";
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    result: parseSafeAgentStorefrontContinuationResult(row.safeResultJson),
    message,
  };
}

export function getAgentStorefrontContextEpochSummary(view: AgentStorefrontContextView): {
  expiresAt: number;
  lastUsedAt: number;
} {
  return {
    expiresAt: toEpochSeconds(new Date(view.expiresAt)),
    lastUsedAt: toEpochSeconds(new Date(view.lastUsedAt)),
  };
}
