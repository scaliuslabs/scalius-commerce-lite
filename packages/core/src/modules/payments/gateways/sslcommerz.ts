// SSLCommerz adapter: hosted redirect flow over its REST API (no SDK).
// SSLCommerz does not sign IPNs or buyer returns: every success is trusted
// only after a server-to-server validationserverAPI call with its val_id.

import { ValidationError } from "@scalius/core/errors";
import { getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { SSL_COMMERZ_BDT_AMOUNT_LIMITS } from "@scalius/shared/payment-gateway-environment";
import {
  getSSLCommerzCheckoutReadiness,
  getSSLCommerzSettings,
  type SSLCommerzSettings,
} from "../gateway-settings";
import { parsePaymentCorrelationId } from "./correlation";
import {
  PaymentProviderError,
  isProviderTimeoutError,
  majorStringToMinor,
  minorToMajorString,
  type GatewayRequest,
  type GatewayVerification,
  type PaymentGateway,
  type PaymentType,
} from "./port";

type Validation = Record<string, string | undefined>;

const VALID_STATUSES = new Set(["VALID", "VALIDATED"]);
const TERMINAL_FAILURE_STATUSES = new Set(["FAILED", "CANCELLED"]);

function baseUrl(settings: SSLCommerzSettings): string {
  return settings.sandbox ? "https://sandbox.sslcommerz.com" : "https://securepay.sslcommerz.com";
}

function clean(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

function formOf(request: GatewayRequest): Record<string, string> {
  if (request.method !== "POST" || !request.rawBody) return {};
  try {
    return Object.fromEntries(new URLSearchParams(request.rawBody).entries());
  } catch {
    return {};
  }
}

function paymentTypeOf(value: string | undefined): PaymentType | null {
  return value === "full" || value === "deposit" || value === "balance" ? value : null;
}

async function validate(settings: SSLCommerzSettings, valId: string, signal?: AbortSignal): Promise<Validation | null> {
  const url = new URL(`${baseUrl(settings)}/validator/api/validationserverAPI.php`);
  url.searchParams.set("val_id", valId);
  url.searchParams.set("store_id", settings.storeId);
  url.searchParams.set("store_passwd", settings.storePassword);
  url.searchParams.set("format", "json");
  try {
    const response = await fetch(url.toString(), { signal });
    return response.ok ? await response.json() as Validation : null;
  } catch {
    return null;
  }
}

async function merchantApi(settings: SSLCommerzSettings, params: Record<string, string>): Promise<Record<string, string>> {
  const url = new URL(`${baseUrl(settings)}/validator/api/merchantTransIDvalidationAPI.php`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("store_id", settings.storeId);
  url.searchParams.set("store_passwd", settings.storePassword);
  url.searchParams.set("format", "json");
  const response = await fetch(url.toString());
  if (!response.ok) throw new PaymentProviderError(`HTTP ${response.status}`);
  const data = await response.json() as Record<string, string>;
  if (data.APIConnect !== "DONE") throw new PaymentProviderError(`API connection failed: ${data.APIConnect}`);
  return data;
}

/**
 * Turn one provider-validated response into a payment event. Callback fields
 * are expectations only: any disagreement with the validated response (or
 * between the validated metadata and its own transaction id) yields no event.
 */
function validatedEvent(
  validation: Validation,
  requestedValId: string,
  expected: { tranId?: string; orderId?: string; paymentType?: PaymentType | null } = {},
): GatewayVerification {
  const status = clean(validation.status);
  const tranId = clean(validation.tran_id);
  const valId = clean(validation.val_id);
  const parsedTran = parsePaymentCorrelationId(tranId);
  const metadataOrderId = clean(validation.value_b) || null;
  const metadataPaymentType = paymentTypeOf(clean(validation.value_a));
  const orderId = metadataOrderId ?? parsedTran.orderId;

  if (
    !tranId ||
    !valId ||
    valId !== requestedValId ||
    (expected.tranId && tranId !== expected.tranId) ||
    (metadataOrderId && parsedTran.orderId !== metadataOrderId) ||
    (expected.orderId && orderId !== expected.orderId) ||
    (metadataPaymentType && parsedTran.paymentType && metadataPaymentType !== parsedTran.paymentType) ||
    (expected.paymentType && metadataPaymentType && expected.paymentType !== metadataPaymentType) ||
    (expected.paymentType && parsedTran.paymentType && expected.paymentType !== parsedTran.paymentType)
  ) {
    return { status: "ignored", reason: "Validated SSLCommerz response does not match its transaction context" };
  }

  const identity = { eventType: "ipn", eventId: `${tranId}:${valId}`, orderId, providerRef: valId };
  if (TERMINAL_FAILURE_STATUSES.has(status)) {
    return { status: "event", event: { ...identity, kind: "failed", details: { tranId, validationStatus: status } } };
  }
  if (!VALID_STATUSES.has(status)) {
    return { status: "ignored", reason: `SSLCommerz status ${status || "unknown"} is not final` };
  }

  const currency = normalizeSupportedCurrencyCode(clean(validation.currency_type) || clean(validation.currency));
  const amountMinor = currency
    ? majorStringToMinor(clean(validation.amount) || clean(validation.store_amount), getDecimalPlaces(currency))
    : null;
  const bankTranId = clean(validation.bank_tran_id);
  if (!currency || !amountMinor || amountMinor <= 0 || !bankTranId) {
    return { status: "retry", reason: "Validation response is missing canonical payment data" };
  }

  return {
    status: "event",
    event: {
      ...identity,
      kind: "confirmed",
      secondaryRef: bankTranId,
      amountMinor,
      currency,
      paymentType: metadataPaymentType ?? parsedTran.paymentType ?? undefined,
      details: {
        tranId,
        validationStatus: status,
        cardType: clean(validation.card_type) || null,
        cardBrand: clean(validation.card_brand) || null,
      },
    },
  };
}

export const sslcommerzGateway: PaymentGateway<SSLCommerzSettings> = {
  id: "sslcommerz",
  label: "SSLCommerz",
  checkoutName: "Online Payment",
  flow: "hosted",
  currencies: ["BDT"],
  amountLimits: {
    currency: SSL_COMMERZ_BDT_AMOUNT_LIMITS.currency,
    minMinor: SSL_COMMERZ_BDT_AMOUNT_LIMITS.min * 100,
    maxMinor: SSL_COMMERZ_BDT_AMOUNT_LIMITS.max * 100,
  },
  supportsRefund: true,

  loadSettings: getSSLCommerzSettings,
  readiness: getSSLCommerzCheckoutReadiness,
  canVerify: (settings) => Boolean(settings.storeId && settings.storePassword),
  environment: (settings) => (settings?.sandbox ?? true) ? "test" : "live",
  publicConfig: (settings) => ({ testMode: settings.sandbox === true }),

  async createSession(settings, input) {
    const body = new URLSearchParams({
      store_id: settings.storeId,
      store_passwd: settings.storePassword,
      total_amount: minorToMajorString(input.amountMinor, getDecimalPlaces(input.currency)),
      currency: input.currency,
      tran_id: input.correlationId,
      success_url: input.urls.success,
      fail_url: input.urls.fail,
      cancel_url: input.urls.cancel,
      ipn_url: input.urls.webhook,
      cus_name: input.buyer.name || "Customer",
      cus_phone: input.buyer.phone || "N/A",
      cus_email: input.buyer.email ?? "noreply@example.com",
      cus_add1: input.buyer.address ?? "N/A",
      cus_city: input.buyer.city ?? "N/A",
      cus_postcode: "0000",
      cus_country: "Bangladesh",
      product_name: "Order",
      product_category: "E-commerce",
      product_profile: "general",
      shipping_method: "NO",
      num_of_item: "1",
      // Returned inside validated responses: the canonical type and order.
      value_a: input.paymentType,
      value_b: input.orderId,
    });

    let data: Record<string, string>;
    try {
      const response = await fetch(`${baseUrl(settings)}/gwprocess/v4/api.php`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: input.signal,
      });
      if (!response.ok) throw new PaymentProviderError(`SSLCommerz API error: HTTP ${response.status}`);
      data = await response.json() as Record<string, string>;
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      if (isProviderTimeoutError(error, input.signal)) {
        throw new PaymentProviderError("SSLCommerz did not respond before the payment timeout. Please try again.", { timedOut: true });
      }
      throw new PaymentProviderError(error instanceof Error ? error.message : "Network error contacting SSLCommerz");
    }
    if (data.status !== "SUCCESS" || !data.GatewayPageURL) {
      throw new PaymentProviderError(data.failedreason ?? data.status ?? "Failed to initiate SSLCommerz session");
    }
    return { providerRef: data.sessionkey, redirectUrl: data.GatewayPageURL };
  },

  async verifyWebhook(settings, request) {
    const valId = clean(formOf(request).val_id);
    if (!valId) return { status: "ignored", reason: "IPN missing val_id" };
    const validation = await validate(settings, valId);
    if (!validation) return { status: "retry", reason: "SSLCommerz validation API call failed" };
    return validatedEvent(validation, valId);
  },

  async verifyReturn(settings, request, signal) {
    const form = formOf(request);
    const tranId = clean(form.tran_id || request.query.tran_id);
    const valId = clean(form.val_id || request.query.val_id);
    const orderId = clean(request.query.order_id) || parsePaymentCorrelationId(tranId).orderId;
    if (!tranId || !valId || !orderId) return { status: "ignored", reason: "Return is missing transaction context" };
    const validation = await validate(settings, valId, signal);
    if (!validation) return { status: "retry", reason: "SSLCommerz validation API call failed" };
    if (!VALID_STATUSES.has(clean(validation.status))) return { status: "ignored", reason: "Return was not validated as paid" };
    return validatedEvent(validation, valId, {
      tranId,
      orderId,
      paymentType: paymentTypeOf(request.query.payment_type ?? request.query.paymentType),
    });
  },

  returnCorrelationId: (request) => clean(formOf(request).tran_id),

  async refund(settings, input) {
    if (!input.secondaryRef) throw new ValidationError("No SSLCommerz bank_tran_id found on payment record");
    // refund_trans_id: at most 30 characters, deterministic so retries reuse it.
    const refundTranId = input.reference.replace(/[^A-Za-z0-9]/g, "").slice(0, 30);
    const data = await merchantApi(settings, {
      bank_tran_id: input.secondaryRef,
      refund_amount: minorToMajorString(input.amountMinor, getDecimalPlaces(input.currency)),
      refund_remarks: input.reason || "Refund requested",
      refund_trans_id: refundTranId,
      v: "1",
    });
    if (data.status !== "success" && data.status !== "processing") {
      throw new PaymentProviderError(data.errorReason || "Refund request failed");
    }
    return { refundId: data.refund_ref_id ?? refundTranId };
  },

  async refundStatus(settings, input) {
    if (!input.providerRefundId) {
      return { outcome: "unknown", error: "SSLCommerz refund reference is missing. Manual provider review required before retrying.", manualReview: true };
    }
    let data: Record<string, string>;
    try {
      data = await merchantApi(settings, { refund_ref_id: input.providerRefundId });
    } catch (error) {
      return { outcome: "unknown", providerRefundId: input.providerRefundId, providerStatus: "cancelled", error: error instanceof Error ? error.message : "Network error" };
    }
    const status = data.status || "processing";
    const providerRefundId = data.refund_ref_id ?? input.providerRefundId;
    const responsePayload = {
      status,
      refundRefId: providerRefundId,
      bankTranId: data.bank_tran_id ?? "",
      tranId: data.tran_id ?? "",
      refundedOn: data.refunded_on,
    };
    if (status === "refunded") return { outcome: "accepted", providerRefundId, providerStatus: status, responsePayload };
    if (status === "cancelled") return { outcome: "rejected", providerRefundId, providerStatus: status, responsePayload };
    return { outcome: "processing", providerRefundId, providerStatus: status, responsePayload };
  },
};
