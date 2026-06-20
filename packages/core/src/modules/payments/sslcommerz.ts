// src/modules/payments/sslcommerz.ts
// SSLCommerz payment gateway integration via REST API.
// No official CF Workers SDK — uses native fetch.
//
// Payment flow:
//   1. Merchant calls initSession() -> SSLCommerz returns gatewayUrl
//   2. Customer is redirected to gatewayUrl to complete payment
//   3. SSLCommerz POSTs IPN to our webhook URL
//   4. We MUST validate via validateIPN() before trusting any IPN payload

import type {
  InitSSLCommerzSessionParams,
  SSLCommerzSessionResult,
  SSLCommerzValidationResult,
} from "./types";
import type { SSLCommerzSettings } from "./gateway-settings";
import type {
  PaymentProvider,
  CreatePaymentParams,
  CreatePaymentResult,
  RefundParams,
  RefundResult,
  WebhookPayload,
} from "./provider";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { getDecimalPlaces } from "@scalius/shared/currency";

/** SSLCommerz API base URLs */
const SANDBOX_BASE = "https://sandbox.sslcommerz.com";
const PRODUCTION_BASE = "https://securepay.sslcommerz.com";
const SSL_COMMERZ_TRAN_SUFFIX_LENGTH = 8;

function getBaseUrl(sandbox: boolean): string {
  return sandbox ? SANDBOX_BASE : PRODUCTION_BASE;
}

function createTransactionSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, SSL_COMMERZ_TRAN_SUFFIX_LENGTH).toUpperCase();
}

function isProviderTimeoutError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { name?: unknown; message?: unknown };
  const name = typeof maybeError.name === "string" ? maybeError.name.toLowerCase() : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
  return (
    name.includes("timeout") ||
    name.includes("abort") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborted")
  );
}

export function buildSSLCommerzTranId(
  orderId: string,
  paymentType: InitSSLCommerzSessionParams["paymentType"],
  suffix = createTransactionSuffix(),
): string {
  return `${orderId}_${paymentType}_${suffix.replace(/[^a-zA-Z0-9]/g, "").slice(0, SSL_COMMERZ_TRAN_SUFFIX_LENGTH).toUpperCase()}`;
}

export function parseSSLCommerzTranId(tranId: string): {
  orderId: string;
  paymentType: InitSSLCommerzSessionParams["paymentType"] | null;
  transactionId: string;
} {
  const match = /^(.+)_(full|deposit|balance)_([a-zA-Z0-9]{6,32})$/.exec(tranId);
  if (!match) {
    return { orderId: tranId, paymentType: null, transactionId: tranId };
  }

  return {
    orderId: match[1]!,
    paymentType: match[2] as InitSSLCommerzSessionParams["paymentType"],
    transactionId: tranId,
  };
}

/**
 * Initiate an SSLCommerz payment session.
 * Returns a gatewayUrl to redirect the customer to.
 */
export async function initSSLCommerzSession(
  storeId: string,
  storePassword: string,
  sandbox: boolean,
  params: InitSSLCommerzSessionParams
): Promise<SSLCommerzSessionResult> {
  const base = getBaseUrl(sandbox);
  const endpoint = `${base}/gwprocess/v4/api.php`;

  const body = new URLSearchParams({
    store_id: storeId,
    store_passwd: storePassword,
    // Use ISO 4217 decimal places for the currency (e.g. BDT: 2, JPY: 0, BHD: 3)
    total_amount: params.totalAmount.toFixed(getDecimalPlaces(params.currency)),
    currency: params.currency,
    tran_id: params.transactionId ?? buildSSLCommerzTranId(params.orderId, params.paymentType),
    success_url: params.successUrl,
    fail_url: params.failUrl,
    cancel_url: params.cancelUrl,
    ipn_url: params.ipnUrl,
    cus_name: params.customerName || "Customer",
    cus_phone: params.customerPhone || "N/A",
    cus_email: params.customerEmail ?? "noreply@example.com",
    cus_add1: params.customerAddress ?? "N/A",
    cus_city: params.customerCity ?? "N/A",
    cus_postcode: params.customerPostcode ?? "0000",
    cus_country: "Bangladesh",
    product_name: params.productName ?? "Order",
    product_category: "E-commerce",
    product_profile: "general",
    shipping_method: "NO",
    num_of_item: String(params.numItems ?? 1),
    // Custom metadata returned by validated IPN responses.
    value_a: params.paymentType,
    value_b: params.orderId,
  });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: params.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        error: `SSLCommerz API error: HTTP ${response.status}`,
      };
    }

    const data = await response.json() as Record<string, string>;

    if (data.status === "SUCCESS" && data.GatewayPageURL) {
      return {
        success: true,
        gatewayUrl: data.GatewayPageURL,
        sessionKey: data.sessionkey,
      };
    }

    return {
      success: false,
      error: data.failedreason ?? data.status ?? "Failed to initiate SSLCommerz session",
    };
  } catch (err: unknown) {
    if (isProviderTimeoutError(err, params.signal)) {
      return {
        success: false,
        error: "SSLCommerz did not respond before the payment timeout. Please try again.",
        timedOut: true,
      };
    }
    const message = err instanceof Error ? err.message : "Network error contacting SSLCommerz";
    return { success: false, error: message };
  }
}

/**
 * Validate an IPN (Instant Payment Notification) from SSLCommerz.
 *
 * IMPORTANT: This MUST be called before trusting any payment data.
 * SSLCommerz does not sign IPN payloads — validation is done via
 * a server-to-server API call using the val_id from the IPN.
 *
 * @returns Validation result from SSLCommerz, or null on network error.
 */
export async function validateSSLCommerzIPN(
  storeId: string,
  storePassword: string,
  sandbox: boolean,
  valId: string
): Promise<SSLCommerzValidationResult | null> {
  const base = getBaseUrl(sandbox);
  const url = new URL(`${base}/validator/api/validationserverAPI.php`);
  url.searchParams.set("val_id", valId);
  url.searchParams.set("store_id", storeId);
  url.searchParams.set("store_passwd", storePassword);
  url.searchParams.set("format", "json");

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return null;
    const data = await response.json() as SSLCommerzValidationResult;
    return data;
  } catch {
    return null;
  }
}

/**
 * Validate a payment using the SSLCommerz order validation API.
 * Can be used as an alternative to IPN validation when re-verifying an order.
 */
export async function validateSSLCommerzPayment(
  storeId: string,
  storePassword: string,
  sandbox: boolean,
  tranId: string
): Promise<{ valid: boolean; data?: SSLCommerzValidationResult; error?: string }> {
  const base = getBaseUrl(sandbox);
  const url = new URL(`${base}/validator/api/merchantTransIDvalidationAPI.php`);
  url.searchParams.set("tran_id", tranId);
  url.searchParams.set("store_id", storeId);
  url.searchParams.set("store_passwd", storePassword);
  url.searchParams.set("format", "json");

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      return { valid: false, error: `HTTP ${response.status}` };
    }
    const data = await response.json() as { element?: SSLCommerzValidationResult[] };
    const element = data.element?.[0];
    if (!element) {
      return { valid: false, error: "No transaction found" };
    }
    const isValid = element.status === "VALID" || element.status === "VALIDATED";
    return { valid: isValid, data: element };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Network error";
    return { valid: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Refund API (per SSLCommerz v4 docs)
// ---------------------------------------------------------------------------

export interface SSLCommerzRefundParams {
  bankTranId: string;
  refundAmount: number;
  refundRemarks: string;
  /** Your internal refund reference ID */
  refundTranId: string;
}

export interface SSLCommerzRefundResult {
  success: boolean;
  /** SSLCommerz-assigned refund reference ID */
  refundRefId?: string;
  status?: "success" | "failed" | "processing";
  error?: string;
}

export interface SSLCommerzRefundStatusResult {
  status: "refunded" | "processing" | "cancelled";
  refundRefId: string;
  bankTranId: string;
  tranId: string;
  initiatedOn?: string;
  refundedOn?: string;
  error?: string;
}

/**
 * Initiate a refund via SSLCommerz Refund API.
 *
 * Per v4 docs: requires `bank_tran_id` (from the original payment),
 * `refund_amount`, `refund_remarks`, and `refund_trans_id`.
 *
 * NOTE: In production, your server's public IP must be registered
 * at SSLCommerz. Sandbox works without IP whitelisting.
 */
export async function initiateSSLCommerzRefund(
  storeId: string,
  storePassword: string,
  sandbox: boolean,
  params: SSLCommerzRefundParams
): Promise<SSLCommerzRefundResult> {
  const base = getBaseUrl(sandbox);
  const url = new URL(`${base}/validator/api/merchantTransIDvalidationAPI.php`);
  url.searchParams.set("bank_tran_id", params.bankTranId);
  // SSLCommerz refund amount uses same decimal convention as session init.
  // We don't have the currency param here — SSLCommerz only supports BDT for
  // refunds, which has 2 decimals. Default to 2 as a safe fallback.
  url.searchParams.set("refund_amount", params.refundAmount.toFixed(2));
  url.searchParams.set("refund_remarks", params.refundRemarks);
  url.searchParams.set("refund_trans_id", params.refundTranId);
  url.searchParams.set("store_id", storeId);
  url.searchParams.set("store_passwd", storePassword);
  url.searchParams.set("v", "1");
  url.searchParams.set("format", "json");

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json() as Record<string, string>;

    if (data.APIConnect !== "DONE") {
      return {
        success: false,
        error: `API connection failed: ${data.APIConnect}`,
      };
    }

    const refundStatus = data.status as "success" | "failed" | "processing";

    if (refundStatus === "success" || refundStatus === "processing") {
      return {
        success: true,
        refundRefId: data.refund_ref_id,
        status: refundStatus,
      };
    }

    return {
      success: false,
      status: refundStatus,
      error: data.errorReason || "Refund request failed",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Network error";
    return { success: false, error: message };
  }
}

/**
 * Query the status of a previously initiated refund.
 *
 * Refund statuses:
 * - `refunded`   — Successfully refunded to customer
 * - `processing` — Refund is under processing
 * - `cancelled`  — Refund has been cancelled
 */
export async function querySSLCommerzRefundStatus(
  storeId: string,
  storePassword: string,
  sandbox: boolean,
  refundRefId: string
): Promise<SSLCommerzRefundStatusResult> {
  const base = getBaseUrl(sandbox);
  const url = new URL(`${base}/validator/api/merchantTransIDvalidationAPI.php`);
  url.searchParams.set("refund_ref_id", refundRefId);
  url.searchParams.set("store_id", storeId);
  url.searchParams.set("store_passwd", storePassword);
  url.searchParams.set("format", "json");

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      return {
        status: "cancelled",
        refundRefId,
        bankTranId: "",
        tranId: "",
        error: `HTTP ${response.status}`,
      };
    }

    const data = await response.json() as Record<string, string>;

    if (data.APIConnect !== "DONE") {
      return {
        status: "cancelled",
        refundRefId,
        bankTranId: "",
        tranId: "",
        error: `API connection failed: ${data.APIConnect}`,
      };
    }

    return {
      status: (data.status as "refunded" | "processing" | "cancelled") ?? "processing",
      refundRefId: data.refund_ref_id ?? refundRefId,
      bankTranId: data.bank_tran_id ?? "",
      tranId: data.tran_id ?? "",
      initiatedOn: data.initiated_on,
      refundedOn: data.refunded_on,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Network error";
    return {
      status: "cancelled",
      refundRefId,
      bankTranId: "",
      tranId: "",
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// PaymentProvider implementation
// ---------------------------------------------------------------------------

/**
 * SSLCommerz PaymentProvider implementation.
 * Wraps the existing SSLCommerz functions behind the unified PaymentProvider interface.
 */
export class SSLCommerzProvider implements PaymentProvider {
  readonly type = "sslcommerz" as const;
  readonly name = "SSLCommerz";

  constructor(private readonly settings: SSLCommerzSettings) {}

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    if (!params.successUrl || !params.failUrl || !params.cancelUrl || !params.ipnUrl) {
      throw new ValidationError("SSLCommerz requires successUrl, failUrl, cancelUrl, and ipnUrl");
    }
    if (!params.customerName || !params.customerPhone) {
      throw new ValidationError("SSLCommerz requires customerName and customerPhone");
    }

    const result = await initSSLCommerzSession(
      this.settings.storeId,
      this.settings.storePassword,
      this.settings.sandbox,
      {
        orderId: params.orderId,
        totalAmount: params.amount,
        currency: params.currency,
        successUrl: params.successUrl,
        failUrl: params.failUrl,
        cancelUrl: params.cancelUrl,
        ipnUrl: params.ipnUrl,
        customerName: params.customerName,
        customerPhone: params.customerPhone,
        customerEmail: params.customerEmail,
        customerAddress: params.customerAddress,
        customerCity: params.customerCity,
        paymentType: params.paymentType,
        productName: params.productName,
        numItems: params.numItems,
      },
    );

    if (!result.success) {
      throw new ServiceUnavailableError(result.error ?? "Failed to initiate SSLCommerz session");
    }

    return {
      transactionId: result.sessionKey,
      redirectUrl: result.gatewayUrl,
    };
  }

  async createRefund(params: RefundParams): Promise<RefundResult> {
    if (!params.transactionId) {
      throw new ValidationError("SSLCommerz bank_tran_id is required for refunds");
    }

    // SSLCommerz docs: refund_trans_id max 30 chars. Use a short unique ID.
    const refundTranId = `REF${Date.now().toString(36).toUpperCase()}`;
    const result = await initiateSSLCommerzRefund(
      this.settings.storeId,
      this.settings.storePassword,
      this.settings.sandbox,
      {
        bankTranId: params.transactionId,
        refundAmount: params.amount ?? 0,
        refundRemarks: params.reason ?? "Refund requested",
        refundTranId,
      },
    );

    if (!result.success) {
      throw new ServiceUnavailableError(result.error ?? "Failed to initiate SSLCommerz refund");
    }

    return { refundId: result.refundRefId ?? refundTranId };
  }

  async verifyWebhook(rawBody: string, _headers: Record<string, string>): Promise<WebhookPayload> {
    // SSLCommerz does not sign webhooks — IPN validation is done via
    // server-to-server API call using the val_id from the IPN payload.
    // Parse the IPN body and validate via the validation API.
    let ipnData: Record<string, string>;
    try {
      const searchParams = new URLSearchParams(rawBody);
      ipnData = Object.fromEntries(searchParams.entries());
    } catch {
      throw new ValidationError("Invalid SSLCommerz IPN payload");
    }

    const valId = ipnData.val_id;
    if (!valId) {
      throw new ValidationError("SSLCommerz IPN payload missing val_id");
    }

    const validation = await validateSSLCommerzIPN(
      this.settings.storeId,
      this.settings.storePassword,
      this.settings.sandbox,
      valId,
    );

    if (!validation) {
      throw new ServiceUnavailableError("Failed to validate SSLCommerz IPN — network error");
    }

    const isValid = validation.status === "VALID" || validation.status === "VALIDATED";
    if (!isValid) {
      throw new ValidationError(`SSLCommerz IPN validation failed: ${validation.status}`);
    }

    return {
      eventType: `payment.${validation.status.toLowerCase()}`,
      data: validation as unknown as Record<string, unknown>,
    };
  }
}
