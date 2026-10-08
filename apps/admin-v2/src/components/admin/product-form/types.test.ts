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
  it("says an empty title can't be blank, then asks for three characters", () => {
    expect(messages({ name: "" })[0]).toBe(`name: ${translate(productMessages, "titleRequired")}`);
    expect(messages({ name: "ab" })).toEqual([`name: ${translate(productMessages, "titleMin")}`]);
    expect(messages({})).toEqual([]);
  });

  it("accepts an empty description in every form the editor writes, and still asks for ten characters of text", () => {
    for (const empty of [null, "", "<p></p>", "<p></p><p></p>", "<p><br></p>"]) expect(messages({ description: empty })).toEqual([]);
    expect(messages({ description: "<p>Too short</p>" })).toEqual([]);
    expect(messages({ description: "<p>a</p>" })).toEqual([`description: ${translate(productMessages, "descriptionMin")}`]);
  });

  it("holds the save while the compare-at price can't be stored, with the reason", () => {
    expect(messages({ compareAtProblem: "notHigher" })).toEqual([`compareAtProblem: ${translate(productMessages, "compareAtNotHigher")}`]);
    expect(messages({ compareAtProblem: "invalid" })).toEqual([`compareAtProblem: ${translate(productMessages, "issueNotANumber")}`]);
    expect(messages({ compareAtProblem: null })).toEqual([]);
  });
});
