// The payment gateways a request can use. Built-in gateways are one adapter
// file in this directory plus one entry in BUILT_IN_GATEWAYS; app providers
// (`<plugin id>:<provider id>`) join per request through
// `createPaymentProviders(apps)`, built by the API from the active
// installations. Both implement the same port, so nothing here or in the
// kernel branches on which kind a gateway is. Cash on delivery is not a
// gateway: the kernel records it without a provider.

import { ValidationError } from "@scalius/core/errors";
import { getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { cashOnDeliveryIncrementMinor, isWholeUnitIncrement } from "@scalius/shared/currency-policy";
import { toMinor } from "@scalius/shared/money";
import type { ProviderAmountCodecs } from "@scalius/shared/plugins/providers";
import { encodeProviderAmount, type EncodedProviderAmount } from "@scalius/shared/plugins/providers/amount";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { providerServesCountry, type ProviderCountries } from "@scalius/shared/plugins/providers/common";
import {
  COD_COUNTRIES,
  COD_LABEL,
  COD_PAYMENT_METHOD,
  GIFT_CARD_TENDER_LABEL,
  GIFT_CARD_TENDER_METHOD,
} from "./identity";
import type { PaymentGateway } from "./port";
import { minorToMajorString } from "./port";
import { sslcommerzGateway } from "./sslcommerz";
import { stripeGateway } from "./stripe";

/** In the order of BUILT_IN_PAYMENT_GATEWAY_IDS (gateway-kernel.test.ts keeps them equal). */
const BUILT_IN_GATEWAYS: readonly PaymentGateway[] = [stripeGateway, sslcommerzGateway];

export {
  BUILT_IN_PAYMENT_GATEWAY_IDS,
  COD_COUNTRIES,
  COD_LABEL,
  COD_PAYMENT_METHOD,
  GIFT_CARD_TENDER_LABEL,
  GIFT_CARD_TENDER_METHOD,
  isOnlinePaymentMethod,
  isPaymentMethodId,
  onlinePaymentMethodCondition,
} from "./identity";

// ── Gateways one request can use ────────────────────────────────────────────

/** Provider charge limits, checked before an order commits and before a session is created. */
export function getGatewayAmountIssue(
  gateway: PaymentGateway,
  amountMinor: number,
  currency: string,
  label = `${gateway.label} payment amount`,
): string | null {
  const limits = gateway.amountLimits;
  if (!limits || limits.currency !== currency.toUpperCase()) return null;
  if (Number.isSafeInteger(amountMinor) && amountMinor >= limits.minMinor && amountMinor <= limits.maxMinor) return null;
  const decimals = getDecimalPlaces(limits.currency);
  return `${label} must be between ${minorToMajorString(limits.minMinor, decimals)} ${limits.currency} and ${minorToMajorString(limits.maxMinor, decimals)} ${limits.currency}.`;
}

/** The refusal reason when cash on delivery cannot collect an amount exactly. */
export const CASH_ON_DELIVERY_AMOUNT_REASON = "cash_on_delivery_amount";

/**
 * Cash on delivery's wire form: the cash it collects comes in its cash
 * increment (`cashOnDeliveryIncrementMinor`: whole taka in BDT).
 */
export function cashOnDeliveryAmountCodecs(currency: string): ProviderAmountCodecs {
  const code = currency.trim().toUpperCase();
  return { [code]: { minorIncrement: cashOnDeliveryIncrementMinor(code) } };
}

/** Why `label` cannot charge exactly this amount (the codec's rounding), or null. */
function exactAmountIssue(label: string, encoded: EncodedProviderAmount, amountMinor: number, cash: boolean): string | null {
  if (encoded.roundingMinor === 0) return null;
  const decimals = getDecimalPlaces(encoded.currency);
  const amount = `${minorToMajorString(amountMinor, decimals)} ${encoded.currency}`;
  if (cash) {
    return encoded.currency === "BDT" && isWholeUnitIncrement("BDT", cashOnDeliveryIncrementMinor("BDT"))
      ? `Cash on delivery collects whole taka, so ${amount} can't be paid on delivery. Choose an online payment method.`
      : `Cash on delivery can't collect ${amount} exactly. Choose an online payment method.`;
  }
  return `${label} cannot charge ${amount} exactly `
    + `(it would drop ${minorToMajorString(encoded.roundingMinor, decimals)}). Set prices in steps the provider accepts.`;
}

/** Public checkout copy of a gateway's limits, in major units. */
export function publicAmountLimits(gateway: PaymentGateway): { currency: string; min: number; max: number } | undefined {
  const limits = gateway.amountLimits;
  if (!limits) return undefined;
  const scale = 10 ** getDecimalPlaces(limits.currency);
  return { currency: limits.currency, min: limits.minMinor / scale, max: limits.maxMinor / scale };
}

export interface CheckoutGatewayPrecommitInput {
  paymentMethod: string;
  currencyCode: string;
  totalAmountMinor: number;
  partialPaymentEnabled: boolean;
  /** The advance-payment setting, a decimal amount. */
  partialPaymentAmount: number;
}

/**
 * The gateways of one request: the built-in ones and the active app
 * providers, keyed by id. Built per request (never module state): an app's
 * gateway closes over its installation and the request's plugin host.
 */
export interface PaymentProviders {
  /** Built-in gateways first, then app providers. */
  readonly gateways: readonly PaymentGateway[];
  get(id: string | null | undefined): PaymentGateway | undefined;
  require(id: string | null | undefined): PaymentGateway;
  /** Every checkout payment method id: the gateways plus COD. */
  methodIds(): string[];
  /** Merchant-facing name of a payment method or tender. */
  label(id: string): string;
  /** Store-currency eligibility shared by every checkout surface; credential readiness is separate. */
  currencyIssue(id: string, currencyCode: unknown): string | null;
  /** The shipping countries a method serves: COD's countries, a gateway's declared ones, else `any`. */
  countries(id: string): ProviderCountries;
  /**
   * Why a method can't take an order delivered to this country, or null
   * (null country: nothing is delivered, every method fits).
   */
  countryIssue(id: string, shippingCountryCode: string | null | undefined): string | null;
  filterForCurrency(ids: readonly string[], currencyCode: unknown): string[];
  /**
   * The one amount codec of every payment path (MARKETS-DESIGN D2): the
   * amount in the method's wire form (a gateway's declared codecs, cash on
   * delivery's cash increment) and what that form cannot carry
   * (`roundingMinor`, never added to a charge).
   */
  encodeAmount(methodId: string, amountMinor: number, currency: string): EncodedProviderAmount;
  /**
   * Why the method cannot charge exactly this amount, or null. Every path
   * refuses a non-zero rounding before the order commits or a provider is
   * called, so what is charged always equals what the order owes.
   */
  amountIssue(methodId: string, amountMinor: number, currency: string): string | null;
  /**
   * Checks an online checkout must pass before its order commits: the store
   * currency is one the gateway can charge, and the first charge (the
   * configured advance when it is below the total, else the total) is within
   * provider limits and exact in the gateway's wire form.
   */
  precommitIssue(input: CheckoutGatewayPrecommitInput): string | null;
}

export function createPaymentProviders(apps: readonly PaymentGateway[] = []): PaymentProviders {
  const byId = new Map<string, PaymentGateway>();
  for (const gateway of [...BUILT_IN_GATEWAYS, ...apps]) {
    // An app cannot shadow a built-in gateway: app ids are always qualified.
    if (!byId.has(gateway.id) && (BUILT_IN_GATEWAYS.includes(gateway) || isQualifiedProviderId(gateway.id))) {
      byId.set(gateway.id, gateway);
    }
  }
  const gateways = [...byId.values()];

  const get = (id: string | null | undefined) => (id ? byId.get(id) : undefined);

  const label = (id: string): string => {
    if (id === GIFT_CARD_TENDER_METHOD) return GIFT_CARD_TENDER_LABEL;
    return id === COD_PAYMENT_METHOD ? COD_LABEL : get(id)?.label ?? id;
  };

  const currencyIssue = (id: string, currencyCode: unknown): string | null => {
    if (id !== COD_PAYMENT_METHOD && !byId.has(id)) return "This payment method is not supported by checkout.";
    const currency = normalizeSupportedCurrencyCode(currencyCode);
    if (!currency) return "Store currency is unavailable. Save a supported currency before enabling payment methods.";
    const gateway = get(id);
    if (gateway && gateway.chargeCurrencies !== "any" && !gateway.chargeCurrencies.includes(currency)) {
      return `${gateway.label} checkout requires the store currency to be ${gateway.chargeCurrencies.join(" or ")}. Current currency: ${currency}.`;
    }
    return null;
  };

  const countries = (id: string): ProviderCountries =>
    id === COD_PAYMENT_METHOD ? COD_COUNTRIES : get(id)?.countries ?? "any";

  const countryIssue = (id: string, shippingCountryCode: string | null | undefined): string | null => {
    if (!shippingCountryCode || providerServesCountry(countries(id), shippingCountryCode)) return null;
    return id === COD_PAYMENT_METHOD
      ? "Cash on delivery isn't available for this delivery country. Choose an online payment method."
      : `${label(id)} isn't available for this delivery country. Choose another payment method.`;
  };

  const encodeAmount = (methodId: string, amountMinor: number, currency: string): EncodedProviderAmount =>
    encodeProviderAmount(
      amountMinor,
      currency,
      methodId === COD_PAYMENT_METHOD ? cashOnDeliveryAmountCodecs(currency) : get(methodId)?.amountCodecs,
    );

  const amountIssue = (methodId: string, amountMinor: number, currency: string): string | null =>
    exactAmountIssue(label(methodId), encodeAmount(methodId, amountMinor, currency), amountMinor, methodId === COD_PAYMENT_METHOD);

  return {
    gateways,
    get,
    require(id) {
      const gateway = get(id);
      if (!gateway) throw new ValidationError(`Unsupported payment gateway: ${id ?? "none"}`);
      return gateway;
    },
    methodIds: () => [...byId.keys(), COD_PAYMENT_METHOD],
    label,
    currencyIssue,
    countries,
    countryIssue,
    filterForCurrency: (ids, currencyCode) => ids.filter((id) => currencyIssue(id, currencyCode) === null),
    encodeAmount,
    amountIssue,
    precommitIssue(input) {
      const gateway = get(input.paymentMethod);
      if (!gateway) return null;
      const issue = currencyIssue(gateway.id, input.currencyCode);
      if (issue) return issue;
      const totalMinor = input.totalAmountMinor;
      const deposit = Number(input.partialPaymentAmount);
      const depositMinor = Number.isFinite(deposit) && deposit > 0
        ? toMinor(deposit, getDecimalPlaces(input.currencyCode))
        : 0;
      const chargeMinor = input.partialPaymentEnabled && depositMinor > 0 && depositMinor < totalMinor
        ? depositMinor
        : totalMinor;
      return getGatewayAmountIssue(gateway, chargeMinor, input.currencyCode)
        ?? amountIssue(gateway.id, chargeMinor, input.currencyCode);
    },
  };
}

/** The built-in gateways alone: for code that never meets an app id (and tests). */
export const BUILT_IN_PAYMENT_PROVIDERS: PaymentProviders = createPaymentProviders();

/**
 * Gateways for work that learns the gateway id from a row (refunds,
 * reconciliation, recovery links): the request's providers, or a loader
 * called only when the id names an app gateway, so work on built-in
 * gateways reads no plugin table. Absent: built-in gateways alone.
 */
export type PaymentProvidersSource = PaymentProviders | (() => Promise<PaymentProviders>);

/** The providers that can answer for `gatewayId` from a source. */
export async function paymentProvidersFor(
  source: PaymentProvidersSource | undefined,
  gatewayId: string | null | undefined,
): Promise<PaymentProviders> {
  if (!source) return BUILT_IN_PAYMENT_PROVIDERS;
  if (typeof source !== "function") return source;
  return gatewayId && isQualifiedProviderId(gatewayId) ? source() : BUILT_IN_PAYMENT_PROVIDERS;
}

/** A merchant-facing name without a request's providers: an app provider falls back to its id. */
export function paymentMethodLabel(id: string): string {
  return BUILT_IN_PAYMENT_PROVIDERS.label(id);
}
