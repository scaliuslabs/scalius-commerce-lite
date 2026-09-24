import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "~/i18n";
import {
  categoryFormSchema,
  customerFormSchema,
  pageFormSchema,
} from "./form-schemas";

const category = {
  status: "draft",
  name: "Eid panjabi",
  description: null,
  content: null,
  slug: "eid-panjabi",
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  image: null,
} as const;

const page = {
  contentType: "page",
  title: "About us",
  slug: "about-us",
  content: "<p>Hello</p>",
  excerpt: null,
  author: null,
  tags: [],
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  publicationMode: "draft",
  publishedAt: null,
  hideHeader: false,
  hideFooter: false,
  hideTitle: false,
  featuredImage: null,
} as const;

function errorsOf(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message]),
  );
}

describe("resource form addresses", () => {
  afterEach(() => setLocale("en"));

  it("accepts a category's own address as its main address and nothing else", () => {
    expect(categoryFormSchema.safeParse({ ...category, canonicalPath: "/categories/eid-panjabi" }).success).toBe(true);
    expect(
      errorsOf(categoryFormSchema.safeParse({ ...category, canonicalPath: "/categories/summer" })),
    ).toEqual({ canonicalPath: "Use this item's own web address." });
  });

  it("accepts a page or blog post's own address as its main address and nothing else", () => {
    expect(pageFormSchema.safeParse({ ...page, canonicalPath: "/about-us" }).success).toBe(true);
    expect(errorsOf(pageFormSchema.safeParse({ ...page, canonicalPath: "/returns" }))).toEqual({
      canonicalPath: "Use this item's own web address.",
    });
    const post = { ...page, contentType: "article", slug: "size-guide" } as const;
    expect(pageFormSchema.safeParse({ ...post, canonicalPath: "/blog/size-guide" }).success).toBe(true);
    expect(errorsOf(pageFormSchema.safeParse({ ...post, canonicalPath: "/size-guide" }))).toEqual({
      canonicalPath: "Use this item's own web address.",
    });
  });

  it("refuses page addresses the storefront owns", () => {
    expect(errorsOf(pageFormSchema.safeParse({ ...page, slug: "checkout" }))).toEqual({
      slug: "This web address is used by the store. Try another.",
    });
  });

  it("lets a new item leave its address to the server, but not a saved one", () => {
    expect(categoryFormSchema.safeParse({ ...category, slug: "" }).success).toBe(true);
    expect(pageFormSchema.safeParse({ ...page, title: "Cart", slug: "" }).success).toBe(true);
    expect(errorsOf(categoryFormSchema.safeParse({ ...category, id: "cat_1", slug: "" }))).toEqual({
      slug: "Use 3 to 100 characters for the web address.",
    });
    expect(errorsOf(pageFormSchema.safeParse({ ...page, id: "page_1", slug: "" }))).toEqual({
      slug: "Use 3 to 100 characters for the web address.",
    });
    expect(errorsOf(categoryFormSchema.safeParse({ ...category, slug: "ab" }))).toEqual({
      slug: "Use 3 to 100 characters for the web address.",
    });
  });

  it("explains a malformed address in the merchant's language", () => {
    expect(errorsOf(categoryFormSchema.safeParse({ ...category, slug: "Eid Panjabi" }))).toEqual({
      slug: "Use lowercase letters, numbers and dashes, e.g. summer-sale.",
    });
    setLocale("bn");
    expect(errorsOf(categoryFormSchema.safeParse({ ...category, slug: "Eid Panjabi" }))).toEqual({
      slug: "ছোট হাতের ইংরেজি অক্ষর, সংখ্যা ও ড্যাশ দিন, যেমন summer-sale।",
    });
  });
});

describe("customer form phone validation", () => {
  const customer = {
    name: "Rahim Uddin",
    email: null,
    address: null,
    city: null,
    zone: null,
    area: null,
  };

  it("accepts a Bangladeshi mobile number and refuses a short one", () => {
    expect(errorsOf(customerFormSchema.safeParse({ ...customer, phone: "+8801712345678" }))).toEqual({});
    expect(errorsOf(customerFormSchema.safeParse({ ...customer, phone: "123" }))).toHaveProperty("phone");
  });
});
