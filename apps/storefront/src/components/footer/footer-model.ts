/**
 * What every footer variant reads, computed once: identity, contact facts,
 * menus (flat API menus nested, "Track your order" placed), the policy links
 * no menu already carries, and social links. Variants choose structure only.
 */
import type { FooterData, FooterMenu, FooterMenuLink, SocialLink } from "@/lib/api";
import { mediaImageUrl } from "@/lib/media-url";
import { optimizeRichContentImages } from "@/lib/rich-content-media";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { applyStorefrontPrefetchPolicyToHtml } from "@/lib/prefetch-policy";
import { telHref, whatsappHref } from "@/lib/store-identity";
import { placeTrackOrderLink } from "@/lib/footer-links";
import type { StorefrontBusinessInfo } from "@/lib/commerce-structured-data";

export interface FooterInput {
  footerData: FooterData;
  storeName: string | null;
  storePhone: string | null;
  social: SocialLink[];
  policies: Array<{ title: string; path: string }>;
  business: StorefrontBusinessInfo | null | undefined;
}

export type FooterNestedMenu = FooterMenu & { links: FooterMenuLink[] };

export interface FooterModel {
  logo: { src: string; alt: string };
  brandName: string;
  storePhone: string | null;
  phoneHref: string | null;
  chatHref: string | null;
  storeEmail: string | null;
  storeAddress: string;
  /** Anything to contact: a contact block without it is left out, not shown empty. */
  hasContactDetails: boolean;
  tagline: string;
  description: string;
  descriptionHtml: string;
  copyrightName: string;
  menus: FooterNestedMenu[];
  trackOrderInBottomRow: boolean;
  /** Policy pages (payment gateways require them visible) no menu already links. */
  policyLinks: Array<{ title: string; href: string }>;
  /** Every top-level menu link and policy, in one list (the band footers). */
  flatLinks: Array<{ title: string; href: string }>;
  social: Array<SocialLink & { optimizedIconUrl: string | null }>;
}

/** Flat API menus (items + rootIds) as nested links; nested menus pass through. */
export function nestedFooterLinks(menu: FooterMenu): FooterMenuLink[] {
  if (menu.links && Array.isArray(menu.links) && menu.links.length > 0) return menu.links;
  if (!menu.items || !menu.rootIds) return [];
  const items = menu.items;
  const build = (ids: string[], seen: Set<string>): FooterMenuLink[] =>
    ids
      .map((id) => {
        const item = items[id];
        if (!item || seen.has(id)) return null;
        const link: FooterMenuLink = {
          id: item.id,
          title: item.title,
          href: item.href || "#",
          openInNewTab: item.openInNewTab,
        };
        if (item.childIds && item.childIds.length > 0) link.subMenu = build(item.childIds, new Set([...seen, id]));
        return link;
      })
      .filter((link): link is FooterMenuLink => link !== null);
  return build(menu.rootIds, new Set());
}

export function footerModel(input: FooterInput, url: URL): FooterModel {
  const { footerData, storeName, storePhone, social, policies, business } = input;
  const logo = footerData?.logo || { src: "", alt: "" };
  const brandName = storeName || logo.alt || footerData?.copyrightText || "";
  const phoneHref = telHref(storePhone);
  const chatHref = whatsappHref(storePhone);
  const storeEmail = business?.email?.trim() || null;
  const storeAddress = [business?.addressLine1, business?.addressLine2, business?.city]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
  const description = footerData?.description || "";
  const { menus, inBottomRow } = placeTrackOrderLink(
    (footerData?.menus || []).map((menu): FooterNestedMenu => ({ ...menu, links: nestedFooterLinks(menu) })),
    "Track your order",
  );
  const linkedHrefs = new Set(menus.flatMap((menu) => menu.links.map((link) => (link.href ?? "").replace(/\/+$/, ""))));
  const policyLinks = policies
    .map((policy) => ({ title: policy.title, href: policy.path }))
    .filter((link) => !linkedHrefs.has(link.href));
  return {
    logo,
    brandName,
    storePhone,
    phoneHref,
    chatHref,
    storeEmail,
    storeAddress,
    hasContactDetails: Boolean(phoneHref || chatHref || storeEmail || storeAddress),
    tagline: footerData?.tagline || "",
    description,
    descriptionHtml: applyStorefrontPrefetchPolicyToHtml(optimizeRichContentImages(sanitizeHtml(description)), url),
    copyrightName: storeName || footerData?.copyrightText || "",
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
export function directoryLinks(menus: FooterNestedMenu[], max = 60): Array<{ title: string; links: FooterMenuLink[] }> {
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
