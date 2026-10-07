import type { Database } from "@scalius/database/client";
import type { AppProviders } from "../../integrations/provider-port";
import {
  agentStorefrontContexts,
  agentStorefrontContinuations,
  customers,
  customerSessions,
  productVariants,
} from "@scalius/database/schema";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@scalius/core/errors";
import {
  assertNoCheckoutRuleErrors,
  DELIVERY_ADDRESS_REQUIRED_REASON,
  NO_CHECKOUT_APP_FUNCTIONS,
  presentCheckoutRateOptions,
  previewStorefrontAppDiscounts,
  priceStorefrontCheckout,
  resolveAppPaymentMethods,
  resolveBundlePromotionInterplay,
  resolveCartPaymentMethods,
  presentStorefrontCartValidation,
  presentStorefrontDeliveryPreflight,
  summarizeStorefrontCartFulfilment,
  validateStorefrontCartItems,
  validateStorefrontDeliveryPreflight,
  type CheckoutAppFunctions,
  type StorefrontCartItemIssue,
} from "@scalius/core/modules/checkout";
import { priceIncrementForCurrency } from "@scalius/core/modules/settings";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { assertDiscountCodesApplied, quoteStorefrontDiscount } from "@scalius/core/modules/promotions";
import { buildStorefrontTaxAllocationLineId } from "@scalius/core/modules/tax";
import { BUILT_IN_PAYMENT_PROVIDERS, getActivePaymentMethods, type PaymentProviders } from "../payments";
import { fromMinor } from "@scalius/shared/money";
import { DELIVERY_HIERARCHY_COUNTRY } from "@scalius/shared/markets";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  addAgentStorefrontCartLine,
  agentContextBillingLocation,
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
import { billingTaxLocation } from "../orders";

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
  /** The delivery selection; `countryCode` is BD unless another country was set. */
  delivery: Required<AgentStorefrontDeliverySelection> & { countryCode: string };
  customerAuthorized: boolean;
  expiresAt: string;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
}

type CartValidation = Awaited<ReturnType<typeof validateStorefrontCartItems>>;
type DeliveryPreflight = Awaited<ReturnType<typeof validateStorefrontDeliveryPreflight>>;

/** Cart state in integer minor units of the store currency. */
interface AgentStorefrontCartState {
  context: AgentStorefrontContextView;
  valid: boolean;
  issues: CartValidation["issues"];
  items: CartValidation["items"];
  subtotalMinor: number;
  hasFreeDeliveryProduct: boolean;
  delivery?: DeliveryPreflight;
  /** The cart's currency and its rate (MARKETS-DESIGN step 6). */
  money: CartValidation["money"];
  currencyCode: string;
  decimalPlaces: number;
}

/** The decimal cart projection agents read. */
export type AgentStorefrontCartProjection = ReturnType<typeof presentAgentStorefrontCart>;

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
  /** Installed apps' discounts in `discountMinor`, after the store's own (checkout functions). */
  appDiscounts: Array<{
    appId: string;
    title: string;
    code: string | null;
    /** Off the items. */
    amount: number;
    amountMinor: number;
    /** Off delivery. */
    shippingAmount: number;
    shippingAmountMinor: number;
  }>;
  /** The delivery options when an app changed them (hid, renamed, priced, reordered); null when none did. */
  shippingRates: Array<{ id: string; name: string; kind: "delivery" | "pickup"; amount: number; amountMinor: number }> | null;
  /**
   * The payment methods submit accepts when an app or the delivery country
   * changed them (cash on delivery serves Bangladesh); null when none did.
   */
  paymentMethods: Array<{ id: string; name: string }> | null;
}

/**
 * Agent carts are `{variantId, quantity}` and never carry buyer inputs, so a
 * product whose buyer inputs include a required field cannot be bought
 * through one (Wave A §3.2).
 */
export const AGENT_STOREFRONT_NEEDS_CUSTOMIZATION = "needs_customization" as const;

export type AgentStorefrontCartIssue = Omit<StorefrontCartItemIssue, "code" | "action"> & {
  code: StorefrontCartItemIssue["code"] | typeof AGENT_STOREFRONT_NEEDS_CUSTOMIZATION;
  action: StorefrontCartItemIssue["action"];
};

/** Cart issues as agents read them: a missing required buyer input becomes `needs_customization`. */
export function presentAgentStorefrontCartIssues(
  issues: readonly StorefrontCartItemIssue[],
): AgentStorefrontCartIssue[] {
  return issues.map((issue) => {
    if (issue.code !== "PROPERTIES_REQUIRED") return issue;
    const name = issue.productName ?? "This product";
    return {
      ...issue,
      code: AGENT_STOREFRONT_NEEDS_CUSTOMIZATION,
      action: "remove",
      message: `${name} asks for details the buyer enters on its product page, so an agent cart cannot hold it. Remove it, or send the buyer to the product page.`,
    };
  });
}

function isDeliveryAddressRequired(error: unknown): boolean {
  return error instanceof ValidationError
    && (error.details as { reason?: unknown } | undefined)?.reason === DELIVERY_ADDRESS_REQUIRED_REASON;
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
      // Null in the row is Bangladesh, as before markets.
      countryCode: row.countryCode ?? DELIVERY_HIERARCHY_COUNTRY,
      cityId: row.cityId,
      zoneId: row.zoneId,
      areaId: row.areaId,
      adminArea: row.adminArea,
      postalCode: row.postalCode,
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
    const currency = await readStoreCurrency(db);
    const proposedValidation = await validateStorefrontCartItems(db, proposedIdentity, {
      currencyCode: currency.code,
      priceIncrementMinor: currency.priceIncrementMinor,
      market: agentCartMarket(db, current),
    });
    if (!proposedValidation.valid) {
      throw new ValidationError("The proposed storefront cart is not currently valid.", {
        itemIssues: presentAgentStorefrontCartIssues(proposedValidation.issues),
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
  options: { now?: Date; customerPhone?: string | null; apps?: CheckoutAppFunctions } = {},
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
      undefined,
      options.apps,
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
  const cart = await loadAgentStorefrontCart(db, current);
  if (!cart.valid) {
    throw new ValidationError("Some items in the storefront cart need attention.", {
      itemIssues: presentAgentStorefrontCartIssues(cart.issues),
    });
  }
  // A pickup rate is checked without an address; a delivery rate must be a
  // rate of the destination's shipping zone (in Bangladesh it still needs
  // its city and thana; the preflight refuses it otherwise).
  if (normalized.shippingMethodId || (normalized.cityId && normalized.zoneId)) {
    await validateStorefrontDeliveryPreflight(db, {
      shippingCountryCode: normalized.countryCode,
      city: normalized.cityId,
      zone: normalized.zoneId,
      area: normalized.areaId,
      shippingAdminArea: normalized.adminArea,
      shippingPostalCode: normalized.postalCode,
      shippingMethodId: normalized.shippingMethodId,
    }, cart);
  }
  const row = await mutateContext(db, {
    grantId,
    contextId,
    expectedRevision,
    now,
    current,
    buildUpdate: () => ({
      countryCode: normalized.countryCode,
      cityId: normalized.cityId,
      zoneId: normalized.zoneId,
      areaId: normalized.areaId,
      adminArea: normalized.adminArea,
      postalCode: normalized.postalCode,
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

/**
 * The market an agent cart prices in: the order's market, as agent checkout
 * prices it (MARKETS-DESIGN D5): the context's country ships a physical cart
 * and bills one with nothing physical. The signed-in buyer (segment price
 * lists) is read only when a segment list applies.
 */
function agentCartMarket(db: Database, row: ContextRow) {
  let customer: Promise<string | null> | null = null;
  return {
    placing: true,
    shippingCountryCode: row.countryCode,
    billingCountryCode: row.countryCode,
    customerId: {
      then<TResult1 = string | null, TResult2 = never>(
        onFulfilled?: ((value: string | null) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        customer ??= getLiveContextCustomerId(db, row);
        return customer.then(onFulfilled, onRejected);
      },
    },
  };
}

async function loadAgentStorefrontCart(
  db: Database,
  row: ContextRow,
): Promise<AgentStorefrontCartState> {
  const cart = parseAgentStorefrontCartJson(row.cartJson);
  const identityLines = await resolveProductIdsForCart(db, cart);
  const currency = await readStoreCurrency(db);
  const validation = await validateStorefrontCartItems(db, identityLines, {
    currencyCode: currency.code,
    priceIncrementMinor: currency.priceIncrementMinor,
    market: agentCartMarket(db, row),
  });

  // Same rule as storefront checkout: a physical line needs one method (a
  // pickup rate needs no address); a cart with nothing physical needs none.
  let delivery: DeliveryPreflight | undefined;
  const requiresDeliveryMethod = summarizeStorefrontCartFulfilment(validation, null).requiresDeliveryMethod;
  if (
    validation.valid
    && validation.items.length > 0
    && (!requiresDeliveryMethod || row.shippingMethodId)
  ) {
    try {
      delivery = await validateStorefrontDeliveryPreflight(db, {
        shippingCountryCode: row.countryCode,
        city: row.cityId,
        zone: row.zoneId,
        area: row.areaId,
        shippingAdminArea: row.adminArea,
        shippingPostalCode: row.postalCode,
        shippingMethodId: row.shippingMethodId,
      }, validation);
    } catch (error) {
      // A delivery rate saved while the cart had nothing physical: the cart
      // now needs its address; checkout asks for it.
      if (!isDeliveryAddressRequired(error)) throw error;
    }
  }

  return {
    context: await projectLiveContext(db, row),
    valid: validation.valid,
    issues: validation.issues,
    items: validation.items,
    subtotalMinor: validation.subtotalMinor,
    hasFreeDeliveryProduct: validation.hasFreeDeliveryProduct,
    ...(delivery ? { delivery } : {}),
    // The cart's currency: its market's (MARKETS-DESIGN step 6).
    money: validation.money,
    currencyCode: validation.money.currencyCode,
    decimalPlaces: validation.money.decimalPlaces,
  };
}

function presentAgentStorefrontCart(state: AgentStorefrontCartState) {
  const { context, delivery, currencyCode: _currencyCode, decimalPlaces, ...cart } = state;
  return {
    context,
    ...presentStorefrontCartValidation(cart, decimalPlaces, delivery?.fulfilment),
    issues: presentAgentStorefrontCartIssues(cart.issues),
    ...(delivery ? { delivery: presentStorefrontDeliveryPreflight(delivery, decimalPlaces) } : {}),
  };
}

async function rehydrateAgentStorefrontCart(
  db: Database,
  row: ContextRow,
): Promise<AgentStorefrontCartProjection> {
  return presentAgentStorefrontCart(await loadAgentStorefrontCart(db, row));
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

/**
 * The one storefront discount path; throws the buyer-facing reason when the
 * code fails. A code only an app answers to (checkout functions, channel
 * "agent") is not "not found": the apps' discount preview claims it, as the
 * storefront's discount preview does. The checkout quote prices it.
 */
async function quoteAgentStorefrontDiscount(
  db: Database,
  row: ContextRow,
  projection: AgentStorefrontCartState,
  code: string | null,
  customerPhone?: string | null,
  apps: CheckoutAppFunctions = NO_CHECKOUT_APP_FUNCTIONS,
) {
  const lines = projection.items.map((item) => ({
    id: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
    productId: item.productId,
    variantId: item.variantId,
    unitPriceMinor: item.unitPriceMinor,
    quantity: item.quantity,
    // Gift-card lines are outside every promotion (Wave B §4.2).
    ...(item.isGiftCard ? { giftCard: true } : {}),
  }));
  const shippingMinor = projection.delivery?.shippingMinor ?? 0;
  // Only a context bound to a live customer session counts as signed in.
  const signedInCustomerId = await getLiveContextCustomerId(db, row);
  const quote = await quoteStorefrontDiscount(db, {
    codes: code ? [code] : [],
    customerId: signedInCustomerId,
    segmentCustomerId: signedInCustomerId,
    customerPhone: customerPhone?.trim() || await getLiveContextCustomerPhone(db, row),
    // The cart's currency (its market's); a promotion's shop amounts convert at its rate.
    cart: {
      currencyCode: projection.money.currencyCode,
      priceIncrementMinor: projection.money.incrementMinor,
      lines,
      shippingAmountMinor: shippingMinor,
      ...(projection.money.currencyCode !== projection.money.shopCurrencyCode ? { money: projection.money } : {}),
    },
  });
  const unknownCode = quote.rejectedCodes.some((rejection) => rejection.reason === "not_found");
  if (!code || !unknownCode || !apps.points.has("checkout.discounts")) {
    assertDiscountCodesApplied(quote);
    return quote;
  }
  const interplay = resolveBundlePromotionInterplay(
    projection.items.map((item, position) => ({
      lineId: lines[position]!.id,
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      bundleDiscountMinor: item.bundleDiscountMinor ?? 0,
    })),
    quote,
  );
  const preview = await previewStorefrontAppDiscounts(db, {
    apps,
    currency: {
      code: projection.money.currencyCode,
      decimalPlaces: projection.money.decimalPlaces,
      priceIncrementMinor: projection.money.incrementMinor,
    },
    lines: lines.map((line) => ({
      lineId: line.id,
      productId: line.productId,
      variantId: line.variantId,
      unitPriceMinor: line.unitPriceMinor,
      quantity: line.quantity,
      ...(line.giftCard ? { giftCard: true } : {}),
    })),
    platformAllocation: interplay.allocation,
    shippingMinor,
    discountCodes: [code],
    channel: "agent",
  });
  const claimed = new Set(preview?.claimedCodes ?? []);
  const checked = {
    ...quote,
    rejectedCodes: quote.rejectedCodes.filter((rejection) =>
      !(rejection.reason === "not_found" && claimed.has(rejection.code.trim().toUpperCase()))),
  };
  assertDiscountCodesApplied(checked);
  return checked;
}

async function assertAgentStorefrontDiscountValid(
  db: Database,
  row: ContextRow,
  normalizedCode: string,
  customerPhone?: string,
  currentCart?: AgentStorefrontCartState,
  apps?: CheckoutAppFunctions,
): Promise<void> {
  const projection = currentCart ?? await loadAgentStorefrontCart(db, row);
  if (!projection.valid || projection.items.length === 0) {
    throw new ValidationError("Add valid available items before applying a discount.", {
      itemIssues: presentAgentStorefrontCartIssues(projection.issues),
    });
  }
  await quoteAgentStorefrontDiscount(db, row, projection, normalizedCode, customerPhone, apps);
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
  options: { now?: Date; customerPhone?: string | null; apps?: CheckoutAppFunctions } = {},
): Promise<AgentStorefrontCartProjection> {
  const now = options.now ?? new Date();
  const row = await loadActiveOwnedContext(db, grantId, contextId, now);
  const cart = await loadAgentStorefrontCart(db, row);
  assertAgentStorefrontCheckoutProjection(cart);
  if (row.discountCode) {
    await assertAgentStorefrontDiscountValid(
      db,
      row,
      row.discountCode,
      options.customerPhone?.trim() || undefined,
      cart,
      options.apps,
    );
  }
  return presentAgentStorefrontCart(cart);
}

function assertAgentStorefrontCheckoutProjection(
  projection: AgentStorefrontCartState,
): void {
  if (projection.context.cart.length === 0) {
    throw new ValidationError("Add at least one item before checkout.");
  }
  if (!projection.valid) {
    throw new ValidationError("Some items in the storefront cart need attention.", {
      itemIssues: presentAgentStorefrontCartIssues(projection.issues),
    });
  }
  if (!projection.delivery) {
    // Only a cart with a physical line gets here: it needs one method.
    throw new ValidationError(projection.context.delivery.shippingMethodId
      ? projection.context.delivery.countryCode === DELIVERY_HIERARCHY_COUNTRY
        ? "Select a city and zone for this delivery method, or choose a pickup method."
        : "Set the delivery address for this delivery method, or choose a pickup method."
      : "Select a delivery or pickup method before checkout.");
  }
}

export async function quoteAgentStorefrontCheckout(
  db: Database,
  grantId: string,
  contextId: string,
  input: {
    customerPhone?: string | null;
    now?: Date;
    /** The apps' checkout functions, channel "agent" (none: platform pricing only). */
    apps?: CheckoutAppFunctions;
    /** Reads the enabled payment methods, only when an app adjusts them or the delivery is abroad. */
    credentialEncryptionKey?: string;
    /** The request's gateways (built-in and active app providers); built-in ones alone by default. */
    paymentProviders?: PaymentProviders;
    /** The request's app providers (an app tax provider). */
    appProviders?: AppProviders;
  } = {},
): Promise<AgentStorefrontCheckoutQuote> {
  const row = await loadActiveOwnedContext(db, grantId, contextId, input.now ?? new Date());
  const projection = await loadAgentStorefrontCart(db, row);
  assertAgentStorefrontCheckoutProjection(projection);
  const delivery = projection.delivery!;
  const discountCode = row.discountCode?.trim().toUpperCase() ?? null;
  const apps = input.apps ?? NO_CHECKOUT_APP_FUNCTIONS;
  const customerId = await getLiveContextCustomerId(db, row);
  const customerPhone = input.customerPhone?.trim() || await getLiveContextCustomerPhone(db, row);
  // Promotions or bundles, then the apps, then tax: the one rule the
  // storefront quote and the submitted order use (checkout/pricing.ts), so
  // the reviewed fingerprint is the committed one.
  const pricing = await priceStorefrontCheckout(db, {
    cartValidation: projection,
    delivery,
    discountCodes: discountCode ? [discountCode] : [],
    customerId,
    customerPhone,
    currency: {
      code: projection.currencyCode,
      decimalPlaces: projection.decimalPlaces,
      priceIncrementMinor: priceIncrementForCurrency(await readStoreCurrency(db), projection.currencyCode),
    },
    apps,
    appProviders: input.appProviders,
    channel: "agent",
    // A cart with nothing physical is taxed at its billing location: the
    // context's country, region and postal code, as submit bills it.
    billing: (() => {
      const location = agentContextBillingLocation(row);
      return location ? billingTaxLocation(location) : null;
    })(),
    // Submit lists delivery options from the order's own address (none for pickup), so the quote does too.
    location: null,
  });
  assertNoCheckoutRuleErrors(pricing.ruleErrors);
  assertDiscountCodesApplied(pricing.typedCodes);
  const quote = pricing.taxQuote;
  // Apps narrow and present the methods submit accepts (read only when an
  // app adjusts them, or when a delivery abroad may rule a method out:
  // cash on delivery serves Bangladesh).
  const paymentProviders = input.paymentProviders ?? BUILT_IN_PAYMENT_PROVIDERS;
  const deliveryCountry = delivery.address?.countryCode ?? null;
  const abroad = deliveryCountry !== null && deliveryCountry !== DELIVERY_HIERARCHY_COUNTRY;
  // A market's own currency may rule a gateway out (`chargeCurrencies`, MARKETS-DESIGN step 6).
  const foreignCurrency = quote.currencyCode !== projection.money.shopCurrencyCode;
  let payment: { methods: Array<{ methodId: string; name: string }>; changed: boolean } | null = null;
  if (apps.points.has("checkout.payment_methods") || abroad || foreignCurrency) {
    const enabled = (await getActivePaymentMethods(db, input.credentialEncryptionKey, paymentProviders)).enabledMethods;
    const allowed = resolveCartPaymentMethods(enabled, delivery.fulfilment, deliveryCountry, paymentProviders, quote.currencyCode);
    payment = await resolveAppPaymentMethods(apps, pricing.appCart, allowed, paymentProviders);
    const withoutCountry = resolveCartPaymentMethods(enabled, delivery.fulfilment);
    if (allowed.length !== withoutCountry.length) payment = { ...payment, changed: true };
  }
  const toAmount = (minor: number) => fromMinor(minor, quote.decimalPlaces);
  const currentQuoteFingerprint = await buildAgentStorefrontCheckoutQuoteFingerprint({
    contextRevision: row.revision,
    shippingMethodId: delivery.shippingMethod?.id ?? null,
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
      unitPrice: toAmount(item.unitPriceMinor),
      productName: item.productName,
      variantLabel: item.variantLabel,
    })),
    appDiscounts: pricing.appDiscounts.map((discount) => ({
      appId: discount.pluginId,
      title: discount.title,
      code: discount.code,
      amount: toAmount(discount.amountMinor),
      amountMinor: discount.amountMinor,
      shippingAmount: toAmount(discount.shippingAmountMinor),
      shippingAmountMinor: discount.shippingAmountMinor,
    })),
    shippingRates: pricing.shippingRates ? presentCheckoutRateOptions(pricing.shippingRates, quote.decimalPlaces) : null,
    paymentMethods: payment?.changed
      ? payment.methods.map((method) => ({ id: method.methodId, name: method.name }))
      : null,
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
