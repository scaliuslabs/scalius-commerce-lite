// SSLCommerz behind the payment port: a hosted redirect gateway (cards,
// mobile wallets and internet banking on SSLCommerz's own page). Moved from
// core (packages/core/src/modules/payments/gateways/sslcommerz.ts) with the
// same requests, the same validation and the same refunds. The transport is
// the app's `ctx.http` (the hosts in the manifest's `allowedHosts`).
//
// - createSession: one SSLCommerz session per attempt the platform claimed
//   (`tran_id` is the platform's correlation id; `value_a`/`value_b` carry
//   the payment type and the order, and come back inside validated answers).
// - verifyWebhook (IPN) and verifyReturn (the buyer's success return):
//   SSLCommerz signs neither, so a payment is trusted only after the
//   server-to-server validation API answers for its `val_id`. Callback
//   fields are expectations only: any disagreement with the validated answer
//   yields no event.
// - A failed or cancelled return posts `tran_id` unsigned: the platform reads
//   it (the manifest's `returnCorrelationField`) to release the attempt it
//   names, never as payment authority, and never calls this app for it.
// - queryPayment: the transaction query by session key, then the same
//   validation as an IPN, so a capture reached any way is the same event.
// - refund / refundStatus: the merchant refund API, at most once per refund
//   reference (`refund_trans_id`), probed when an answer is lost.
//
// Errors are `ProviderError`s with merchant-safe messages: never a
// credential, a provider body or the buyer's contact data. Nothing here logs.

import {
  ProviderError,
  definePaymentProvider,
  type PaymentEvent,
  type PaymentQuery,
  type PaymentQueryInput,
  type PaymentRefund,
  type PaymentRefundInput,
  type PaymentRefundProbe,
  type PaymentRefundProbeInput,
  type PaymentSession,
  type PaymentSessionInput,
  type PaymentVerification,
  type PluginContext,
  type ProviderHttpRequest,
} from "@scalius/plugin-sdk";
import { platformErrorCode, requireText } from "./common";

export const SSLCOMMERZ_HOSTS = { sandbox: "sandbox.sslcommerz.com", live: "securepay.sslcommerz.com" } as const;

/** SSLCommerz accepts BDT charges only within 10 to 500,000 taka. */
export const SSLCOMMERZ_AMOUNT_LIMITS = { currency: "BDT", minMinor: 1_000, maxMinor: 50_000_000 } as const;

type Answer = Record<string, string | undefined>;
type PaymentType = PaymentSessionInput["paymentType"];

const VALID_STATUSES = new Set(["VALID", "VALIDATED"]);
const TERMINAL_FAILURE_STATUSES = new Set(["FAILED", "CANCELLED"]);
/** SSLCommerz's session keys, validation ids and refund references: short alphanumerics. */
const REFERENCE = /^[A-Za-z0-9_-]{1,128}$/;
/** The validation calls of a webhook or a return: within the platform's per-call ceiling. */
const VALIDATION_TIMEOUT_MS = 15_000;

interface Account {
  environment: keyof typeof SSLCOMMERZ_HOSTS;
  storeId: string;
  storePassword: string;
}

function accountOf(ctx: PluginContext): Account {
  return {
    // Anything but "live" is the sandbox.
    environment: ctx.settings.sslcommerz_environment === "live" ? "live" : "sandbox",
    storeId: requireText(ctx, "sslcommerz_store_id", "SSLCommerz: store ID"),
    storePassword: requireText(ctx, "sslcommerz_store_password", "SSLCommerz: store password"),
  };
}

function baseUrl(account: Account): string {
  return `https://${SSLCOMMERZ_HOSTS[account.environment]}`;
}

function clean(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function formOf(request: ProviderHttpRequest): Record<string, string> {
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

/** An SSLCommerz JSON answer as flat text fields; null when it is not a JSON object. */
function answerOf(text: string): Answer | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const answer: Answer = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") answer[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) answer[key] = String(value);
    }
    return answer;
  } catch {
    return null;
  }
}

/**
 * The platform's merchant reference (`buildPaymentCorrelationId`):
 * `<order>_<type>_<suffix>`, or `<order>_<F|D|B><suffix>` when that is too
 * long. Context only.
 */
export function parseCorrelationId(value: string): { orderId: string; paymentType: PaymentType | null } {
  const readable = /^(.+)_(full|deposit|balance)_([a-zA-Z0-9]{6,32})$/.exec(value);
  if (readable) return { orderId: readable[1]!, paymentType: readable[2] as PaymentType };
  const compact = /^(.+)_([FDB])([a-zA-Z0-9]{6,8})$/.exec(value);
  if (compact) return { orderId: compact[1]!, paymentType: ({ F: "full", D: "deposit", B: "balance" } as const)[compact[2] as "F" | "D" | "B"] };
  return { orderId: value, paymentType: null };
}

/** "150.00" taka → 15000 paisa, exactly; null for anything else (a third non-zero decimal included). */
export function takaToMinor(value: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  if (fraction.length > 2 && /[^0]/.test(fraction.slice(2))) return null;
  const minor = Number(`${match[1]}${fraction.slice(0, 2)}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

const timedOut = (error: unknown) => platformErrorCode(error) === "http_timeout";

// ── Validation ──────────────────────────────────────────────────────────────

/** The validation API's answer for one `val_id`; null when it could not be asked or read. */
async function validate(ctx: PluginContext, account: Account, valId: string): Promise<Answer | null> {
  const url = new URL(`${baseUrl(account)}/validator/api/validationserverAPI.php`);
  url.searchParams.set("val_id", valId);
  url.searchParams.set("store_id", account.storeId);
  url.searchParams.set("store_passwd", account.storePassword);
  url.searchParams.set("format", "json");
  try {
    const response = await ctx.http.fetch(url.toString(), { timeoutMs: VALIDATION_TIMEOUT_MS });
    return response.ok ? answerOf(await response.text()) : null;
  } catch {
    return null;
  }
}

/**
 * One validated answer as a payment event. Callback fields are expectations
 * only: any disagreement with the validated answer (or between its metadata
 * and its own transaction id) yields no event.
 */
export function validatedEvent(
  validation: Answer,
  requestedValId: string,
  expected: { tranId?: string; orderId?: string; paymentType?: PaymentType | null } = {},
): PaymentVerification {
  const status = clean(validation.status);
  const tranId = clean(validation.tran_id);
  const valId = clean(validation.val_id);
  const parsedTran = parseCorrelationId(tranId);
  const metadataOrderId = clean(validation.value_b) || null;
  const metadataPaymentType = paymentTypeOf(clean(validation.value_a));
  const orderId = metadataOrderId ?? parsedTran.orderId;

  if (
    !tranId ||
    !valId ||
    valId !== requestedValId ||
    tranId.length > 30 ||
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
    // tran_id is the platform's correlation id: the attempt this failure ends.
    return { status: "event", event: { ...identity, kind: "failed", correlationId: tranId, details: { tranId, validationStatus: status } } };
  }
  if (!VALID_STATUSES.has(status)) {
    return { status: "ignored", reason: `SSLCommerz status ${status.slice(0, 40) || "unknown"} is not final` };
  }

  const currency = (clean(validation.currency_type) || clean(validation.currency)).toUpperCase();
  const amountMinor = currency === "BDT" ? takaToMinor(clean(validation.amount) || clean(validation.store_amount)) : null;
  const bankTranId = clean(validation.bank_tran_id);
  if (!amountMinor || amountMinor <= 0 || !bankTranId || bankTranId.length > 256) {
    return { status: "retry", reason: "Validation response is missing canonical payment data" };
  }

  const event: PaymentEvent = {
    ...identity,
    kind: "confirmed",
    secondaryRef: bankTranId,
    amountMinor,
    currency,
    ...((metadataPaymentType ?? parsedTran.paymentType) ? { paymentType: (metadataPaymentType ?? parsedTran.paymentType)! } : {}),
    details: {
      tranId,
      validationStatus: status,
      cardType: clean(validation.card_type).slice(0, 100) || null,
      cardBrand: clean(validation.card_brand).slice(0, 100) || null,
    },
  };
  return { status: "event", event };
}

// ── The merchant API (transaction query, refunds) ───────────────────────────

/** One merchant API call; throws when SSLCommerz could not be asked or did not take the call. */
async function merchantApi(ctx: PluginContext, account: Account, params: Record<string, string>, mutating: boolean): Promise<Answer> {
  const url = new URL(`${baseUrl(account)}/validator/api/merchantTransIDvalidationAPI.php`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("store_id", account.storeId);
  url.searchParams.set("store_passwd", account.storePassword);
  url.searchParams.set("format", "json");
  let response;
  try {
    response = await ctx.http.fetch(url.toString(), { timeoutMs: VALIDATION_TIMEOUT_MS });
  } catch (error) {
    throw new ProviderError("retryable", "SSLCommerz could not be reached.", {
      uncertain: mutating,
      code: timedOut(error) ? "sslcommerz_timeout" : "sslcommerz_unreachable",
    });
  }
  if (!response.ok) {
    throw new ProviderError("retryable", `SSLCommerz answered HTTP ${response.status}.`, { uncertain: mutating, code: "sslcommerz_http" });
  }
  const data = answerOf(await response.text());
  if (!data) throw new ProviderError("retryable", "SSLCommerz's answer could not be read.", { uncertain: mutating, code: "sslcommerz_unreadable" });
  if (data.APIConnect !== "DONE") {
    const state = clean(data.APIConnect).replace(/[^A-Z_]/g, "").slice(0, 20) || "unknown";
    throw new ProviderError("retryable", `SSLCommerz API connection failed: ${state}.`, { uncertain: mutating, code: "sslcommerz_api_connect" });
  }
  return data;
}

// ── Operations ──────────────────────────────────────────────────────────────

export async function createSession(input: PaymentSessionInput, ctx: PluginContext): Promise<PaymentSession> {
  const account = accountOf(ctx);
  const body = new URLSearchParams({
    store_id: account.storeId,
    store_passwd: account.storePassword,
    total_amount: input.wireAmount.decimal,
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

  let response;
  try {
    response = await ctx.http.fetch(`${baseUrl(account)}/gwprocess/v4/api.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      timeoutMs: input.requestTimeoutMs,
    });
  } catch (error) {
    if (timedOut(error)) {
      throw new ProviderError("retryable", "SSLCommerz did not respond before the payment timeout. Please try again.", { code: "sslcommerz_timeout" });
    }
    throw new ProviderError("declined", "Network error contacting SSLCommerz", { code: "sslcommerz_unreachable" });
  }
  if (!response.ok) throw new ProviderError("declined", `SSLCommerz API error: HTTP ${response.status}`, { code: "sslcommerz_http" });
  const data = answerOf(await response.text()) ?? {};
  const pageUrl = clean(data.GatewayPageURL);
  if (data.status !== "SUCCESS" || !pageUrl) {
    // SSLCommerz's short refusal ("Store Credential Error Or Store is De-active"): no credential or buyer data.
    const reason = clean(data.failedreason) || clean(data.status) || "Failed to initiate SSLCommerz session";
    throw new ProviderError("declined", reason.slice(0, 200), { code: "sslcommerz_session_refused" });
  }
  if (!pageUrl.startsWith("https://") || pageUrl.length > 2048 || !URL.canParse(pageUrl)) {
    throw new ProviderError("declined", "SSLCommerz's answer did not include its payment page.", { code: "sslcommerz_page" });
  }
  const sessionKey = clean(data.sessionkey);
  return { ...(REFERENCE.test(sessionKey) ? { providerRef: sessionKey } : {}), redirectUrl: pageUrl };
}

export async function verifyWebhook(request: ProviderHttpRequest, ctx: PluginContext): Promise<PaymentVerification> {
  const valId = clean(formOf(request).val_id);
  if (!valId) return { status: "ignored", reason: "IPN missing val_id" };
  if (!REFERENCE.test(valId)) return { status: "ignored", reason: "IPN val_id is not an SSLCommerz validation id" };
  const validation = await validate(ctx, accountOf(ctx), valId);
  if (!validation) return { status: "retry", reason: "SSLCommerz validation API call failed" };
  return validatedEvent(validation, valId);
}

/** The buyer's success return (a failed or cancelled one is the platform's: `returnCorrelationField`). */
export async function verifyReturn(request: ProviderHttpRequest, ctx: PluginContext): Promise<PaymentVerification> {
  const form = formOf(request);
  const tranId = clean(form.tran_id || request.query.tran_id);
  const valId = clean(form.val_id || request.query.val_id);
  const orderId = clean(request.query.order_id) || parseCorrelationId(tranId).orderId;
  if (!tranId || !valId || !orderId) return { status: "ignored", reason: "Return is missing transaction context" };
  if (!REFERENCE.test(valId)) return { status: "ignored", reason: "Return val_id is not an SSLCommerz validation id" };
  const validation = await validate(ctx, accountOf(ctx), valId);
  if (!validation) return { status: "retry", reason: "SSLCommerz validation API call failed" };
  if (!VALID_STATUSES.has(clean(validation.status))) return { status: "ignored", reason: "Return was not validated as paid" };
  return validatedEvent(validation, valId, {
    tranId,
    orderId,
    paymentType: paymentTypeOf(request.query.payment_type ?? request.query.paymentType),
  });
}

/**
 * Whether the session the platform recorded was paid: SSLCommerz's
 * transaction query by session key, then the validation API for the
 * payment it names, so the event is the one its IPN gives.
 */
export async function queryPayment(input: PaymentQueryInput, ctx: PluginContext): Promise<PaymentQuery> {
  if (!REFERENCE.test(input.providerRef)) {
    throw new ProviderError("declined", "This is not an SSLCommerz session key.", { code: "sslcommerz_session_key" });
  }
  const account = accountOf(ctx);
  const session = await merchantApi(ctx, account, { sessionkey: input.providerRef }, false);
  const status = clean(session.status).slice(0, 100) || "Unknown";
  const valId = clean(session.val_id);
  if (!VALID_STATUSES.has(clean(session.status)) || !REFERENCE.test(valId)) return { providerStatus: status };
  const validation = await validate(ctx, account, valId);
  if (!validation) throw new ProviderError("retryable", "SSLCommerz validation API call failed.", { code: "sslcommerz_validation" });
  const verified = validatedEvent(validation, valId, { orderId: input.orderId });
  if (verified.status === "retry") throw new ProviderError("retryable", verified.reason, { code: "sslcommerz_validation" });
  return verified.status === "event" && verified.event.kind === "confirmed"
    ? { providerStatus: status, event: verified.event }
    : { providerStatus: status };
}

export async function refund(input: PaymentRefundInput, ctx: PluginContext): Promise<PaymentRefund> {
  if (!input.secondaryRef) {
    throw new ProviderError("declined", "No SSLCommerz bank_tran_id found on payment record", { code: "sslcommerz_bank_tran_id" });
  }
  // refund_trans_id: at most 30 characters, deterministic so retries reuse it.
  const refundTranId = input.reference.replace(/[^A-Za-z0-9]/g, "").slice(0, 30);
  const data = await merchantApi(ctx, accountOf(ctx), {
    bank_tran_id: input.secondaryRef,
    refund_amount: input.wireAmount.decimal,
    refund_remarks: input.reason || "Refund requested",
    refund_trans_id: refundTranId,
    v: "1",
  }, true);
  if (data.status !== "success" && data.status !== "processing") {
    // A refusal is kept for reconciliation, never resent.
    const reason = clean(data.errorReason).slice(0, 200) || "Refund request failed";
    throw new ProviderError("retryable", reason, { uncertain: true, code: "sslcommerz_refund_refused" });
  }
  const refundRef = clean(data.refund_ref_id);
  return { refundId: REFERENCE.test(refundRef) ? refundRef : refundTranId };
}

export async function refundStatus(input: PaymentRefundProbeInput, ctx: PluginContext): Promise<PaymentRefundProbe> {
  if (!input.providerRefundId) {
    return { outcome: "unknown", error: "SSLCommerz refund reference is missing. Manual provider review required before retrying.", manualReview: true };
  }
  let data: Answer;
  try {
    data = await merchantApi(ctx, accountOf(ctx), { refund_ref_id: input.providerRefundId }, false);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.category === "misconfigured") throw error;
    return { outcome: "unknown", providerRefundId: input.providerRefundId, providerStatus: "cancelled", error: error.message };
  }
  const status = clean(data.status).slice(0, 100) || "processing";
  const refundRef = clean(data.refund_ref_id);
  const providerRefundId = REFERENCE.test(refundRef) ? refundRef : input.providerRefundId;
  const responsePayload = {
    status,
    refundRefId: providerRefundId,
    bankTranId: clean(data.bank_tran_id).slice(0, 256),
    tranId: clean(data.tran_id).slice(0, 256),
    ...(data.refunded_on ? { refundedOn: clean(data.refunded_on).slice(0, 64) } : {}),
  };
  if (status === "refunded") return { outcome: "accepted", providerRefundId, providerStatus: status, responsePayload };
  if (status === "cancelled") return { outcome: "rejected", providerRefundId, providerStatus: status, responsePayload };
  return { outcome: "processing", providerRefundId, providerStatus: status, responsePayload };
}

/** One transaction query for a reference no payment has: SSLCommerz takes the call only with working credentials. */
async function testConnection(_input: unknown, ctx: PluginContext): Promise<{ ok: boolean; message: string }> {
  const account = accountOf(ctx);
  try {
    await merchantApi(ctx, account, { tran_id: `SCALIUSTEST${Date.now()}` }, false);
    return { ok: true, message: `Connected to SSLCommerz ${account.environment}.` };
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, message: error.message };
    throw error;
  }
}

export const paymentProviders = {
  sslcommerz: definePaymentProvider({
    createSession,
    verifyWebhook,
    verifyReturn,
    queryPayment,
    refund,
    refundStatus,
    testConnection,
  }),
};
