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

describe("page validation", () => {
  it("accepts a featured image when creating a page", () => {
    const parsed = createPageSchema.parse({
      title: "Combo Offer",
      slug: "combo-offer",
      content: "<p>Offer details</p>",
      metaTitle: null,
      metaDescription: null,
      isPublished: true,
      sortOrder: 0,
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
    const parsed = updatePageSchema.parse({ featuredImage: null });

    expect(parsed).toEqual({ featuredImage: null });
  });
});
