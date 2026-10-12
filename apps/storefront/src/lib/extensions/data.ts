// What app components get, built from what the page already holds: the
// header and footer data from the layout read and the theme, a card from the
// same card model the core card uses, a component section's settings from
// the page's section data. The shapes are the versioned contract
// (@scalius/shared/plugins/storefront-protocol): additive only.

import type {
  StorefrontFooterData,
  StorefrontHeaderData,
  StorefrontImage,
  StorefrontMenuItem,
  StorefrontProductCard,
  StorefrontResolvedSettings,
} from "@scalius/shared/plugins/storefront-protocol";
import { resolveStorefrontSettings, type StorefrontExtension } from "@scalius/shared/plugins/storefront-components";
import type { PluginSettingsSchema } from "@scalius/shared/plugins/settings-schema";
import { mediaImageSrcSet, mediaImageUrl } from "@scalius/shared/media-variants";
import type { CategoryNavigationNode, FooterMenu, NavigationItem } from "@/lib/api";
import type { StorefrontBusinessInfo } from "@/lib/commerce-structured-data";
import type { ProductCardModel, ProductCardProduct } from "@/components/cards/card-model";
import { getProductImageSrcSet, getProductImageUrl } from "@/lib/product-media";
import { navigationFromCategoryTree, sourceNavigation, type NavigationSource } from "@/components/header/nav-tree";
import type { RequestTheme } from "@/lib/storefront-theme-context";
import type { HomepageHeaderLead } from "@/lib/homepage-sections";

/** Three levels at most, store paths or https links only. */
function menuItems(items: readonly NavigationItem[] | undefined, depth = 1): StorefrontMenuItem[] {
  if (!items || depth > 3) return [];
  return items.flatMap((item) => {
    const url = item.href?.trim() ?? "";
    if (!item.title?.trim() || (url && !/^(?:\/(?!\/)|https:\/\/)/.test(url))) return [];
    return [{ title: item.title.trim(), url: url || "#", children: menuItems(item.subMenu, depth + 1) }];
  });
}

/** An image from the media library: its URL, renditions and size. */
export function storefrontImageOf(asset: { url: string; alt?: string | null; width?: number | null; height?: number | null } | null | undefined): StorefrontImage | null {
  if (!asset?.url) return null;
  const srcset = mediaImageSrcSet(asset.url) || null;
  return {
    url: srcset ? mediaImageUrl(asset.url, 1200) || asset.url : asset.url,
    srcset,
    width: asset.width ?? null,
    height: asset.height ?? null,
    alt: asset.alt?.trim() ?? "",
  };
}

export function headerData(input: {
  theme: RequestTheme;
  storeName: string | null;
  navigation: readonly NavigationItem[];
  categoryTree: { nodes: CategoryNavigationNode[] } | null | undefined;
  page?: StorefrontHeaderData["page"];
}): StorefrontHeaderData {
  const { resolved, brand } = input.theme;
  const nodes = input.categoryTree?.nodes ?? [];
  const topBar = resolved.blocks.topBar;
  const settings = topBar.settings as { text?: unknown; link?: unknown };
  const text = topBar.variant !== "none" && typeof settings.text === "string" ? settings.text.trim() : "";
  return {
    store: {
      name: input.storeName?.trim() || "Store",
      url: "/",
      logo: storefrontImageOf(brand.logo ? { ...brand.logo, alt: brand.logo.alt || input.storeName } : null),
      logoWidth: resolved.brand.logoWidth,
    },
    menu: menuItems(sourceNavigation(resolved.blocks.navigation.source as NavigationSource, input.navigation, nodes)),
    categories: menuItems(navigationFromCategoryTree(nodes)),
    announcement: text ? { text, url: typeof settings.link === "string" && settings.link ? settings.link : null } : null,
    routes: { home: "/", search: "/search", cart: "/cart", account: "/account" },
    searchParam: "q",
    ...(input.page !== undefined ? { page: input.page } : {}),
  };
}

/** No reads: a header sees only its own lead section's normalized settings and resolved media. */
export function headerPageData(lead: HomepageHeaderLead, extension: StorefrontExtension): NonNullable<StorefrontHeaderData["page"]> {
  if (!lead || lead.kind === "core") return { lead };
  const { pluginId, type, instanceId } = lead;
  const schema = pluginId === extension.pluginId && extension.sections.includes(type)
    ? extension.sectionSettings[type]
    : undefined;
  const media = new Map(lead.media.flatMap((asset) => {
    const image = storefrontImageOf(asset);
    return image ? [[asset.id, image] as const] : [];
  }));
  return {
    lead: {
      kind: "app", pluginId, type, instanceId,
      ...(schema ? { settings: componentSectionSettings(schema, lead.values, media, new Map()) } : {}),
    },
  };
}

const SOCIAL_NETWORKS = ["facebook", "instagram", "youtube", "tiktok", "twitter", "x", "linkedin", "pinterest", "whatsapp", "telegram", "messenger", "threads"];

export function footerData(input: {
  theme: RequestTheme;
  storeName: string | null;
  storePhone: string | null;
  menus: readonly FooterMenu[];
  policies: ReadonlyArray<{ title: string; path: string }>;
  business: StorefrontBusinessInfo | null | undefined;
  social: ReadonlyArray<{ label: string; url: string }>;
}): StorefrontFooterData {
  const { resolved, brand } = input.theme;
  const business = input.business ?? {};
  const address = [business.addressLine1, business.addressLine2, business.city, business.postalCode]
    .map((part) => part?.trim()).filter(Boolean).join(", ");
  return {
    store: {
      name: input.storeName?.trim() || "Store",
      url: "/",
      logo: storefrontImageOf(brand.logo),
      logoWidth: resolved.brand.logoWidth,
      footerLogo: storefrontImageOf(brand.footerLogo ?? brand.logo),
      phone: input.storePhone?.trim() || null,
      email: business.email?.trim() || null,
      address: address || null,
      social: input.social.flatMap((link) => {
        if (!/^https:\/\//.test(link.url)) return [];
        const label = link.label.toLowerCase();
        const host = (() => { try { return new URL(link.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
        const network = SOCIAL_NETWORKS.find((name) => label.includes(name) || host.startsWith(`${name}.`)) ?? label.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return [{ network: network || "link", url: link.url }];
      }),
    },
    menus: input.menus.map((menu) => ({ title: menu.title, items: menuItems(menu.links) })).filter((menu) => menu.items.length > 0),
    policies: input.policies.filter((policy) => policy.path.startsWith("/")).map((policy) => ({ title: policy.title, url: policy.path })),
    newsletter: true,
    routes: { home: "/", newsletter: "/newsletter" },
    year: new Date().getUTCFullYear(),
  };
}

/** A product as an app card gets it, from the core card model (same prices, photo and quick-add rules). */
export function productCardData(product: ProductCardProduct, model: ProductCardModel, currency: { symbol: string; code: string }): StorefrontProductCard {
  void currency;
  const discounted = model.price.regular !== null;
  const percent = discounted && product.price > 0 ? Math.round((1 - product.discountedPrice / product.price) * 100) : 0;
  const image = model.image
    ? { url: model.image.src, srcset: model.image.srcset ?? null, width: null, height: null, alt: model.image.alt }
    : null;
  const hover = model.hoverImage
    ? { url: getProductImageUrl(model.hoverImage.url, 480), srcset: getProductImageSrcSet(model.hoverImage.url) ?? null, width: null, height: null, alt: "" }
    : null;
  const facts = [...model.facts.keySpecs, ...(model.facts.packSize ? [model.facts.packSize] : []), ...(model.condition ? [model.condition] : [])];
  return {
    id: product.id,
    title: product.name,
    url: product.canonicalPath?.startsWith("/") ? product.canonicalPath : model.href,
    price: { amount: product.discountedPrice, formatted: model.price.current },
    compareAt: discounted ? { amount: product.price, formatted: model.price.regular! } : null,
    priceVaries: model.price.from,
    percentOff: percent > 0 ? percent : null,
    image,
    hoverImage: hover,
    soldOut: model.soldOut,
    rating: model.facts.rating,
    quickAdd: model.quickAddEligible,
    needsOptions: model.needsOptions,
    facts,
  };
}

/** A component section's settings, from the section data the page read for it. */
export function componentSectionSettings(
  schema: PluginSettingsSchema,
  values: unknown,
  media: ReadonlyMap<string, StorefrontImage>,
  products: ReadonlyMap<string, StorefrontProductCard[]>,
): StorefrontResolvedSettings {
  return resolveStorefrontSettings(schema, values, {
    image: (id) => media.get(id) ?? null,
    products: (source) => products.get(source) ?? [],
  });
}
