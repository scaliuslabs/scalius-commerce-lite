// src/lib/api/customer-auth.ts
// API client for storefront customer sign-in (one-time codes by email, SMS or WhatsApp).
//
// All auth requests go through a same-origin proxy (/api/customer-auth/*)
// so Set-Cookie headers are processed by the browser. Cross-origin
// Cross-origin Set-Cookie is silently dropped
// by modern browsers.
import {
  PaymentSessionProcessingTimeoutError,
  fetchPaymentSessionWithProcessingRetry,
  unwrapPaymentSessionPayload,
  type PaymentSessionRetryOptions,
} from "../checkout/payment-session-retry";
import type { OrderReceiptDiscount } from "./types";

// ---------------------------------------------------------------------------
// Response shapes for customer auth API endpoints
// ---------------------------------------------------------------------------

/** Envelope for send-otp / verify-otp / profile responses */
interface AuthApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: string | { message?: string; details?: { retryAfterSeconds?: number; attemptsLeft?: number } };
}

interface SendOtpData {
  resendAfterSeconds?: number;
}

interface VerifyOtpData {
  status?: "signed_in" | "needs_account_details";
  customer?: CustomerInfo;
  isNewUser?: boolean;
  suggestion?: unknown;
}

interface ProfileData {
  customer?: CustomerInfo;
}

interface OrdersData {
  orders: CustomerOrder[];
  customer?: CustomerInfo;
  summary?: CustomerOrdersSummary;
  pagination?: CustomerOrdersPagination;
  phoneVerification?: unknown;
}

interface SessionData {
  authenticated: boolean;
  customer?: CustomerInfo;
}

interface CustomerOrderPaymentSessionData {
  gateway: string;
  paymentType: "full" | "deposit" | "balance";
  amount: number;
  currency: string;
  stripe?: {
    clientSecret?: string;
    paymentIntentId?: string;
    publishableKey: string;
    amount: number;
    currency: string;
  };
  hosted?: {
    gatewayUrl?: string;
    sessionKey?: string;
    checkoutId?: string;
  };
}

interface CustomerOrderPaymentSessionProcessingData {
  status: "processing";
  retryable?: boolean;
  retryAfterSeconds?: number;
  message?: string;
}

function isCustomerOrderPaymentSession(value: unknown): value is CustomerOrderPaymentSessionData {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<CustomerOrderPaymentSessionData>;
  return (
    typeof session.gateway === "string" && session.gateway.length > 0 &&
    (session.paymentType === "full" || session.paymentType === "deposit" || session.paymentType === "balance")
  );
}

export type CustomerOtpChannel = "email" | "sms" | "whatsapp";

export interface SendCustomerOtpInput {
  method: "email" | "phone";
  channel: CustomerOtpChannel;
  identifier: string;
}

export interface NewCustomerAccountDetails {
  name: string;
  phone?: string;
  email?: string;
  /** Copy the suggested order's delivery address; the server reads it itself. */
  saveOrderAddress?: boolean;
}

/** What the store knows from the latest order placed with the proven contact. */
export interface NewCustomerSuggestion {
  name: string | null;
  phone: string | null;
  email: string | null;
  /** One line to show ("House 1, Road 2, Mirpur, Dhaka"); never sent back. */
  address: { orderNumber: number | null; text: string } | null;
}

export interface VerifyCustomerOtpInput extends SendCustomerOtpInput {
  code: string;
  /** Only after the server answered `needs_account_details`. */
  account?: NewCustomerAccountDetails;
}

export type SendCustomerOtpResult =
  | { success: true; resendAfterSeconds: number }
  | { success: false; error: string; retryAfterSeconds?: number };

export type VerifyCustomerOtpResult =
  | { success: true; status: "signed_in"; customer: CustomerInfo; isNewUser: boolean }
  | { success: true; status: "needs_account_details"; suggestion: NewCustomerSuggestion | null }
  | { success: false; error: string; attemptsLeft?: number };

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSuggestion(value: unknown): NewCustomerSuggestion | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const address = raw.address && typeof raw.address === "object" ? raw.address as Record<string, unknown> : null;
  const addressText = optionalText(address?.text);
  const orderNumber = address?.orderNumber;
  return {
    name: optionalText(raw.name),
    phone: optionalText(raw.phone),
    email: optionalText(raw.email),
    address: addressText
      ? { orderNumber: typeof orderNumber === "number" && Number.isSafeInteger(orderNumber) ? orderNumber : null, text: addressText }
      : null,
  };
}

/**
 * Build a same-origin customer auth URL.
 * On the client, uses a relative path (same-origin proxy).
 * On SSR, also uses relative path (resolved by the Astro route).
 */
function authUrl(subpath: string): string {
  return `/api/customer-auth/${subpath}`;
}

const CUSTOMER_AUTH_READ_TIMEOUT_MS = 8_000;
const CUSTOMER_AUTH_WRITE_TIMEOUT_MS = 12_000;
let inFlightCustomerSessionRead: Promise<AuthState> | null = null;

async function customerAuthFetch(
  input: string,
  init: RequestInit = {},
  timeoutMs = CUSTOMER_AUTH_READ_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function readEnvelope<T>(res: Response): Promise<AuthApiEnvelope<T>> {
  try {
    return (await res.json()) as AuthApiEnvelope<T>;
  } catch {
    return {
      success: false,
      error: {
        message: res.ok
          ? "Invalid account response. Please try again."
          : `Request failed with status ${res.status}`,
      },
    };
  }
}

const UNREACHABLE_MESSAGE = "We couldn't reach the store. Check your connection and try again.";

/** Extract a human-readable error message from the API envelope */
function extractError(raw: AuthApiEnvelope): string | undefined {
  if (!raw.error) return undefined;
  return typeof raw.error === "object" ? raw.error.message : raw.error;
}

function errorDetails(raw: AuthApiEnvelope): { retryAfterSeconds?: number; attemptsLeft?: number } {
  return typeof raw.error === "object" && raw.error.details ? raw.error.details : {};
}

/** Server messages for 4xx; one plain sentence for outages (never "Proxy error"). */
function failureMessage(res: Response, raw: AuthApiEnvelope): string {
  if (res.status >= 500 || res.status === 0) return UNREACHABLE_MESSAGE;
  return extractError(raw) || "Something went wrong. Please try again.";
}

function isTemporaryReadFailure(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function isFailedEnvelope(raw: AuthApiEnvelope): boolean {
  return raw.success === false;
}

/** Timeouts and network failures read the same to a buyer. */
function networkErrorMessage(_error: unknown): string {
  return UNREACHABLE_MESSAGE;
}

function clearInFlightCustomerSessionRead(): void {
  inFlightCustomerSessionRead = null;
}

function clearReadableCustomerAuthMirrorCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = "cs_auth=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
}

export interface CustomerInfo {
  email: string;
  name: string;
  phone?: string;
  customerId?: string;
  address?: string | null;
  city?: string | null;
  cityName?: string | null;
  zone?: string | null;
  zoneName?: string | null;
  area?: string | null;
  areaName?: string | null;
  /** A delivery address is saved (checkout can prefill it). */
  profileComplete?: boolean;
}

export interface AuthState {
  authenticated: boolean;
  customer?: CustomerInfo;
  unavailable?: boolean;
  error?: string;
  status?: number;
}

/**
 * Send a sign-in code. The same call for new and returning buyers.
 */
export async function sendCustomerOtp(input: SendCustomerOtpInput): Promise<SendCustomerOtpResult> {
  try {
    const res = await customerAuthFetch(authUrl("send-otp"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS);
    const raw = await readEnvelope<SendOtpData>(res);
    if (!res.ok || isFailedEnvelope(raw)) {
      return {
        success: false,
        error: failureMessage(res, raw),
        retryAfterSeconds: errorDetails(raw).retryAfterSeconds,
      };
    }
    return { success: true, resendAfterSeconds: raw.data?.resendAfterSeconds ?? 60 };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error) };
  }
}

/**
 * Check a code: signs in, or reports that a new buyer must add details.
 */
export async function verifyCustomerOtp(input: VerifyCustomerOtpInput): Promise<VerifyCustomerOtpResult> {
  try {
    const res = await customerAuthFetch(authUrl("verify-otp"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS);
    const raw = await readEnvelope<VerifyOtpData>(res);
    const data = raw.data;
    if (!res.ok || isFailedEnvelope(raw) || !data?.status) {
      return { success: false, error: failureMessage(res, raw), attemptsLeft: errorDetails(raw).attemptsLeft };
    }
    if (data.status === "needs_account_details") {
      return { success: true, status: data.status, suggestion: readSuggestion(data.suggestion) };
    }
    if (!data.customer) return { success: false, error: "Something went wrong. Please try again." };
    clearInFlightCustomerSessionRead();
    return { success: true, status: "signed_in", customer: data.customer, isNewUser: data.isNewUser === true };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error) };
  }
}

/**
 * Get current customer session info.
 */
export async function getCustomerSession(): Promise<AuthState> {
  if (inFlightCustomerSessionRead) {
    return inFlightCustomerSessionRead;
  }

  inFlightCustomerSessionRead = (async (): Promise<AuthState> => {
    try {
      const res = await customerAuthFetch(authUrl("me"), {
        credentials: "include",
        cache: "no-store",
      });
      const raw = await readEnvelope<SessionData>(res);
      const data = raw.data ?? (raw as unknown as SessionData);
      if (!res.ok || isFailedEnvelope(raw) || typeof data.authenticated !== "boolean") {
        const unavailable = isTemporaryReadFailure(res.status) || res.ok;
        if (!unavailable) clearReadableCustomerAuthMirrorCookie();
        return {
          authenticated: false,
          unavailable,
          status: res.status,
          error: extractError(raw) || "Account status could not be read. Please try again.",
        };
      }
      if (!data.authenticated) clearReadableCustomerAuthMirrorCookie();
      return data as AuthState;
    } catch (error: unknown) {
      return {
        authenticated: false,
        unavailable: true,
        status: 0,
        error: networkErrorMessage(error),
      };
    }
  })();

  try {
    return await inFlightCustomerSessionRead;
  } finally {
    clearInFlightCustomerSessionRead();
  }
}

/**
 * Log out the current customer.
 * Uses a same-origin proxy (/api/auth/logout) to guarantee the browser
 * processes the Set-Cookie headers that clear the HttpOnly cs_tok cookie.
 * Cross-origin Set-Cookie from a different domain is
 * silently dropped by modern browsers.
 */
export async function logoutCustomer(): Promise<void> {
  clearInFlightCustomerSessionRead();
  clearReadableCustomerAuthMirrorCookie();
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    // Ignore errors — client-side cs_auth clear is a fallback
  }
}

export interface CustomerOrderItem {
  productId: string;
  variantId: string | null;
  quantity: number;
  price: number;
  productName: string | null;
  productSlug: string | null;
  productImage: string | null;
  variantLabel: string | null;
  unitPriceMinor?: number | null;
  lineSubtotalMinor?: number | null;
  discountAmountMinor?: number | null;
  taxableAmountMinor?: number | null;
  taxAmountMinor?: number;
}

export interface CustomerOrderShipment {
  id: string;
  providerType: string;
  providerName: string | null;
  status: string;
  rawStatus: string | null;
  trackingId: string | null;
  trackingUrl: string | null;
  courierName: string | null;
  /** Buyer words for the courier state ("On its way"); never provider states. */
  statusLabel: string;
  lastChecked: string | null;
  updatedAt: string | null;
  createdAt: string | null;
}

export interface CustomerOrder {
  id: string;
  /** Short sequential number ("#1001"); null until the store has one. */
  orderNumber?: number | null;
  status: string;
  statusLabel: string;
  currencyCode: string;
  openSupportRequestType: string | null;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  shippingCharge: number;
  shippingMethodId: string | null;
  shippingMethodName: string | null;
  shippingMethodDescription: string | null;
  shippingMethodBaseAmountMinor: number | null;
  shippingFeeWaived: boolean | null;
  discountAmount: number | null;
  paymentStatus: string;
  paymentMethod: string;
  fulfillmentStatus: string;
  shippingAddress: string;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  notes: string | null;
  createdAt: string | null;
  latestShipment: CustomerOrderShipment | null;
  items: CustomerOrderItem[];
}

export interface CustomerOrdersSummary {
  totalOrders: number;
  totalSpent: number;
  completedOrders: number;
  pendingOrders: number;
}

export interface CustomerOrdersPagination {
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CustomerOrderDetailPayment {
  id: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  paymentType: string;
  status: string;
  codReceiptUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CustomerOrderDetailPaymentPlan {
  totalAmount: number;
  depositAmount: number;
  balanceDue: number;
  balanceDueDate: string | null;
  status: string;
  depositPaidAt: string | null;
  balancePaidAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CustomerOrderDetailCod {
  codStatus: string;
  deliveryAttempts: number;
  failureReason: string | null;
  collectedAmount: number | null;
  receiptUrl: string | null;
  lastAttemptAt: string | null;
  collectedAt: string | null;
  updatedAt: string | null;
}

export interface CustomerOrderTimelineEvent {
  id: string;
  type: "order" | "payment" | "refund" | "request";
  status: string;
  label: string;
  happenedAt: string | null;
  details?: string | null;
}

export interface CustomerOrderRefundAttempt {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  gateway: string;
  status: "queued" | "checking" | "processing" | "settled" | "failed";
  providerStatus: null;
  active: boolean;
  severity: "info" | "success" | "warning" | "danger";
  label: string;
  message: string;
  createdAt: string | null;
  updatedAt: string | null;
  nextProbeAt: string | null;
  lastProbeAt: string | null;
  refundedAt: string | null;
  failedAt: string | null;
}

export interface CustomerActiveRefundOperation {
  active: true;
  status: string;
  severity: "info" | "success" | "warning" | "danger";
  label: string;
  message: string;
  amount: number;
  currency: string;
  gateway: string;
  attemptCount: number;
  nextProbeAt: string | null;
  lastProbeAt: string | null;
  providerStatus: null;
}

export interface CustomerPaymentRecovery {
  eligible: boolean;
  gateway: string | null;
  paymentType: "full" | "deposit" | "balance" | null;
  amountDue: number;
  label: string | null;
  reason: string | null;
  requiresCardForm: boolean;
  hostedRedirect: boolean;
}

export type CustomerOrderSupportRequestType = "cancel_pre_shipment" | "return" | "refund";

export interface CustomerOrderSupportRequest {
  id: string;
  orderId: string;
  customerId: string;
  type: CustomerOrderSupportRequestType;
  status: string;
  active: boolean;
  severity: "info" | "success" | "warning" | "danger";
  label: string;
  actionLabel: string;
  reason: string;
  message: string | null;
  submittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CustomerOrderSupportRequestAction {
  type: CustomerOrderSupportRequestType;
  label: string;
  description: string;
  eligible: boolean;
  disabledReason: string | null;
}

export interface CreateCustomerOrderSupportRequestInput {
  type: CustomerOrderSupportRequestType;
  reason: string;
  message?: string | null;
}

interface CustomerOrderSupportRequestData {
  request: CustomerOrderSupportRequest;
  supportRequests: CustomerOrderSupportRequest[];
  supportRequestActions: CustomerOrderSupportRequestAction[];
  supportRequestIntro: string;
}

export type CustomerOrderPaymentSession = CustomerOrderPaymentSessionData;

export interface CustomerOrderProgress {
  steps: Array<{ key: "placed" | "confirmed" | "shipped" | "delivered"; label: string; done: boolean; happenedAt: string | null }>;
  outcome: { key: string; label: string; happenedAt: string | null } | null;
}

export interface CustomerOrderDetailOrder {
  id: string;
  orderNumber?: number | null;
  invoiceNumber: number | null;
  status: string;
  statusLabel: string;
  customerName: string;
  customerPhone: string;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  shippingCharge: number;
  discountAmount: number | null;
  currencyCode?: string | null;
  currencyDecimalPlaces?: number | null;
  subtotalAmountMinor?: number | null;
  shippingAmountMinor?: number | null;
  shippingMethodId?: string | null;
  shippingMethodName?: string | null;
  shippingMethodDescription?: string | null;
  shippingMethodBaseAmountMinor?: number | null;
  shippingFeeWaived?: boolean | null;
  discountAmountMinor?: number | null;
  taxAmountMinor?: number;
  totalAmountMinor?: number | null;
  taxLabel?: string | null;
  pricesIncludeTax?: boolean;
  paymentStatus: string;
  paymentMethod: string;
  fulfillmentStatus: string;
  expectedDelivery: string | null;
  shippingAddress: string;
  city: string;
  zone: string;
  area: string | null;
  cityName: string | null;
  zoneName: string | null;
  areaName: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CustomerOrderDetail {
  order: CustomerOrderDetailOrder;
  items: Array<CustomerOrderItem & {
    id: string;
    productSlug: string | null;
    unitPrice: number;
    lineTotal: number;
    fulfillmentStatus: string;
    createdAt: string | null;
  }>;
  shipments: Array<CustomerOrderShipment & {
    note: string | null;
    shipmentAmount: number | null;
    isFinalShipment: boolean;
  }>;
  payments: CustomerOrderDetailPayment[];
  refundAttempts: CustomerOrderRefundAttempt[];
  activeRefundOperation: CustomerActiveRefundOperation | null;
  supportRequests: CustomerOrderSupportRequest[];
  supportRequestActions: CustomerOrderSupportRequestAction[];
  supportRequestIntro: string;
  paymentPlan: CustomerOrderDetailPaymentPlan | null;
  cod: CustomerOrderDetailCod | null;
  progress: CustomerOrderProgress;
  paymentRecovery: CustomerPaymentRecovery;
  timeline: CustomerOrderTimelineEvent[];
  /** Each discount used, as on the receipt: `amount` off the items, `shippingAmount` off delivery. */
  discounts?: OrderReceiptDiscount[];
}

export interface ProfileUpdateData {
  name?: string;
  address?: string;
  city?: string;
  zone?: string;
  area?: string;
  cityName?: string;
  zoneName?: string;
  areaName?: string;
}

/**
 * Update customer profile. Requires active session (cs_tok cookie).
 */
export async function updateCustomerProfile(data: ProfileUpdateData): Promise<{
  success: boolean;
  customer?: CustomerInfo;
  error?: string;
  status?: number;
  unavailable?: boolean;
}> {
  try {
    const res = await customerAuthFetch(authUrl("profile"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(data),
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS);
    const raw = await readEnvelope<ProfileData>(res);
    const result = raw.data ?? (raw as unknown as ProfileData); // Unwrap envelope
    if (!res.ok || isFailedEnvelope(raw)) {
      return {
        success: false,
        error: extractError(raw) || "Profile could not be updated. Please try again.",
        status: res.status,
        unavailable: isTemporaryReadFailure(res.status) || res.ok,
      };
    }
    clearInFlightCustomerSessionRead();
    return { success: true, customer: result.customer };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error), status: 0, unavailable: true };
  }
}

/**
 * Get customer order history. Requires active session (cs_tok cookie).
 */
export async function getCustomerOrders(options: {
  cursor?: string | null;
  limit?: number;
} = {}): Promise<{
  success: boolean;
  orders: CustomerOrder[];
  customer?: CustomerInfo;
  summary?: CustomerOrdersSummary;
  pagination?: CustomerOrdersPagination;
  /** Set only when the account's own phone is unverified and the store can text it a code. */
  phoneVerification?: PhoneVerificationPrompt | null;
  error?: string;
  status?: number;
  unavailable?: boolean;
}> {
  try {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    const path = params.size > 0 ? `orders?${params.toString()}` : "orders";
    const res = await customerAuthFetch(authUrl(path), {
      credentials: "include",
      cache: "no-store",
    });
    const raw = await readEnvelope<OrdersData>(res);
    const data = raw.data ?? (raw as unknown as OrdersData); // Unwrap envelope
    if (!res.ok || isFailedEnvelope(raw) || !Array.isArray(data.orders)) {
      return {
        success: false,
        orders: [],
        error: extractError(raw) || "Order history could not be read. Please try again.",
        status: res.status,
        unavailable: isTemporaryReadFailure(res.status) || res.ok,
      };
    }
    return {
      success: true,
      orders: data.orders || [],
      customer: data.customer,
      ...(data.summary ? { summary: data.summary } : {}),
      ...(data.pagination ? { pagination: data.pagination } : {}),
      phoneVerification: readPhoneVerification(data.phoneVerification),
    };
  } catch (error: unknown) {
    return {
      success: false,
      orders: [],
      error: networkErrorMessage(error),
      status: 0,
      unavailable: true,
    };
  }
}

/** The account's own phone, still unverified, when the store can text it a code. */
export interface PhoneVerificationPrompt {
  /** E.164 phone of this account ("+8801712345678"); shown formatted, never put in a URL. */
  phone: string;
}

function readPhoneVerification(value: unknown): PhoneVerificationPrompt | null {
  if (!value || typeof value !== "object") return null;
  const phone = (value as Record<string, unknown>).phone;
  return typeof phone === "string" && phone.trim() ? { phone: phone.trim() } : null;
}

export type SendPhoneVerificationCodeResult =
  | { success: true; message: string; resendAfterSeconds: number }
  | { success: false; error: string; status: number; retryAfterSeconds?: number };

export type VerifyPhoneResult =
  | { success: true; movedOrders: number; message: string }
  | { success: false; error: string; status: number; attemptsLeft?: number };

/** Server messages as they are, even for 503 ("Text message codes aren't available right now."). */
function phoneVerificationFailure(res: Response, raw: AuthApiEnvelope): string {
  return extractError(raw) || (res.status >= 500 ? UNREACHABLE_MESSAGE : "Something went wrong. Please try again.");
}

/** Text a code to this account's own phone. No body: the server reads the phone from the session. */
export async function sendPhoneVerificationCode(): Promise<SendPhoneVerificationCodeResult> {
  try {
    const res = await customerAuthFetch(authUrl("phone/send-code"), {
      method: "POST",
      credentials: "include",
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS);
    const raw = await readEnvelope<{ message?: string; resendAfterSeconds?: number }>(res);
    const data = raw.data;
    if (!res.ok || isFailedEnvelope(raw) || !data) {
      return { success: false, error: phoneVerificationFailure(res, raw), status: res.status, retryAfterSeconds: errorDetails(raw).retryAfterSeconds };
    }
    return {
      success: true,
      message: data.message || "We sent a code to your phone.",
      resendAfterSeconds: data.resendAfterSeconds ?? 60,
    };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error), status: 0 };
  }
}

/** Prove the account's phone with its code; orders placed with it move to this account. */
export async function verifyPhone(code: string): Promise<VerifyPhoneResult> {
  try {
    const res = await customerAuthFetch(authUrl("phone/verify"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code }),
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS);
    const raw = await readEnvelope<{ movedOrders?: number; message?: string }>(res);
    const data = raw.data;
    if (!res.ok || isFailedEnvelope(raw) || !data) {
      return { success: false, error: phoneVerificationFailure(res, raw), status: res.status, attemptsLeft: errorDetails(raw).attemptsLeft };
    }
    const movedOrders = typeof data.movedOrders === "number" && data.movedOrders > 0 ? data.movedOrders : 0;
    return {
      success: true,
      movedOrders,
      message: data.message || "Your phone number is verified.",
    };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error), status: 0 };
  }
}

/**
 * Get one customer order detail/timeline. Requires active session (cs_tok cookie).
 */
export async function getCustomerOrderDetail(orderId: string): Promise<{
  success: boolean;
  detail?: CustomerOrderDetail;
  error?: string;
  status?: number;
  unavailable?: boolean;
}> {
  if (!orderId) {
    return { success: false, error: "Order ID is required", status: 400 };
  }

  try {
    const res = await customerAuthFetch(authUrl(`orders/${encodeURIComponent(orderId)}`), {
      credentials: "include",
      cache: "no-store",
    });
    const raw = await readEnvelope<CustomerOrderDetail>(res);
    const detail = raw.data ?? (raw as unknown as CustomerOrderDetail);
    if (!res.ok || isFailedEnvelope(raw) || !detail.order) {
      return {
        success: false,
        error: extractError(raw) || "Order details could not be read. Please try again.",
        status: res.status,
        unavailable: isTemporaryReadFailure(res.status) || res.ok,
      };
    }
    return { success: true, detail };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error), status: 0, unavailable: true };
  }
}

/**
 * Create a support request for an order owned by the signed-in customer.
 * This records buyer intent only; it never changes order, shipment, or payment state.
 */
export async function createCustomerOrderSupportRequest(
  orderId: string,
  input: CreateCustomerOrderSupportRequestInput,
): Promise<{
  success: boolean;
  data?: CustomerOrderSupportRequestData;
  error?: string;
  status?: number;
}> {
  if (!orderId) {
    return { success: false, error: "Order ID is required", status: 400 };
  }

  try {
    const res = await customerAuthFetch(authUrl(`orders/${encodeURIComponent(orderId)}/support-requests`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify(input),
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS);
    const raw = await readEnvelope<CustomerOrderSupportRequestData>(res);
    const data = raw.data ?? (raw as unknown as CustomerOrderSupportRequestData);
    if (!res.ok || isFailedEnvelope(raw) || !data.request) {
      return {
        success: false,
        error: extractError(raw) || "Request could not be submitted. Please try again.",
        status: res.status,
      };
    }
    return { success: true, data };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error), status: 0 };
  }
}

/**
 * Create a payment session for an order owned by the signed-in customer.
 * This endpoint never accepts or returns receipt tokens.
 */
type CreateCustomerOrderPaymentSessionOptions = Pick<PaymentSessionRetryOptions, "onProcessing"> & {
  gateway?: string;
  replaceExistingAttempt?: boolean;
};

export async function createCustomerOrderPaymentSession(orderId: string, options: CreateCustomerOrderPaymentSessionOptions = {}): Promise<{
  success: boolean;
  session?: CustomerOrderPaymentSession;
  error?: string;
  status?: number;
}> {
  if (!orderId) {
    return { success: false, error: "Order ID is required", status: 400 };
  }

  try {
    const { data: rawResponse, response: res } = await fetchPaymentSessionWithProcessingRetry(() => customerAuthFetch(authUrl(`orders/${encodeURIComponent(orderId)}/payment-session`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({
        ...(options.gateway ? { gateway: options.gateway } : {}),
        ...(options.replaceExistingAttempt !== undefined
          ? { replaceExistingAttempt: options.replaceExistingAttempt }
          : {}),
      }),
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS), {
      onProcessing: options?.onProcessing,
    });
    const raw = rawResponse as unknown as AuthApiEnvelope<CustomerOrderPaymentSessionData | CustomerOrderPaymentSessionProcessingData>;
    const session = unwrapPaymentSessionPayload(rawResponse) as unknown as CustomerOrderPaymentSessionData | CustomerOrderPaymentSessionProcessingData;
    if (!res.ok || isFailedEnvelope(raw) || !isCustomerOrderPaymentSession(session)) {
      return {
        success: false,
        error: extractError(raw) || "Payment could not be prepared. Please try again.",
        status: res.status,
      };
    }
    return { success: true, session: session as CustomerOrderPaymentSessionData };
  } catch (error: unknown) {
    if (error instanceof PaymentSessionProcessingTimeoutError) {
      return { success: false, error: error.message, status: error.status };
    }
    return { success: false, error: networkErrorMessage(error), status: 0 };
  }
}
