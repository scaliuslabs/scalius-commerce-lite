// src/lib/payment/sslcommerz.ts
// SSLCommerz payment gateway integration via REST API.
// No official CF Workers SDK — uses native fetch.
//
// Payment flow:
//   1. Merchant calls initSession() → SSLCommerz returns gatewayUrl
//   2. Customer is redirected to gatewayUrl to complete payment
//   3. SSLCommerz POSTs IPN to our webhook URL
//   4. We MUST validate via validateIPN() before trusting any IPN payload

import type {
  InitSSLCommerzSessionParams,
  SSLCommerzSessionResult,
  SSLCommerzValidationResult,
} from "./types";

/** SSLCommerz API base URLs */
const SANDBOX_BASE = "https://sandbox.sslcommerz.com";
const PRODUCTION_BASE = "https://securepay.sslcommerz.com";

function getBaseUrl(sandbox: boolean): string {
  return sandbox ? SANDBOX_BASE : PRODUCTION_BASE;
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
    total_amount: params.totalAmount.toFixed(2),
    currency: params.currency,
    tran_id: params.orderId,
    success_url: params.successUrl,
    fail_url: params.failUrl,
    cancel_url: params.cancelUrl,
    ipn_url: params.ipnUrl,
    cus_name: params.customerName,
    cus_phone: params.customerPhone,
    cus_email: params.customerEmail ?? "",
    cus_add1: params.customerAddress ?? "",
    cus_city: params.customerCity ?? "",
    cus_country: "Bangladesh",
    product_name: params.productName ?? "Order",
    product_category: "E-commerce",
    product_profile: "general",
    shipping_method: "YES",
    num_of_item: String(params.numItems ?? 1),
    // Custom metadata: encode paymentType as value_a
    value_a: params.paymentType,
  });

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
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
  } catch (err) {
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
  } catch (err) {
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
  } catch (err) {
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
  } catch (err) {
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
