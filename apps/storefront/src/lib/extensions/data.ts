// What app components get, built from what the page already holds: the
// header and footer data from the layout read and the theme, a card from the
// same card model the core card uses, a component section's settings from
// the page's section data. The shapes are the versioned contract
// (@scalius/shared/plugins/storefront-protocol): additive only.

import type {
  StorefrontFieldValues,
  StorefrontFooterData,
  StorefrontHeaderData,
  StorefrontImage,
  StorefrontLink,
  StorefrontListingPage,
  StorefrontMenuItem,
  StorefrontMoney,
  StorefrontProductCard,
  StorefrontProductPage,
  StorefrontResolvedSettings,
  StorefrontSectionSkinData,
  StorefrontTile,
} from "@scalius/shared/plugins/storefront-protocol";
import {
  HOME_PRODUCT_LIST_LIMIT,
  homeSectionProductLists,
  resolveCoreSectionSettings,
  storefrontProductSourceKey,
  storefrontVisibleSection,
  type StorefrontSectionOf,
  type StorefrontSkinnableSectionType,
} from "@scalius/shared/storefront-theme";
import { resolveBuyerAvailabilityBand, type BuyerAvailabilityBand } from "@scalius/shared/buyer-availability";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { resolveStorefrontSettings, type StorefrontExtension } from "@scalius/shared/plugins/storefront-components";
import type { PluginSettingsSchema } from "@scalius/shared/plugins/settings-schema";
import { mediaImageSrcSet, mediaImageUrl } from "@scalius/shared/media-variants";
import type {
  CategoryNavigationNode,
  FooterMenu,
  NavigationItem,
  Product,
  ProductMedia,
  ProductOptionDefinition,
  ProductVariant,
  StorefrontCustomField,
} from "@/lib/api";
import type { StorefrontBusinessInfo } from "@/lib/commerce-structured-data";
import { productCardModel, type ProductCardModel, type ProductCardProduct } from "@/components/cards/card-model";
import { getProductImageSrcSet, getProductImageUrl } from "@/lib/product-media";
import { productGalleryItems } from "@/components/product/lib/gallery-media";
import { isVariantAvailable } from "@/lib/product-sellable-variants";
import { navigationFromCategoryTree, sourceNavigation, type NavigationSource } from "@/components/header/nav-tree";
import type { RequestTheme } from "@/lib/storefront-theme-context";
import {
  collectionShowsProducts,
  homepageBrandHref,
  homepageCollectionsFallback,
  homepageMedia,
  homepageSourceProducts,
  type HomepageContent,
  type HomepageHeaderLead,
} from "@/lib/homepage-sections";

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
export function productCardData(product: ProductCardProduct, model: ProductCardModel): StorefrontProductCard {
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

// ── Skins of the product page, listings and core sections ────────────────
//
// The projections a skin gets are built from exactly what the core renderer
// draws from (the page's batch data, the same card model and price engine),
// and only when a skin will draw: a page without skins builds none of this.

/** Cards for a list of products, through the core card model (market prices, photo renditions, quick-add rules). */
export function productCardsOf(
  products: readonly ProductCardProduct[],
  options: { currencySymbol: string; currencyCode: string; ratings: boolean },
): StorefrontProductCard[] {
  return products.map((product) => productCardData(product, productCardModel(product, { ...options, hoverImage: true })));
}

/** A resource's storefront-visible custom fields by `<namespace>.<key>`. */
export function storefrontFieldValues(fields: readonly StorefrontCustomField[] | null | undefined): StorefrontFieldValues {
  const values: StorefrontFieldValues = {};
  for (const field of fields ?? []) values[`${field.namespace}.${field.key}`] = field.value;
  return values;
}

const BAND_ORDER: readonly BuyerAvailabilityBand[] = ["in_stock", "untracked", "low_stock"];
const PRODUCT_PAGE_MEDIA_MAX = 20;
const PRODUCT_PAGE_VARIANTS_MAX = 100;

/** The product page's projection (`StorefrontProductPage`): what a product-main skin and product blocks get. */
export function productPageData(input: {
  product: Product;
  media: readonly ProductMedia[];
  /** The buyer's SKUs (`resolveBuyerVariants`), sold-out ones included. */
  variants: readonly ProductVariant[];
  options: readonly ProductOptionDefinition[];
  url: string;
  breadcrumbs: StorefrontLink[];
  /** The price the buy form opens on: current, regular (discounted when higher) and whether options price differently. */
  price: { current: number; regular: number; from: boolean };
  /** One SKU's buyer price (the page's price engine). */
  variantPrice: (variant: ProductVariant) => number;
  money: (amount: number) => string;
}): StorefrontProductPage {
  const { product, money } = input;
  const amount = (value: number): StorefrontMoney => ({ amount: value, formatted: money(value) });
  const compare = (current: number, regular: number) => (regular > current ? amount(regular) : null);
  const media = productGalleryItems(product, input.media).flatMap((item) => {
    const url = item.kind === "video" ? item.posterUrl : item.url;
    const source = input.media.find((each) => each.id === item.id);
    const image = url ? storefrontImageOf({ url, alt: item.altText, width: source?.width ?? null, height: source?.height ?? null }) : null;
    return image ? [image] : [];
  }).slice(0, PRODUCT_PAGE_MEDIA_MAX);
  const bands = input.variants.map((variant) => variant.availabilityBand ?? resolveBuyerAvailabilityBand(variant));
  const availability = BAND_ORDER.find((band) => bands.includes(band)) ?? "out_of_stock";
  const summary = product.reviews?.summary;
  const brand = product.brand?.name?.trim();
  return {
    product: {
      id: product.id,
      title: product.name,
      url: input.url,
      brand: brand && product.brand ? { title: brand, url: `/brands/${encodeURIComponent(product.brand.slug)}` } : null,
      descriptionHtml: product.description ? sanitizeHtml(product.description) : "",
      media,
      price: amount(input.price.current),
      compareAt: compare(input.price.current, input.price.regular),
      priceVaries: input.price.from,
      availability,
      rating: summary && summary.count > 0 ? { average: summary.average, count: summary.count } : null,
      options: input.options.map((option) => ({
        name: option.name,
        values: option.values.map((value) => ({ label: value.value, swatch: null })),
      })),
      variants: input.variants.slice(0, PRODUCT_PAGE_VARIANTS_MAX).map((variant) => {
        const price = input.variantPrice(variant);
        const image = variant.imageUrl ? storefrontImageOf({ url: variant.imageUrl, alt: product.name }) : null;
        return {
          id: variant.id,
          title: variant.selectedOptions.map((option) => option.value).join(" / ") || product.name,
          options: input.options.map((option) => variant.selectedOptions.find((each) => each.optionDefinitionId === option.id)?.value ?? ""),
          price: amount(price),
          compareAt: compare(price, variant.price ?? product.price),
          available: isVariantAvailable(variant),
          image,
        };
      }),
      fields: storefrontFieldValues(product.customFields),
      breadcrumbs: input.breadcrumbs,
    },
  };
}

/** A listing page's projection (`StorefrontListingPage`): what a listing-main skin gets. */
export function listingPageData(input: {
  kind: StorefrontListingPage["kind"];
  title: string;
  descriptionHtml: string | null;
  image: StorefrontImage | null;
  cards: StorefrontProductCard[];
  pagination: { page: number; totalPages: number; total: number; totalIsCapped?: boolean };
  breadcrumbs: ReadonlyArray<{ label: string; href: string }>;
  fields: StorefrontFieldValues;
}): StorefrontListingPage {
  return {
    kind: input.kind,
    title: input.title,
    descriptionHtml: input.descriptionHtml ? sanitizeHtml(input.descriptionHtml) : null,
    image: input.image,
    cards: input.cards,
    total: input.pagination.total,
    totalIsCapped: input.pagination.totalIsCapped === true,
    page: input.pagination.page,
    pageCount: input.pagination.totalPages,
    breadcrumbs: input.breadcrumbs.map((crumb) => ({ title: crumb.label, url: crumb.href })),
    fields: input.fields,
  };
}

/**
 * A core section's projection (`StorefrontSectionSkinData`): its settings
 * with references resolved from the page's section data by the fixed rules
 * (`resolveCoreSectionSettings`), each product source to as many cards as
 * the core section shows.
 */
export function coreSectionSkinData(
  section: StorefrontSectionOf<StorefrontSkinnableSectionType>,
  content: HomepageContent,
  money: { currencySymbol: string; currencyCode: string; ratings: boolean },
): StorefrontSectionSkinData {
  const shown = storefrontVisibleSection(section);
  const cards = (products: readonly unknown[]) => productCardsOf(products as ProductCardProduct[], money);
  const limits = new Map(homeSectionProductLists(shown).map((list) => [storefrontProductSourceKey(list.source), list.limit]));
  const settings = resolveCoreSectionSettings(shown, {
    image: (id) => storefrontImageOf(homepageMedia(content, id)),
    products: (source) => {
      const list = homepageSourceProducts(source, limits.get(storefrontProductSourceKey(source)) ?? HOME_PRODUCT_LIST_LIMIT, content);
      return { title: list?.title ?? "", url: list?.href ?? null, cards: list ? cards(list.products) : [] };
    },
    tiles: (kind, ids) => ids.flatMap((id): StorefrontTile[] => {
      if (kind === "category") {
        const category = content.categories.get(id);
        return category ? [{
          id,
          title: category.name,
          url: category.canonicalPath || `/categories/${encodeURIComponent(category.slug)}`,
          image: category.imageUrl ? storefrontImageOf({ url: category.imageUrl, alt: category.name }) : null,
          cards: [],
        }] : [];
      }
      const collection = content.collections.get(id);
      return collection && collectionShowsProducts(collection) ? [{
        id,
        title: collection.name,
        url: collection.canonicalPath || `/collections/${encodeURIComponent(collection.id)}`,
        image: null,
        cards: cards(collection.products ?? []),
      }] : [];
    }),
    promotion: (id) => {
      const endsAt = content.promotionEnds.get(id);
      return endsAt && Date.parse(endsAt) > Date.now() ? { endsAt } : null;
    },
    deliveryFacts: () => content.deliveryFacts.map((fact) => ({ title: fact.title, detail: fact.detail })),
  });
  return {
    type: shown.type,
    version: shown.version,
    settings: settings as Record<string, unknown>,
    tiles: shown.type === "brand-wall"
      ? content.brands.map((brand) => ({
        id: brand.id,
        title: brand.name,
        url: homepageBrandHref(brand),
        image: brand.logo ? storefrontImageOf({ ...brand.logo, alt: brand.logo.alt || brand.name }) : null,
        cards: [],
      }))
      : [],
    cards: shown.type === "collections" ? cards(homepageCollectionsFallback(shown, content)) : [],
  };
}
