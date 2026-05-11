import { describe, expect, it, vi } from "vitest";
import {
  WidgetPlacementRule,
  WidgetPlacementScope,
  WidgetPlacementSlot,
} from "../../../../packages/database/src/schema";
import { getHomepageData } from "../../../../packages/core/src/modules/storefront/storefront.service";
import { createMockDb } from "../../../setup";

describe("homepage widget feed", () => {
  it("does not expose standalone widgets through consolidated homepage data", async () => {
    const db = createMockDb({
      selectResult: [
        {
          id: "homepage-widget",
          name: "Homepage",
          htmlContent: "<section>Homepage slot</section>",
          cssContent: "",
          aiContext: null,
          isActive: true,
          displayTarget: "homepage",
          placementRule: WidgetPlacementRule.STANDALONE,
          referenceCollectionId: null,
          sortOrder: 999,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
          placement: {
            id: "wpl_homepage-widget",
            widgetId: "homepage-widget",
            scope: WidgetPlacementScope.HOMEPAGE,
            scopeId: null,
            slot: WidgetPlacementSlot.TOP,
            anchorType: null,
            anchorId: null,
            sortOrder: 1,
            isActive: true,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          },
        },
      ],
    }) as any;
    const batchResults = [
      [
        {
          siteTitle: "Scalius",
          homepageTitle: "Home",
          homepageMetaDescription: "Homepage",
        },
      ],
      [],
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
