import { describe, expect, it } from "vitest";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { DEFAULT_PRODUCT_CONDITION, productFormSchema, type ProductFormValues } from "./types";

const valid: ProductFormValues = {
  name: "Linen shirt",
  description: "A long enough description of the shirt.",
  price: 100,
  categoryId: "",
  isActive: false,
  discountType: "percentage",
  discountPercentage: 0,
  discountAmount: 0,
  freeDelivery: false,
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  salesChannelIds: null,
  productCondition: DEFAULT_PRODUCT_CONDITION,
  slug: "",
  media: [],
  slugEdited: false,
  variantPriced: false,
  attributes: [],
  additionalInfo: [],
  fulfillmentKind: "physical",
  isGiftCard: false,
  warrantyPolicyId: null,
  brandId: null,
  customizationSchema: [],
};

const messages = (values: Partial<ProductFormValues>) => {
  const result = productFormSchema.safeParse({ ...valid, ...values });
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
};

describe("product form checks", () => {
  it("takes a title of 1 to 255 characters", () => {
    expect(messages({ name: "" })[0]).toBe(`name: ${translate(productMessages, "titleRequired")}`);
    expect(messages({ name: "   " })[0]).toBe(`name: ${translate(productMessages, "titleRequired")}`);
    expect(messages({ name: "TV" })).toEqual([]);
    expect(messages({ name: "x".repeat(255) })).toEqual([]);
    expect(messages({ name: "x".repeat(256) })).toEqual([`name: ${translate(productMessages, "titleMax")}`]);
    expect(messages({})).toEqual([]);
  });

  it("takes a description of any length", () => {
    for (const value of [null, "", "<p></p>", "<p><br></p>", "<p>a</p>", "<p>Hi</p>"]) expect(messages({ description: value })).toEqual([]);
  });

  it("holds the save while the compare-at price can't be stored, with the reason", () => {
    expect(messages({ compareAtProblem: "notHigher" })).toEqual([`compareAtProblem: ${translate(productMessages, "compareAtNotHigher")}`]);
    expect(messages({ compareAtProblem: "invalid" })).toEqual([`compareAtProblem: ${translate(productMessages, "issueNotANumber")}`]);
    expect(messages({ compareAtProblem: null })).toEqual([]);
  });
});
