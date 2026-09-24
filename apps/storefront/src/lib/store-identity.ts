/**
 * One store identity for every buyer-facing surface: page titles, Open Graph,
 * schema, header, footer and the mobile menu all read the store name and
 * support phone from Business settings, so they can never disagree.
 */
import type { SocialLink } from "./api/types";
import { mediaImageUrl } from "./media-url";
import { MEDIA_DISCOVERY_IMAGE_WIDTH } from "@scalius/shared/media-variants";
import type { StorefrontBusinessInfo } from "./commerce-structured-data";

export function resolveStoreName(
  business: StorefrontBusinessInfo | null | undefined,
): string | null {
  return business?.companyName?.trim() || business?.legalName?.trim() || null;
}

/**
 * The name buyers see in titles, the header, footer and Open Graph: the
 * Business settings name, else the Store URL host (never blank). Schema
 * identity stays on resolveStoreName only.
 */
export function resolveStoreDisplayName(
  business: StorefrontBusinessInfo | null | undefined,
  storefrontUrl: string | null | undefined,
): string | null {
  const name = resolveStoreName(business);
  if (name) return name;
  try {
    return storefrontUrl ? new URL(storefrontUrl).host || null : null;
  } catch {
    return null;
  }
}

/**
 * The store-level share image: the social image from Preferences, else the
 * header logo. Pages without their own image (and schema that needs one)
 * use it, so no page shares without a preview.
 */
export function resolveStoreShareImage(input: {
  socialImage?: string | null;
  logo?: string | null;
}): string | null {
  const source = input.socialImage?.trim() || input.logo?.trim();
  return source ? mediaImageUrl(source, MEDIA_DISCOVERY_IMAGE_WIDTH) || null : null;
}

/** Business settings own the support phone; the header field is the fallback. */
export function resolveStorePhone(
  business: StorefrontBusinessInfo | null | undefined,
  headerPhone: string | null | undefined,
): string | null {
  return business?.phone?.trim() || headerPhone?.trim() || null;
}

/** A pagination suffix added by listing pages (" – Page 2"). */
const PAGE_SUFFIX = /\s[–—-]\sPage \d+$/u;
/** " | Brand" or " – Brand": the title already carries its own brand segment. */
const BRAND_SEPARATOR = /\s[|–—]\s/u;

/**
 * `Page | Store`. A title that already names the store, or that the merchant
 * wrote with its own brand segment ("Footwear | Scalius Market"), is used as
 * written so no page ever carries two brands.
 */
export function buildDocumentTitle(
  title: string | null | undefined,
  storeName: string | null,
): string {
  const pageTitle = title?.trim() ?? "";
  if (!storeName) return pageTitle;
  if (!pageTitle) return storeName;
  const withoutPage = pageTitle.replace(PAGE_SUFFIX, "");
  return withoutPage.toLocaleLowerCase().includes(storeName.toLocaleLowerCase()) ||
    BRAND_SEPARATOR.test(withoutPage)
    ? pageTitle
    : `${pageTitle} | ${storeName}`;
}

const BANGLA_DIGITS = /[০-৯]/g;

/** International digits for wa.me/tel: a local `01XXXXXXXXX` becomes `8801XXXXXXXXX`. */
export function internationalPhoneDigits(phone: string | null | undefined): string | null {
  const digits = (phone ?? "")
    .replace(BANGLA_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/\D/g, "");
  if (digits.length < 6) return null;
  return /^01\d{9}$/.test(digits) ? `88${digits}` : digits;
}

export function telHref(phone: string | null | undefined): string | null {
  const digits = internationalPhoneDigits(phone);
  return digits ? `tel:+${digits}` : null;
}

export function whatsappHref(phone: string | null | undefined): string | null {
  const digits = internationalPhoneDigits(phone);
  return digits ? `https://wa.me/${digits}` : null;
}

function absoluteSocialUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function isWhatsappLink(link: SocialLink, url: URL): boolean {
  const name = `${link.platform ?? ""} ${link.label ?? ""}`.toLowerCase();
  return (
    name.includes("whatsapp") ||
    /(^|\.)whatsapp\.com$/i.test(url.hostname) ||
    url.hostname.toLowerCase() === "wa.me"
  );
}

/** A WhatsApp link opens a chat only when it names a number. */
function whatsappLinkHasNumber(url: URL): boolean {
  if (url.hostname.toLowerCase() === "wa.me") return /\d{6,}/.test(url.pathname);
  return /\d{6,}/.test(url.searchParams.get("phone") ?? "");
}

/**
 * The store's single social icon set: header and footer links merged in
 * order, de-duplicated by URL. A WhatsApp link without a number (for example
 * `web.whatsapp.com`) is pointed at a chat with the store's phone instead.
 */
export function resolveStoreSocialLinks(
  sources: ReadonlyArray<ReadonlyArray<SocialLink> | null | undefined>,
  storePhone: string | null,
): Array<SocialLink & { url: string }> {
  const seen = new Set<string>();
  const links: Array<SocialLink & { url: string }> = [];
  for (const link of sources.flat()) {
    if (!link?.url?.trim()) continue;
    let url: URL;
    try {
      url = new URL(absoluteSocialUrl(link.url.trim()));
    } catch {
      continue;
    }
    let href = url.toString();
    if (isWhatsappLink(link, url) && !whatsappLinkHasNumber(url)) {
      const chat = whatsappHref(storePhone);
      if (!chat) continue;
      href = chat;
    }
    const key = href.toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ ...link, url: href });
  }
  return links;
}
