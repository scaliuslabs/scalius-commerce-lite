import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const actionBarSource = readFileSync(
  new URL("./ProductStickyHeader.tsx", import.meta.url),
  "utf8",
);
const variantManagerSource = readFileSync(
  new URL("./variants/VariantManager.tsx", import.meta.url),
  "utf8",
);
const productFormSource = readFileSync(
  new URL("../ProductForm.tsx", import.meta.url),
  "utf8",
);
const optionNamesSource = readFileSync(
  new URL("./OptionDiscoverySection.tsx", import.meta.url),
  "utf8",
);
const pricingSource = readFileSync(
  new URL("./PricingCard.tsx", import.meta.url),
  "utf8",
);
const mediaSource = readFileSync(
  new URL("./ProductImagesSection.tsx", import.meta.url),
  "utf8",
);
const gallerySource = readFileSync(
  new URL("../DraggableImageGallery.tsx", import.meta.url),
  "utf8",
);

describe("product editing workflow boundaries", () => {
  it("does not leave live navigation anchors active during product save", () => {
    expect(actionBarSource).toContain("isSubmitting ? (");
    expect(actionBarSource).toContain("<Link to={cancelUrl}>Discard</Link>");
    expect(actionBarSource).toContain('<Link to="/admin/products/new">');
    expect(actionBarSource).not.toMatch(
      /asChild\s+disabled=\{isSubmitting\}/,
    );
  });

  it("shows the create-another shortcut only with product create permission", () => {
    expect(actionBarSource).toContain(
      "isEdit && productActions.canCreate &&",
    );
  });

  it("guards add, edit, and bulk option drafts from navigation loss", () => {
    expect(variantManagerSource).toContain("const hasUnsavedVariantDrafts =");
    expect(variantManagerSource).toContain("isAnyRowEditing ||");
    expect(variantManagerSource).toContain("draftNewIds.length > 0");
    expect(variantManagerSource).toContain(
      "Object.keys(draftBulkUpdates).length > 0",
    );
    expect(variantManagerSource).toContain(
      "isDirty={hasUnsavedVariantDrafts}",
    );
  });

  it("keeps product composition in the main flow and the narrow rail operational", () => {
    const mediaIndex = productFormSource.indexOf("<ProductImagesSection");
    const pricingIndex = productFormSource.indexOf("<PricingCard");
    const optionNamesIndex = productFormSource.indexOf("<OptionDiscoverySection");
    const attributesIndex = productFormSource.indexOf("<AttributesSection");
    const seoIndex = productFormSource.indexOf("<SeoSection");
    const railIndex = productFormSource.indexOf("Right Column - Settings & Metadata");
    const statusIndex = productFormSource.indexOf("<StatusCard");
    const organizationIndex = productFormSource.indexOf("<OrganizationCard");

    expect(mediaIndex).toBeGreaterThan(-1);
    expect(mediaIndex).toBeLessThan(pricingIndex);
    expect(pricingIndex).toBeLessThan(optionNamesIndex);
    expect(optionNamesIndex).toBeLessThan(attributesIndex);
    expect(attributesIndex).toBeLessThan(seoIndex);
    expect(seoIndex).toBeLessThan(railIndex);
    expect(railIndex).toBeLessThan(statusIndex);
    expect(statusIndex).toBeLessThan(organizationIndex);
    expect(productFormSource.slice(railIndex)).not.toContain("<PricingCard");
    expect(productFormSource.slice(railIndex)).not.toContain("<SeoSection");
  });

  it("describes option labels as buyer-visible names rather than feed-only metadata", () => {
    expect(optionNamesSource).toContain('title="Option names"');
    expect(optionNamesSource).toContain("storefront, feeds, and structured data");
    expect(optionNamesSource).toContain("Option name");
    expect(optionNamesSource).not.toContain("feeds and ProductGroup JSON-LD only");
  });

  it("keeps media and pricing dense without hiding invalid secondary fields", () => {
    expect(mediaSource).toContain("Add media");
    expect(mediaSource).toContain("field.value.length > 0");
    expect(mediaSource).toContain("enableVariantImages ? (");
    expect(gallerySource).toContain("grid-cols-2 gap-2");
    expect(gallerySource).not.toContain("min-h-[5px]");

    expect(pricingSource).toContain('aria-controls="product-discount-fields"');
    expect(pricingSource).toContain("showDiscount || Boolean(discountErrors)");
    expect(pricingSource).toContain("Customer price");
    expect(pricingSource).toContain("discountSummary.effectivePrice");
  });
});
