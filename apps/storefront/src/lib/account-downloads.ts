// Buyer downloads and licence keys (Wave B design §3.4, §9.2): the copy, the
// shapes the API returns, the id/return-path checks every route and page
// shares, and the markup of a file row and a key row. Pure: the account
// Downloads page, the receipt's per-line delivery and the browser-rendered
// account order page all render with these helpers.
//
// Nothing secret passes through here. Forms carry ids and a same-origin return
// path; the proof (session or receipt cookie) never enters markup or a URL,
// and a revealed licence key is only rendered by `pages/account/licence-key`.

import { escapeHtml } from "@scalius/shared/html-escape";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { formatAccountDate } from "@/lib/account-format";

export const DOWNLOAD_COPY = {
  pageTitle: "Downloads",
  pageIntro: "Files and licence keys from your orders.",
  signInTitle: "Sign in to see your downloads",
  signInBody: "Files and licence keys you bought appear here after you sign in.",
  signIn: "Sign in",
  unavailable: "We couldn't reach the store. Check your connection and try again.",
  retry: "Try again",
  empty: "Nothing to download yet. Files and licence keys from your orders appear here once they are delivered.",
  order: "Order {number}",
  productFallback: "Product",
  deliveredOn: "Delivered {date}",
  filesHeading: "Files",
  keysHeading: "Licence keys",
  download: "Download",
  usage: "{count} of {limit} downloads used",
  unlimited: "Unlimited downloads",
  availableUntil: "Available until {date}",
  endedOn: "Access ended {date}",
  usedUp: "All downloads used.",
  askForMore: "Ask the store for more downloads",
  revoked: "The store removed access to this file.",
  expired: "Access to this file has ended.",
  notAvailable: "This file isn't available right now.",
  keyEndingIn: "Licence key ending in {last4}",
  showKey: "Show key",
  // Outcome of a Download press (the `download` flag on the page it came from).
  statusLimit: "You've used every download of this file. Ask the store for more downloads.",
  statusRevoked: "The store removed access to this file.",
  statusExpired: "Access to this file has ended.",
  statusRate: "Too many tries. Wait a minute and try again.",
  statusSignin: "Sign in again to download this file.",
  statusMissing: "This download isn't available in this browser. Open the order from your account or from the link in your order message.",
  statusUnavailable: "The download couldn't start. Try again in a moment.",
  // The licence key page.
  keyPageTitle: "Your licence key",
  keyPageIntro: "Keep this key private: anyone who has it can use your purchase.",
  keyLabel: "Licence key",
  copyKey: "Copy key",
  copiedKey: "Copied",
  back: "Back",
  keyUnavailable: "We couldn't show this key. Go back and try again.",
  // The product page promise (digital products only).
  promiseLabel: "Digital delivery",
  promiseDeliveryTitle: "Delivered digitally",
  promiseDeliveryDetail: "Sent to you as soon as your order is confirmed.",
  promiseAccessTitle: "Download files or show your key",
  promiseAccessDetail: "From your order page, or Downloads in your account.",
  promiseShippingTitle: "No shipping needed",
  promiseShippingDetail: "Nothing is posted, so there is no delivery fee.",
} as const;

export function fillCopy(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

// ---------------------------------------------------------------------------
// Ids, path params and the ticket link
// ---------------------------------------------------------------------------

const DIGITAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const TICKET_EXP_PATTERN = /^\d{1,12}$/;
const TICKET_SIG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Entitlement, licence-key and order ids as the digital routes accept them. */
export function isDigitalId(value: unknown): value is string {
  return typeof value === "string" && DIGITAL_ID_PATTERN.test(value);
}

export interface DownloadTicketParams {
  entitlementId: string;
  exp: string;
  sig: string;
}

/** The stream route's path params, or null when any is malformed (the route answers 404). */
export function readTicketParams(params: Record<string, string | undefined>): DownloadTicketParams | null {
  const { entitlementId, exp, sig } = params;
  if (!isDigitalId(entitlementId) || !exp || !TICKET_EXP_PATTERN.test(exp) || !sig || !TICKET_SIG_PATTERN.test(sig)) return null;
  return { entitlementId, exp, sig };
}

/** Which proof a download, ticket or reveal uses: the account session, or one order's receipt cookie. */
export type DigitalAccess = { kind: "account" } | { kind: "receipt"; orderId: string };

/** The storefront stream path for a ticket; the API's `href` must be exactly this shape before we redirect to it. */
export function isDownloadTicketHref(href: unknown, access: DigitalAccess, entitlementId: string): href is string {
  if (typeof href !== "string" || href.length > 400) return false;
  const prefix = access.kind === "account"
    ? "/api/downloads/account/"
    : `/api/downloads/order/${access.orderId}/`;
  if (!href.startsWith(prefix)) return false;
  const [id, exp, sig, ...rest] = href.slice(prefix.length).split("/");
  return rest.length === 0 && id === entitlementId && readTicketParams({ entitlementId: id, exp, sig }) !== null;
}

// ---------------------------------------------------------------------------
// Return paths and the outcome flag
// ---------------------------------------------------------------------------

export const DOWNLOAD_STATUS_PARAM = "download";
export const DOWNLOAD_STATUS_FLAGS = ["limit", "revoked", "expired", "rate", "signin", "missing", "unavailable"] as const;
export type DownloadStatusFlag = (typeof DOWNLOAD_STATUS_FLAGS)[number];

const STATUS_TEXT: Record<DownloadStatusFlag, string> = {
  limit: DOWNLOAD_COPY.statusLimit,
  revoked: DOWNLOAD_COPY.statusRevoked,
  expired: DOWNLOAD_COPY.statusExpired,
  rate: DOWNLOAD_COPY.statusRate,
  signin: DOWNLOAD_COPY.statusSignin,
  missing: DOWNLOAD_COPY.statusMissing,
  unavailable: DOWNLOAD_COPY.statusUnavailable,
};

export function isDownloadStatusFlag(value: unknown): value is DownloadStatusFlag {
  return typeof value === "string" && (DOWNLOAD_STATUS_FLAGS as readonly string[]).includes(value);
}

export function downloadStatusText(flag: DownloadStatusFlag): string {
  return STATUS_TEXT[flag];
}

/** What a refused ticket or reveal means for the buyer. */
export function downloadFlagForApi(status: number, code: string | null, access: DigitalAccess): DownloadStatusFlag {
  if (status === 409) {
    if (code === "DOWNLOAD_REVOKED") return "revoked";
    if (code === "DOWNLOAD_EXPIRED") return "expired";
    return "limit";
  }
  if (status === 429) return "rate";
  // A guest has no session to renew: a refused receipt proof means this browser lost access.
  if (status === 401) return access.kind === "account" ? "signin" : "missing";
  if (status === 403 || status === 404) return "missing";
  return "unavailable";
}

const RETURN_PATH_PATTERN = /^\/(?:account\/downloads|account\/orders\/[A-Za-z0-9_-]{1,128}|order-success|track-order)\/?$/;
/** The only query keys a return path keeps: the order a receipt page shows. */
const RETURN_QUERY_KEYS = ["orderId", "order"] as const;
const RETURN_QUERY_VALUE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A page a download or key form may send the buyer back to: same-origin, one
 * of the pages that list downloads, with at most the order id in the query.
 * Anything else (absolute, protocol-relative, other paths, extra data) is null.
 */
export function safeDownloadReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.length > 512) return null;
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  let url: URL;
  try {
    url = new URL(raw, "https://storefront.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://storefront.invalid" || !RETURN_PATH_PATTERN.test(url.pathname)) return null;
  const kept = new URLSearchParams();
  for (const key of RETURN_QUERY_KEYS) {
    const keptValue = url.searchParams.get(key);
    if (keptValue && RETURN_QUERY_VALUE.test(keptValue)) kept.set(key, keptValue);
  }
  const search = kept.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}

/** Where a form goes back to when it sent no usable `returnTo`. */
export function defaultDownloadReturnPath(access: DigitalAccess): string {
  return access.kind === "account" ? "/account/downloads" : `/order-success?${new URLSearchParams({ orderId: access.orderId })}`;
}

/** The current page as a form's `returnTo` (the outcome flag dropped). */
export function downloadReturnPathOf(url: URL): string {
  return safeDownloadReturnPath(`${url.pathname}${url.search}`) ?? url.pathname;
}

/** The anchor of one file row, so the page scrolls back to the file that was pressed. */
export function downloadRowId(entitlementId: string): string {
  return `download-${entitlementId}`;
}

/** `returnTo` with the outcome flag and the file's anchor (the anchor never leaves the browser). */
export function withDownloadStatus(returnTo: string, flag: DownloadStatusFlag, entitlementId: string | null): string {
  const url = new URL(returnTo, "https://storefront.invalid");
  url.searchParams.set(DOWNLOAD_STATUS_PARAM, flag);
  url.hash = entitlementId && isDigitalId(entitlementId) ? downloadRowId(entitlementId) : "";
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A Download press that came back refused. `entitlementId` is the file it was
 * for when the page knows (the browser reads it from the anchor); null on a
 * server render, where the row shows the message only while it is the anchor's
 * target (`:target`, no JavaScript needed).
 */
export interface DownloadNotice {
  flag: DownloadStatusFlag;
  entitlementId: string | null;
}

export function readDownloadNotice(search: string, hash = ""): DownloadNotice | null {
  const flag = new URLSearchParams(search).get(DOWNLOAD_STATUS_PARAM);
  if (!isDownloadStatusFlag(flag)) return null;
  const anchor = hash.startsWith("#download-") ? hash.slice("#download-".length) : "";
  return { flag, entitlementId: isDigitalId(anchor) ? anchor : null };
}

// ---------------------------------------------------------------------------
// Shapes (API responses, narrowed defensively)
// ---------------------------------------------------------------------------

/** One file a line received, as the account list and the order extras both describe it. */
export interface DownloadFileView {
  entitlementId: string;
  displayName: string;
  downloadCount: number;
  /** null: unlimited. */
  downloadLimit: number | null;
  /** ISO; null: never ends. */
  expiresAt: string | null;
  revoked: boolean;
  /** The API's own verdict when it gives one (account list). */
  available?: boolean;
  sizeBytes?: number | null;
}

export interface LicenceKeyView {
  keyId: string;
  last4: string;
}

/** `GET /customer-auth/downloads` line (BuyerDigitalLine). */
export interface BuyerDigitalLine {
  orderId: string;
  orderNumber: number | null;
  orderItemId: string;
  productName: string | null;
  variantLabel: string | null;
  deliveredAt: string;
  files: DownloadFileView[];
  licenceKeys: LicenceKeyView[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** One file entry, or null when it lacks an id or a name. */
export function readDownloadFile(value: unknown): DownloadFileView | null {
  const raw = record(value);
  if (!raw || !isDigitalId(raw.entitlementId)) return null;
  const displayName = optionalText(raw.displayName) ?? optionalText(raw.filename);
  if (!displayName) return null;
  const limit = raw.downloadLimit;
  return {
    entitlementId: raw.entitlementId,
    displayName,
    downloadCount: count(raw.downloadCount),
    downloadLimit: typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
    expiresAt: isoOrNull(raw.expiresAt),
    revoked: raw.revoked === true,
    ...(typeof raw.available === "boolean" ? { available: raw.available } : {}),
    ...(typeof raw.sizeBytes === "number" && Number.isFinite(raw.sizeBytes) && raw.sizeBytes >= 0 ? { sizeBytes: raw.sizeBytes } : {}),
  };
}

/** One key entry, or null when it lacks an id or its last characters. */
export function readLicenceKey(value: unknown): LicenceKeyView | null {
  const raw = record(value);
  if (!raw || !isDigitalId(raw.keyId) || typeof raw.last4 !== "string") return null;
  const last4 = raw.last4.trim().slice(-8);
  return last4 ? { keyId: raw.keyId, last4 } : null;
}

export function readDownloadFiles(value: unknown): DownloadFileView[] {
  return Array.isArray(value) ? value.map(readDownloadFile).filter((file): file is DownloadFileView => file !== null) : [];
}

export function readLicenceKeys(value: unknown): LicenceKeyView[] {
  return Array.isArray(value) ? value.map(readLicenceKey).filter((key): key is LicenceKeyView => key !== null) : [];
}

/** The account list, newest delivery first; malformed lines and lines with nothing to show are dropped. */
export function readBuyerDigitalLines(value: unknown): BuyerDigitalLine[] | null {
  const lines = record(value)?.lines;
  if (!Array.isArray(lines)) return null;
  const read: BuyerDigitalLine[] = [];
  for (const entry of lines) {
    const raw = record(entry);
    if (!raw || !isDigitalId(raw.orderId) || typeof raw.orderItemId !== "string") continue;
    const files = readDownloadFiles(raw.files);
    const licenceKeys = readLicenceKeys(raw.licenceKeys);
    if (files.length === 0 && licenceKeys.length === 0) continue;
    read.push({
      orderId: raw.orderId,
      orderNumber: typeof raw.orderNumber === "number" && Number.isSafeInteger(raw.orderNumber) ? raw.orderNumber : null,
      orderItemId: raw.orderItemId,
      productName: optionalText(raw.productName),
      variantLabel: optionalText(raw.variantLabel),
      deliveredAt: isoOrNull(raw.deliveredAt) ?? "",
      files,
      licenceKeys,
    });
  }
  return read
    .map((line, index) => ({ line, index, at: Date.parse(line.deliveredAt) || 0 }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ line }) => line);
}

// ---------------------------------------------------------------------------
// File state and wording
// ---------------------------------------------------------------------------

export type DownloadFileState = "available" | "limit" | "revoked" | "expired" | "unavailable";

/** Why a file can or can't be downloaded now. The API rechecks every ticket; this only decides the button. */
export function downloadFileState(file: DownloadFileView, nowMs = Date.now()): DownloadFileState {
  if (file.revoked) return "revoked";
  const expires = file.expiresAt ? Date.parse(file.expiresAt) : Number.NaN;
  if (Number.isFinite(expires) && expires <= nowMs) return "expired";
  if (file.downloadLimit !== null && file.downloadCount >= file.downloadLimit) return "limit";
  return file.available === false ? "unavailable" : "available";
}

export function downloadUsageText(file: Pick<DownloadFileView, "downloadCount" | "downloadLimit">): string {
  return file.downloadLimit === null
    ? DOWNLOAD_COPY.unlimited
    : fillCopy(DOWNLOAD_COPY.usage, { count: Math.min(file.downloadCount, file.downloadLimit), limit: file.downloadLimit });
}

/** "Available until …" / "Access ended …", or "" when access never ends. */
export function downloadExpiryText(expiresAt: string | null, nowMs = Date.now()): string {
  if (!expiresAt) return "";
  const at = Date.parse(expiresAt);
  const date = formatAccountDate(expiresAt, { time: false });
  if (!date || !Number.isFinite(at)) return "";
  return fillCopy(at <= nowMs ? DOWNLOAD_COPY.endedOn : DOWNLOAD_COPY.availableUntil, { date });
}

const SIZE_UNITS = ["KB", "MB", "GB"] as const;

export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${SIZE_UNITS[unit]}`;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

export interface DeliveryMarkupContext {
  access: DigitalAccess;
  /** Where the forms send the buyer back (a `safeDownloadReturnPath`). */
  returnTo: string;
  /** Where "Ask the store for more downloads" goes (the order's conversation). */
  askHref: string;
  notice?: DownloadNotice | null;
  nowMs?: number;
}

const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors";
const PRIMARY_BUTTON = `${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90`;
const SECONDARY_BUTTON = `${BUTTON} border border-border bg-background text-foreground hover:bg-muted`;

function hiddenFields(context: DeliveryMarkupContext, fields: Record<string, string>): string {
  const all = { ...fields, ...(context.access.kind === "receipt" ? { orderId: context.access.orderId } : {}), returnTo: context.returnTo };
  return Object.entries(all)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("");
}

function reasonMarkup(state: DownloadFileState, context: DeliveryMarkupContext): string {
  if (state === "available") return "";
  if (state === "limit") {
    return `<p class="text-sm text-foreground">${escapeHtml(DOWNLOAD_COPY.usedUp)} <a href="${escapeHtml(context.askHref)}" data-astro-prefetch="false" class="font-medium text-primary hover:underline">${escapeHtml(DOWNLOAD_COPY.askForMore)}</a></p>`;
  }
  const text = state === "revoked" ? DOWNLOAD_COPY.revoked : state === "expired" ? DOWNLOAD_COPY.expired : DOWNLOAD_COPY.notAvailable;
  return `<p class="text-sm text-foreground">${escapeHtml(text)}</p>`;
}

function noticeMarkup(file: DownloadFileView, notice: DownloadNotice | null | undefined): string {
  if (!notice) return "";
  if (notice.entitlementId !== null && notice.entitlementId !== file.entitlementId) return "";
  // Without the anchor (a server render), only the row the page scrolled to shows it.
  const visibility = notice.entitlementId === null ? "hidden group-target:block " : "";
  return `<p role="status" class="${visibility}mt-1 text-sm font-medium text-destructive">${escapeHtml(downloadStatusText(notice.flag))}</p>`;
}

/** One file row: name, usage, expiry, and a Download POST form or the reason it is off. */
export function downloadFileMarkup(file: DownloadFileView, context: DeliveryMarkupContext): string {
  const now = context.nowMs ?? Date.now();
  const state = downloadFileState(file, now);
  const facts = [formatFileSize(file.sizeBytes), downloadUsageText(file), downloadExpiryText(file.expiresAt, now)].filter(Boolean);
  const action = state === "available"
    ? `<form method="post" action="/api/downloads/ticket" class="shrink-0">${hiddenFields(context, { entitlementId: file.entitlementId })}<button type="submit" class="${PRIMARY_BUTTON}">${escapeHtml(DOWNLOAD_COPY.download)}<span class="sr-only"> ${escapeHtml(file.displayName)}</span></button></form>`
    : "";
  return `<li id="${escapeHtml(downloadRowId(file.entitlementId))}" class="group flex scroll-mt-24 flex-wrap items-center justify-between gap-3 py-3">
    <div class="min-w-0 flex-1">
      <p class="break-words font-medium text-foreground">${escapeHtml(file.displayName)}</p>
      <p class="text-sm text-muted-foreground">${facts.map(escapeHtml).join(" · ")}</p>
      ${reasonMarkup(state, context)}${noticeMarkup(file, context.notice)}
    </div>${action}
  </li>`;
}

/** One key row: masked ("•••• ABCD") with a Show key POST form. */
export function licenceKeyMarkup(key: LicenceKeyView, context: DeliveryMarkupContext): string {
  const label = fillCopy(DOWNLOAD_COPY.keyEndingIn, { last4: key.last4 });
  return `<li class="flex flex-wrap items-center justify-between gap-3 py-3">
    <p class="min-w-0"><span class="sr-only">${escapeHtml(label)}</span><span aria-hidden="true" class="font-mono text-sm tracking-wider text-foreground">•••• ${escapeHtml(key.last4)}</span></p>
    <form method="post" action="/account/licence-key" class="shrink-0">${hiddenFields(context, { keyId: key.keyId })}<button type="submit" class="${SECONDARY_BUTTON}">${escapeHtml(DOWNLOAD_COPY.showKey)}<span class="sr-only"> (${escapeHtml(label)})</span></button></form>
  </li>`;
}

/** Files then keys, each under a small heading; "" when there is nothing. */
export function digitalDeliveryListsMarkup(
  files: readonly DownloadFileView[],
  keys: readonly LicenceKeyView[],
  context: DeliveryMarkupContext,
): string {
  const heading = (text: string) => `<p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">${escapeHtml(text)}</p>`;
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(`<div>${heading(DOWNLOAD_COPY.filesHeading)}<ul class="divide-y divide-border">${files.map((file) => downloadFileMarkup(file, context)).join("")}</ul></div>`);
  }
  if (keys.length > 0) {
    parts.push(`<div>${heading(DOWNLOAD_COPY.keysHeading)}<ul class="divide-y divide-border">${keys.map((key) => licenceKeyMarkup(key, context)).join("")}</ul></div>`);
  }
  return parts.join("");
}

/** The account Downloads list: one card per delivered line, newest first. */
export function renderDownloadLines(lines: readonly BuyerDigitalLine[], options: { returnTo: string; nowMs?: number }): string {
  return lines.map((line) => {
    const orderHref = `/account/orders/${encodeURIComponent(line.orderId)}`;
    const context: DeliveryMarkupContext = {
      access: { kind: "account" },
      returnTo: options.returnTo,
      askHref: `${orderHref}#conversation`,
      nowMs: options.nowMs,
    };
    const delivered = formatAccountDate(line.deliveredAt, { time: false });
    const meta = [
      `<a href="${escapeHtml(orderHref)}" data-astro-prefetch="false" class="font-medium text-primary hover:underline">${escapeHtml(fillCopy(DOWNLOAD_COPY.order, { number: formatOrderNumber(line.orderNumber, line.orderId) }))}</a>`,
      delivered ? escapeHtml(fillCopy(DOWNLOAD_COPY.deliveredOn, { date: delivered })) : "",
    ].filter(Boolean).join(" · ");
    return `<li class="rounded-xl border border-border bg-card p-5">
      <h2 class="break-words text-base font-semibold text-foreground">${escapeHtml(line.productName ?? DOWNLOAD_COPY.productFallback)}</h2>
      ${line.variantLabel ? `<p class="text-sm text-muted-foreground">${escapeHtml(line.variantLabel)}</p>` : ""}
      <p class="mt-1 text-sm text-muted-foreground">${meta}</p>
      <div class="mt-4 space-y-4">${digitalDeliveryListsMarkup(line.files, line.licenceKeys, context)}</div>
    </li>`;
  }).join("");
}
