import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PARAM_SOURCES, pickId, resolveParams } from "./params.mjs";
import { buildPlan, familyOf, fillPath, filterRoutes, pageUrl, paramNames, parseLeafRoutes, skipReason } from "./routes.mjs";
import { defaultFromSource, readAdminCredentials } from "./auth.mjs";

const TREE = `
export interface FileRoutesByFullPath {
  '/admin/': typeof AdminIndexRoute
  '/admin/orders': typeof AdminOrdersListRouteWithChildren
}
export interface FileRoutesByTo {
  '/': typeof IndexRoute
  '/auth/login': typeof AuthLoginRoute
  '/admin': typeof AdminIndexRoute
  '/admin/products': typeof AdminProductsIndexRoute
  '/admin/products/$productId/edit': typeof AdminProductsProductIdEditRoute
  '/admin/metaobjects/$definitionId/entries/$entryId': typeof X
  '/admin/settings/agent-access/authorize/$requestId': typeof Y
}
export interface FileRoutesById {
  '/admin/never': typeof Z
}
`;

describe("route discovery", () => {
  it("reads the leaf URLs of FileRoutesByTo only", () => {
    expect(parseLeafRoutes(TREE)).toEqual([
      "/", "/auth/login", "/admin", "/admin/products", "/admin/products/$productId/edit",
      "/admin/metaobjects/$definitionId/entries/$entryId", "/admin/settings/agent-access/authorize/$requestId",
    ]);
  });

  it("fails loudly when the generated file changes shape", () => {
    expect(() => parseLeafRoutes("export const x = 1")).toThrow(/FileRoutesByTo/);
  });

  it("finds the real route tree's leaves", () => {
    const source = readFileSync(fileURLToPath(new URL("../../apps/admin-v2/src/routeTree.gen.ts", import.meta.url)), "utf8");
    const leaves = parseLeafRoutes(source);
    expect(leaves.length).toBeGreaterThan(80);
    expect(leaves).toContain("/admin/products/$productId/edit");
    expect(leaves.every((leaf) => leaf.startsWith("/"))).toBe(true);
  });

  it("names params and fills them, encoding the values", () => {
    expect(paramNames("/admin/metaobjects/$definitionId/entries/$entryId")).toEqual(["definitionId", "entryId"]);
    expect(fillPath("/admin/orders/$orderId/edit", { orderId: "a b/c" })).toBe("/admin/orders/a%20b%2Fc/edit");
  });

  it("groups routes into families", () => {
    expect(familyOf("/admin")).toBe("home");
    expect(familyOf("/admin/settings/store")).toBe("settings");
    expect(familyOf("/auth/login")).toBe("auth");
    expect(familyOf("/invoice/$orderId")).toBe("public");
  });

  it("filters by glob, by plain part and by family", () => {
    const paths = parseLeafRoutes(TREE);
    expect(filterRoutes(paths, { routes: ["/admin/products*"] })).toEqual(["/admin/products", "/admin/products/$productId/edit"]);
    expect(filterRoutes(paths, { routes: ["login"] })).toEqual(["/auth/login"]);
    expect(filterRoutes(paths, { families: ["settings"] })).toEqual(["/admin/settings/agent-access/authorize/$requestId"]);
    expect(filterRoutes(paths, {})).toHaveLength(paths.length);
  });

  it("skips pages that need a token, with the reason", () => {
    expect(skipReason("/admin/settings/agent-access/authorize/$requestId")).toMatch(/agent-access/);
    expect(skipReason("/admin/products")).toBeNull();
  });

  it("plans the routes that have every param and reports the others", () => {
    const paths = parseLeafRoutes(TREE);
    const plan = buildPlan({ paths, resolved: { productId: "p1" }, unresolved: { definitionId: "the store has no metaobject definitions" } });
    expect(plan.routes.map((route) => route.url)).toContain("/admin/products/p1/edit");
    expect(plan.skipped).toContainEqual({ path: "/admin/metaobjects/$definitionId/entries/$entryId", reason: "the store has no metaobject definitions" });
    expect(plan.skipped.some((item) => item.path.includes("agent-access"))).toBe(true);
    expect(plan.routes.find((route) => route.path === "/auth/login").public).toBe(true);
  });

  it("builds the page URL from the base URL", () => {
    expect(pageUrl("http://localhost:4323/admin", "/admin/products")).toBe("http://localhost:4323/admin/products");
    expect(pageUrl("http://localhost:4400", "/admin")).toBe("http://localhost:4400/admin");
    expect(pageUrl("https://shop.test/dash/admin/", "/admin/orders")).toBe("https://shop.test/dash/admin/orders");
  });
});

describe("param resolution", () => {
  it("reads the first id of a list response", () => {
    expect(pickId({ success: true, data: { products: [{ id: "prod_1" }, { id: "prod_2" }], pagination: {} } }, { keys: ["products"] })).toBe("prod_1");
    expect(pickId({ data: { items: [{ id: "x" }], nextCursor: null } }, { keys: ["items"] })).toBe("x");
    expect(pickId({ data: [{ id: 7 }] }, {})).toBe("7");
  });

  it("returns null for an empty or odd response", () => {
    expect(pickId({ data: { brands: [] } }, { keys: ["brands"] })).toBeNull();
    expect(pickId(null, {})).toBeNull();
    expect(pickId({ data: { items: [{ name: "no id" }] } }, { keys: ["items"] })).toBeNull();
  });

  it("covers every param name the route tree uses", () => {
    const source = readFileSync(fileURLToPath(new URL("../../apps/admin-v2/src/routeTree.gen.ts", import.meta.url)), "utf8");
    const names = new Set(parseLeafRoutes(source).flatMap(paramNames));
    const skippedOnly = new Set(["requestId", "handoffId", "pageId"]);
    for (const name of names) {
      if (skippedOnly.has(name)) continue;
      expect(PARAM_SOURCES, `no data source for :${name}`).toHaveProperty(name);
    }
  });

  it("resolves dependent params in order and reports an empty resource", async () => {
    const calls = [];
    const getJson = async (path) => {
      calls.push(path);
      if (path.includes("/metaobjects/definitions/mod_1/entries")) return { data: { entries: [{ id: "moe_1" }] } };
      if (path.endsWith("/metaobjects/definitions")) return { data: { items: [{ id: "mod_1" }] } };
      if (path.includes("/brands")) return { data: { brands: [] } };
      throw new Error("404");
    };
    const { resolved, unresolved } = await resolveParams(["entryId", "brandId", "productId"], getJson);
    expect(resolved).toEqual({ definitionId: "mod_1", entryId: "moe_1" });
    expect(unresolved.brandId).toMatch(/no brands/);
    expect(unresolved.productId).toMatch(/no products/);
    expect(calls[0]).toMatch(/definitions$/);
  });

  it("does not fetch a param twice", async () => {
    let count = 0;
    await resolveParams(["orderId", "orderId"], async () => {
      count += 1;
      return { data: { orders: [{ id: "o1" }] } };
    });
    expect(count).toBe(1);
  });
});

describe("sign-in defaults", () => {
  it("reads the defaults from dev-admin.mjs text and lets the environment override", () => {
    const source = 'email: process.env.LOCAL_ADMIN_EMAIL || "a@b.test",\n password: process.env.LOCAL_ADMIN_PASSWORD || "secret-value",';
    expect(defaultFromSource(source, "LOCAL_ADMIN_EMAIL")).toBe("a@b.test");
    expect(defaultFromSource(source, "LOCAL_ADMIN_PASSWORD")).toBe("secret-value");
    expect(defaultFromSource(source, "NOPE")).toBeNull();
  });

  it("finds credentials in the real dev-admin.mjs", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const credentials = readAdminCredentials(root, {});
    expect(credentials.email).toMatch(/@/);
    expect(credentials.password.length).toBeGreaterThan(8);
    expect(readAdminCredentials(root, { LOCAL_ADMIN_EMAIL: "x@y.test" }).email).toBe("x@y.test");
  });
});
