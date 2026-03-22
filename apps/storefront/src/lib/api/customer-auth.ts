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

/**
 * Build a same-origin customer auth URL.
 * On the client, uses a relative path (same-origin proxy).
 * On SSR, also uses relative path (resolved by the Astro route).
 */
function authUrl(subpath: string): string {
  return `/api/customer-auth/${subpath}`;
}

/** Extract a human-readable error message from the API envelope */
function extractError(raw: AuthApiEnvelope): string | undefined {
  if (!raw.error) return undefined;
  return typeof raw.error === "object" ? raw.error.message : raw.error;
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
}

/**
 * Send OTP to customer via email or phone.
 */
export async function sendCustomerOtp(
  method: "email" | "phone",
  identifier: string,
  name?: string
): Promise<{ success: boolean; error?: string; retryAfter?: number }> {
  try {
    const res = await fetch(authUrl("send-otp"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ method, identifier, name }),
    });
    const raw = (await res.json()) as AuthApiEnvelope<SendOtpData>;
    const data = raw.data ?? (raw as unknown as SendOtpData); // Unwrap { success, data: T } envelope
    if (!res.ok) {
      return { success: false, error: extractError(raw), retryAfter: data.retryAfter };
    }
    return { success: true };
  } catch {
    return { success: false, error: "Network error. Please try again." };
  }
}

/**
 * Verify OTP and create session.
 */
export async function verifyCustomerOtp(
  method: "email" | "phone",
  identifier: string,
  code: string,
  name?: string,
  phone?: string,
  email?: string,
): Promise<{ success: boolean; customer?: CustomerInfo; error?: string; attemptsLeft?: number; isNewUser?: boolean; }> {
  try {
    const res = await fetch(authUrl("verify-otp"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ method, identifier, code, name, phone, email }),
    });
    const raw = (await res.json()) as AuthApiEnvelope<VerifyOtpData>;
    const data = raw.data ?? (raw as unknown as VerifyOtpData); // Unwrap { success, data: T } envelope
    if (!res.ok) {
      return { success: false, error: extractError(raw), attemptsLeft: data.attemptsLeft };
    }
    return { success: true, customer: data.customer, isNewUser: data.isNewUser };
  } catch {
    return { success: false, error: "Network error. Please try again." };
  }
}

/**
 * Get current customer session info.
 */
export async function getCustomerSession(): Promise<AuthState> {
  try {
    const res = await fetch(authUrl("me"), {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return { authenticated: false };
    const raw = (await res.json()) as AuthApiEnvelope<SessionData>;
    return (raw.data ?? raw) as AuthState;
  } catch {
    return { authenticated: false };
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
  items: CustomerOrderItem[];
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
}> {
  try {
    const res = await fetch(authUrl("profile"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(data),
    });
    const raw = (await res.json()) as AuthApiEnvelope<ProfileData>;
    const result = raw.data ?? (raw as unknown as ProfileData); // Unwrap envelope
    if (!res.ok) {
      return { success: false, error: extractError(raw) };
    }
    return { success: true, customer: result.customer };
  } catch {
    return { success: false, error: "Network error" };
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
}> {
  try {
    const res = await fetch(authUrl("orders"), {
      credentials: "include",
    });
    if (!res.ok) {
      const raw = (await res.json()) as AuthApiEnvelope;
      return { success: false, orders: [], error: extractError(raw) };
    }
    const raw = (await res.json()) as AuthApiEnvelope<OrdersData>;
    const data = raw.data ?? (raw as unknown as OrdersData); // Unwrap envelope
    return { success: true, orders: data.orders || [], customer: data.customer };
  } catch {
    return { success: false, orders: [], error: "Network error" };
  }
}
