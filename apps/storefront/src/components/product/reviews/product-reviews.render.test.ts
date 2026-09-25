// @vitest-environment node
/**
 * The product page's review surfaces, render-only (Astro container API
 * through a Vite dev server in middleware mode, like the card matrix): the
 * star line under the title and the reviews module, with reviews off, at
 * zero and with reviews. Every control is a link that works without
 * JavaScript, and nothing says "0 reviews".
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import { BANGLA_CHECKOUT_LANGUAGE_DATA, ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import type { Product, ProductReviews } from "@/lib/api";
import { pickReviewCopy } from "./review-format";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};

interface Container {
  renderToString(component: unknown, options: { props?: object; request?: Request }): Promise<string>;
}

let server: ViteDevServer;
let container: Container;
let ProductReviewsModule: unknown;
let ReviewsSummary: unknown;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig(
    {
      root,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
      plugins: [
        {
          name: "reviews-render-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0reviews-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0reviews-test:") ? VIRTUAL_MODULES[id.slice("\0reviews-test:".length)] : undefined,
        },
      ],
    } as never,
    { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never,
  ) as unknown as (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  container = await experimental_AstroContainer.create();
  ProductReviewsModule = (await server.ssrLoadModule("/src/components/product/reviews/ProductReviews.astro")).default;
  ReviewsSummary = (await server.ssrLoadModule("/src/components/product/reviews/ReviewsSummary.astro")).default;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const window = new Window();
const parse = (html: string) => new window.DOMParser().parseFromString(`<body>${html}</body>`, "text/html") as unknown as Document;
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, " ").trim() ?? "";

const copy = pickReviewCopy(ENGLISH_CHECKOUT_LANGUAGE_DATA);

function withReviews(reviews: ProductReviews | null | undefined): Product {
  return { id: "prod_1", slug: "blue-shirt", name: "Blue shirt", reviews } as unknown as Product;
}

const sixReviews: ProductReviews = {
  summary: {
    average: 4.66,
    count: 128,
    histogram: [
      { rating: 5, count: 100 },
      { rating: 4, count: 20 },
      { rating: 3, count: 8 },
      { rating: 2, count: 0 },
      { rating: 1, count: 0 },
    ],
  },
  items: Array.from({ length: 5 }, (_, index) => ({
    id: `rev_${index}`,
    rating: 5,
    title: `Title ${index}`,
    body: index === 0 ? "<img src=x onerror=alert(1)>" : "Nice",
    authorName: `Buyer ${index}`,
    variantLabel: index === 0 ? "Size: M" : null,
    verifiedPurchase: true as const,
    publishedAt: "2026-09-12T08:00:00.000Z",
    editedAt: null,
    reply: index === 0 ? { body: "Thanks", repliedAt: "2026-09-13T08:00:00.000Z" } : null,
  })),
  nextCursor: "WzE3OTAwMDAwMDAsInJldl80Iiw1XQ",
};

async function render(component: unknown, product: Product, extra: object = {}) {
  return parse(await container.renderToString(component, {
    props: { product, copy, language: "en", storeName: "Dhaka Store", ...extra },
    request: new Request("https://shop.test/products/blue-shirt"),
  }));
}

describe("the product page's reviews", () => {
  it("renders nothing when the store's reviews are off", async () => {
    for (const component of [ProductReviewsModule, ReviewsSummary]) {
      const doc = await render(component, withReviews(null));
      expect(doc.querySelector("#reviews, [data-review-summary]")).toBeNull();
    }
  });

  it("shows the zero state and no star line at 0 reviews", async () => {
    const zero = withReviews({ summary: { average: 0, count: 0, histogram: [] }, items: [], nextCursor: null });
    const module = await render(ProductReviewsModule, zero);
    expect(text(module.querySelector("[data-review-empty]"))).toBe("No reviews yet. Bought this? Review it from your orders.");
    expect(module.querySelector(".product-reviews-histogram, [data-review-list]")).toBeNull();
    const summary = await render(ReviewsSummary, zero);
    expect(summary.querySelector("[data-review-summary]")).toBeNull();
  });

  it("links the star line to #reviews with the one-decimal average and the count", async () => {
    const doc = await render(ReviewsSummary, withReviews(sixReviews));
    const line = doc.querySelector<HTMLAnchorElement>("a[data-review-summary]")!;
    expect(line.getAttribute("href")).toBe("#reviews");
    expect(text(line)).toContain("4.7");
    expect(text(line)).toContain("128 ratings");
    expect(line.querySelector(".sc-stars")?.getAttribute("style")).toBe("--sc-fill:90%");
  });

  it("renders the summary, five linked bars, five reviews and links that work without JavaScript", async () => {
    const doc = await render(ProductReviewsModule, withReviews(sixReviews));
    const section = doc.querySelector("section#reviews")!;
    expect(text(section.querySelector(".product-reviews-score"))).toContain("4.7 out of 5");
    expect(text(section.querySelector(".product-reviews-total"))).toBe("128 reviews");
    const bars = [...section.querySelectorAll(".product-reviews-histogram li")];
    expect(bars).toHaveLength(5);
    expect(bars[0]!.querySelector("a")?.getAttribute("href")).toBe("/products/blue-shirt/reviews?rating=5");
    // A star with no reviews is not a link.
    expect(bars[3]!.querySelector("a")).toBeNull();
    expect(section.querySelectorAll("[data-review-list] > li")).toHaveLength(5);
    expect([...section.querySelectorAll("[data-review-sort]")].map((link) => link.getAttribute("href"))).toEqual([
      "/products/blue-shirt/reviews",
      "/products/blue-shirt/reviews?sort=highest",
      "/products/blue-shirt/reviews?sort=lowest",
    ]);
    const more = section.querySelector<HTMLAnchorElement>("[data-review-more]")!;
    expect(more.hasAttribute("hidden")).toBe(false);
    expect(more.getAttribute("href")).toBe("/products/blue-shirt/reviews?after=WzE3OTAwMDAwMDAsInJldl80Iiw1XQ");
    expect(text(section)).toContain("Verified purchase");
    expect(text(section)).toContain("Response from Dhaka Store");
    // Review text is escaped, never markup.
    expect(section.querySelector("[data-review-list] img")).toBeNull();
    expect(section.innerHTML).toContain("&lt;img");
  });

  it("hides Show more when every review is on the page, and reads Bangla", async () => {
    const doc = await render(ProductReviewsModule, withReviews({ ...sixReviews, nextCursor: null }), {
      copy: pickReviewCopy(BANGLA_CHECKOUT_LANGUAGE_DATA),
      language: "bn",
    });
    expect(doc.querySelector("[data-review-more]")?.hasAttribute("hidden")).toBe(true);
    expect(text(doc.querySelector("#reviews-heading"))).toBe("ক্রেতাদের রিভিউ");
    expect(text(doc.querySelector(".product-reviews-total"))).toBe("128টি রিভিউ");
  });
});
