// Skins (docs/STOREFRONT-COMPONENTS.md "Skins"): app markup for a core-owned
// unit. The theme names the skin (`apps.skins.<unit>`, or `skin` on a core
// section placement); the app draws the unit from its public projection, and
// core draws it whenever the skin is missing, fails or draws nothing.
//
// A core section's projection is its settings at its version with every
// reference resolved by the fixed rules below, so a skin gets the same data
// the core section renders from and never names a read.

import {
  STOREFRONT_SECTION_SKIN_PREFIX,
  STOREFRONT_SKIN_UNITS,
  type StorefrontImage,
  type StorefrontProductList,
  type StorefrontSkinTarget,
  type StorefrontTile,
} from "../plugins/storefront-protocol";
import {
  STOREFRONT_SECTION_RENDERERS,
  storefrontProductSourceSchema,
  type StorefrontProductSource,
  type StorefrontSectionOf,
  type StorefrontSectionRenderer,
} from "./sections";

/**
 * Core section types a skin may draw: every rendered type whose data is the
 * page's own. Not the buyer's browsing history (recently viewed), an endless
 * feed whose next pages are core cards, or content types (Objects arrive
 * with their own projection).
 */
export const STOREFRONT_SKINNABLE_SECTION_TYPES = STOREFRONT_SECTION_RENDERERS.filter(
  (type) => type !== "recently-viewed" && type !== "endless-grid" && type !== "metaobjects",
) as Array<Exclude<StorefrontSectionRenderer, "recently-viewed" | "endless-grid" | "metaobjects">>;
export type StorefrontSkinnableSectionType = (typeof STOREFRONT_SKINNABLE_SECTION_TYPES)[number];

/** `section:<type>`: the skin target of a core section type. */
export function storefrontSectionSkinTarget(type: StorefrontSkinnableSectionType): `section:${StorefrontSkinnableSectionType}` {
  return `${STOREFRONT_SECTION_SKIN_PREFIX}${type}` as `section:${StorefrontSkinnableSectionType}`;
}

/** The core section type a `section:<type>` target names; null for a unit or anything else. */
export function storefrontSkinTargetSection(target: string): StorefrontSkinnableSectionType | null {
  if (!target.startsWith(STOREFRONT_SECTION_SKIN_PREFIX)) return null;
  const type = target.slice(STOREFRONT_SECTION_SKIN_PREFIX.length);
  return (STOREFRONT_SKINNABLE_SECTION_TYPES as readonly string[]).includes(type) ? type as StorefrontSkinnableSectionType : null;
}

/** Whether a value is a skin target: a fixed unit or a skinnable core section. */
export function isStorefrontSkinTarget(value: unknown): value is StorefrontSkinTarget {
  return typeof value === "string"
    && ((STOREFRONT_SKIN_UNITS as readonly string[]).includes(value) || storefrontSkinTargetSection(value) !== null);
}

// ── A core section's projection ────────────────────────────────────────────

const IMAGE_KEYS = new Set(["image", "phoneImage", "mediaId"]);
const TILE_KEYS = { categoryIds: "category", collectionIds: "collection" } as const;

/** A delivery-facts strip's facts, as the strip shows them. */
export interface CoreDeliveryFacts {
  kind: "delivery-facts";
  items: Array<{ title: string; detail: string }>;
}

type ImageKey = "image" | "phoneImage" | "mediaId";
type TileKey = keyof typeof TILE_KEYS;

/** A stored section value with its references resolved (the type side of `resolveCoreSectionSettings`). */
export type CoreSectionValue<Value> =
  Value extends StorefrontProductSource ? StorefrontProductList
    : Value extends { kind: "delivery-facts" } ? CoreDeliveryFacts
      : Value extends ReadonlyArray<infer Item> ? Array<CoreSectionValue<Item>>
        : Value extends object ? {
          [Key in keyof Value]: Key extends ImageKey ? StorefrontImage | null
            : Key extends TileKey ? StorefrontTile[]
              : Key extends "promotionId" ? { endsAt: string } | null
                : CoreSectionValue<Value[Key]>
        }
          : Value;

/** One core section type's settings as its skin gets them (`StorefrontSectionSkinData<CoreSectionSettings<"hero">>`). */
export type CoreSectionSettings<Type extends StorefrontSkinnableSectionType> = CoreSectionValue<StorefrontSectionOf<Type>["settings"]>;

/** What resolving a section's references reads: lookups into the data the page already holds. */
export interface CoreSectionResolver {
  image(mediaId: string): StorefrontImage | null;
  products(source: StorefrontProductSource): StorefrontProductList;
  tiles(kind: "category" | "collection", ids: readonly string[]): StorefrontTile[];
  /** A running promotion's end; null when it has ended or is unknown. */
  promotion(promotionId: string): { endsAt: string } | null;
  deliveryFacts(): CoreDeliveryFacts["items"];
}

function resolveValue(key: string | null, value: unknown, resolver: CoreSectionResolver): unknown {
  if (key !== null && IMAGE_KEYS.has(key)) return typeof value === "string" && value ? resolver.image(value) : null;
  if (key !== null && key in TILE_KEYS) {
    const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    return resolver.tiles(TILE_KEYS[key as TileKey], ids);
  }
  if (key === "promotionId") return typeof value === "string" && value ? resolver.promotion(value) : null;
  if (Array.isArray(value)) return value.map((item) => resolveValue(null, item, resolver));
  if (typeof value !== "object" || value === null) return value;
  if ((value as { kind?: unknown }).kind === "delivery-facts") return { kind: "delivery-facts", items: resolver.deliveryFacts() };
  const source = storefrontProductSourceSchema.safeParse(value);
  if (source.success) return resolver.products(source.data);
  return Object.fromEntries(Object.entries(value).map(([entry, item]) => [entry, resolveValue(entry, item, resolver)]));
}

/**
 * A section's settings with every reference resolved by the fixed rules: a
 * media id (`image`, `phoneImage`, `mediaId`) as an image or null, a product
 * source as its list, `categoryIds` and `collectionIds` as tiles (missing
 * ones left out), a `promotionId` as its end, a delivery-facts source as the
 * store's facts. Pass the section through `storefrontVisibleSection` first,
 * so hidden blocks stay out.
 */
export function resolveCoreSectionSettings<Type extends StorefrontSkinnableSectionType>(
  section: StorefrontSectionOf<Type>,
  resolver: CoreSectionResolver,
): CoreSectionSettings<Type> {
  return resolveValue(null, (section as { settings: unknown }).settings, resolver) as CoreSectionSettings<Type>;
}
