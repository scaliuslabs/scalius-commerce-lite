import { describe, expect, it } from "vitest";
import {
  AI_CONTEXT_LIMITS,
  appendUniqueWithinLimit,
  getEffectiveImageLimit,
  uniqueByLimit,
} from "../../../apps/admin-v2/src/components/admin/widgets/widget-form/ai-context-limits";
import { toSelectableProducts } from "../../../apps/admin-v2/src/components/admin/widgets/widget-form/ai-product-selector";

describe("widget AI context limits", () => {
  it("uses the lower of model and API image limits", () => {
    expect(getEffectiveImageLimit("anthropic/claude-sonnet-4")).toBe(
      AI_CONTEXT_LIMITS.maxImages,
    );
    expect(getEffectiveImageLimit("google/gemini-2.5-pro")).toBe(
      AI_CONTEXT_LIMITS.maxImages,
    );
    expect(getEffectiveImageLimit("openai/gpt-4o")).toBe(
      AI_CONTEXT_LIMITS.maxImages,
    );
  });

  it("deduplicates and clamps saved context", () => {
    const items = Array.from({ length: AI_CONTEXT_LIMITS.maxProducts + 5 }, (_, index) => ({
      id: `prod_${index < 2 ? 1 : index}`,
    }));

    const result = uniqueByLimit(
      items,
      (item) => item.id,
      AI_CONTEXT_LIMITS.maxProducts,
    );

    expect(result).toHaveLength(AI_CONTEXT_LIMITS.maxProducts);
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
  });

  it("reports skipped items when appending beyond a limit", () => {
    const current = [{ id: "prod_1" }, { id: "prod_2" }];
    const incoming = [{ id: "prod_2" }, { id: "prod_3" }, { id: "prod_4" }];

    const result = appendUniqueWithinLimit(current, incoming, (item) => item.id, 3);

    expect(result.next.map((item) => item.id)).toEqual([
      "prod_1",
      "prod_2",
      "prod_3",
    ]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("keeps inactive products out of AI context selector results", () => {
    const products = toSelectableProducts([
      {
        id: "prod_active",
        name: "Active",
        slug: "active",
        price: 100,
        isActive: true,
        primaryImage: "https://cloud.scalius.com/active.webp",
      },
      {
        id: "prod_inactive",
        name: "Inactive",
        slug: "inactive",
        price: 100,
        isActive: false,
        primaryImage: "https://cloud.scalius.com/inactive.webp",
      },
      {
        id: "prod_unspecified",
        name: "Unspecified",
        slug: "unspecified",
        primaryImage: null,
      },
    ]);

    expect(products.map((product) => product.id)).toEqual([
      "prod_active",
      "prod_unspecified",
    ]);
  });
});
