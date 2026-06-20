// src/lib/api/customer-auth.ts
// API client for storefront customer authentication (email OTP).
//
// All auth requests go through a same-origin proxy (/api/customer-auth/*)
// so Set-Cookie headers are processed by the browser. Cross-origin
// Cross-origin Set-Cookie is silently dropped
// by modern browsers.

// ---------------------------------------------------------------------------
// Response shapes for customer auth API endpoints
// ---------------------------------------------------------------------------

/** Envelope for send-otp / verify-otp / profile responses */
interface AuthApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: string | { message?: string };
}

interface SendOtpData {
  retryAfter?: number;
}

interface VerifyOtpData {
  customer?: CustomerInfo;
  isNewUser?: boolean;
  attemptsLeft?: number;
}

interface ProfileData {
  customer?: CustomerInfo;
}

interface OrdersData {
  orders: CustomerOrder[];
  customer?: CustomerInfo;
}

interface SessionData {
  authenticated: boolean;
  customer?: CustomerInfo;
}

interface CustomerOrderPaymentSessionData {
  gateway: "stripe" | "sslcommerz" | "polar";
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

export type CustomerAuthIntent = "sign_in" | "sign_up";
export type CustomerOtpChannel = "email" | "sms" | "whatsapp";

export interface SendCustomerOtpInput {
  intent: CustomerAuthIntent;
  method: "email" | "phone";
  channel: CustomerOtpChannel;
  identifier: string;
  name?: string;
  phone?: string;
  email?: string;
}

export interface VerifyCustomerOtpInput extends SendCustomerOtpInput {
  code: string;
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

/** Extract a human-readable error message from the API envelope */
function extractError(raw: AuthApiEnvelope): string | undefined {
  if (!raw.error) return undefined;
  return typeof raw.error === "object" ? raw.error.message : raw.error;
}

function isTemporaryReadFailure(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function isFailedEnvelope(raw: AuthApiEnvelope): boolean {
  return raw.success === false;
}

function networkErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Account request timed out. Please try again.";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "Account request timed out. Please try again.";
  }
  return "Network error. Please try again.";
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
}

export interface AuthState {
  authenticated: boolean;
  customer?: CustomerInfo;
  unavailable?: boolean;
  error?: string;
  status?: number;
}

/**
 * Send OTP to customer via email or phone.
 */
export async function sendCustomerOtp(
  input: SendCustomerOtpInput,
): Promise<{ success: boolean; error?: string; retryAfter?: number }> {
  try {
    const res = await customerAuthFetch(authUrl("send-otp"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS);
    const raw = await readEnvelope<SendOtpData>(res);
    const data = raw.data ?? (raw as unknown as SendOtpData); // Unwrap { success, data: T } envelope
    if (!res.ok || isFailedEnvelope(raw)) {
      return { success: false, error: extractError(raw), retryAfter: data.retryAfter };
    }
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error) };
  }
}

/**
 * Verify OTP and create session.
 */
export async function verifyCustomerOtp(
  input: VerifyCustomerOtpInput,
): Promise<{ success: boolean; customer?: CustomerInfo; error?: string; attemptsLeft?: number; isNewUser?: boolean; }> {
  try {
    const res = await customerAuthFetch(authUrl("verify-otp"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS);
    const raw = await readEnvelope<VerifyOtpData>(res);
    const data = raw.data ?? (raw as unknown as VerifyOtpData); // Unwrap { success, data: T } envelope
    if (!res.ok || isFailedEnvelope(raw)) {
      return { success: false, error: extractError(raw), attemptsLeft: data.attemptsLeft };
    }
    return { success: true, customer: data.customer, isNewUser: data.isNewUser };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error) };
  }
}

/**
 * Get current customer session info.
 */
export async function getCustomerSession(): Promise<AuthState> {
  try {
    const res = await customerAuthFetch(authUrl("me"), {
      credentials: "include",
      cache: "no-store",
    });
    const raw = await readEnvelope<SessionData>(res);
    const data = raw.data ?? (raw as unknown as SessionData);
    if (!res.ok || isFailedEnvelope(raw) || typeof data.authenticated !== "boolean") {
      return {
        authenticated: false,
        unavailable: isTemporaryReadFailure(res.status) || res.ok,
        status: res.status,
        error: extractError(raw) || "Account status could not be read. Please try again.",
      };
    }
    return data as AuthState;
  } catch (error: unknown) {
    return {
      authenticated: false,
      unavailable: true,
      status: 0,
      error: networkErrorMessage(error),
    };
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
  variantSize: string | null;
  variantColor: string | null;
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
  lastChecked: string | null;
  updatedAt: string | null;
  createdAt: string | null;
}

export interface CustomerOrder {
  id: string;
  status: string;
  totalAmount: number;
  paidAmount: number;
  shippingCharge: number;
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

export interface CustomerOrderDetailNotification {
  id: string;
  notificationType: string;
  channel: string;
  status: string;
  provider: string;
  providerStatus: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  skippedAt: string | null;
  updatedAt: string | null;
  createdAt: string | null;
}

export interface CustomerOrderTimelineEvent {
  id: string;
  type: "order" | "payment" | "shipment" | "notification";
  status: string;
  label: string;
  happenedAt: string | null;
  details?: string | null;
}

export interface CustomerPaymentRecovery {
  eligible: boolean;
  gateway: "stripe" | "sslcommerz" | "polar" | null;
  paymentType: "full" | "deposit" | "balance" | null;
  amountDue: number;
  label: string | null;
  reason: string | null;
  requiresCardForm: boolean;
  hostedRedirect: boolean;
}

export type CustomerOrderPaymentSession = CustomerOrderPaymentSessionData;

export interface CustomerOrderDetailOrder {
  id: string;
  invoiceNumber: number | null;
  status: string;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  shippingCharge: number;
  discountAmount: number | null;
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
  paymentPlan: CustomerOrderDetailPaymentPlan | null;
  cod: CustomerOrderDetailCod | null;
  notifications: CustomerOrderDetailNotification[];
  paymentRecovery: CustomerPaymentRecovery;
  timeline: CustomerOrderTimelineEvent[];
}

export interface ProfileUpdateData {
  name?: string;
  address?: string;
  city?: string;
  zone?: string;
  cityName?: string;
  zoneName?: string;
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
    return { success: true, customer: result.customer };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error), status: 0, unavailable: true };
  }
}

/**
 * Get customer order history. Requires active session (cs_tok cookie).
 */
export async function getCustomerOrders(): Promise<{
  success: boolean;
  orders: CustomerOrder[];
  customer?: CustomerInfo;
  error?: string;
  status?: number;
  unavailable?: boolean;
}> {
  try {
    const res = await customerAuthFetch(authUrl("orders"), {
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
    return { success: true, orders: data.orders || [], customer: data.customer };
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
 * Create a payment session for an order owned by the signed-in customer.
 * This endpoint never accepts or returns receipt tokens.
 */
export async function createCustomerOrderPaymentSession(orderId: string): Promise<{
  success: boolean;
  session?: CustomerOrderPaymentSession;
  error?: string;
  status?: number;
}> {
  if (!orderId) {
    return { success: false, error: "Order ID is required", status: 400 };
  }

  try {
    const res = await customerAuthFetch(authUrl(`orders/${encodeURIComponent(orderId)}/payment-session`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({}),
    }, CUSTOMER_AUTH_WRITE_TIMEOUT_MS);
    const raw = await readEnvelope<CustomerOrderPaymentSessionData>(res);
    if (!res.ok || isFailedEnvelope(raw)) {
      return {
        success: false,
        error: extractError(raw) || "Payment could not be prepared. Please try again.",
        status: res.status,
      };
    }
    const session = raw.data ?? (raw as unknown as CustomerOrderPaymentSessionData);
    return { success: true, session };
  } catch (error: unknown) {
    return { success: false, error: networkErrorMessage(error), status: 0 };
  }
}
