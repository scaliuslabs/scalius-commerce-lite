// Server side of the account pages: the reads every server-rendered account
// page makes (the tab counts, the orders, the profile) and the profile write,
// all through the storefront's proxy transport with the `cs_tok` session
// cookie only. Nothing here logs a body, a cookie or a customer field.
import { resolveBackendTarget } from "@/lib/api/transport";
import { sessionCookieOf } from "@/lib/account-inbox-server";
import { readAccountSummary, type AccountSummary } from "@/lib/account-tabs";
import type {
  CustomerInfo,
  CustomerOrder,
  CustomerOrdersPagination,
  PhoneVerificationPrompt,
} from "@/lib/api/customer-auth";

const READ_TIMEOUT_MS = 6_000;
const WRITE_TIMEOUT_MS = 10_000;

export type AccountRead<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "signed_out" | "unavailable" };

interface ApiAnswer {
  status: number;
  data: unknown;
  error: string | null;
}

async function callAccountApi(
  request: Request,
  path: string,
  init: { method?: "GET" | "PUT"; body?: unknown } = {},
): Promise<ApiAnswer | null> {
  const session = sessionCookieOf(request);
  if (!session) return { status: 401, data: null, error: null };
  const target = resolveBackendTarget(path);
  if (!target) return null;
  const headers = new Headers({ Accept: "application/json", Cookie: session });
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp) headers.set("cf-connecting-ip", connectingIp);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  try {
    const response = await target.fetch(target.url, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(init.method === "PUT" ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as {
      success?: unknown;
      data?: unknown;
      error?: { message?: unknown } | string | null;
    } | null;
    const error = typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.error?.message === "string" ? payload.error.message : null;
    return { status: response.status, data: payload?.success === true ? payload.data : null, error };
  } catch (error) {
    console.warn("[account] API call failed:", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

function failed(answer: ApiAnswer | null): { ok: false; reason: "signed_out" | "unavailable" } {
  return { ok: false, reason: answer?.status === 401 || answer?.status === 403 ? "signed_out" : "unavailable" };
}

/** The account tab counts; null when signed out or unreachable (the tabs then show only what always shows). */
export async function readAccountSummaryForRequest(request: Request): Promise<AccountSummary | null> {
  const answer = await callAccountApi(request, "/api/v1/customer-auth/account-summary");
  return answer?.status === 200 ? readAccountSummary(answer.data) : null;
}

export interface AccountOrdersPage {
  customer: CustomerInfo | null;
  orders: CustomerOrder[];
  totalOrders: number;
  pagination: CustomerOrdersPagination | null;
  phoneVerification: PhoneVerificationPrompt | null;
}

/** One page of the account's orders, newest first (`cursor` is the API's opaque cursor). */
export async function readAccountOrders(request: Request, cursor: string | null): Promise<AccountRead<AccountOrdersPage>> {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  const answer = await callAccountApi(request, `/api/v1/customer-auth/orders${query}`);
  const data = answer?.status === 200 ? answer.data as Partial<{
    orders: CustomerOrder[];
    customer: CustomerInfo;
    summary: { totalOrders?: number };
    pagination: CustomerOrdersPagination;
    phoneVerification: { phone?: unknown } | null;
  }> | null : null;
  if (!data || !Array.isArray(data.orders)) return failed(answer);
  const phone = data.phoneVerification?.phone;
  return {
    ok: true,
    data: {
      customer: data.customer ?? null,
      orders: data.orders,
      totalOrders: data.summary?.totalOrders ?? data.orders.length,
      pagination: data.pagination ?? null,
      phoneVerification: typeof phone === "string" && phone.trim() ? { phone: phone.trim() } : null,
    },
  };
}

/** The signed-in customer's profile. */
export async function readAccountCustomer(request: Request): Promise<AccountRead<CustomerInfo>> {
  const answer = await callAccountApi(request, "/api/v1/customer-auth/me");
  const data = answer?.status === 200 ? answer.data as { authenticated?: unknown; customer?: CustomerInfo } | null : null;
  if (data?.authenticated === false) return { ok: false, reason: "signed_out" };
  if (!data?.customer) return failed(answer);
  return { ok: true, data: data.customer };
}

export interface ProfileUpdate {
  name?: string;
  address?: string;
  city?: string;
  zone?: string;
  area?: string;
}

export type ProfileSaveResult =
  | { ok: true; customer: CustomerInfo }
  | { ok: false; reason: "signed_out" | "unavailable" | "invalid"; message: string | null };

/** Saves the name or the delivery address; the API validates and resolves the location. */
export async function saveAccountProfile(request: Request, update: ProfileUpdate): Promise<ProfileSaveResult> {
  const answer = await callAccountApi(request, "/api/v1/customer-auth/profile", { method: "PUT", body: update });
  const customer = answer?.status === 200 ? (answer.data as { customer?: CustomerInfo } | null)?.customer : null;
  if (customer) return { ok: true, customer };
  if (answer?.status === 400 || answer?.status === 422) return { ok: false, reason: "invalid", message: answer.error };
  return { ...failed(answer), message: null };
}
