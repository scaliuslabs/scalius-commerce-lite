import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EVERYDAY_ROUTES, warmEverydayRouteCode } from "./warm-route-code";

describe("everyday route code warming", () => {
  it("names only routes that exist", () => {
    const routeTree = readFileSync(join(import.meta.dirname, "..", "routeTree.gen.ts"), "utf8");
    for (const { ids } of EVERYDAY_ROUTES) {
      for (const id of ids) expect(routeTree).toContain(`'${id}': typeof`);
    }
  });

  it("loads the code of the screens this person may open, and nothing else", () => {
    const loadRouteChunk = vi.fn(() => Promise.resolve());
    const looseRoutesById = Object.fromEntries(EVERYDAY_ROUTES.flatMap(({ ids }) => ids.map((id) => [id, { id }])));
    warmEverydayRouteCode({ looseRoutesById, loadRouteChunk }, (path) => path === "/admin/orders");
    expect(loadRouteChunk.mock.calls.map((call) => (call as unknown as [{ id: string }])[0].id)).toEqual([
      "/admin/orders/_list",
      "/admin/orders/_list/",
      "/admin/orders/$orderId/",
    ]);
  });
});
