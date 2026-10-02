import { describe, expect, it } from "vitest";

import { readAdminSnapshot } from "./api-read.mjs";

function collectionBody(path) {
  if (path.startsWith("/api/v1/admin/media?")) {
    return { files: [], pagination: { limit: 100, hasMore: false, nextCursor: null } };
  }
  const key = path.includes("/categories?")
    ? "categories"
    : path.includes("/products?")
      ? "products"
      : path.includes("/attributes?")
        ? "attributes"
        : path.includes("/collections?")
          ? "collections"
          : null;
  if (key) return { [key]: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } };
  return {};
}

describe("demo-store admin snapshot reads", () => {
  it("uses each route's accepted sort contract and keeps D1-backed reads sequential", async () => {
    const paths = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      async get(path) {
        paths.push(path);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        if (path === "/api/v1/admin/auth/account-security") return { isSuperAdmin: true };
        if (path === "/api/v1/admin/settings/theme/workspace") {
          return { published: { theme: {}, revision: 1 }, draft: { theme: {}, revision: 0, basePublishedRevision: 1 }, storeShape: {}, media: [] };
        }
        return collectionBody(path);
      },
    };

    await expect(readAdminSnapshot(client, {
      categories: [],
      products: [],
      collections: [],
      heroes: [],
    })).resolves.toMatchObject({
      auth: { authenticated: true, isSuperAdmin: true },
      presentation: { theme: { published: { revision: 1 }, draft: { revision: 0, basePublishedRevision: 1 } } },
    });

    const collectionsPath = paths.find((path) => path.startsWith("/api/v1/admin/collections?"));
    expect(collectionsPath).toContain("sort=updatedAt");
    expect(collectionsPath).not.toContain("sort=createdAt");
    expect(maxInFlight).toBe(1);
    // The homepage is the theme: no hero-slider or retired settings documents are read.
    expect(paths.filter((path) => path.startsWith("/api/v1/admin/settings/"))).toEqual(["/api/v1/admin/settings/theme/workspace"]);
  });
});
