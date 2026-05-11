import { describe, expect, it, vi } from "vitest";
import { WidgetPlacementRule } from "../../../../packages/database/src/schema";
import { getHomepageData } from "../../../../packages/core/src/modules/storefront/storefront.service";
import { createMockDb } from "../../../setup";

describe("homepage widget feed", () => {
  it("does not expose standalone widgets through consolidated homepage data", async () => {
    const db = createMockDb() as any;
    const batchResults = [
      [
        {
          siteTitle: "Scalius",
          homepageTitle: "Home",
          homepageMetaDescription: "Homepage",
        },
      ],
      [],
      [
        {
          id: "standalone-widget",
          name: "Standalone",
          htmlContent: "<section>Manual embed only</section>",
          cssContent: "",
          isActive: true,
          displayTarget: "homepage",
          placementRule: WidgetPlacementRule.STANDALONE,
          referenceCollectionId: null,
          sortOrder: 0,
        },
        {
          id: "homepage-widget",
          name: "Homepage",
          htmlContent: "<section>Homepage slot</section>",
          cssContent: "",
          isActive: true,
          displayTarget: "homepage",
          placementRule: WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
          referenceCollectionId: null,
          sortOrder: 1,
        },
      ],
      [],
    ];
    let batchCall = 0;
    db.batch = vi.fn(async () => {
      batchCall += 1;
      return batchCall === 1 ? batchResults : [[], [], [], []];
    });

    const homepage = await getHomepageData(db);

    expect(homepage.widgets).toHaveLength(1);
    expect(homepage.widgets[0]).toMatchObject({
      id: "homepage-widget",
      placementRule: WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
    });
  });
});
