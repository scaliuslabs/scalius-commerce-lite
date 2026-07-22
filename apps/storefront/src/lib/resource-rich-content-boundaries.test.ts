import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontSourcePath } from "./test-source-paths";

const category = readFileSync(
  storefrontSourcePath("pages/categories/[slug].astro"),
  "utf8",
);
const collection = readFileSync(
  storefrontSourcePath("pages/collections/[id].astro"),
  "utf8",
);

describe("resource rich-content rendering boundaries", () => {
  it.each([category, collection])(
    "does not render empty editor documents as visible content",
    (source) => {
      expect(source).toContain("hasRenderableHtmlContent");
      expect(source).not.toMatch(/\?\.description && \(/);
      expect(source).not.toMatch(/\.content && !hasListingQuery/);
    },
  );

  it("keeps category introduction and editorial rendering media-aware", () => {
    expect(category).toContain(
      "hasRenderableHtmlContent(categoryDescription) &&",
    );
    expect(category).toContain("hasRenderableHtmlContent(categoryContent) &&");
  });

  it("keeps collection introduction and editorial rendering media-aware", () => {
    expect(collection).toContain(
      "hasRenderableHtmlContent(collectionDescription) &&",
    );
    expect(collection).toContain(
      "hasRenderableHtmlContent(collectionContent) &&",
    );
  });
});
