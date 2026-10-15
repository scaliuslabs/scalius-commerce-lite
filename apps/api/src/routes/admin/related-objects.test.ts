import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { relatedObjectsProjection, withRelatedObjects } from "./related-objects";

const { project } = vi.hoisted(() => ({ project: vi.fn(() => ({ sql: "related objects" })) }));
vi.mock("@scalius/core/modules/objects", () => ({
  relatedObjectsJson: project,
  parseRelatedObjects: (value: string | null) => value ? JSON.parse(value) : [],
}));

async function readDetail(permissions: string[], pluginId?: string) {
  const app = new Hono();
  app.get("/detail", (c) => {
    c.set("adminPermissions" as never, new Set(permissions) as never);
    if (pluginId) c.set("pluginPrincipal" as never, { pluginId } as never);
    const projection = relatedObjectsProjection(c, "product", "prod_1");
    return c.json({ projected: projection !== undefined });
  });
  return (await app.request("/detail")).json();
}

describe("related object access", () => {
  beforeEach(() => project.mockClear());

  it("does no object SQL work for a resource viewer without objects.view", async () => {
    expect(await readDetail(["products.view"])).toEqual({ projected: false });
    expect(project).not.toHaveBeenCalled();
  });

  it("does not expose other namespaces to an app with objects.view", async () => {
    expect(await readDetail(["products.view", "objects.view"], "acme.app")).toEqual({ projected: false });
    expect(project).not.toHaveBeenCalled();
  });

  it("includes the bounded projection for staff with objects.view", async () => {
    expect(await readDetail(["products.view", "objects.view"])).toEqual({ projected: true });
    expect(project).toHaveBeenCalledOnce();
    expect(project).toHaveBeenCalledWith("product", "prod_1");
  });

  it("removes the raw internal JSON column from the response", () => {
    expect(withRelatedObjects({ id: "prod_1", relatedObjectsJson: null })).toEqual({ id: "prod_1", relatedObjects: [] });
  });
});
