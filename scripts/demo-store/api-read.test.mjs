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
        return collectionBody(path);
      },
    };

    await expect(readAdminSnapshot(client, {
      categories: [],
      products: [],
      collections: [],
      heroes: [],
    })).resolves.toMatchObject({ auth: { authenticated: true, isSuperAdmin: true } });

    const collectionsPath = paths.find((path) => path.startsWith("/api/v1/admin/collections?"));
    expect(collectionsPath).toContain("sort=updatedAt");
    expect(collectionsPath).not.toContain("sort=createdAt");
    expect(maxInFlight).toBe(1);
  });
});
