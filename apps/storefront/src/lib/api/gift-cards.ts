// Server side of the storefront's gift-card surfaces (Wave B §4.3, §4.5): the
// checkout apply proxy, the /gift-card-balance page and the account "Gift
// cards" page call the API from here, through the storefront transport
// (service binding in production).
//
// A code is bearer value: it only ever travels in a POST body to the API and
// is never logged, echoed, put in a URL or returned to the browser (the one
// exception is "Show code", the owner's own card, rendered in-page only).
// The account session travels as the `cs_tok` cookie only.

import { normalizeGiftCardCode } from "@scalius/shared/gift-card-code";
import { apiFetch } from "@/lib/api/transport";

const GIFT_CARD_TIMEOUT_MS = 8_000;
const SESSION_COOKIE_PATTERN = /(?:^|;\s*)(cs_tok=[^;]+)/;
const LAST4_PATTERN = /^[0-9A-Z]{4}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export type GiftCardFailureReason =
  /** Unknown, disabled, expired, empty or wrong currency: always the same answer. */
  | "unusable"
  | "not_found"
  | "signed_out"
  | "rate_limited"
  | "unavailable";

export type GiftCardApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: GiftCardFailureReason; status: number; retryAfterSeconds?: number };

/** A card applied at checkout: the handle stands in for the code from now on. */
export interface AppliedGiftCard {
  handle: string;
  /** ISO time the handle stops working. */
  handleExpiresAt: string;
  last4: string;
  balance: number;
  balanceMinor: number;
  currencyCode: string;
  expiresAt: string | null;
}

export type GiftCardBalanceStatus = "active" | "disabled" | "expired";

export interface GiftCardBalance {
  last4: string;
  balance: number;
  balanceMinor: number;
  currencyCode: string;
  expiresAt: string | null;
  status: GiftCardBalanceStatus;
}

export type AccountGiftCardTransactionKind = "issue" | "redeem" | "release" | "refund" | "adjust";

export interface AccountGiftCardTransaction {
  id: string;
  kind: AccountGiftCardTransactionKind;
  amount: number;
  amountMinor: number;
  balanceAfter: number;
  balanceAfterMinor: number;
  orderId: string | null;
  orderNumber: string | null;
  createdAt: string;
}

export interface AccountGiftCard {
  id: string;
  last4: string;
  currencyCode: string;
  initialAmount: number;
  initialAmountMinor: number;
  balance: number;
  balanceMinor: number;
  status: "active" | "disabled";
  expiresAt: string | null;
  expired: boolean;
  source: "purchase" | "manual" | "refund";
  createdAt: string;
  transactions: AccountGiftCardTransaction[];
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function nullableIso(value: unknown): string | null | undefined {
  if (value === null) return null;
  const text = str(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function money(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function minor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readLast4(value: unknown): string | null {
  return typeof value === "string" && LAST4_PATTERN.test(value) ? value : null;
}

function readCurrency(value: unknown): string | null {
  return typeof value === "string" && CURRENCY_PATTERN.test(value) ? value : null;
}

export function readAppliedGiftCard(value: unknown): AppliedGiftCard | null {
  if (!isRecord(value)) return null;
  const handle = str(value.handle, 200);
  const handleExpiresAt = nullableIso(value.handleExpiresAt);
  const last4 = readLast4(value.last4);
  const balance = money(value.balance);
  const balanceMinor = minor(value.balanceMinor);
  const currencyCode = readCurrency(value.currencyCode);
  const expiresAt = value.expiresAt === undefined ? null : nullableIso(value.expiresAt);
  if (
    !handle || !handleExpiresAt || !last4 || balance === null || balanceMinor === null ||
    !currencyCode || expiresAt === undefined
  ) {
    return null;
  }
  return { handle, handleExpiresAt, last4, balance, balanceMinor, currencyCode, expiresAt };
}

export function readGiftCardBalance(value: unknown): GiftCardBalance | null {
  if (!isRecord(value)) return null;
  const last4 = readLast4(value.last4);
  const balance = money(value.balance);
  const balanceMinor = minor(value.balanceMinor);
  const currencyCode = readCurrency(value.currencyCode);
  const expiresAt = value.expiresAt === undefined ? null : nullableIso(value.expiresAt);
  const status = value.status;
  if (
    !last4 || balance === null || balanceMinor === null || !currencyCode || expiresAt === undefined ||
    (status !== "active" && status !== "disabled" && status !== "expired")
  ) {
    return null;
  }
  return { last4, balance, balanceMinor, currencyCode, expiresAt, status };
}

const TRANSACTION_KINDS = new Set<AccountGiftCardTransactionKind>(["issue", "redeem", "release", "refund", "adjust"]);

function readTransaction(value: unknown): AccountGiftCardTransaction | null {
  if (!isRecord(value)) return null;
  const id = str(value.id, 80);
  const kind = value.kind as AccountGiftCardTransactionKind;
  const amount = money(value.amount);
  const amountMinor = minor(value.amountMinor);
  const balanceAfter = money(value.balanceAfter);
  const balanceAfterMinor = minor(value.balanceAfterMinor);
  const createdAt = nullableIso(value.createdAt);
  if (
    !id || !TRANSACTION_KINDS.has(kind) || amount === null || amountMinor === null ||
    balanceAfter === null || balanceAfterMinor === null || !createdAt
  ) {
    return null;
  }
  return {
    id,
    kind,
    amount,
    amountMinor,
    balanceAfter,
    balanceAfterMinor,
    orderId: str(value.orderId, 80),
    orderNumber: str(value.orderNumber, 40),
    createdAt,
  };
}

export function readAccountGiftCard(value: unknown): AccountGiftCard | null {
  if (!isRecord(value)) return null;
  const id = str(value.id, 80);
  const last4 = readLast4(value.last4);
  const currencyCode = readCurrency(value.currencyCode);
  const initialAmount = money(value.initialAmount);
  const initialAmountMinor = minor(value.initialAmountMinor);
  const balance = money(value.balance);
  const balanceMinor = minor(value.balanceMinor);
  const expiresAt = value.expiresAt === undefined ? null : nullableIso(value.expiresAt);
  const createdAt = nullableIso(value.createdAt);
  const { status, source } = value;
  if (
    !id || !last4 || !currencyCode || initialAmount === null || initialAmountMinor === null ||
    balance === null || balanceMinor === null || expiresAt === undefined || !createdAt ||
    (status !== "active" && status !== "disabled") ||
    (source !== "purchase" && source !== "manual" && source !== "refund")
  ) {
    return null;
  }
  const transactions = Array.isArray(value.transactions)
    ? value.transactions.slice(0, 200).flatMap((entry) => {
        const transaction = readTransaction(entry);
        return transaction ? [transaction] : [];
      })
    : [];
  return {
    id,
    last4,
    currencyCode,
    initialAmount,
    initialAmountMinor,
    balance,
    balanceMinor,
    status,
    expiresAt,
    expired: value.expired === true,
    source,
    createdAt,
    transactions,
  };
}

// ── Transport ────────────────────────────────────────────────────────────────

function positiveSeconds(value: unknown): number | undefined {
  const seconds = typeof value === "string" ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.ceil(seconds), 3600)
    : undefined;
}

/** Only the account session cookie, never the rest of the buyer's cookies. */
export function giftCardSessionCookie(request: Request): string | null {
  return request.headers.get("cookie")?.match(SESSION_COOKIE_PATTERN)?.[1] ?? null;
}

function failureReason(status: number, code: string): GiftCardFailureReason {
  if (status === 401) return "signed_out";
  if (status === 429) return "rate_limited";
  if (status === 404 || code === "GIFT_CARD_NOT_FOUND") return "not_found";
  if (status === 400 || status === 409 || status === 422 || code === "GIFT_CARD_UNUSABLE") return "unusable";
  return "unavailable";
}

async function callGiftCardApi(
  path: string,
  request: Request,
  init: { method: "GET" | "POST"; body?: Record<string, unknown>; session?: boolean },
): Promise<GiftCardApiResult<Record<string, unknown>>> {
  const headers = new Headers({ Accept: "application/json" });
  if (init.body) headers.set("Content-Type", "application/json");
  // The API's per-IP limiter sees the buyer, not the storefront Worker.
  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp) headers.set("cf-connecting-ip", connectingIp);
  if (init.session) {
    const session = giftCardSessionCookie(request);
    if (!session) return { ok: false, reason: "signed_out", status: 401 };
    headers.set("Cookie", session);
  }
  try {
    const response = await apiFetch(
      path,
      {
        method: init.method,
        headers,
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        cache: "no-store",
      },
      { retries: 0, timeout: GIFT_CARD_TIMEOUT_MS, auth: false, batch: false, logTerminalFailure: false },
    );
    const json: unknown = await response.json().catch(() => null);
    if (response.ok && isRecord(json) && json.success !== false && isRecord(json.data)) {
      return { ok: true, data: json.data };
    }
    const error = isRecord(json) && isRecord(json.error) ? json.error : {};
    const details = isRecord(error.details) ? error.details : {};
    const status = response.ok ? 502 : response.status;
    const retryAfterSeconds = positiveSeconds(details.retryAfterSeconds ?? response.headers.get("Retry-After"));
    return {
      ok: false,
      reason: failureReason(status, typeof error.code === "string" ? error.code : ""),
      status,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  } catch (error) {
    // The path names the operation only; no code or buyer data is logged.
    console.error("[gift-cards] API request failed:", path.split("/").slice(0, 4).join("/"), error instanceof Error ? error.name : typeof error);
    return { ok: false, reason: "unavailable", status: 502 };
  }
}

function parsed<T>(
  result: GiftCardApiResult<Record<string, unknown>>,
  read: (data: Record<string, unknown>) => T | null,
): GiftCardApiResult<T> {
  if (!result.ok) return result;
  const value = read(result.data);
  return value === null
    ? { ok: false, reason: "unavailable", status: 502 }
    : { ok: true, data: value };
}

// ── Operations ───────────────────────────────────────────────────────────────

/** Checkout: prove a code once and get the short-lived handle that replaces it. */
export async function applyGiftCard(rawCode: unknown, request: Request): Promise<GiftCardApiResult<AppliedGiftCard>> {
  const code = normalizeGiftCardCode(rawCode);
  if (!code) return { ok: false, reason: "unusable", status: 400 };
  return parsed(
    await callGiftCardApi("/checkout/gift-cards/apply", request, { method: "POST", body: { code } }),
    readAppliedGiftCard,
  );
}

/** /gift-card-balance: last 4, balance, expiry and status. */
export async function checkGiftCardBalance(rawCode: unknown, request: Request): Promise<GiftCardApiResult<GiftCardBalance>> {
  const code = normalizeGiftCardCode(rawCode);
  if (!code) return { ok: false, reason: "not_found", status: 404 };
  return parsed(
    await callGiftCardApi("/checkout/gift-cards/balance", request, { method: "POST", body: { code } }),
    readGiftCardBalance,
  );
}

/** The signed-in buyer's cards, newest first. */
export async function listAccountGiftCards(request: Request): Promise<GiftCardApiResult<AccountGiftCard[]>> {
  return parsed(
    await callGiftCardApi("/customer-auth/gift-cards", request, { method: "GET", session: true }),
    (data) => Array.isArray(data.giftCards)
      ? data.giftCards.slice(0, 200).flatMap((entry) => {
          const card = readAccountGiftCard(entry);
          return card ? [card] : [];
        })
      : null,
  );
}

/** "Save a card to my account": possession of the code is the proof. */
export async function saveAccountGiftCard(rawCode: unknown, request: Request): Promise<GiftCardApiResult<AccountGiftCard>> {
  const code = normalizeGiftCardCode(rawCode);
  if (!code) return { ok: false, reason: "unusable", status: 400 };
  return parsed(
    await callGiftCardApi("/customer-auth/gift-cards/save", request, { method: "POST", body: { code }, session: true }),
    (data) => readAccountGiftCard(data.giftCard),
  );
}

const GIFT_CARD_ID_PATTERN = /^gc_[A-Za-z0-9_-]{1,77}$/;

export function isGiftCardId(value: unknown): value is string {
  return typeof value === "string" && GIFT_CARD_ID_PATTERN.test(value);
}

/** "Show code" for a card the buyer owns; the code is rendered in-page only. */
export async function revealAccountGiftCardCode(giftCardId: string, request: Request): Promise<GiftCardApiResult<string>> {
  if (!isGiftCardId(giftCardId)) return { ok: false, reason: "not_found", status: 404 };
  return parsed(
    await callGiftCardApi(`/customer-auth/gift-cards/${encodeURIComponent(giftCardId)}/reveal`, request, {
      method: "POST",
      session: true,
    }),
    (data) => (typeof data.code === "string" && normalizeGiftCardCode(data.code) ? data.code : null),
  );
}
