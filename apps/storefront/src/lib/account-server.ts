// Server side of the account pages: the reads every server-rendered account
// page makes (the tab counts, the orders, the profile) and the profile write,
// all through the storefront's proxy transport with the `cs_tok` session
// cookie only. Nothing here logs a body, a cookie or a customer field.
import { resolveBackendTarget } from "@/lib/api/transport";
import { sessionCookieOf } from "@/lib/account-inbox-server";
import { readAccountSummary, type AccountSummary } from "@/lib/account-tabs";
import type { BuyerUiBlock } from "@scalius/shared/plugins/buyer-ui";
import { buyerUiLocaleHeaders } from "@/lib/buyer-ui/locale";
import {
  MARKETING_CONSENT_STATUSES,
  isMarketingChannel,
  type MarketingChannel,
  type MarketingConsentStatus,
} from "@scalius/shared/customer-marketing";
import type {
  CustomerAddress,
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
  init: { method?: "GET" | "PUT" | "POST" | "DELETE"; body?: unknown } = {},
): Promise<ApiAnswer | null> {
  const session = sessionCookieOf(request);
  if (!session) return { status: 401, data: null, error: null };
  const target = resolveBackendTarget(path);
  if (!target) return null;
  const headers = new Headers({ Accept: "application/json", Cookie: session });
  if (path === "/api/v1/customer-auth/account-summary") {
    for (const [key, value] of Object.entries(await buyerUiLocaleHeaders())) headers.set(key, value);
  }
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp) headers.set("cf-connecting-ip", connectingIp);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  try {
    const response = await target.fetch(target.url, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(init.method && init.method !== "GET" ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS),
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
export async function readAccountSummaryForRequest(request: Request): Promise<(AccountSummary & { buyerUi?: BuyerUiBlock[] }) | null> {
  const answer = await callAccountApi(request, "/api/v1/customer-auth/account-summary");
  const summary = answer?.status === 200 ? readAccountSummary(answer.data) : null;
  if (!summary) return null;
  const buyerUi = (answer?.data as { buyerUi?: BuyerUiBlock[] } | null)?.buyerUi;
  return Array.isArray(buyerUi) ? { ...summary, buyerUi } : summary;
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

/** The profile is the name; addresses are in the address book. */
export interface ProfileUpdate {
  name?: string;
}

export type ProfileSaveResult =
  | { ok: true; customer: CustomerInfo }
  | { ok: false; reason: "signed_out" | "unavailable" | "invalid"; message: string | null };

export interface AccountMarketingChannel {
  channel: MarketingChannel;
  /** `subscribed`, `pending` (e-mail waiting for its link), `unsubscribed` or `not_subscribed`. */
  status: MarketingConsentStatus;
  /** The account has an address for this channel (an e-mail, a phone). */
  available: boolean;
}

function readMarketingChannels(data: unknown): AccountMarketingChannel[] | null {
  const channels = (data as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(channels)) return null;
  return channels.flatMap((each) => {
    const row = each as Partial<AccountMarketingChannel> | null;
    return row && isMarketingChannel(row.channel)
      && (MARKETING_CONSENT_STATUSES as readonly string[]).includes(String(row.status))
      ? [{ channel: row.channel, status: row.status as MarketingConsentStatus, available: row.available === true }]
      : [];
  });
}

/** The account's marketing preferences, one row per channel. */
export async function readAccountMarketing(request: Request): Promise<AccountRead<AccountMarketingChannel[]>> {
  const answer = await callAccountApi(request, "/api/v1/customer-auth/marketing");
  const channels = answer?.status === 200 ? readMarketingChannels(answer.data) : null;
  return channels ? { ok: true, data: channels } : failed(answer);
}

export type AccountMarketingSaveResult =
  | { ok: true; channels: AccountMarketingChannel[]; confirmationRequested: boolean }
  | { ok: false; reason: "signed_out" | "unavailable" | "invalid"; message: string | null };

/** Turns channels on or off (only the ones named); an unverified e-mail waits for its link. */
export async function saveAccountMarketing(
  request: Request,
  update: Partial<Record<MarketingChannel, boolean>> & { language?: string },
): Promise<AccountMarketingSaveResult> {
  const answer = await callAccountApi(request, "/api/v1/customer-auth/marketing", { method: "PUT", body: update });
  const channels = answer?.status === 200 ? readMarketingChannels(answer.data) : null;
  if (channels) {
    return { ok: true, channels, confirmationRequested: (answer!.data as { confirmationRequested?: unknown }).confirmationRequested === true };
  }
  if (answer?.status === 400 || answer?.status === 422) return { ok: false, reason: "invalid", message: answer.error };
  return { ...failed(answer), message: null };
}

/** The account's address book, the default first. */
export async function readAccountAddresses(request: Request): Promise<AccountRead<CustomerAddress[]>> {
  const answer = await callAccountApi(request, "/api/v1/customer-auth/addresses");
  const addresses = answer?.status === 200 ? (answer.data as { addresses?: unknown } | null)?.addresses : null;
  return Array.isArray(addresses) ? { ok: true, data: addresses as CustomerAddress[] } : failed(answer);
}

export type AddressBookResult =
  | { ok: true; addresses: CustomerAddress[] }
  | { ok: false; reason: "signed_out" | "unavailable" | "invalid"; message: string | null };

/**
 * One address-book change: add (no `addressId`), change, delete, make
 * default or make the default billing address. The API checks the address against its country's rules and
 * answers the whole book; a refusal's message names the field.
 */
export async function changeAccountAddresses(
  request: Request,
  change:
    | { action: "save"; addressId?: string; body: unknown }
    | { action: "delete" | "default" | "default_billing"; addressId: string },
): Promise<AddressBookResult> {
  const path = "/api/v1/customer-auth/addresses";
  const id = "addressId" in change && change.addressId ? `/${encodeURIComponent(change.addressId)}` : "";
  const answer = change.action === "save"
    ? await callAccountApi(request, `${path}${id}`, { method: id ? "PUT" : "POST", body: change.body })
    : change.action === "delete"
      ? await callAccountApi(request, `${path}${id}`, { method: "DELETE" })
      : await callAccountApi(request, `${path}${id}/${change.action === "default_billing" ? "default-billing" : "default"}`, { method: "POST" });
  const addresses = answer?.status === 200 ? (answer.data as { addresses?: unknown } | null)?.addresses : null;
  if (Array.isArray(addresses)) return { ok: true, addresses: addresses as CustomerAddress[] };
  if (answer?.status === 400 || answer?.status === 404 || answer?.status === 409 || answer?.status === 422) {
    return { ok: false, reason: "invalid", message: answer.error };
  }
  return { ...failed(answer), message: null };
}

/** Saves the name; the API validates it. */
export async function saveAccountProfile(request: Request, update: ProfileUpdate): Promise<ProfileSaveResult> {
  const answer = await callAccountApi(request, "/api/v1/customer-auth/profile", { method: "PUT", body: update });
  const customer = answer?.status === 200 ? (answer.data as { customer?: CustomerInfo } | null)?.customer : null;
  if (customer) return { ok: true, customer };
  if (answer?.status === 400 || answer?.status === 422) return { ok: false, reason: "invalid", message: answer.error };
  return { ...failed(answer), message: null };
}
