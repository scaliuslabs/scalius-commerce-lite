import { describe, expect, it } from "vitest";

import { AGENT_INTENT_EVAL_CASES } from "../../../../../packages/cli/test/fixtures/agent-intents";
import app from "../../app";
import { finalizeOpenApiContract } from "../../openapi-contract";
import { buildAgentOperationManifest } from "../../openapi/agent-operation-manifest";
import { buildAgentWorkflowCatalog } from "./catalog";
import {
  createWorkflowResolver,
  type WorkflowResolution,
} from "./resolver-core";

const document = finalizeOpenApiContract(
  app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Workflow resolver test", version: "1.0.0" },
  }),
);
const operations = buildAgentOperationManifest(document);
const catalog = buildAgentWorkflowCatalog(operations, {
  requireCuratedCards: true,
});
const resolveWorkflow = createWorkflowResolver({ catalog, operations });

function operationIds(resolution: WorkflowResolution): string[] {
  if (resolution.kind === "plan") return resolution.plan.operationIds;
  if (resolution.kind === "control") return resolution.safePlan?.operationIds ?? [];
  return [];
}

function resolutionFlags(resolution: WorkflowResolution) {
  const plan = resolution.kind === "plan"
    ? resolution.plan
    : resolution.kind === "control"
      ? resolution.safePlan
      : null;
  return {
    requiresFacts: plan?.requiresFacts === true,
    requiresConfirmation: plan?.requiresConfirmation === true,
    requiresVerification: plan?.requiresVerification === true,
  };
}

describe("reviewed agent workflow resolver", () => {
  it("returns the exact smallest reviewed outcome for all 65 unchanged cases", () => {
    for (const testCase of AGENT_INTENT_EVAL_CASES) {
      const resolution = resolveWorkflow({
        prompt: testCase.prompt,
        surface: testCase.surface,
      });
      const expectedDisposition = testCase.expectedDisposition ?? "execute";
      expect(resolution.disposition, testCase.id).toBe(expectedDisposition);
      expect(operationIds(resolution), testCase.id).toEqual(testCase.expectedOperationIds);

      if (testCase.expectedDisposition) {
        expect(resolution.kind, testCase.id).toBe("control");
        if (resolution.kind === "control") {
          expect(resolution.classification.controlId, testCase.id).toBe(testCase.id);
          expect(resolution.forbiddenOperationIds, testCase.id).toEqual(
            testCase.forbiddenOperationIds ?? [],
          );
          expect(resolution.safetyNotes, testCase.id).toHaveLength(
            testCase.safetyAssertions?.length ?? 0,
          );
        }
      } else {
        expect(resolution.kind, testCase.id).toBe("plan");
        if (resolution.kind === "plan") {
          expect(resolution.plan.source, testCase.id).toBe("route");
          expect(resolution.plan.routeIds, testCase.id).toEqual([testCase.id]);
          expect(resolution.plan.operationIds.length, testCase.id).toBeLessThanOrEqual(20);
        }
      }

      const flags = resolutionFlags(resolution);
      expect(flags.requiresFacts, `${testCase.id}: facts`).toBe(testCase.requiresFacts === true);
      expect(flags.requiresConfirmation, `${testCase.id}: confirmation`).toBe(
        testCase.requiresConfirmation === true,
      );
      expect(flags.requiresVerification, `${testCase.id}: verification`).toBe(
        testCase.requiresVerification === true,
      );
      for (const forbidden of testCase.forbiddenOperationIds ?? []) {
        expect(operationIds(resolution), testCase.id).not.toContain(forbidden);
      }
    }
  });

  it("is deterministic when all live inputs are reversed", () => {
    const reversed = createWorkflowResolver({
      catalog: {
        ...catalog,
        routes: [...catalog.routes].reverse(),
        controls: [...catalog.controls].reverse(),
      },
      operations: [...operations].reverse(),
    });
    for (const testCase of AGENT_INTENT_EVAL_CASES) {
      const input = { prompt: testCase.prompt, surface: testCase.surface };
      expect(reversed(input), testCase.id).toEqual(resolveWorkflow(input));
    }
  });

  it.each([
    [
      "dashboard",
      "Give me today's revenue, orders waiting to ship, stock problems, and checkout health.",
      "dashboard.daily-operations-snapshot",
    ],
    [
      "dashboard",
      "Make a shirt with sizes and colors, unique SKUs, images per color, and publish it.",
      "dashboard.complex-product-create",
    ],
    [
      "dashboard",
      "Subtract five damaged items from this SKU.",
      "dashboard.inventory-relative-adjustment",
    ],
    [
      "dashboard",
      "Why can nobody check out, and which gateways and couriers work?",
      "dashboard.checkout-readiness",
    ],
    [
      "dashboard",
      "Refund a captured card payment and reconcile if the provider times out.",
      "dashboard.order-refund",
    ],
    [
      "storefront",
      "Help me find a black shirt and inspect its variants and availability.",
      "storefront.product-research",
    ],
    [
      "storefront",
      "Add this variant, pick delivery, apply the code, and place my order.",
      "storefront.checkout-journey",
    ],
  ] as const)("resolves indirect merchant language (%s)", (surface, prompt, routeId) => {
    const resolution = resolveWorkflow({ surface, prompt });
    expect(resolution.kind).toBe("plan");
    if (resolution.kind === "plan") expect(resolution.plan.routeIds).toEqual([routeId]);
  });

  it("does not turn safely negated policy language into a refusal", () => {
    for (const id of ["storefront.product-research", "storefront.payment-recovery"]) {
      const route = catalog.routes.find((candidate) => candidate.id === id)!;
      const resolution = resolveWorkflow({
        prompt: route.examples[0]!,
        surface: route.surface,
      });
      expect(resolution.kind, id).toBe("plan");
      expect(resolution.disposition, id).toBe("execute");
    }
  });

  it("returns one exact operation fallback and abstains from unrelated work", () => {
    const fallback = resolveWorkflow({
      prompt: "dashboard.taxes.classifications_list",
      surface: "dashboard",
    });
    expect(fallback.kind).toBe("plan");
    if (fallback.kind === "plan") {
      expect(fallback.plan.source).toBe("operation-fallback");
      expect(fallback.plan.operationIds).toEqual(["dashboard.taxes.classifications_list"]);
    }

    const unsupported = resolveWorkflow({
      prompt: "Write a poem about the moons of Mars.",
      surface: "dashboard",
    });
    expect(unsupported).toMatchObject({
      kind: "unsupported",
      disposition: "unsupported",
      classification: { code: "no_supported_workflow" },
    });
  });

  it("returns at most three compact choices for genuinely broad intent", () => {
    const resolution = resolveWorkflow({ prompt: "settings", surface: "dashboard" });
    expect(resolution.kind).toBe("choices");
    if (resolution.kind === "choices") {
      expect(resolution.choices.length).toBeGreaterThan(1);
      expect(resolution.choices.length).toBeLessThanOrEqual(3);
      expect(new Set(resolution.choices.map((choice) => choice.id)).size).toBe(
        resolution.choices.length,
      );
    }
  });

  it("keeps compact plans below their context budgets", () => {
    const daily = resolveWorkflow({
      prompt: catalog.routes.find((route) =>
        route.id === "dashboard.daily-operations-snapshot"
      )!.examples[0]!,
      surface: "dashboard",
    });
    const product = resolveWorkflow({
      prompt: catalog.routes.find((route) =>
        route.id === "dashboard.complex-product-create"
      )!.examples[0]!,
      surface: "dashboard",
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: daily }))).toBeLessThanOrEqual(
      4 * 1024,
    );
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: product }))).toBeLessThanOrEqual(
      16 * 1024,
    );
  });

  it("keeps warm p95 resolution below 50 ms", () => {
    for (let warmup = 0; warmup < 3; warmup += 1) {
      for (const testCase of AGENT_INTENT_EVAL_CASES) {
        resolveWorkflow({ prompt: testCase.prompt, surface: testCase.surface });
      }
    }
    const timings: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      for (const testCase of AGENT_INTENT_EVAL_CASES) {
        const startedAt = performance.now();
        resolveWorkflow({ prompt: testCase.prompt, surface: testCase.surface });
        timings.push(performance.now() - startedAt);
      }
    }
    timings.sort((left, right) => left - right);
    expect(timings[Math.floor(timings.length * 0.95)]).toBeLessThan(50);
  });
});
