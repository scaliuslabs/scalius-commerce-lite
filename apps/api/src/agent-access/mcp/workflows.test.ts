import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import type { AgentPrincipal, AgentResource } from "../types";

const mocks = vi.hoisted(() => ({
  dispatchAgentOperation: vi.fn(),
  getAuthorizedOperation: vi.fn(),
}));

vi.mock("../dispatch", () => ({
  dispatchAgentOperation: mocks.dispatchAgentOperation,
}));

vi.mock("./operations", () => ({
  getAuthorizedOperation: mocks.getAuthorizedOperation,
}));

import { resolveAuthorizedWorkflow } from "./workflows";

function principal(): AgentPrincipal {
  return {
    kind: "agent",
    grantId: "agr_workflow_test",
    credentialId: "pat_workflow_test",
    ownerUserId: "usr_workflow_test",
    isSuperAdmin: false,
    resource: "dashboard",
    grantKind: "pat",
    preset: "operator",
    permissions: new Set(["orders.view", "products.view"]),
    riskCeiling: "security",
    authorityRevision: 1,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

describe("authorized MCP workflow resolution", () => {
  beforeEach(() => {
    mocks.dispatchAgentOperation.mockReset();
    mocks.getAuthorizedOperation.mockReset().mockImplementation(
      async (operationId: string, surface: AgentResource) => {
        const operation = AGENT_OPERATIONS_BY_ID[operationId];
        return operation?.surface === surface ? operation : null;
      },
    );
  });

  it("returns an authorized exact route without dispatching", async () => {
    const actor = principal();
    const result = await resolveAuthorizedWorkflow({
      prompt: "dashboard.sales-today",
      surface: "dashboard",
      principal: actor,
    });

    expect(result).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: {
        source: "route",
        routeIds: ["dashboard.sales-today"],
        operationIds: ["dashboard.home.activity"],
      },
    });
    expect(mocks.getAuthorizedOperation).toHaveBeenCalledExactlyOnceWith(
      "dashboard.home.activity",
      "dashboard",
      actor,
    );
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("resolves paraphrased intent and authorizes every unique operation", async () => {
    const actor = principal();
    const result = await resolveAuthorizedWorkflow({
      prompt: "Give me today's revenue, orders waiting to ship, stock problems, and checkout health.",
      surface: "dashboard",
      principal: actor,
    });

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") return;
    expect(result.plan.routeIds).toEqual(["dashboard.daily-operations-snapshot"]);
    expect(result.plan.detail?.steps).toHaveLength(9);
    expect(mocks.getAuthorizedOperation).toHaveBeenCalledTimes(
      new Set(result.plan.operationIds).size,
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12 * 1024);
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("returns one generic result when any plan operation is unavailable", async () => {
    const actor = principal();
    mocks.getAuthorizedOperation.mockImplementation(
      async (operationId: string, surface: AgentResource) => {
        if (operationId === "dashboard.checkout.readiness_get") return null;
        const operation = AGENT_OPERATIONS_BY_ID[operationId];
        return operation?.surface === surface ? operation : null;
      },
    );

    const result = await resolveAuthorizedWorkflow({
      prompt: "dashboard.daily-operations-snapshot",
      surface: "dashboard",
      principal: actor,
    });

    expect(result).toEqual({
      kind: "unavailable",
      disposition: "unavailable",
      version: "3.0.0",
      classification: {
        code: "workflow_unavailable",
        reason: "The requested workflow is unavailable.",
      },
    });
    expect(mocks.getAuthorizedOperation).toHaveBeenCalledTimes(8);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("dashboard.home.activity");
    expect(serialized).not.toContain("dashboard.checkout.readiness_get");
    expect(serialized).not.toContain(actor.grantId);
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("authorizes only a control's safe plan and never exposes forbidden IDs", async () => {
    const actor = principal();
    const result = await resolveAuthorizedWorkflow({
      prompt: "Permanently delete this product even if its SKUs have inventory movement history.",
      surface: "dashboard",
      principal: actor,
    });

    expect(result).toMatchObject({
      kind: "control",
      disposition: "refuse",
      classification: {
        controlId: "dashboard.product-hard-delete-guard",
      },
      safePlan: {
        operationIds: ["dashboard.products.get_section"],
      },
    });
    expect(mocks.getAuthorizedOperation).toHaveBeenCalledExactlyOnceWith(
      "dashboard.products.get_section",
      "dashboard",
      actor,
    );
    expect(JSON.stringify(result)).not.toContain("dashboard.products.delete_permanently");
    expect(result).not.toHaveProperty("forbiddenOperationIds");
  });

  it("keeps control classification but redacts an unavailable safe plan", async () => {
    mocks.getAuthorizedOperation.mockResolvedValue(null);
    const result = await resolveAuthorizedWorkflow({
      prompt: "Permanently delete this product even if its SKUs have inventory movement history.",
      surface: "dashboard",
      principal: principal(),
    });

    expect(result).toMatchObject({
      kind: "control",
      disposition: "refuse",
      classification: {
        controlId: "dashboard.product-hard-delete-guard",
      },
      safePlan: null,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("dashboard.products.get_section");
    expect(serialized).not.toContain("dashboard.products.delete_permanently");
  });

  it("returns unrelated intent as unsupported without authorization", async () => {
    const result = await resolveAuthorizedWorkflow({
      prompt: "Write a poem about the moons of Mars.",
      surface: "dashboard",
      principal: principal(),
    });

    expect(result).toMatchObject({
      kind: "unsupported",
      disposition: "unsupported",
      classification: { code: "no_supported_workflow" },
    });
    expect(mocks.getAuthorizedOperation).not.toHaveBeenCalled();
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("fails closed when the verified principal belongs to another audience", async () => {
    const actor = { ...principal(), resource: "storefront" as const };
    const result = await resolveAuthorizedWorkflow({
      prompt: "dashboard.sales-today",
      surface: "dashboard",
      principal: actor,
    });

    expect(result).toMatchObject({
      kind: "unavailable",
      classification: { code: "workflow_unavailable" },
    });
    expect(mocks.getAuthorizedOperation).not.toHaveBeenCalled();
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("labels storefront verification for a separate audience without authorizing it", async () => {
    const actor = principal();
    const result = await resolveAuthorizedWorkflow({
      prompt: "dashboard.checkout-readiness",
      surface: "dashboard",
      principal: actor,
    });

    expect(result).toMatchObject({
      kind: "plan",
      plan: {
        routeIds: ["dashboard.checkout-readiness"],
        operationIds: expect.not.arrayContaining(["storefront.checkout.get_config"]),
        externalAudienceVerification: [{
          operationId: "storefront.checkout.get_config",
          surface: "storefront",
          risk: "read",
          separateAudienceRequired: true,
          requiredPrincipalResource: "storefront",
        }],
      },
    });
    expect(AGENT_OPERATIONS_BY_ID["storefront.checkout.get_config"]?.risk).toBe("read");
    expect(mocks.getAuthorizedOperation).not.toHaveBeenCalledWith(
      "storefront.checkout.get_config",
      "storefront",
      actor,
    );
    expect(mocks.getAuthorizedOperation).toHaveBeenCalledTimes(4);
    for (const call of mocks.getAuthorizedOperation.mock.calls) {
      expect(call[1]).toBe("dashboard");
    }
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("returns the complete authorized optioned-product model within 16 KiB", async () => {
    const actor = principal();
    const result = await resolveAuthorizedWorkflow({
      prompt: "dashboard.complex-product-create",
      surface: "dashboard",
      principal: actor,
    });

    expect(result).toMatchObject({
      kind: "plan",
      plan: {
        routeIds: ["dashboard.complex-product-create"],
        detail: {
          constructionRules: {
            variantImageReferences: "pmed-association-id",
            variantMatrix: "complete",
            createMode: "single-atomic-products.create",
          },
          requiredFacts: expect.arrayContaining([
            expect.objectContaining({
              id: "mediaSet",
              description: expect.stringContaining("1-250 unique, one primary"),
            }),
            expect.objectContaining({
              id: "optionMatrix",
              description: expect.stringContaining("complete SKU price/stock/mediaSet imageId rows"),
            }),
          ]),
          steps: expect.arrayContaining([
            expect.objectContaining({
              operationId: "dashboard.products.create",
              mutation: "create",
              input: expect.objectContaining({
                picks: expect.arrayContaining([
                  expect.objectContaining({ factId: "productSpec" }),
                ]),
                materializations: expect.arrayContaining([
                  expect.objectContaining({ factId: "mediaSet", keyField: "id" }),
                  expect.objectContaining({ factId: "attributeSet" }),
                ]),
              }),
              policies: expect.objectContaining({ confirmation: "required" }),
            }),
          ]),
        },
        externalAudienceVerification: [expect.objectContaining({
          operationId: "storefront.products.get_section",
        })],
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(mocks.getAuthorizedOperation).not.toHaveBeenCalledWith(
      "storefront.products.get_section",
      "storefront",
      actor,
    );
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });
});
