/**
 * Product-page and listing choices that the redesign removed, read as the
 * choice that replaced them. A stored document that used one must still read
 * (see `withTightenedBounds` in upgrade.ts), so each retired id maps to the
 * current one here, with the settings that keep its arrangement. The strict
 * parse still rejects an unknown id on write.
 */
type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);

/** `classic`'s settings when none were stored (the pre-redesign classic buy box). */
const CLASSIC_DEFAULTS = { cta: "row", features: false, details: "buy-box", emi: false, whatsapp: false } as const;

/**
 * The eleven measured buy boxes as `classic` with settings. Their type scale,
 * button height and shape are gone (the theme tokens set them); what stays is
 * what changed the arrangement: stacked or side-by-side buttons, key features
 * in the box, the description in the box or below, the EMI line and contact links.
 */
const RETIRED_BUY_BOXES: Record<string, (settings: RecordValue) => RecordValue> = {
  spec: (settings) => ({ cta: "row", features: true, details: "below", emi: settings.emi !== false }),
  tech: (settings) => ({ cta: "stack", details: "below", emi: settings.emi !== false, whatsapp: settings.whatsapp !== false }),
  retail: () => ({ cta: "stack", features: true, details: "below" }),
  mall: () => ({ cta: "row", features: true, details: "below" }),
  essentials: () => ({ cta: "row", details: "below", whatsapp: true }),
  boutique: () => ({ cta: "stack" }),
  showcase: () => ({ cta: "stack", whatsapp: true }),
  fashion: () => ({ cta: "row" }),
  heritage: () => ({ cta: "stack" }),
  digital: () => ({ cta: "row", details: "below" }),
};

/** Buy boxes, phone bars and the like that the redesign removed, read as their replacements. Mutates `doc`. */
export function retireProductPageChoices(doc: RecordValue): void {
  const blocks = doc.blocks;
  if (!isRecord(blocks)) return;
  const product = blocks.product;
  if (isRecord(product) && isRecord(product.buyBox)) {
    const { variant, settings } = product.buyBox;
    const stored = isRecord(settings) ? settings : {};
    if (typeof variant === "string" && variant in RETIRED_BUY_BOXES) {
      product.buyBox = { variant: "classic", settings: { ...CLASSIC_DEFAULTS, ...RETIRED_BUY_BOXES[variant]!(stored) } };
    } else if (variant === "classic") {
      product.buyBox = { variant: "classic", settings: { ...CLASSIC_DEFAULTS, ...stored } };
    }
  }
  // "Frequently bought together" showed photos joined by "+" with no way to add them: the related products below carry the same pairings.
  if (isRecord(product) && Array.isArray(product.below)) {
    product.below = product.below.filter((module) => module !== "frequently-bought-together");
  }
  const listing = blocks.listing;
  // The bottom filter bar sat above the bottom tabs (two fixed bars); the standard bar replaces it.
  if (isRecord(listing) && listing.phoneBar === "bottom") listing.phoneBar = "standard";
}
