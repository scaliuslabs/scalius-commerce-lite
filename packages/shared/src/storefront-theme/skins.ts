// Skins (docs/STOREFRONT-COMPONENTS.md "Skins"): app markup for a core-owned
// unit. The theme names the skin (`apps.skins.<unit>`, or `skin` on a core
// section placement); the app draws the unit from its public projection, and
// core draws it whenever the skin is missing, fails or draws nothing.
//
// A core section's projection is sealed in the protocol
// (`StorefrontSectionSkinSettings[type]`, ../plugins/storefront-protocol.ts).
// This file is the one place the host maps core's settings to it: every
// reference resolved by the fixed rules below and renamed to what it holds,
// editor-only keys dropped. The compile-time check at the end fails when a
// core section's settings stop matching its projection; that type then gets
// an adapter in `CORE_SKIN_ADAPTERS`, so skins keep their input while core
// changes its own.

import {
  STOREFRONT_SECTION_SKIN_PREFIX,
  STOREFRONT_SECTION_SKIN_PROJECTIONS,
  STOREFRONT_SKIN_UNITS,
  type StorefrontDeliveryFacts,
  type StorefrontImage,
  type StorefrontObjectFieldView,
  type StorefrontProductList,
  type StorefrontPromotionEnd,
  type StorefrontSectionSkinSettings,
  type StorefrontSkinnableSection,
  type StorefrontSkinTarget,
  type StorefrontTile,
} from "../plugins/storefront-protocol";
import {
  storefrontProductSourceSchema,
  type StorefrontProductSource,
  type StorefrontSectionOf,
  type StorefrontSectionRenderer,
} from "./sections";

/**
 * Core section types a skin may draw (the protocol's projections): every
 * rendered type whose data is the page's own. Not the buyer's browsing
 * history (recently viewed), an endless feed whose next pages are core cards,
 * or content types (Objects arrive with their own projection).
 */
export const STOREFRONT_SKINNABLE_SECTION_TYPES = Object.keys(STOREFRONT_SECTION_SKIN_PROJECTIONS) as StorefrontSkinnableSection[];
export type StorefrontSkinnableSectionType = StorefrontSkinnableSection;
// Every projection names a section type the storefront renders.
const _rendered: StorefrontSectionRenderer = "" as StorefrontSkinnableSection;
void _rendered;

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

/** References and what each becomes: the key it is renamed to and how it resolves. */
const IMAGE_KEYS = { image: "image", phoneImage: "phoneImage", mediaId: "image" } as const;
const TILE_KEYS = { categoryIds: ["category", "categories"], collectionIds: ["collection", "collections"] } as const;
/** Keys only the editor reads: a block's hidden mark and its dynamic sources. */
const EDITOR_KEYS = new Set(["hidden", "bindings"]);

type ImageKey = keyof typeof IMAGE_KEYS;
type TileKey = keyof typeof TILE_KEYS;

/** The projection key a stored key becomes. */
type ProjectedKey<Key, Value> =
  Key extends ImageKey ? (typeof IMAGE_KEYS)[Key]
    : Key extends TileKey ? (typeof TILE_KEYS)[Key][1]
      : Key extends "promotionId" ? "promotion"
        : Key extends "objectField" ? "objectFields"
          : Key extends "source" ? ([Value] extends [StorefrontProductSource] ? "products" : "source")
            : Key;

/** A stored section value as the fixed rules project it (the type side of `coreSectionSkinSettings`). */
export type CoreSectionProjection<Value> =
  Value extends StorefrontProductSource ? StorefrontProductList
    : Value extends { kind: "delivery-facts" } ? StorefrontDeliveryFacts
      : Value extends ReadonlyArray<infer Item> ? Array<CoreSectionProjection<Item>>
        : Value extends object ? {
          [Key in keyof Value as Key extends "hidden" | "bindings" ? never : ProjectedKey<Key, Value[Key]>]:
          Key extends ImageKey ? StorefrontImage | null
            : Key extends TileKey ? StorefrontTile[]
              : Key extends "promotionId" ? StorefrontPromotionEnd | null
                : Key extends "objectField" ? StorefrontObjectFieldView[]
                  : CoreSectionProjection<Value[Key]>
        }
          : Value;

/** What resolving a section's references reads: lookups into the data the page already holds. */
export interface CoreSectionResolver {
  image(mediaId: string): StorefrontImage | null;
  products(source: StorefrontProductSource): StorefrontProductList;
  tiles(kind: "category" | "collection", ids: readonly string[]): StorefrontTile[];
  /** A running promotion's end; null when it has ended or is unknown. */
  promotion(promotionId: string): StorefrontPromotionEnd | null;
  deliveryFacts(): StorefrontDeliveryFacts["items"];
  objectField?(qualifiedKey: string): StorefrontObjectFieldView[];
}

function projectEntry(key: string, value: unknown, resolver: CoreSectionResolver): [string, unknown] {
  if (Object.hasOwn(IMAGE_KEYS, key)) {
    return [IMAGE_KEYS[key as ImageKey], typeof value === "string" && value ? resolver.image(value) : null];
  }
  if (Object.hasOwn(TILE_KEYS, key)) {
    const [kind, name] = TILE_KEYS[key as TileKey];
    const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    return [name, resolver.tiles(kind, ids)];
  }
  if (key === "promotionId") return ["promotion", typeof value === "string" && value ? resolver.promotion(value) : null];
  if (key === "objectField") return ["objectFields", typeof value === "string" && value ? resolver.objectField?.(value) ?? [] : []];
  if (key === "source" && storefrontProductSourceSchema.safeParse(value).success) return ["products", project(value, resolver)];
  return [key, project(value, resolver)];
}

function project(value: unknown, resolver: CoreSectionResolver): unknown {
  if (Array.isArray(value)) return value.map((item) => project(item, resolver));
  if (typeof value !== "object" || value === null) return value;
  if ((value as { kind?: unknown }).kind === "delivery-facts") return { kind: "delivery-facts", items: resolver.deliveryFacts() };
  const source = storefrontProductSourceSchema.safeParse(value);
  if (source.success) return resolver.products(source.data);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !EDITOR_KEYS.has(key))
    .map(([key, item]) => projectEntry(key, item, resolver)));
}

/** Core settings that no longer project by the fixed rules alone: one adapter per such type. */
const CORE_SKIN_ADAPTERS = {} satisfies {
  [Type in StorefrontSkinnableSection]?: (projected: CoreSectionProjection<StorefrontSectionOf<Type>["settings"]>) => StorefrontSectionSkinSettings[Type];
};

/**
 * A core section's projection for its skin (`StorefrontSectionSkinSettings[type]`):
 * a media id (`image`, `phoneImage`, `mediaId` as `image`) as an image or
 * null, a product source as its list (`source` as `products`),
 * `categoryIds` and `collectionIds` as tiles (`categories`, `collections`;
 * missing ones left out), a `promotionId` as its end (`promotion`), an object
 * field as its views (`objectFields`), a delivery-facts source as the store's
 * facts; `hidden` and `bindings` dropped. Pass the section through
 * `storefrontVisibleSection` first, so hidden blocks stay out.
 */
export function coreSectionSkinSettings<Type extends StorefrontSkinnableSection>(
  section: StorefrontSectionOf<Type>,
  resolver: CoreSectionResolver,
): StorefrontSectionSkinSettings[Type] {
  const projected = project((section as { settings: unknown }).settings, resolver);
  const adapter = (CORE_SKIN_ADAPTERS as Partial<Record<string, (value: unknown) => unknown>>)[(section as { type: string }).type];
  return (adapter ? adapter(projected) : projected) as StorefrontSectionSkinSettings[Type];
}

// ── The seal ───────────────────────────────────────────────────────────────
// Each type without an adapter must project exactly to its sealed shape.
// A compile error here means a core section's settings changed: extend the
// projection only additively (an optional field), or add an adapter above.

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Sealed = {
  [Type in StorefrontSkinnableSection]: Type extends keyof typeof CORE_SKIN_ADAPTERS
    ? true
    : Same<CoreSectionProjection<StorefrontSectionOf<Type>["settings"]>, StorefrontSectionSkinSettings[Type]>;
};
const _sealed: { [Type in StorefrontSkinnableSection]: true } = null as unknown as Sealed;
void _sealed;
