import { trimTrailingCharacter } from "@scalius/shared/text-scan";
/**
 * What every footer variant reads, computed once: the footer block's words
 * (tagline, about, the name after ©), the theme's footer logo, identity and
 * contact facts (Business settings), menus ("Track your order" placed), the
 * policy links no menu already carries, and social links. Variants choose
 * structure only.
 */
import type { FooterMenu, FooterMenuLink, SocialLink } from "@/lib/api";
import {
  buildStorefrontColorCss,
  storefrontThemeContrast,
  storefrontThemeShowsDarkColors,
  type StorefrontBrandAsset,
  type StorefrontThemeColors,
  type StorefrontThemeTokens,
} from "@scalius/shared/storefront-theme";
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
  /** The image dark pages show instead of the footer logo (`footerDarkPagesLogo`). */
  darkPagesLogo?: StorefrontBrandAsset | null;
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
  /**
   * The footer logo's image (`src` "" without one: the store name in text),
   * and the image dark pages show instead (`darkSrc`, "" for the same one):
   * set only where the footer's surface turns from light to dark, or dark to
   * light, with the dark colours (`footerDarkPagesLogo`).
   */
  logo: { src: string; darkSrc: string };
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

/** The surface a footer is painted on: its tone's colour (the marketplace directory wears the header's). */
export type FooterSurface = "secondary" | "muted" | "ink" | "header";

function surfaceIsDark(colors: StorefrontThemeColors, headerTone: StorefrontThemeTokens["headerTone"], surface: FooterSurface): boolean {
  const painted = buildStorefrontColorCss(colors, headerTone);
  const hex = surface === "ink" ? painted["theme-ink"]
    : surface === "header" ? painted["theme-header-background"]
    : surface === "muted" ? colors.muted
    : colors.secondary;
  return storefrontThemeContrast(hex, "#ffffff") > storefrontThemeContrast(hex, "#000000");
}

/**
 * The logo dark pages show in the footer instead of its footer logo, from
 * the surface the footer is actually painted on in each colour set: none
 * when that surface stays light or stays dark (the footer logo was chosen
 * for it), the logo for dark pages when it turns dark, and the header's logo
 * (made for light surfaces) when it turns light, as a header-tone footer
 * under a light brand colour can. Null when dark colours never show.
 */
export function footerDarkPagesLogo(
  tokens: Pick<StorefrontThemeTokens, "colors" | "darkColors" | "headerTone" | "colorScheme" | "colorSchemeToggle">,
  surface: FooterSurface,
  brand: { logo: StorefrontBrandAsset | null; darkLogo: StorefrontBrandAsset | null },
): StorefrontBrandAsset | null {
  if (!tokens.darkColors || !storefrontThemeShowsDarkColors(tokens)) return null;
  const light = surfaceIsDark(tokens.colors, tokens.headerTone, surface);
  const dark = surfaceIsDark(tokens.darkColors, tokens.headerTone, surface);
  if (light === dark) return null;
  return dark ? brand.darkLogo : brand.logo;
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
  const linkedHrefs = new Set(menus.flatMap((menu) => menu.links.map((link) => trimTrailingCharacter((link.href ?? ""), "/"))));
  const policyLinks = policies
    .map((policy) => ({ title: policy.title, href: policy.path }))
    .filter((link) => !linkedHrefs.has(link.href));
  return {
    logo: { src: logo?.url ?? "", darkSrc: logo && input.darkPagesLogo && input.darkPagesLogo.url !== logo.url ? input.darkPagesLogo.url : "" },
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
    copyrightName: trimTrailingCharacter((words.copyright || brandName), "."),
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
