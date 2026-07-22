import { describe, expect, it } from "vitest";
import type { PageFormValues } from "./form-schemas";
import { toCreatePageInput, toUpdatePageInput } from "./page-form-input";

function values(
  contentType: PageFormValues["contentType"],
): PageFormValues {
  return {
    contentType,
    title: "Returns",
    slug: "returns",
    content: "<p>Policy</p>",
    excerpt: contentType === "article" ? "Summary" : null,
    author: contentType === "article" ? "Scalius" : null,
    tags: contentType === "article" ? ["Guide"] : [],
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
  };
}

describe("page form mutation serialization", () => {
  it("uses explicit empty article metadata when creating a static page", () => {
    expect(toCreatePageInput(values("page"))).toMatchObject({
      contentType: "page",
      excerpt: null,
      author: null,
      tags: [],
    });
  });

  it("omits immutable and article-only fields when updating a static page", () => {
    const input = toUpdatePageInput(values("page"));
    expect(input).not.toHaveProperty("contentType");
    expect(input).not.toHaveProperty("excerpt");
    expect(input).not.toHaveProperty("author");
    expect(input).not.toHaveProperty("tags");
  });

  it("keeps article metadata when updating an article", () => {
    expect(toUpdatePageInput(values("article"))).toMatchObject({
      excerpt: "Summary",
      author: "Scalius",
      tags: ["Guide"],
    });
  });
});
