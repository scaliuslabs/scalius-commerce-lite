import { describe, expect, it } from "vitest";
import {
  createPage,
  getPublicPageBySlug,
  updatePage,
} from "../../../../packages/core/src/modules/pages/pages.service";
import { createMockDb } from "../../../setup";

const pageRecord = {
  id: "page_1",
  title: "Landing",
  slug: "landing",
  content: '<section onclick="x">Copy<script>alert(1)</script></section>',
  metaTitle: null,
  metaDescription: null,
  isPublished: true,
  publishedAt: null,
  sortOrder: 0,
  hideHeader: false,
  hideFooter: false,
  hideTitle: false,
  featuredImage: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

describe("page content sanitization", () => {
  it("sanitizes legacy public page content on read", async () => {
    const db = createMockDb({ selectResult: pageRecord });

    const page = await getPublicPageBySlug(db as any, "landing");

    expect(page?.content).toBe("<section>Copy</section>");
  });

  it("sanitizes page content before create persistence", async () => {
    const db = createMockDb({ selectResult: null });

    await createPage(
      db as any,
      {
        title: "Landing",
        slug: "landing",
        content: '<img src="javascript:alert(1)" onerror="x"><p>Copy</p>',
        metaTitle: null,
        metaDescription: null,
        isPublished: true,
        publishedAt: null,
        sortOrder: 0,
        hideHeader: false,
        hideFooter: false,
        hideTitle: false,
        featuredImage: null,
      },
      { canPublish: true },
    );

    const valuesCall = db._calls.find((call) => call.method === "insert.values");
    expect(valuesCall?.args[0]).toMatchObject({
      content: "<img><p>Copy</p>",
    });
  });

  it("sanitizes page content before update persistence", async () => {
    const db = createMockDb({ selectResult: pageRecord });

    await updatePage(db as any, "page_1", {
      content: '<a href="vbscript:msgbox(1)">Bad</a>',
    });

    const setCall = db._calls.find((call) => call.method === "update.set");
    expect(setCall?.args[0]).toMatchObject({
      content: "<a>Bad</a>",
    });
  });
});
