import { describe, expect, it } from "vitest";
import { getCategoryPublishReadiness } from "./categories.publication";

function readinessDb(row: Record<string, unknown> | undefined) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ get: async () => row }),
      }),
    }),
  };
}

describe("category publish readiness", () => {
  it("blocks publication without a buyer-resolvable assigned product", async () => {
    const readiness = await getCategoryPublishReadiness(readinessDb({
      imageUrl: null,
      description: null,
      metaDescription: null,
      eligibleProductCount: 0,
    }) as never, "cat_1");

    expect(readiness).toMatchObject({
      ready: false,
      eligibleProductCount: 0,
      blockers: [{ code: "no_buyer_resolvable_products" }],
    });
    expect(readiness?.warnings.map((warning) => warning.code)).toEqual([
      "missing_image",
      "missing_description",
      "missing_meta_description",
    ]);
  });

  it("treats optional merchandising copy as warnings, not blockers", async () => {
    const readiness = await getCategoryPublishReadiness(readinessDb({
      imageUrl: null,
      description: "Buyer copy",
      metaDescription: "Search copy",
      eligibleProductCount: 2,
    }) as never, "cat_1");

    expect(readiness).toMatchObject({
      ready: true,
      eligibleProductCount: 2,
      blockers: [],
      warnings: [{ code: "missing_image" }],
    });
  });
});
