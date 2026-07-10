import { describe, expect, it } from "vitest";

import {
  appendStorefrontAssistantCatalogReferences,
  splitStorefrontAssistantCatalogReferences,
} from "./storefront-assistant-references";

const FIRST = "gid://scalius/product/prod_first";
const SECOND = "gid://scalius/product/prod_second";

describe("storefront assistant catalog reference footer", () => {
  it("round-trips a bounded ordered public product reference list", () => {
    const content = appendStorefrontAssistantCatalogReferences(
      "Here are two current matches.",
      [FIRST, SECOND],
      2_000,
    );

    expect(splitStorefrontAssistantCatalogReferences(content)).toEqual({
      content: "Here are two current matches.",
      productIds: [FIRST, SECOND],
    });
  });

  it("fails closed on duplicate, malformed, embedded, or multiple footers", () => {
    for (const content of [
      `Answer\n[[scalius.catalog_refs.v1|${FIRST}|${FIRST}]]`,
      "Answer\n[[scalius.catalog_refs.v1|prod_private]]",
      `Answer [[scalius.catalog_refs.v1|${FIRST}]]`,
      `Answer\n[[scalius.catalog_refs.v1|${FIRST}]]\n[[scalius.catalog_refs.v1|${SECOND}]]`,
    ]) {
      expect(splitStorefrontAssistantCatalogReferences(content).productIds)
        .toEqual([]);
    }
  });

  it("reserves footer space instead of truncating product identity", () => {
    const content = appendStorefrontAssistantCatalogReferences(
      "x".repeat(2_000),
      [FIRST, SECOND],
      180,
    );

    expect(content.length).toBeLessThanOrEqual(180);
    expect(splitStorefrontAssistantCatalogReferences(content).productIds)
      .toEqual([FIRST, SECOND]);
  });
});
