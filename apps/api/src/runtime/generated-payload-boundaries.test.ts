import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../generated/agent-operations.gen");
  vi.doUnmock("../generated/openapi-contract.gen");
  vi.resetModules();
});

describe("generated runtime payload boundaries", () => {
  const routeLoaders = {
    probe: () => import("./probe-app"),
    publicConfig: () => import("./public-config-app"),
    publicCatalog: () => import("./public-catalog-app"),
    publicContent: () => import("./public-content-app"),
    publicBuyer: () => import("./public-buyer-app"),
    adminDashboard: () => import("./admin-dashboard-app"),
    adminCatalog: () => import("./admin-catalog-app"),
    adminSales: () => import("./admin-sales-app"),
    adminContent: () => import("./admin-content-app"),
    adminAccess: () => import("./admin-access-app"),
    system: () => import("./system-app"),
    plugins: () => import("./plugins-app"),
  } as const;

  it.each(Object.keys(routeLoaders) as Array<keyof typeof routeLoaders>)(
    "%s routes initialize neither generated payload",
    async (family) => {
      let agentOperationsLoaded = false;
      let openApiLoaded = false;
      vi.doMock("../generated/agent-operations.gen", () => {
        agentOperationsLoaded = true;
        return { AGENT_OPERATIONS: [] };
      });
      vi.doMock("../generated/openapi-contract.gen", () => {
        openApiLoaded = true;
        return { OPENAPI_CONTRACT_ETAG: '"test"', OPENAPI_CONTRACT_JSON: "{}" };
      });

      await routeLoaders[family]();

      expect(agentOperationsLoaded).toBe(false);
      expect(openApiLoaded).toBe(false);
    },
  );

  it("docs load only the OpenAPI payload, with the first request for it", async () => {
    let agentOperationsLoaded = false;
    let openApiLoaded = false;
    vi.doMock("../generated/agent-operations.gen", () => {
      agentOperationsLoaded = true;
      return { AGENT_OPERATIONS: [] };
    });
    vi.doMock("../generated/openapi-contract.gen", () => {
      openApiLoaded = true;
      return { OPENAPI_CONTRACT_ETAG: '"test"', OPENAPI_CONTRACT_JSON: "{}" };
    });

    await import("./docs-app");
    expect(openApiLoaded).toBe(false);
    const { Hono } = await import("hono");
    const { registerDocRoutes } = await import("./register-doc-routes");
    const routes = new Hono();
    registerDocRoutes(routes as never);
    const response = await routes.request("/openapi.json");

    expect(await response.text()).toBe("{}");
    expect(response.headers.get("ETag")).toBe('"test"');
    expect(agentOperationsLoaded).toBe(false);
    expect(openApiLoaded).toBe(true);
  });

  it("loads agent operations only when their resolver is requested", async () => {
    let agentOperationsLoaded = false;
    vi.doMock("../generated/agent-operations.gen", () => {
      agentOperationsLoaded = true;
      return { AGENT_OPERATIONS: [] };
    });

    await import("../agent-access/direct-operation");

    expect(agentOperationsLoaded).toBe(true);
  });
});
