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
const additionalInfoSource = readFileSync(
  new URL("./AdditionalInfoManager.tsx", import.meta.url),
  "utf8",
);
const selectSource = readFileSync(
  new URL("../../ui/select.tsx", import.meta.url),
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
    expect(attributesIndex).toBeLessThan(railIndex);
    expect(railIndex).toBeLessThan(statusIndex);
    expect(statusIndex).toBeLessThan(organizationIndex);
    expect(organizationIndex).toBeLessThan(seoIndex);
    expect(productFormSource.slice(railIndex)).not.toContain("<PricingCard");
    expect(productFormSource.slice(railIndex)).toContain("<SeoSection");
  });

  it("describes option labels as buyer-visible names rather than feed-only metadata", () => {
    expect(optionNamesSource).toContain('title="Product options"');
    expect(optionNamesSource).toContain("Choice axes");
    expect(optionNamesSource).toContain("Shape, Pack");
    expect(optionNamesSource).toContain("Option name");
    expect(optionNamesSource).toContain("Standard mapping");
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

  it("keeps option definitions with their variant editor and discovery visible in the rail", () => {
    expect(productFormSource).toContain('id="product-options"');
    expect(productFormSource).toContain("Define customer choices, then manage the sellable SKU combinations in one place.");
    expect(productFormSource).toContain("<OptionDiscoverySection form={form} embedded />");
    expect(productFormSource).toContain("{optionManager}");
    expect(productFormSource).toContain("<SeoSection");
    expect(productFormSource).toContain("defaultOpen={false}");
  });

  it("opens each newly added rich-text section and fixes shared select collision positioning", () => {
    expect(additionalInfoSource).toContain("setExpandedItemId(newItem.id)");
    expect(additionalInfoSource).toContain("expandedItemId === item.id");
    expect(additionalInfoSource).toContain("setExpandedItemId(expanded ? item.id : null)");
    expect(selectSource).toContain('position = "popper"');
    expect(selectSource).toContain('"relative z-[9999]');
    expect(selectSource).not.toContain('"fixed z-[9999]');
  });
});
