import { describe, expect, it, vi } from "vitest";
import {
  WidgetPlacementRule,
  WidgetPlacementScope,
  WidgetPlacementSlot,
} from "../../../../packages/database/src/schema";
import {
  getHomepageData,
  getPageRenderData,
} from "../../../../packages/core/src/modules/storefront/storefront.service";
import { getActiveWidgetById } from "../../../../packages/core/src/modules/widgets/widgets.service";
import { createMockDb } from "../../../setup";

function createQueuedSelectDb(results: unknown[]) {
  const queue = [...results];
  const calls: string[] = [];

  const chainable = (result: unknown) => {
    const chain: Record<string, (...args: unknown[]) => unknown> & {
      get?: () => unknown;
      then?: (resolve: (value: unknown) => void) => Promise<void>;
    } = {};
    for (const method of [
      "from",
      "where",
      "orderBy",
      "limit",
      "offset",
      "innerJoin",
      "leftJoin",
    ]) {
      chain[method] = () => {
        calls.push(method);
        return chain;
      };
    }
    chain.get = () => {
      calls.push("get");
      return result ?? null;
    };
    chain.then = (resolve: (value: unknown) => void) => {
      const value = Array.isArray(result) ? result : result ? [result] : [];
      return Promise.resolve(value).then(resolve);
    };
    return chain;
  };

  return {
    select: vi.fn(() => chainable(queue.shift())),
    _calls: calls,
  };
}

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
          metadata: { internal: true },
          history: [{ prompt: "secret" }],
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
    expect(homepage.widgets[0]).not.toHaveProperty("aiContext");
    expect(homepage.widgets[0]).not.toHaveProperty("metadata");
    expect(homepage.widgets[0]).not.toHaveProperty("history");
    expect(homepage.widgets[0]).not.toHaveProperty("placement");
    expect(homepage.widgets[0]?.placements?.[0]).toEqual({
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
    });
  });

  it("strips authoring context from the public single-widget endpoint service", async () => {
    const widget = {
      id: "wid_public",
      name: "Public Widget",
      htmlContent: "<section onclick='alert(1)'>Hello</section>",
      cssContent: ".x { color: red; }",
      aiContext: JSON.stringify({ prompt: "secret merchant prompt" }),
      metadata: { internal: true },
      isActive: true,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.STANDALONE,
      referenceCollectionId: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    const placement = {
      id: "wpl_public",
      widgetId: "wid_public",
      scope: WidgetPlacementScope.PAGE,
      scopeId: "page_1",
      slot: WidgetPlacementSlot.BEFORE_CONTENT,
      anchorType: null,
      anchorId: null,
      sortOrder: 3,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      metadata: { internal: true },
    };
    const db = createQueuedSelectDb([widget, [placement]]) as any;

    const result = await getActiveWidgetById(db, "wid_public");

    expect(result).toMatchObject({
      id: "wid_public",
      placements: [
        {
          id: "wpl_public",
          scope: WidgetPlacementScope.PAGE,
          scopeId: "page_1",
        },
      ],
    });
    expect(result).not.toHaveProperty("aiContext");
    expect(result).not.toHaveProperty("metadata");
    expect(result).not.toHaveProperty("placement");
    expect(result?.placements[0]).not.toHaveProperty("metadata");
  });

  it("strips authoring context from page render widgets", async () => {
    const page = {
      id: "page_1",
      title: "Landing",
      slug: "landing",
      content: "<p>Landing</p>",
      metaTitle: null,
      metaDescription: null,
      isPublished: true,
      hideHeader: false,
      hideFooter: false,
      hideTitle: false,
      featuredImage: null,
      publishedAt: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    };
    const row = {
      id: "wid_page",
      name: "Page Widget",
      htmlContent: "<section>Page</section>",
      cssContent: "",
      aiContext: JSON.stringify({ prompt: "do not expose" }),
      isActive: true,
      displayTarget: "homepage",
      placementRule: WidgetPlacementRule.STANDALONE,
      referenceCollectionId: null,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      placement: {
        id: "wpl_page",
        widgetId: "wid_page",
        scope: WidgetPlacementScope.PAGE,
        scopeId: "page_1",
        slot: WidgetPlacementSlot.AFTER_CONTENT,
        anchorType: null,
        anchorId: null,
        sortOrder: 2,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      },
    };
    const db = createQueuedSelectDb([page, [row]]) as any;

    const result = await getPageRenderData(db, "landing");

    expect(result?.widgets).toHaveLength(1);
    expect(result?.widgets[0]).toMatchObject({
      id: "wid_page",
      placementRule: WidgetPlacementRule.STANDALONE,
    });
    expect(result?.widgets[0]).not.toHaveProperty("aiContext");
    expect(result?.widgets[0]).not.toHaveProperty("placement");
  });
});
