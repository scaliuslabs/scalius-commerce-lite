import { describe, expect, it } from "vitest";
import { createPageSchema, updatePageSchema } from "./pages.validation";

const featuredImage = {
  id: "media_123",
  url: "https://cloud.scalius.com/pages/combo-offer.webp",
  filename: "combo-offer.webp",
  size: 12345,
  mimeType: "image/webp",
  altText: "Combo offer",
  width: 1200,
  height: 630,
  createdAt: "2026-05-11T00:00:00.000Z",
};

const pageInput = {
  title: "Return Policy",
  slug: "returns",
  content: "<p>Return policy details.</p>",
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  isPublished: true,
  hideHeader: false,
  hideFooter: false,
  hideTitle: false,
  featuredImage: null,
};

describe("page validation", () => {
  it("creates pages as drafts by default", () => {
    const parsed = createPageSchema.parse({
      title: "Draft Page",
      slug: "draft-page",
      content: "<p>Draft content</p>",
      metaTitle: null,
      metaDescription: null,
      hideHeader: false,
      hideFooter: false,
      hideTitle: false,
    });

    expect(parsed.isPublished).toBe(false);
    expect(parsed.contentType).toBe("page");
    expect(parsed.tags).toEqual([]);
  });

  it("accepts a featured image when creating a page", () => {
    const parsed = createPageSchema.parse({
      title: "Combo Offer",
      slug: "combo-offer",
      content: "<p>Offer details</p>",
      metaTitle: null,
      metaDescription: null,
      isPublished: true,
      hideHeader: false,
      hideFooter: false,
      hideTitle: false,
      featuredImage,
    });

    expect(parsed.featuredImage).toMatchObject({
      id: featuredImage.id,
      url: featuredImage.url,
      altText: featuredImage.altText,
    });
  });

  it("allows featured image removal when updating a page", () => {
    const parsed = updatePageSchema.parse({
      expectedRevision: 1,
      featuredImage: null,
    });

    expect(parsed).toEqual({ expectedRevision: 1, featuredImage: null });
  });

  it("does not clear canonical path on unrelated partial updates", () => {
    const parsed = updatePageSchema.parse({
      expectedRevision: 3,
      title: "Updated Offer",
    });

    expect(parsed).toEqual({ expectedRevision: 3, title: "Updated Offer" });
  });

  it("accepts single-segment page canonical overrides", () => {
    const parsed = createPageSchema.parse({
      ...pageInput,
      canonicalPath: " /returns ",
    });

    expect(parsed.canonicalPath).toBe("/returns");
  });

  it("rejects multi-segment and reserved page canonical overrides", () => {
    for (const canonicalPath of [
      "/company/about",
      "/products",
      "/categories",
      "/collections",
      "/api",
      "/buy",
      "/blog",
      "/health",
      "/order-success",
      "/payment-recovery",
      "/sitemap.xml",
      "/robots.txt",
      "/search",
      "/cart",
      "/checkout",
      "/account",
      "/admin",
    ]) {
      expect(
        createPageSchema.safeParse({
          ...pageInput,
          canonicalPath,
        }).success,
        canonicalPath,
      ).toBe(false);
    }
  });

  it("rejects reserved storefront slugs", () => {
    for (const slug of [
      "account",
      "admin",
      "api",
      "blog",
      "buy",
      "cart",
      "categories",
      "checkout",
      "collections",
      "health",
      "products",
      "search",
    ]) {
      expect(
        createPageSchema.safeParse({ ...pageInput, slug }).success,
        slug,
      ).toBe(false);
    }
  });

  it("accepts article metadata and only article-shaped canonical paths", () => {
    const parsed = createPageSchema.parse({
      ...pageInput,
      contentType: "article",
      slug: "choose-running-shoes",
      canonicalPath: " /blog/choose-running-shoes ",
      excerpt: "A practical guide to fit, cushioning, and daily mileage.",
      author: "Scalius Editorial",
      tags: ["Guides", "running", "guides"],
    });

    expect(parsed.canonicalPath).toBe("/blog/choose-running-shoes");
    expect(parsed.tags).toEqual(["Guides", "running"]);
    expect(
      createPageSchema.safeParse({
        ...pageInput,
        contentType: "article",
        canonicalPath: "/choose-running-shoes",
      }).success,
    ).toBe(false);
  });

  it("keeps article-only metadata off static pages", () => {
    expect(
      createPageSchema.safeParse({
        ...pageInput,
        excerpt: "This belongs to an article.",
      }).success,
    ).toBe(false);
  });

  it("requires a positive expected revision on updates", () => {
    expect(updatePageSchema.safeParse({ title: "Updated Offer" }).success).toBe(
      false,
    );
    expect(
      updatePageSchema.safeParse({
        expectedRevision: 0,
        title: "Updated Offer",
      }).success,
    ).toBe(false);
    expect(
      updatePageSchema.safeParse({
        expectedRevision: 1,
        title: "Updated Offer",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid publication timestamps at the API boundary", () => {
    expect(
      createPageSchema.safeParse({
        ...pageInput,
        publishedAt: "not-a-date",
      }).success,
    ).toBe(false);
    expect(
      updatePageSchema.safeParse({
        expectedRevision: 1,
        publishedAt: "not-a-date",
      }).success,
    ).toBe(false);
  });
});
