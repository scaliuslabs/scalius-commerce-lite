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
    const categories = Array.from({ length: 91 }, (_, index) => ({
      id: `cat_${index}`,
      expectedRevision: 1,
    }));
    const response = await adminCategoryRoutes.request("/bulk-restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categories }),
    });

    expect(response.status).toBe(400);
  });

  it("requires explicit revision claims and canonical publication statuses", async () => {
    const missingRevision = await adminCategoryRoutes.request("/bulk-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categories: [{ id: "cat_1" }] }),
    });
    const invalidStatus = await adminCategoryRoutes.request("/?status=active");
    const missingSingleRevision = await adminCategoryRoutes.request("/cat_1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(missingRevision.status).toBe(400);
    expect(invalidStatus.status).toBe(400);
    expect(missingSingleRevision.status).toBe(400);
  });
});
