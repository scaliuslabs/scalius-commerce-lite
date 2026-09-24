// @vitest-environment node
/**
 * Opt-in catalogue-scale measurement of the Google/Meta XML feed builders
 * against a real local API (scripts/catalog-scale-seed.mjs):
 *
 *   CATALOG_SCALE_API=http://localhost:8821 pnpm vitest run \
 *     apps/storefront/src/lib/route-tests/api/catalog-feed-scale.test.ts
 *
 * Follows the feed's own continuation links until the catalogue ends and
 * appends API reads, build time, heap growth and XML size per window to
 * CATALOG_SCALE_OUT (JSON lines).
 * Skipped unless CATALOG_SCALE_API is set.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const API = process.env.CATALOG_SCALE_API;
const reads = { count: 0, ms: 0 };

vi.mock("@/lib/api/products", () => ({
  getFeedProducts: async (options: Record<string, unknown>) => {
    const query = new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]));
    const started = performance.now();
    const response = await fetch(`${API}/api/v1/products/feed?${query}`);
    const body = await response.json() as { data: { products: unknown[]; pagination: unknown } };
    reads.count += 1;
    reads.ms += performance.now() - started;
    return { data: body.data.products, pagination: body.data.pagination };
  },
}));
vi.mock("@/lib/api", () => ({
  getLayoutData: async () => ({ currency: { code: "BDT" }, media: undefined, business: { companyName: "Scale Store" } }),
  getSeoSettings: async () => ({ discovery: undefined }),
  getShippingMethods: async () => [],
}));
vi.mock("@/lib/api/runtime", () => ({
  getRuntimeStorefrontUrl: () => "https://storefront.example.test",
  setRuntimeImageCdnPolicy: () => undefined,
}));
vi.mock("@/lib/media-url", () => ({
  resolveMediaUrl: (url: string) => (url.startsWith("http") ? url : `https://media.example.test/${url}`),
}));

import { GET as GOOGLE_FEED_GET } from "../../../pages/api/product-feed.xml";

describe.skipIf(!API)("catalogue-scale XML feed", () => {
  it.each([1000, 5000])("walks the whole catalogue in windows of %i products", async (limit) => {
    let url: string | null = `https://storefront.example.test/api/product-feed.xml?limit=${limit}`;
    const windows: Array<{ items: number; bytes: number; ms: number; apiReads: number; apiMs: number; heapMb: number }> = [];
    while (url) {
      reads.count = 0;
      reads.ms = 0;
      globalThis.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const response = await GOOGLE_FEED_GET({ url: new URL(url) } as never);
      const xml = await response.text();
      expect(response.status).toBe(200);
      windows.push({
        items: (xml.match(/<item>/g) ?? []).length,
        bytes: xml.length,
        ms: Math.round(performance.now() - started),
        apiReads: reads.count,
        apiMs: Math.round(reads.ms),
        heapMb: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e5) / 10,
      });
      const next = response.headers.get("Link")?.match(/<([^>]+)>; rel="next"/)?.[1] ?? null;
      url = next;
    }
    const summary = JSON.stringify({ limit, windows: windows.length, totalItems: windows.reduce((sum, w) => sum + w.items, 0), perWindow: windows });
    if (process.env.CATALOG_SCALE_OUT) appendFileSync(process.env.CATALOG_SCALE_OUT, `${summary}\n`);
  }, 1_800_000);
});
