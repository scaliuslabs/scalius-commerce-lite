// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getArticles: vi.fn(),
  getLayoutData: vi.fn(),
  getRuntimeStorefrontUrl: vi.fn(() => "https://storefront.example.test"),
}));

vi.mock("@/lib/api/articles", () => ({ getArticles: mocks.getArticles }));
vi.mock("@/lib/api", () => ({ getLayoutData: mocks.getLayoutData }));
vi.mock("@/lib/api/runtime-env", () => ({
  getRuntimeStorefrontUrl: mocks.getRuntimeStorefrontUrl,
}));

import { GET } from "../../pages/blog/feed.xml";

describe("blog RSS feed", () => {
  beforeEach(() => {
    mocks.getArticles.mockReset();
    mocks.getLayoutData.mockReset().mockResolvedValue({
      business: { companyName: "Scalius & Co" },
    });
    mocks.getRuntimeStorefrontUrl.mockReturnValue(
      "https://storefront.example.test",
    );
  });

  it("emits escaped article metadata and canonical links", async () => {
    mocks.getArticles.mockResolvedValueOnce({
      data: [
        {
          title: "Fit & comfort",
          slug: "fit-comfort",
          canonicalPath: null,
          excerpt: "Choose <better> shoes.",
          content: "<p>Long body</p>",
          tags: ["Guides"],
          publishedAt: 1782691200,
        },
      ],
      pagination: { page: 1, limit: 24, total: 1, totalPages: 1 },
    });

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(
      "application/rss+xml",
    );
    expect(body).toContain("<title>Scalius &amp; Co Blog</title>");
    expect(body).toContain("<title>Fit &amp; comfort</title>");
    expect(body).toContain("https://storefront.example.test/blog/fit-comfort");
    expect(body).toContain("Choose &lt;better&gt; shoes.");
    expect(body).toContain("<category>Guides</category>");
  });

  it("fails closed without an absolute Store URL", async () => {
    mocks.getRuntimeStorefrontUrl.mockReturnValueOnce("");
    const response = await GET({} as never);
    expect(response.status).toBe(503);
    expect(mocks.getArticles).not.toHaveBeenCalled();
  });
});
