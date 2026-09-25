// B3 (digital goods): one order line's downloads and licence keys, as markup.
// The receipt renders it server-side (DigitalLineDelivery.astro); the
// browser-rendered account order page appends it under the line through
// `lineExtrasMarkup`. Download and Show key are plain POST forms carrying ids
// only; `orderId` goes with them on receipt pages, where the proof is that
// order's receipt cookie. Nothing when the line has no downloads or keys.
import type { LineExtrasContext, OrderLine } from "@/lib/order-line-extras";
import {
  DOWNLOAD_COPY,
  digitalDeliveryListsMarkup,
  readDownloadFiles,
  readDownloadNotice,
  readLicenceKeys,
  safeDownloadReturnPath,
  type DownloadFileView,
  type DownloadNotice,
  type LicenceKeyView,
} from "@/lib/account-downloads";
import { escapeHtml } from "@scalius/shared/html-escape";

/** `extras.downloads`: the files the line received (OrderLineDownloadExtra). */
export type DigitalDownloadsExtra = ReadonlyArray<Omit<DownloadFileView, "available" | "sizeBytes">>;
/** `extras.licenceKeys`: the keys the line received, by their last characters (OrderLineLicenceKeyExtra). */
export type LicenceKeysExtra = ReadonlyArray<LicenceKeyView>;

export interface DigitalLineDeliveryOptions {
  /** The page the forms return to; defaults to the page for this access. */
  returnTo?: string;
  /** A refused Download that came back to this page (read from the address bar in the browser). */
  notice?: DownloadNotice | null;
  nowMs?: number;
}

/** The page's own Download outcome, when this runs in a browser. */
function browserNotice(): DownloadNotice | null {
  const location = (globalThis as { location?: Location }).location;
  return location ? readDownloadNotice(location.search, location.hash) : null;
}

function defaultReturnTo(context: LineExtrasContext): string {
  if (context.access === "account") return `/account/orders/${encodeURIComponent(context.orderId)}`;
  const location = (globalThis as { location?: Location }).location;
  const here = location ? safeDownloadReturnPath(`${location.pathname}${location.search}`) : null;
  return here ?? `/order-success?${new URLSearchParams({ orderId: context.orderId })}`;
}

export function digitalLineDeliveryMarkup(
  line: OrderLine,
  context: LineExtrasContext,
  options: DigitalLineDeliveryOptions = {},
): string {
  const files = readDownloadFiles(line.extras?.downloads);
  const keys = readLicenceKeys(line.extras?.licenceKeys);
  if (files.length === 0 && keys.length === 0) return "";
  const lists = digitalDeliveryListsMarkup(files, keys, {
    access: context.access === "receipt" ? { kind: "receipt", orderId: context.orderId } : { kind: "account" },
    returnTo: options.returnTo ?? defaultReturnTo(context),
    askHref: "#conversation",
    notice: options.notice === undefined ? browserNotice() : options.notice,
    nowMs: options.nowMs,
  });
  return `<div class="mt-3 space-y-3 rounded-lg border border-border bg-background p-3" aria-label="${escapeHtml(DOWNLOAD_COPY.pageTitle)}" role="group">${lists}</div>`;
}
