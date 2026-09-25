// Warranty on the storefront (Wave B §5.3): the words for a policy ("1 year
// brand warranty · 7-day replacement"), each order line's warranty records,
// Account › Warranties and the claim form's outcome. Pure: the product page,
// the receipt, the account order page (in the browser) and the account's
// Warranties page share it. The copy is the store's checkout language.
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { escapeHtml } from "@scalius/shared/html-escape";
import { formatAccountDate } from "@/lib/account-format";

export const WARRANTY_COPY_KEYS = [
  "warrantyBrandText",
  "warrantyStoreText",
  "warrantyReplacementText",
  "warrantyDayText",
  "warrantyDaysText",
  "warrantyMonthText",
  "warrantyMonthsText",
  "warrantyYearText",
  "warrantyYearsText",
  "warrantyLabelText",
  "warrantyTermsText",
  "warrantyHowToClaimText",
  "warrantyUntilText",
  "warrantyEndedText",
  "warrantyVoidText",
  "warrantyReplacementUntilText",
  "warrantyMakeClaimText",
  "warrantyViewClaimText",
  "warrantyClaimOpenText",
  "warrantyClaimInProgressText",
  "warrantyClaimResolvedText",
  "warrantyClaimRejectedText",
  "warrantyClaimDescriptionText",
  "warrantyClaimDescriptionHelpText",
  "warrantyClaimPhotosText",
  "warrantyClaimPhotosHelpText",
  "warrantyClaimSubmitText",
  "warrantyClaimInvalidText",
  "warrantyClaimPhotoText",
  "warrantyClaimInactiveText",
  "warrantyClaimExistsText",
  "warrantyClaimRateLimitedText",
  "warrantyClaimUnavailableText",
  "warrantyClaimSignInText",
  "warrantyClaimReceiptExpiredText",
  "warrantiesTitleText",
  "warrantiesIntroText",
  "warrantiesActiveTitleText",
  "warrantiesExpiredTitleText",
  "warrantiesNoneText",
  "warrantyDaysLeftText",
  "warrantyDayLeftText",
  "warrantyMonthsLeftText",
  "warrantyOrderText",
  "warrantiesSignInTitleText",
  "warrantiesSignInText",
  "warrantiesUnavailableText",
  "warrantiesRetryText",
] as const satisfies readonly (keyof CheckoutLanguageData)[];

export type WarrantyCopy = Pick<CheckoutLanguageData, (typeof WARRANTY_COPY_KEYS)[number]>;

/** The warranty copy: the store's saved words over the language preset. */
export function pickWarrantyCopy(
  copy: Partial<CheckoutLanguageData> | null | undefined,
  fallback: CheckoutLanguageData,
): WarrantyCopy {
  return Object.fromEntries(WARRANTY_COPY_KEYS.map((key) => {
    const value = copy?.[key];
    return [key, typeof value === "string" && value.trim() ? value : fallback[key]];
  })) as WarrantyCopy;
}

// ---------------------------------------------------------------------------
// Policy words
// ---------------------------------------------------------------------------

export type WarrantyProvider = "brand" | "store";
export type WarrantyDurationUnit = "days" | "months" | "years";
export type WarrantyClaimStatus = "open" | "in_progress" | "resolved" | "rejected";

/** What the buyer bought: the policy's (or the frozen revision's) terms. */
export interface WarrantyTerms {
  provider: WarrantyProvider;
  durationValue: number;
  durationUnit: WarrantyDurationUnit;
  replacementDays: number | null;
}

const PROVIDERS: readonly string[] = ["brand", "store"];
const UNITS: readonly string[] = ["days", "months", "years"];
const CLAIM_STATUSES: readonly string[] = ["open", "in_progress", "resolved", "rejected"];

/** "1 year", "18 months", "7 days". */
export function warrantyDurationText(value: number, unit: WarrantyDurationUnit, copy: WarrantyCopy): string {
  const [one, many] = unit === "years"
    ? [copy.warrantyYearText, copy.warrantyYearsText]
    : unit === "months"
      ? [copy.warrantyMonthText, copy.warrantyMonthsText]
      : [copy.warrantyDayText, copy.warrantyDaysText];
  return value === 1 ? one : formatCheckoutLanguageText(many, { count: value });
}

/** "1 year brand warranty · 7-day replacement". */
export function warrantySummaryText(terms: WarrantyTerms, copy: WarrantyCopy): string {
  const duration = warrantyDurationText(terms.durationValue, terms.durationUnit, copy);
  const warranty = formatCheckoutLanguageText(
    terms.provider === "brand" ? copy.warrantyBrandText : copy.warrantyStoreText,
    { duration },
  );
  return terms.replacementDays && terms.replacementDays > 0
    ? `${warranty} · ${formatCheckoutLanguageText(copy.warrantyReplacementText, { days: terms.replacementDays })}`
    : warranty;
}

/** "Claim open", "Claim resolved", … */
export function warrantyClaimStatusText(status: WarrantyClaimStatus, copy: WarrantyCopy): string {
  if (status === "in_progress") return copy.warrantyClaimInProgressText;
  if (status === "resolved") return copy.warrantyClaimResolvedText;
  if (status === "rejected") return copy.warrantyClaimRejectedText;
  return copy.warrantyClaimOpenText;
}

const DAY_MS = 86_400_000;

/** "12 days left", "1 day left", "9 months left"; "" once ended. */
export function warrantyTimeLeftText(expiresAt: string, now: number, copy: WarrantyCopy): string {
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end) || end <= now) return "";
  const days = Math.ceil((end - now) / DAY_MS);
  if (days <= 1) return copy.warrantyDayLeftText;
  // Two months or more read in months (never "1 months").
  if (days < 62) return formatCheckoutLanguageText(copy.warrantyDaysLeftText, { count: days });
  return formatCheckoutLanguageText(copy.warrantyMonthsLeftText, { count: Math.floor(days / 30.44) });
}

function day(iso: string): string {
  return formatAccountDate(iso, { time: false });
}

/** "Warranty until 3 Oct 2027 · Replacement until 10 Oct 2026", "Warranty ended …" or "Warranty void". */
export function warrantyDatesText(
  record: { expiresAt: string; replacementUntil: string | null; voided: boolean },
  now: number,
  copy: WarrantyCopy,
): string {
  if (record.voided) return copy.warrantyVoidText;
  const end = Date.parse(record.expiresAt);
  if (!(end > now)) return formatCheckoutLanguageText(copy.warrantyEndedText, { date: day(record.expiresAt) });
  const until = formatCheckoutLanguageText(copy.warrantyUntilText, { date: day(record.expiresAt) });
  const replacementEnd = record.replacementUntil ? Date.parse(record.replacementUntil) : Number.NaN;
  return record.replacementUntil && replacementEnd > now
    ? `${until} · ${formatCheckoutLanguageText(copy.warrantyReplacementUntilText, { date: day(record.replacementUntil) })}`
    : until;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const WARRANTY_ID = /^wty_[A-Za-z0-9_-]{8,80}$/;
const CLAIM_ID = /^wcl_[A-Za-z0-9_-]{8,64}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isWarrantyId(value: unknown): value is string {
  return typeof value === "string" && WARRANTY_ID.test(value);
}

export function isWarrantyClaimId(value: unknown): value is string {
  return typeof value === "string" && CLAIM_ID.test(value);
}

// ---------------------------------------------------------------------------
// API shapes (read defensively: a malformed entry is skipped)
// ---------------------------------------------------------------------------

export interface WarrantyClaimRef {
  id: string;
  conversationId: string;
  status: WarrantyClaimStatus;
}

/** One `items[].extras.warranty[]` record: one per handed-over fulfilment line. */
export interface LineWarranty extends WarrantyTerms {
  warrantyId: string;
  policyName: string;
  terms: string | null;
  startsAt: string;
  expiresAt: string;
  replacementUntil: string | null;
  voided: boolean;
  claim: WarrantyClaimRef | null;
}

/** One entry of the account's `GET /customer-auth/warranties`. */
export interface BuyerWarranty extends WarrantyTerms {
  warrantyId: string;
  orderId: string;
  orderNumber: string;
  productName: string | null;
  variantLabel: string | null;
  imageUrl: string | null;
  policyName: string;
  terms: string | null;
  expiresAt: string;
  replacementUntil: string | null;
  state: "active" | "expired" | "voided";
  claim: WarrantyClaimRef | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function readTerms(entry: Record<string, unknown>): WarrantyTerms | null {
  const { provider, durationValue, durationUnit, replacementDays } = entry;
  if (typeof provider !== "string" || !PROVIDERS.includes(provider)) return null;
  if (typeof durationUnit !== "string" || !UNITS.includes(durationUnit)) return null;
  if (typeof durationValue !== "number" || !Number.isInteger(durationValue) || durationValue < 1) return null;
  return {
    provider: provider as WarrantyProvider,
    durationValue,
    durationUnit: durationUnit as WarrantyDurationUnit,
    replacementDays: typeof replacementDays === "number" && Number.isInteger(replacementDays) && replacementDays > 0 ? replacementDays : null,
  };
}

function readClaim(value: unknown): WarrantyClaimRef | null {
  if (!isRecord(value)) return null;
  const { id, conversationId, status } = value;
  if (!isWarrantyClaimId(id) || typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) return null;
  if (typeof status !== "string" || !CLAIM_STATUSES.includes(status)) return null;
  return { id, conversationId, status: status as WarrantyClaimStatus };
}

export function readLineWarranties(value: unknown): LineWarranty[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry): LineWarranty[] => {
    if (!isRecord(entry)) return [];
    const terms = readTerms(entry);
    const policyName = text(entry.policyName, 200);
    if (!terms || !policyName || !isWarrantyId(entry.warrantyId) || !isIso(entry.startsAt) || !isIso(entry.expiresAt)) return [];
    return [{
      ...terms,
      warrantyId: entry.warrantyId,
      policyName,
      terms: text(entry.terms, 8_000),
      startsAt: entry.startsAt,
      expiresAt: entry.expiresAt,
      replacementUntil: isIso(entry.replacementUntil) ? entry.replacementUntil : null,
      voided: entry.voided === true,
      claim: readClaim(entry.claim),
    }];
  });
}

export function readBuyerWarranties(value: unknown): BuyerWarranty[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((entry): BuyerWarranty[] => {
    if (!isRecord(entry)) return [];
    const terms = readTerms(entry);
    const policyName = text(entry.policyName, 200);
    const orderNumber = text(entry.orderNumber, 64);
    const { state } = entry;
    if (
      !terms || !policyName || !orderNumber || !isWarrantyId(entry.warrantyId) ||
      typeof entry.orderId !== "string" || !CONVERSATION_ID.test(entry.orderId) || !isIso(entry.expiresAt) ||
      (state !== "active" && state !== "expired" && state !== "voided")
    ) {
      return [];
    }
    const imageUrl = text(entry.imageUrl, 2_000);
    return [{
      ...terms,
      warrantyId: entry.warrantyId,
      orderId: entry.orderId,
      orderNumber,
      productName: text(entry.productName, 300),
      variantLabel: text(entry.variantLabel, 200),
      imageUrl: imageUrl && /^(https?:)?\//.test(imageUrl) ? imageUrl : null,
      policyName,
      terms: text(entry.terms, 8_000),
      expiresAt: entry.expiresAt,
      replacementUntil: isIso(entry.replacementUntil) ? entry.replacementUntil : null,
      state,
      claim: readClaim(entry.claim),
    }];
  });
}

/** A record the buyer may claim on now: not void, not ended, no open claim. */
export function canClaimWarranty(record: { expiresAt: string; voided: boolean; claim: WarrantyClaimRef | null }, now: number): boolean {
  if (record.voided || !(Date.parse(record.expiresAt) > now)) return false;
  return !record.claim || record.claim.status === "resolved" || record.claim.status === "rejected";
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type WarrantyAccess = { kind: "account" } | { kind: "receipt"; orderId: string };

/** Where a claim's thread lives: the account inbox, or the guest's claim page. */
export function warrantyClaimThreadHref(claim: WarrantyClaimRef, access: WarrantyAccess): string {
  return access.kind === "account"
    ? `/account/inbox/${encodeURIComponent(claim.conversationId)}`
    : `/warranty-claims/${encodeURIComponent(access.orderId)}/${encodeURIComponent(claim.id)}`;
}

/** Account › Warranties with this warranty's claim form open. */
export function accountClaimFormHref(warrantyId: string): string {
  return `/account/warranties?${new URLSearchParams({ claim: warrantyId })}#warranty-${warrantyId}`;
}

/** The claim form's same-origin endpoint. A receipt names its order (an id, never the proof). */
export function warrantyClaimAction(warrantyId: string, access: WarrantyAccess): string {
  const base = `/api/warranties/${encodeURIComponent(warrantyId)}/claim`;
  return access.kind === "account"
    ? `${base}?access=account`
    : `${base}?${new URLSearchParams({ orderId: access.orderId })}`;
}

// ---------------------------------------------------------------------------
// The claim form's outcome (a plain post comes back with ids and a flag only)
// ---------------------------------------------------------------------------

export const WARRANTY_CLAIM_FLAGS = [
  "invalid",
  "photo",
  "inactive",
  "exists",
  "rate",
  "signin",
  "missing",
  "unavailable",
] as const;
export type WarrantyClaimFlag = (typeof WARRANTY_CLAIM_FLAGS)[number];

export const WARRANTY_CLAIM_PARAM = "claim";
export const WARRANTY_CLAIM_STATUS_PARAM = "claimStatus";

export function warrantyClaimFlagText(flag: WarrantyClaimFlag, copy: WarrantyCopy): string {
  switch (flag) {
    case "invalid": return copy.warrantyClaimInvalidText;
    case "photo": return copy.warrantyClaimPhotoText;
    case "inactive": return copy.warrantyClaimInactiveText;
    case "exists": return copy.warrantyClaimExistsText;
    case "rate": return copy.warrantyClaimRateLimitedText;
    case "signin": return copy.warrantyClaimSignInText;
    case "missing": return copy.warrantyClaimReceiptExpiredText;
    default: return copy.warrantyClaimUnavailableText;
  }
}

/** The warranty whose claim form the page should open, and how its last plain post went. */
export function readWarrantyClaimNotice(url: URL): { warrantyId: string; flag: WarrantyClaimFlag | null } | null {
  const warrantyId = url.searchParams.get(WARRANTY_CLAIM_PARAM);
  if (!isWarrantyId(warrantyId)) return null;
  const flag = url.searchParams.get(WARRANTY_CLAIM_STATUS_PARAM);
  return {
    warrantyId,
    flag: (WARRANTY_CLAIM_FLAGS as readonly string[]).includes(flag ?? "") ? flag as WarrantyClaimFlag : null,
  };
}

/** `returnTo` with this warranty's form open, the outcome flag, and its anchor. */
export function withWarrantyClaimStatus(returnTo: string, warrantyId: string, flag: WarrantyClaimFlag): string {
  const url = new URL(returnTo, "https://storefront.invalid");
  url.searchParams.set(WARRANTY_CLAIM_PARAM, warrantyId);
  url.searchParams.set(WARRANTY_CLAIM_STATUS_PARAM, flag);
  url.hash = `warranty-${warrantyId}`;
  return `${url.pathname}${url.search}${url.hash}`;
}

// ---------------------------------------------------------------------------
// One order line's warranty (receipt and account order page)
// ---------------------------------------------------------------------------

const SHIELD_ICON = '<svg aria-hidden="true" class="size-4 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>';

const LINK = "inline-flex min-h-11 items-center font-medium text-primary hover:underline";

/**
 * One warranty record under an order line: what was bought, its dates, and the
 * claim (its status and thread) or, when `claimHref` is given and the record is
 * claimable, a "Make a claim" link.
 */
export function lineWarrantyMarkup(
  record: LineWarranty,
  options: { copy: WarrantyCopy; access: WarrantyAccess; now: number; claimHref?: string | null },
): string {
  const { copy, access, now } = options;
  const claim = record.claim;
  const action = claim
    ? `<span class="text-muted-foreground">${escapeHtml(warrantyClaimStatusText(claim.status, copy))}</span>
        <a href="${escapeHtml(warrantyClaimThreadHref(claim, access))}" data-astro-prefetch="false" class="${LINK}">${escapeHtml(copy.warrantyViewClaimText)}</a>`
    : "";
  const make = options.claimHref && canClaimWarranty(record, now)
    ? `<a href="${escapeHtml(options.claimHref)}" data-astro-prefetch="false" class="${LINK}">${escapeHtml(copy.warrantyMakeClaimText)}</a>`
    : "";
  const actions = action || make
    ? `<p class="flex flex-wrap items-center gap-x-3">${action}${make}</p>`
    : "";
  return `<div class="mt-2 text-sm" id="warranty-${escapeHtml(record.warrantyId)}" data-line-warranty>
      <p class="flex items-center gap-1.5 font-medium text-foreground">${SHIELD_ICON}<span>${escapeHtml(warrantySummaryText(record, copy))}</span></p>
      <p class="text-muted-foreground">${escapeHtml(warrantyDatesText(record, now, copy))}</p>
      ${actions}
    </div>`;
}
