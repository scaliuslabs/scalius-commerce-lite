import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../generated/agent-operations.gen");
  vi.doUnmock("../generated/openapi-contract.gen");
  vi.doUnmock("../generated/agent-operation-policies.gen");
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

    const { docRoutes } = await import("./docs-app");
    expect(openApiLoaded).toBe(false);
    const response = await docRoutes.request("/openapi.json");

    expect(await response.text()).toBe("{}");
    expect(response.headers.get("ETag")).toBe('"test"');
    expect(agentOperationsLoaded).toBe(false);
    expect(openApiLoaded).toBe(true);
  });

  it("loads only the policy index when an operation resolver is requested", async () => {
    let agentOperationsLoaded = false;
    let policiesLoaded = false;
    vi.doMock("../generated/agent-operations.gen", () => {
      agentOperationsLoaded = true;
      return { AGENT_OPERATIONS: [] };
    });
    vi.doMock("../generated/agent-operation-policies.gen", () => {
      policiesLoaded = true;
      return { AGENT_OPERATION_POLICIES: [], AGENT_OPERATION_POLICIES_BY_ID: {} };
    });

    await import("../agent-access/direct-operation");

    expect(policiesLoaded).toBe(true);
    expect(agentOperationsLoaded).toBe(false);
  });

  // Plugin authority and the admin agent checks (route resolution, grant
  // scopes, body limits, the confirmation gate and approvals, idempotent
  // replay) read the policy index; schemas load only to describe or call.
  const policyOnlyRuntimes = {
    pluginAuthority: () => import("../plugins/authority"),
    pluginBridge: () => import("../plugins/bridge"),
    pluginAdminRequest: () => import("../plugins/admin-request"),
    pluginMessaging: () => import("../plugins/messaging"),
    adminAuth: () => import("../middleware/admin-auth"),
    agentPrincipal: () => import("../middleware/agent-principal"),
    confirmGate: () => import("../agent-access/confirm-gate"),
    approvals: () => import("../agent-access/approvals"),
    grantScopes: () => import("../agent-access/grant-scopes"),
    idempotentReplay: () => import("../routes/admin/idempotency"),
    directOperation: () => import("../agent-access/direct-operation"),
  } as const;

  it.each(Object.keys(policyOnlyRuntimes) as Array<keyof typeof policyOnlyRuntimes>)(
    "%s never initializes the full agent manifest",
    async (runtime) => {
      let agentOperationsLoaded = false;
      vi.doMock("../generated/agent-operations.gen", () => {
        agentOperationsLoaded = true;
        return { AGENT_OPERATIONS: [], AGENT_OPERATIONS_BY_ID: {}, AGENT_COMPONENT_SCHEMAS: {} };
      });

      await policyOnlyRuntimes[runtime]();

      expect(agentOperationsLoaded).toBe(false);
    },
  );

  it("the policy index is the manifest without prose and schemas", async () => {
    const { AGENT_OPERATION_POLICIES } = await import("../generated/agent-operation-policies.gen");
    const { AGENT_OPERATIONS } = await import("../generated/agent-operations.gen");
    const { agentOperationPolicyOf } = await import("../openapi/agent-operation-manifest");
    // The index is the manifest without prose and schemas, operation for operation.
    expect(AGENT_OPERATION_POLICIES).toEqual(AGENT_OPERATIONS.map(agentOperationPolicyOf));
  });
});
