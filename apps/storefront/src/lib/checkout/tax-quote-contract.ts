import {
  isDeliveryMethodKind,
  isFulfillmentType,
  type DeliveryMethodKind,
  type FulfillmentType,
} from "@scalius/shared/fulfilment";
import { buyerUiBlockSchema, checkoutAttributesSchema, type BuyerUiBlock } from "@scalius/shared/plugins/buyer-ui";
import { LINE_PROPERTY_INPUT_LIMITS } from "@scalius/shared/line-properties";
import { GIFT_CARD_HANDLE_PATTERN, MAX_GIFT_CARDS_PER_ORDER } from "./gift-cards";

export const TAX_QUOTE_MAX_ITEMS = 99;
export const TAX_QUOTE_MAX_REQUEST_BYTES = 256 * 1024;
export const TAX_QUOTE_MAX_RESPONSE_BYTES = 256 * 1024;

const MAX_ID_LENGTH = 180;
const MAX_CART_KEY_LENGTH = 256;
const MAX_NAME_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;
const MAX_LOCATION_LENGTH = 180;
const MAX_CODE_LENGTH = 50;
/** Mirrors the API's `MAX_SUBMITTED_DISCOUNT_CODES`. */
const MAX_DISCOUNT_CODES = 5;
const MAX_PHONE_LENGTH = 16;
const MAX_DISPLAY_LABEL_LENGTH = 80;
const MAX_SHIPPING_METHOD_NAME_LENGTH = 100;
const MAX_SHIPPING_METHOD_DESCRIPTION_LENGTH = 255;
const MAX_QUANTITY = 99;
/** Bounds for the options and methods a store app leaves on a quote. */
const MAX_QUOTED_SHIPPING_RATES = 100;
const MAX_QUOTED_PAYMENT_METHODS = 32;
const MAX_PAYMENT_METHOD_ID_LENGTH = 64;
const MAX_PAYMENT_METHOD_NAME_LENGTH = 100;
const MAX_MAJOR_AMOUNT = 1_000_000_000_000;
const FINGERPRINT_PATTERN = /^taxq_[A-Za-z0-9_-]{22}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export type TaxQuoteInventoryPool = "regular" | "preorder" | "backorder";

export interface TaxQuoteRequestItem {
  cartKey?: string;
  productId: string;
  variantId: string;
  quantity: number;
  productName?: string;
  variantLabel?: string;
  /** Buyer inputs (body only, never a URL). */
  properties?: Array<{ key: string; value: string }>;
}

export interface TaxQuoteRequest {
  attributes?: Record<string, string>;
  items: TaxQuoteRequestItem[];
  inventoryPool?: TaxQuoteInventoryPool;
  /** Delivery only; pickup and carts with nothing physical send no address. */
  city?: string;
  zone?: string;
  area?: string;
  /**
   * Delivery outside Bangladesh: the country and, when known, its admin
   * area and postal code (its shipping zone matches on them). A Bangladesh
   * address sends none of them, as before.
   */
  shippingCountryCode?: string;
  shippingAdminArea?: string;
  shippingPostalCode?: string;
  /**
   * A cart with nothing physical: its billing country and, when given, its
   * region and postal code (it is taxed there).
   */
  billingCountryCode?: string;
  billingAdminArea?: string;
  billingPostalCode?: string;
  /** A delivery or pickup rate; absent when nothing is physical. */
  shippingMethodId?: string;
  shippingRateToken?: string;
  cod?: boolean;
  discountCodes: string[];
  customerPhone?: string;
  /** Applied gift cards by apply handle (never a code); absent without cards. */
  giftCards?: Array<{ handle: string }>;
}

/** A buyer input as the order will keep it. */
export interface TaxQuoteItemProperty {
  key: string;
  label: string;
  value: string;
  displayValue: string;
  priceMinor: number;
}

export interface TaxQuoteItem {
  cartKey: string;
  productId: string;
  variantId: string;
  quantity: number;
  /** One unit including the surcharges of its buyer inputs. */
  unitPrice: number;
  productName: string;
  variantLabel: string | null;
  fulfillmentType: FulfillmentType | null;
  properties: TaxQuoteItemProperty[];
  propertiesPriceMinor: number;
  propertiesHash: string | null;
}

export interface TaxQuotePickup {
  address: string | null;
  hours: string | null;
}

export interface TaxQuoteShippingMethod {
  id: string;
  name: string;
  description: string | null;
  baseAmountMinor: number;
  feeWaived: boolean;
}

/**
 * One line per applied discount (automatic by title, codes with their code).
 * A discount a store app gave has no promotion: `promotionId` is null and
 * `appId` names the app (present only then).
 */
export interface CheckoutDiscountLine {
  promotionId: string | null;
  appId?: string | null;
  title: string;
  code: string | null;
  /** Off the items: a discount line. */
  amount: number;
  /** Off delivery: shown on the delivery line, never as a discount line. */
  shippingAmount: number;
  /** A code only: the automatic discount it replaced (it saves more; they can't be combined). */
  replaces?: string;
}

/**
 * A stable identity for a discount line in a rendered list: its promotion, or
 * for an app's discount the app and the line's position in the quote.
 */
export function discountLineKey(
  line: Pick<CheckoutDiscountLine, "promotionId" | "appId">,
  position: number,
): string {
  return line.promotionId ?? `app:${line.appId ?? ""}:${position}`;
}

/**
 * A delivery or pickup option as a store app left it on this quote: shown in
 * this order, with this name and this fee (what the buyer pays, platform
 * free-delivery waivers already applied).
 */
export interface QuotedShippingRate {
  id: string;
  name: string;
  kind: "delivery" | "pickup";
  amount: number;
  amountMinor: number;
}

/** A payment method as a store app left it on this quote: shown in this order, with this name. */
export interface QuotedPaymentMethod {
  id: string;
  name: string;
}

export interface CheckoutOfferProduct {
  id: string;
  slug: string;
  name: string;
  /** Set for simple products: they can be added in one tap. */
  variantId: string | null;
  price: number | null;
}

/** A Buy X get Y the buyer completes by adding items. */
export interface CheckoutDiscountOffer {
  promotionId: string;
  title: string;
  code: string | null;
  kind: "get" | "buy";
  percentOff: number;
  quantity: number;
  shortfallAmount: number | null;
  products: CheckoutOfferProduct[];
}

export type CheckoutRejectedCodeReason =
  | "not_found"
  | "needs_phone"
  | "minimum_subtotal"
  | "minimum_quantity"
  | "get_items"
  | "buy_items"
  | "not_combinable"
  | "lower_savings"
  | "needs_delivery"
  | "delivery_discount_applied"
  | "unavailable";

/** An applied code that adds nothing right now, with why and what to do. */
export interface CheckoutRejectedCode {
  code: string;
  reason: CheckoutRejectedCodeReason;
  message: string;
  shortfallAmount?: number;
  shortfallQuantity?: number;
  conflictsWith?: string;
  offer?: CheckoutDiscountOffer;
  requiresCustomerPhone?: boolean;
  /** The code applies, but the quantity-bundle saving is bigger, so the bundle is used. */
  bundleSavesMore?: true;
}

export interface CheckoutDiscountFacts {
  discounts: CheckoutDiscountLine[];
  /** Automatic Buy X get Y the buyer earned: the items to get are not in the cart yet. */
  offers: CheckoutDiscountOffer[];
  rejectedCodes: CheckoutRejectedCode[];
}

/** What one applied gift card pays on this quote. */
export interface TaxQuoteGiftCardTender {
  handle: string;
  last4: string;
  applied: number;
  appliedMinor: number;
  /** The card's balance as the quote read it. */
  balance: number;
  balanceMinor: number;
}

/** A card the quote could not use (`handle` null for a problem with the cards as a whole). */
export interface TaxQuoteGiftCardIssue {
  handle: string | null;
  code: string;
  message: string;
}

/** The gift-card tender on a quote; present whenever the API reports it. */
export interface CheckoutGiftCardQuoteFacts {
  giftCardTenders?: TaxQuoteGiftCardTender[];
  giftCardIssues?: TaxQuoteGiftCardIssue[];
  /** Total minus gift cards: what cash on delivery or a gateway collects. */
  amountDue?: number;
  amountDueMinor?: number;
}

export interface CheckoutTaxQuote extends CheckoutDiscountFacts, CheckoutGiftCardQuoteFacts {
  buyerUi?: BuyerUiBlock[];
  valid: true;
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
  /** Null when the cart has nothing physical (no delivery method, no fee). */
  shippingMethod: TaxQuoteShippingMethod | null;
  shippingRateToken?: string | null;
  deliveryMethodKind: DeliveryMethodKind | null;
  /** Some line ships: the order needs the delivery address. */
  requiresShipping: boolean;
  /** Where and when to collect, for a pickup method. */
  pickup: TaxQuotePickup | null;
  /** Payment methods this cart may use (no cash on delivery when nothing is handed over). */
  allowedPaymentMethods: string[];
  /**
   * The delivery options to show, when a store app changed them (absent when
   * none did: the options stay as read from the store).
   */
  shippingRates?: QuotedShippingRate[] | null;
  /** The payment methods to show, when a store app changed them (absent when none did). */
  paymentMethods?: QuotedPaymentMethod[] | null;
  items: TaxQuoteItem[];
}

export class TaxQuoteContractError extends Error {
  constructor() {
    super("The checkout total response did not match the expected contract.");
    this.name = "TaxQuoteContractError";
  }
}

function fail(): never {
  throw new TaxQuoteContractError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") fail();
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    hasControlCharacter(normalized)
  ) {
    fail();
  }
  return normalized;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, maxLength);
}

function nullableString(value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  return requiredString(value, maxLength);
}

function nullableDescription(value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) fail();
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if ((code <= 31 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      fail();
    }
  }
  return normalized;
}

function positiveQuantity(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_QUANTITY
  ) {
    fail();
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail();
  }
  return value;
}

function nonNegativeAmount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_MAJOR_AMOUNT
  ) {
    fail();
  }
  return value;
}

const PROPERTY_KEY_PATTERN = /^[a-z0-9_]{1,40}$/;

/** Buyer inputs as the API accepts them: at most 10, text keys and values, bounded. */
export function parseRequestProperties(value: unknown): Array<{ key: string; value: string }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > LINE_PROPERTY_INPUT_LIMITS.entries) fail();
  const properties = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      !PROPERTY_KEY_PATTERN.test(entry.key) ||
      typeof entry.value !== "string" ||
      entry.value.length > LINE_PROPERTY_INPUT_LIMITS.valueLength
    ) {
      fail();
    }
    return { key: entry.key, value: entry.value };
  });
  return properties.length > 0 ? properties : undefined;
}

function parseRequestItem(value: unknown): TaxQuoteRequestItem {
  if (!isRecord(value)) fail();
  const cartKey = optionalString(value.cartKey, MAX_CART_KEY_LENGTH);
  const productName = optionalString(value.productName, MAX_NAME_LENGTH);
  const variantLabel = optionalString(value.variantLabel, MAX_LABEL_LENGTH);
  const variantId = requiredString(value.variantId, MAX_ID_LENGTH);
  if (variantId === "default") fail();
  const properties = parseRequestProperties(value.properties);

  return {
    ...(cartKey ? { cartKey } : {}),
    productId: requiredString(value.productId, MAX_ID_LENGTH),
    variantId,
    quantity: positiveQuantity(value.quantity),
    ...(productName ? { productName } : {}),
    ...(variantLabel ? { variantLabel } : {}),
    ...(properties ? { properties } : {}),
  };
}

/** Buyer fields travel only in bodies; form handoffs serialize the same bounded map. */
export function parseCheckoutAttributes(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { fail(); }
  }
  const parsed = checkoutAttributesSchema.safeParse(value);
  if (!parsed.success) fail();
  return Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
}

export function normalizeTaxQuoteRequest(value: unknown): TaxQuoteRequest {
  if (!isRecord(value) || !Array.isArray(value.items)) fail();
  if (value.items.length === 0 || value.items.length > TAX_QUOTE_MAX_ITEMS) fail();

  const inventoryPool = value.inventoryPool;
  if (
    inventoryPool !== undefined &&
    inventoryPool !== "regular" &&
    inventoryPool !== "preorder" &&
    inventoryPool !== "backorder"
  ) {
    fail();
  }

  const city = optionalString(value.city, MAX_LOCATION_LENGTH);
  const zone = optionalString(value.zone, MAX_LOCATION_LENGTH);
  // A Bangladesh delivery quote names both; pickup and service quotes name neither.
  if (Boolean(city) !== Boolean(zone)) fail();
  const area = city ? optionalString(value.area, MAX_LOCATION_LENGTH) : undefined;
  const shippingMethodId = optionalString(value.shippingMethodId, MAX_ID_LENGTH);
  const shippingRateToken = optionalString(value.shippingRateToken, 2048);
  if (value.cod !== undefined && typeof value.cod !== "boolean") fail();
  if (city && !shippingMethodId) fail();
  // Another country's delivery: its country, admin area and postal code, never Bangladesh's ids.
  const country = optionalString(value.shippingCountryCode, 2)?.toUpperCase();
  if (country !== undefined && !/^[A-Z]{2}$/.test(country)) fail();
  const foreign = country !== undefined && country !== "BD";
  if (foreign && city) fail();
  const shippingAdminArea = foreign ? optionalString(value.shippingAdminArea, 120) : undefined;
  const shippingPostalCode = foreign ? optionalString(value.shippingPostalCode, 20) : undefined;
  // A cart with nothing physical: its billing location (never with a delivery).
  const billingCountry = optionalString(value.billingCountryCode, 2)?.toUpperCase();
  if (billingCountry !== undefined && (!/^[A-Z]{2}$/.test(billingCountry) || city || shippingMethodId)) fail();
  const billingAdminArea = billingCountry ? optionalString(value.billingAdminArea, 120) : undefined;
  const billingPostalCode = billingCountry ? optionalString(value.billingPostalCode, 20) : undefined;
  const codes = value.discountCodes ?? [];
  if (!Array.isArray(codes) || codes.length > MAX_DISCOUNT_CODES) fail();
  const discountCodes = codes.map((code) => requiredString(code, MAX_CODE_LENGTH).toUpperCase());
  const customerPhone = optionalString(value.customerPhone, MAX_PHONE_LENGTH);
  if (customerPhone && customerPhone.length < 7) fail();
  const giftCards = parseRequestGiftCards(value.giftCards);
  const attributes = parseCheckoutAttributes(value.attributes);

  return {
    items: value.items.map(parseRequestItem),
    ...(inventoryPool ? { inventoryPool } : {}),
    ...(city && zone ? { city, zone } : {}),
    ...(area ? { area } : {}),
    ...(foreign ? { shippingCountryCode: country } : {}),
    ...(shippingAdminArea ? { shippingAdminArea } : {}),
    ...(shippingPostalCode ? { shippingPostalCode } : {}),
    ...(billingCountry ? { billingCountryCode: billingCountry } : {}),
    ...(billingAdminArea ? { billingAdminArea } : {}),
    ...(billingPostalCode ? { billingPostalCode } : {}),
    ...(shippingMethodId ? { shippingMethodId } : {}),
    ...(shippingRateToken ? { shippingRateToken } : {}),
    ...(value.cod === undefined ? {} : { cod: value.cod as boolean }),
    discountCodes: [...new Set(discountCodes)],
    ...(customerPhone ? { customerPhone } : {}),
    ...(giftCards ? { giftCards } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

/** `giftCards: [{handle}]`, at most five distinct handles; undefined when none. */
export function parseRequestGiftCards(value: unknown): Array<{ handle: string }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_GIFT_CARDS_PER_ORDER) fail();
  const handles = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.handle !== "string" || !GIFT_CARD_HANDLE_PATTERN.test(entry.handle)) fail();
    return entry.handle;
  });
  if (new Set(handles).size !== handles.length) fail();
  return handles.length > 0 ? handles.map((handle) => ({ handle })) : undefined;
}

function parseQuoteItem(value: unknown): TaxQuoteItem {
  if (!isRecord(value)) fail();
  const variantId = requiredString(value.variantId, MAX_ID_LENGTH);
  if (variantId === "default") fail();

  const properties = value.properties === undefined ? [] : value.properties;
  if (!Array.isArray(properties) || properties.length > LINE_PROPERTY_INPUT_LIMITS.entries) fail();

  return {
    cartKey: requiredString(value.cartKey, MAX_CART_KEY_LENGTH),
    productId: requiredString(value.productId, MAX_ID_LENGTH),
    variantId,
    quantity: positiveQuantity(value.quantity),
    unitPrice: nonNegativeAmount(value.unitPrice),
    productName: requiredString(value.productName, MAX_NAME_LENGTH),
    variantLabel: nullableString(value.variantLabel, MAX_LABEL_LENGTH),
    fulfillmentType: isFulfillmentType(value.fulfillmentType) ? value.fulfillmentType : null,
    properties: properties.map((property) => {
      if (!isRecord(property)) fail();
      return {
        key: requiredString(property.key, 40),
        label: requiredString(property.label, 120),
        value: nullableDescription(property.value, LINE_PROPERTY_INPUT_LIMITS.valueLength) ?? fail(),
        displayValue: nullableDescription(property.displayValue, LINE_PROPERTY_INPUT_LIMITS.valueLength) ?? fail(),
        priceMinor: nonNegativeSafeInteger(property.priceMinor),
      };
    }),
    propertiesPriceMinor: value.propertiesPriceMinor === undefined
      ? 0
      : nonNegativeSafeInteger(value.propertiesPriceMinor),
    propertiesHash: typeof value.propertiesHash === "string" ? value.propertiesHash : null,
  };
}

function assertAmountMatchesMinor(
  amount: number,
  minor: number,
  decimalPlaces: number,
): void {
  const factor = 10 ** decimalPlaces;
  if (Math.round(amount * factor) !== minor) fail();
}

export function parseTaxQuoteEnvelope(value: unknown): CheckoutTaxQuote {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) fail();
  const data = value.data;
  if (data.valid !== true) fail();

  const quoteFingerprint = requiredString(
    data.quoteFingerprint,
    27,
  );
  if (!FINGERPRINT_PATTERN.test(quoteFingerprint)) fail();

  const displayLabel = requiredString(data.displayLabel, MAX_DISPLAY_LABEL_LENGTH);
  const currencyCode = requiredString(data.currencyCode, 3);
  if (!CURRENCY_CODE_PATTERN.test(currencyCode)) fail();
  if (
    typeof data.pricesIncludeTax !== "boolean" ||
    typeof data.shippingTaxed !== "boolean"
  ) {
    fail();
  }

  const decimalPlaces = nonNegativeSafeInteger(data.decimalPlaces);
  if (decimalPlaces > 3) fail();
  const settingsVersion = nonNegativeSafeInteger(data.settingsVersion);

  const subtotalMinor = nonNegativeSafeInteger(data.subtotalMinor);
  const subtotalAmount = nonNegativeAmount(data.subtotalAmount);
  const shippingMinor = nonNegativeSafeInteger(data.shippingMinor);
  const shippingAmount = nonNegativeAmount(data.shippingAmount);
  const discountMinor = nonNegativeSafeInteger(data.discountMinor);
  const discountAmount = nonNegativeAmount(data.discountAmount);
  const taxMinor = nonNegativeSafeInteger(data.taxMinor);
  const taxAmount = nonNegativeAmount(data.taxAmount);
  const totalMinor = nonNegativeSafeInteger(data.totalMinor);
  const totalAmount = nonNegativeAmount(data.totalAmount);

  // Null when nothing in the cart is physical: no method and no fee.
  let shippingMethod: TaxQuoteShippingMethod | null = null;
  if (data.shippingMethod !== null) {
    if (!isRecord(data.shippingMethod)) fail();
    if (typeof data.shippingMethod.feeWaived !== "boolean") fail();
    shippingMethod = {
      id: requiredString(data.shippingMethod.id, MAX_ID_LENGTH),
      name: requiredString(
        data.shippingMethod.name,
        MAX_SHIPPING_METHOD_NAME_LENGTH,
      ),
      description: nullableDescription(
        data.shippingMethod.description,
        MAX_SHIPPING_METHOD_DESCRIPTION_LENGTH,
      ),
      baseAmountMinor: nonNegativeSafeInteger(
        data.shippingMethod.baseAmountMinor,
      ),
      feeWaived: data.shippingMethod.feeWaived,
    };
  }
  const deliveryMethodKind = data.deliveryMethodKind === undefined || data.deliveryMethodKind === null
    ? null
    : isDeliveryMethodKind(data.deliveryMethodKind) ? data.deliveryMethodKind : fail();
  const requiresShipping = data.requiresShipping === undefined
    ? deliveryMethodKind === "delivery"
    : typeof data.requiresShipping === "boolean" ? data.requiresShipping : fail();
  let pickup: TaxQuotePickup | null = null;
  if (data.pickup !== undefined && data.pickup !== null) {
    if (!isRecord(data.pickup)) fail();
    pickup = {
      address: data.pickup.address === null ? null : nullableDescription(data.pickup.address, 500),
      hours: data.pickup.hours === null ? null : nullableDescription(data.pickup.hours, 200),
    };
  }
  // Required: payment eligibility fails closed.
  if (!Array.isArray(data.allowedPaymentMethods) || data.allowedPaymentMethods.length > 32) fail();
  const allowedPaymentMethods = data.allowedPaymentMethods.map((method) => requiredString(method, 64));

  assertAmountMatchesMinor(subtotalAmount, subtotalMinor, decimalPlaces);
  assertAmountMatchesMinor(shippingAmount, shippingMinor, decimalPlaces);
  assertAmountMatchesMinor(discountAmount, discountMinor, decimalPlaces);
  assertAmountMatchesMinor(taxAmount, taxMinor, decimalPlaces);
  assertAmountMatchesMinor(totalAmount, totalMinor, decimalPlaces);

  const expectedTotalMinor =
    subtotalMinor +
    shippingMinor -
    discountMinor +
    (data.pricesIncludeTax ? 0 : taxMinor);
  if (!Number.isSafeInteger(expectedTotalMinor) || expectedTotalMinor !== totalMinor) fail();
  if (!shippingMethod || shippingMethod.feeWaived) {
    if (shippingMinor !== 0) fail();
  } else if (shippingMethod.baseAmountMinor !== shippingMinor) {
    fail();
  }

  const shippingRates = parseQuotedShippingRates(data.shippingRates, decimalPlaces);
  const paymentMethods = parseQuotedPaymentMethods(data.paymentMethods);

  const discountFacts = parseDiscountFacts(data);
  // Quantity-bundle savings are part of `discountMinor` but are not a
  // promotion line; without their own line the summary would not add up.
  const bundleLine = parseBundleDiscountLine(data, decimalPlaces);
  if (bundleLine) discountFacts.discounts = [...discountFacts.discounts, bundleLine];
  const giftCardFacts = parseGiftCardQuoteFacts(data, totalMinor, decimalPlaces);

  if (!Array.isArray(data.items) || data.items.length === 0) fail();
  if (data.items.length > TAX_QUOTE_MAX_ITEMS) fail();
  const items = data.items.map(parseQuoteItem);
  const seenCartKeys = new Set<string>();
  const itemSubtotalMinor = items.reduce((sum, item) => {
    if (seenCartKeys.has(item.cartKey)) fail();
    seenCartKeys.add(item.cartKey);
    const unitPriceMinor = Math.round(item.unitPrice * (10 ** decimalPlaces));
    const lineSubtotalMinor = unitPriceMinor * item.quantity;
    if (!Number.isSafeInteger(lineSubtotalMinor)) fail();
    return sum + lineSubtotalMinor;
  }, 0);
  if (itemSubtotalMinor !== subtotalMinor) fail();
  const buyerUi = buyerUiBlockSchema.array().max(40).safeParse(data.buyerUi);

  return {
    valid: true,
    quoteFingerprint,
    ...(buyerUi.success ? { buyerUi: buyerUi.data } : {}),
    displayLabel,
    pricesIncludeTax: data.pricesIncludeTax,
    shippingTaxed: data.shippingTaxed,
    currencyCode,
    decimalPlaces,
    settingsVersion,
    subtotalMinor,
    subtotalAmount,
    shippingMinor,
    shippingAmount,
    discountMinor,
    discountAmount,
    taxMinor,
    taxAmount,
    totalMinor,
    totalAmount,
    shippingMethod,
    ...(data.shippingRateToken == null ? {} : { shippingRateToken: requiredString(data.shippingRateToken, 2048) }),
    deliveryMethodKind,
    requiresShipping,
    pickup,
    allowedPaymentMethods,
    // Only when an app changed them: a quote without apps is exactly the old one.
    ...(shippingRates ? { shippingRates } : {}),
    ...(paymentMethods ? { paymentMethods } : {}),
    ...discountFacts,
    ...giftCardFacts,
    items,
  };
}

function parseQuotedRateKind(value: unknown): QuotedShippingRate["kind"] {
  return value === "delivery" || value === "pickup" ? value : fail();
}

/** One quoted delivery option; amounts are checked against their minor units when the scale is known. */
export function parseQuotedShippingRate(
  value: unknown,
  decimalPlaces: number | null,
): QuotedShippingRate {
  if (!isRecord(value)) fail();
  const amount = nonNegativeAmount(value.amount);
  const amountMinor = nonNegativeSafeInteger(value.amountMinor);
  if (decimalPlaces !== null) assertAmountMatchesMinor(amount, amountMinor, decimalPlaces);
  return {
    id: requiredString(value.id, MAX_ID_LENGTH),
    name: requiredString(value.name, MAX_SHIPPING_METHOD_NAME_LENGTH),
    kind: parseQuotedRateKind(value.kind),
    amount,
    amountMinor,
  };
}

/**
 * The delivery options a store app left on the quote, or null when no app
 * changed them. Any malformed entry refuses the whole quote.
 */
export function parseQuotedShippingRates(
  value: unknown,
  decimalPlaces: number,
): QuotedShippingRate[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_QUOTED_SHIPPING_RATES) fail();
  const rates = value.map((rate) => parseQuotedShippingRate(rate, decimalPlaces));
  if (new Set(rates.map(({ id }) => id)).size !== rates.length) fail();
  return rates;
}

/** The payment methods a store app left on the quote, or null when no app changed them. */
export function parseQuotedPaymentMethods(value: unknown): QuotedPaymentMethod[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_QUOTED_PAYMENT_METHODS) fail();
  const methods = value.map((method): QuotedPaymentMethod => {
    if (!isRecord(method)) fail();
    return {
      id: requiredString(method.id, MAX_PAYMENT_METHOD_ID_LENGTH),
      name: requiredString(method.name, MAX_PAYMENT_METHOD_NAME_LENGTH),
    };
  });
  if (new Set(methods.map(({ id }) => id)).size !== methods.length) fail();
  return methods;
}

const MAX_GIFT_CARD_ISSUES = 10;

/**
 * The gift-card tender, when the API reports it (an API without gift cards
 * sends none and the quote is exactly the old one). Applied amounts plus the
 * amount due must add up to the total, or the quote is refused.
 */
export function parseGiftCardQuoteFacts(
  data: Record<string, unknown>,
  totalMinor: number,
  decimalPlaces: number,
): CheckoutGiftCardQuoteFacts {
  const { giftCardTenders, giftCardIssues, amountDue, amountDueMinor } = data;
  if (
    giftCardTenders === undefined &&
    giftCardIssues === undefined &&
    amountDue === undefined &&
    amountDueMinor === undefined
  ) {
    return {};
  }
  const tenders = giftCardTenders ?? [];
  const issues = giftCardIssues ?? [];
  if (!Array.isArray(tenders) || tenders.length > MAX_GIFT_CARDS_PER_ORDER) fail();
  if (!Array.isArray(issues) || issues.length > MAX_GIFT_CARD_ISSUES) fail();

  const parsedTenders = tenders.map((tender): TaxQuoteGiftCardTender => {
    if (!isRecord(tender)) fail();
    const handle = requiredString(tender.handle, 200);
    if (!GIFT_CARD_HANDLE_PATTERN.test(handle)) fail();
    const last4 = requiredString(tender.last4, 4);
    if (!/^[0-9A-Z]{4}$/.test(last4)) fail();
    const appliedMinor = nonNegativeSafeInteger(tender.appliedMinor);
    const applied = nonNegativeAmount(tender.applied);
    const balanceMinor = nonNegativeSafeInteger(tender.balanceMinor);
    const balance = nonNegativeAmount(tender.balance);
    assertAmountMatchesMinor(applied, appliedMinor, decimalPlaces);
    assertAmountMatchesMinor(balance, balanceMinor, decimalPlaces);
    if (appliedMinor === 0) fail();
    return { handle, last4, applied, appliedMinor, balance, balanceMinor };
  });
  if (new Set(parsedTenders.map(({ handle }) => handle)).size !== parsedTenders.length) fail();

  const parsedIssues = issues.map((issue): TaxQuoteGiftCardIssue => {
    if (!isRecord(issue)) fail();
    return {
      handle: issue.handle === null || issue.handle === undefined
        ? null
        : requiredString(issue.handle, 200),
      code: requiredString(issue.code, 64),
      message: requiredString(issue.message, 300),
    };
  });

  const dueMinor = amountDueMinor === undefined
    ? totalMinor
    : nonNegativeSafeInteger(amountDueMinor);
  const due = amountDue === undefined
    ? dueMinor / 10 ** decimalPlaces
    : nonNegativeAmount(amountDue);
  assertAmountMatchesMinor(due, dueMinor, decimalPlaces);
  const appliedTotalMinor = parsedTenders.reduce((sum, tender) => sum + tender.appliedMinor, 0);
  if (appliedTotalMinor + dueMinor !== totalMinor) fail();

  return {
    giftCardTenders: parsedTenders,
    giftCardIssues: parsedIssues,
    amountDue: due,
    amountDueMinor: dueMinor,
  };
}

/** What is left to pay after gift cards: the total when the quote carries no tender. */
export function quoteAmountDue(
  quote: Pick<CheckoutTaxQuote, "totalAmount" | "totalMinor" | "amountDue" | "amountDueMinor">,
): { amountDue: number; amountDueMinor: number } {
  return typeof quote.amountDueMinor === "number" && typeof quote.amountDue === "number"
    ? { amountDue: quote.amountDue, amountDueMinor: quote.amountDueMinor }
    : { amountDue: quote.totalAmount, amountDueMinor: quote.totalMinor };
}

function parseOffer(value: unknown): CheckoutDiscountOffer {
  if (!isRecord(value) || (value.kind !== "get" && value.kind !== "buy")) fail();
  if (!Array.isArray(value.products) || value.products.length > 3) fail();
  return {
    promotionId: requiredString(value.promotionId, MAX_ID_LENGTH),
    title: requiredString(value.title, 160),
    code: value.code === null ? null : requiredString(value.code, MAX_CODE_LENGTH),
    kind: value.kind,
    percentOff: nonNegativeAmount(value.percentOff),
    quantity: positiveQuantity(Math.min(Number(value.quantity), MAX_QUANTITY)),
    shortfallAmount: value.shortfallAmount === null ? null : nonNegativeAmount(value.shortfallAmount),
    products: value.products.map((product) => {
      if (!isRecord(product)) fail();
      return {
        id: requiredString(product.id, MAX_ID_LENGTH),
        slug: requiredString(product.slug, MAX_ID_LENGTH),
        name: requiredString(product.name, MAX_NAME_LENGTH),
        variantId: product.variantId === null ? null : requiredString(product.variantId, MAX_ID_LENGTH),
        price: product.price === null ? null : nonNegativeAmount(product.price),
      };
    }),
  };
}

/** Stands in for a promotion id on the quantity-bundle discount line. */
export const BUNDLE_DISCOUNT_LINE_ID = "bundle";

/**
 * The quote's quantity-bundle saving as one discount line named by its tier
 * labels ("Discount · Pair"), or null when no bundle applies (or the API
 * predates bundles).
 */
function parseBundleDiscountLine(
  data: Record<string, unknown>,
  decimalPlaces: number,
): CheckoutDiscountLine | null {
  if (data.bundleDiscountMinor === undefined || data.bundleDiscountMinor === null) return null;
  const minor = nonNegativeSafeInteger(data.bundleDiscountMinor);
  const amount = nonNegativeAmount(data.bundleDiscountAmount);
  assertAmountMatchesMinor(amount, minor, decimalPlaces);
  if (minor === 0) return null;
  return bundleDiscountLine(data.bundles, amount);
}

function bundleDiscountLine(bundles: unknown, amount: number): CheckoutDiscountLine {
  bundles ??= [];
  if (!Array.isArray(bundles) || bundles.length > TAX_QUOTE_MAX_ITEMS) fail();
  const labels = [...new Set(bundles.flatMap((bundle) =>
    isRecord(bundle) && typeof bundle.label === "string" && bundle.label.trim()
      ? [requiredString(bundle.label, 60)]
      : []))];
  return {
    promotionId: BUNDLE_DISCOUNT_LINE_ID,
    title: labels.join(", "),
    code: null,
    amount,
    shippingAmount: 0,
  };
}

/**
 * The cart preview's (`/discounts/validate`) quantity-bundle saving as the
 * same "Discount · Pair" line the tax quote shows, or null when none applies
 * (or the API predates bundle previews).
 */
export function parsePreviewBundleDiscountLine(data: Record<string, unknown>): CheckoutDiscountLine | null {
  if (data.bundleDiscountAmount === undefined || data.bundleDiscountAmount === null) return null;
  const amount = nonNegativeAmount(data.bundleDiscountAmount);
  return amount > 0 ? bundleDiscountLine(data.bundles, amount) : null;
}

const REJECTED_CODE_REASONS = new Set<CheckoutRejectedCodeReason>([
  "not_found", "needs_phone", "minimum_subtotal", "minimum_quantity",
  "get_items", "buy_items", "not_combinable", "lower_savings", "needs_delivery",
  "delivery_discount_applied", "unavailable",
]);

/** The discount lines, offers and code statuses shared by the tax quote and the cart preview. */
export function parseDiscountFacts(data: Record<string, unknown>): CheckoutDiscountFacts {
  const { discounts = [], offers = [], rejectedCodes = [] } = data;
  if (!Array.isArray(discounts) || discounts.length > 10) fail();
  if (!Array.isArray(offers) || offers.length > 3) fail();
  if (!Array.isArray(rejectedCodes) || rejectedCodes.length > MAX_DISCOUNT_CODES) fail();
  return {
    discounts: discounts.map((line) => {
      if (!isRecord(line)) fail();
      // A promotion's line, or (promotion null) a line a store app gave.
      const promotionId = line.promotionId === null ? null : requiredString(line.promotionId, MAX_ID_LENGTH);
      const appId = line.appId === undefined || line.appId === null ? null : requiredString(line.appId, MAX_ID_LENGTH);
      if (promotionId === null && appId === null) fail();
      return {
        promotionId,
        ...(appId !== null ? { appId } : {}),
        title: requiredString(line.title, 160),
        code: line.code === null ? null : requiredString(line.code, MAX_CODE_LENGTH),
        amount: nonNegativeAmount(line.amount),
        shippingAmount: nonNegativeAmount(line.shippingAmount),
        ...(line.replaces === undefined ? {} : { replaces: requiredString(line.replaces, 160) }),
      };
    }),
    offers: offers.map(parseOffer),
    rejectedCodes: rejectedCodes.map((rejection) => {
      if (!isRecord(rejection) || !REJECTED_CODE_REASONS.has(rejection.reason as CheckoutRejectedCodeReason)) fail();
      return {
        code: requiredString(rejection.code, MAX_CODE_LENGTH),
        reason: rejection.reason as CheckoutRejectedCodeReason,
        message: requiredString(rejection.message, 300),
        ...(typeof rejection.shortfallAmount === "number" ? { shortfallAmount: nonNegativeAmount(rejection.shortfallAmount) } : {}),
        ...(typeof rejection.shortfallQuantity === "number" ? { shortfallQuantity: positiveQuantity(Math.min(rejection.shortfallQuantity, MAX_QUANTITY)) } : {}),
        ...(typeof rejection.conflictsWith === "string" ? { conflictsWith: requiredString(rejection.conflictsWith, 160) } : {}),
        ...(rejection.offer !== undefined ? { offer: parseOffer(rejection.offer) } : {}),
        ...(rejection.requiresCustomerPhone === true ? { requiresCustomerPhone: true } : {}),
        ...(rejection.bundleSavesMore === true ? { bundleSavesMore: true as const } : {}),
      };
    }),
  };
}
