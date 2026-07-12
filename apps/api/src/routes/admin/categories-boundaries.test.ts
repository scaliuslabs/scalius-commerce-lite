import { describe, expect, it } from "vitest";

import { adminCategoryRoutes } from "./categories";

describe("admin category request boundaries", () => {
  it("rejects invalid pagination and sort values before D1 work", async () => {
    await expect(adminCategoryRoutes.request("/?page=0")).resolves.toMatchObject({ status: 400 });
    await expect(adminCategoryRoutes.request("/?limit=1.5")).resolves.toMatchObject({ status: 400 });
    await expect(adminCategoryRoutes.request("/?sort=productCount")).resolves.toMatchObject({ status: 400 });
    await expect(adminCategoryRoutes.request("/?order=sideways")).resolves.toMatchObject({ status: 400 });
  });

  it("caps destructive ID sets below D1's binding ceiling", async () => {
    const categoryIds = Array.from({ length: 91 }, (_, index) => `cat_${index}`);
    const response = await adminCategoryRoutes.request("/bulk-restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryIds }),
    });

    expect(response.status).toBe(400);
  });
});
