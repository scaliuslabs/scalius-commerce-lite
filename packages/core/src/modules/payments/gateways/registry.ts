// The payment gateways a request can use. Built-in gateways are one adapter
// file in this directory plus one entry in BUILT_IN_GATEWAYS; app providers
// (`<plugin id>:<provider id>`) join per request through
// `createPaymentProviders(apps)`, built by the API from the active
// installations. Both implement the same port, so nothing here or in the
// kernel branches on which kind a gateway is. Cash on delivery is not a
// gateway: the kernel records it without a provider.

import { ValidationError } from "@scalius/core/errors";
import { getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { toMinor } from "@scalius/shared/money";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import {
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
  filterForCurrency(ids: readonly string[], currencyCode: unknown): string[];
  /**
   * Checks an online checkout must pass before its order commits: the store
   * currency is one the gateway can charge, and the first charge (the
   * configured advance when it is below the total, else the total) is within
   * provider limits.
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
    filterForCurrency: (ids, currencyCode) => ids.filter((id) => currencyIssue(id, currencyCode) === null),
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
      return getGatewayAmountIssue(gateway, chargeMinor, input.currencyCode);
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
