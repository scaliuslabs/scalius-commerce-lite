/**
 * What every footer variant reads, computed once: the footer block's words
 * (tagline, about, the name after ©), the theme's footer logo, identity and
 * contact facts (Business settings), menus ("Track your order" placed), the
 * policy links no menu already carries, and social links. Variants choose
 * structure only.
 */
import type { FooterMenu, FooterMenuLink, SocialLink } from "@/lib/api";
import type { StorefrontBrandAsset } from "@scalius/shared/storefront-theme";
import { mediaImageUrl } from "@/lib/media-url";
import { telHref, whatsappHref } from "@/lib/store-identity";
import { placeTrackOrderLink } from "@/lib/footer-links";
import type { StorefrontBusinessInfo } from "@/lib/commerce-structured-data";

/** The words every footer variant's settings carry (plain text). */
export interface FooterWords {
  tagline: string;
  about: string;
  copyright: string;
}

/** The footer block's words from its resolved settings (missing ones read as empty). */
export function footerWords(settings: Record<string, unknown>): FooterWords {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return { tagline: text(settings.tagline), about: text(settings.about), copyright: text(settings.copyright) };
}

export interface FooterInput {
  words: FooterWords;
  /** The theme's footer logo; null: the store name in text. */
  logo: StorefrontBrandAsset | null;
  menus: FooterMenu[];
  storeName: string | null;
  storePhone: string | null;
  social: SocialLink[];
  policies: Array<{ title: string; path: string }>;
  business: StorefrontBusinessInfo | null | undefined;
  /** The "Track your order" link's words in the store's language. */
  trackOrderLabel: string;
}

export interface FooterModel {
  /** The footer logo's image (`src` "" without one: the store name in text). */
  logo: { src: string };
  brandName: string;
  storePhone: string | null;
  phoneHref: string | null;
  chatHref: string | null;
  storeEmail: string | null;
  storeAddress: string;
  /** Anything to contact: a contact block without it is left out, not shown empty. */
  hasContactDetails: boolean;
  tagline: string;
  /** The about text's paragraphs (plain text: blank lines separate them). */
  about: string[];
  /** The name after ©: the footer's own words, else the store name. */
  copyrightName: string;
  menus: FooterMenu[];
  trackOrderInBottomRow: boolean;
  /** Policy pages (payment gateways require them visible) no menu already links. */
  policyLinks: Array<{ title: string; href: string }>;
  /** Every top-level menu link and policy, in one list (the band footers). */
  flatLinks: Array<{ title: string; href: string }>;
  social: Array<SocialLink & { optimizedIconUrl: string | null }>;
}

/** Plain text as paragraphs: blank lines separate them. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function footerModel(input: FooterInput): FooterModel {
  const { words, logo, storeName, storePhone, social, policies, business } = input;
  const brandName = storeName || "";
  const phoneHref = telHref(storePhone);
  const chatHref = whatsappHref(storePhone);
  const storeEmail = business?.email?.trim() || null;
  const storeAddress = [business?.addressLine1, business?.addressLine2, business?.city]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
  const { menus, inBottomRow } = placeTrackOrderLink(
    input.menus.map((menu): FooterMenu => ({ ...menu, links: Array.isArray(menu.links) ? menu.links : [] })),
    input.trackOrderLabel,
  );
  const linkedHrefs = new Set(menus.flatMap((menu) => menu.links.map((link) => (link.href ?? "").replace(/\/+$/, ""))));
  const policyLinks = policies
    .map((policy) => ({ title: policy.title, href: policy.path }))
    .filter((link) => !linkedHrefs.has(link.href));
  return {
    logo: { src: logo?.url ?? "" },
    brandName,
    storePhone,
    phoneHref,
    chatHref,
    storeEmail,
    storeAddress,
    hasContactDetails: Boolean(phoneHref || chatHref || storeEmail || storeAddress),
    tagline: words.tagline,
    about: paragraphs(words.about),
    // The line ends with its own ". All rights reserved.": a name ending in "." (Ltd.) keeps one dot.
    copyrightName: (words.copyright || brandName).replace(/\.+$/, ""),
    menus,
    trackOrderInBottomRow: inBottomRow,
    policyLinks,
    flatLinks: [
      ...menus.flatMap((menu) =>
        menu.links.filter((link): link is FooterMenuLink & { href: string } => Boolean(link.href)),
      ),
      ...policyLinks,
    ].map((link) => ({ title: link.title, href: link.href })),
    social: social.map((item) => ({
      ...item,
      optimizedIconUrl: item.iconUrl ? mediaImageUrl(item.iconUrl, 160) : null,
    })),
  };
}

/** The directory footer's links: each menu's links and their children, capped overall (about 60 curated links). */
export function directoryLinks(menus: FooterMenu[], max = 60): Array<{ title: string; links: FooterMenuLink[] }> {
  let left = max;
  return menus
    .map((menu) => {
      const flat = menu.links.flatMap((link) => [link, ...(link.subMenu ?? [])]).filter((link) => link.href);
      const links = flat.slice(0, Math.max(0, left));
      left -= links.length;
      return { title: menu.title, links };
    })
    .filter((menu) => menu.links.length > 0);
}
