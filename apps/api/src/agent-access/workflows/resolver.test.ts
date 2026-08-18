import { describe, expect, it } from "vitest";

import { AGENT_INTENT_EVAL_CASES } from "../../../../../packages/cli/test/fixtures/agent-intents";
import app from "../../app";
import { finalizeOpenApiContract } from "../../openapi-contract";
import { buildAgentOperationManifest } from "../../openapi/agent-operation-manifest";
import { buildAgentWorkflowCatalog } from "./catalog";
import {
  createWorkflowReadCompiler,
  createWorkflowResolver,
  projectWorkflowReadResponse,
  type WorkflowResolution,
  type WorkflowResolverCard,
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
const compileWorkflowRead = createWorkflowReadCompiler({ catalog, operations });

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
          expect(resolution.safePlan?.detail, testCase.id).toBeUndefined();
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
        cards: [...catalog.cards].reverse(),
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
      expect(fallback.plan.detail).toBeUndefined();
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

  it("projects the optioned-product card into a complete compact execution model", () => {
    const route = catalog.routes.find((candidate) =>
      candidate.id === "dashboard.complex-product-create"
    )!;
    const resolution = resolveWorkflow({
      prompt: route.examples[0]!,
      surface: "dashboard",
    });
    expect(resolution.kind).toBe("plan");
    if (resolution.kind !== "plan") return;
    const detail = resolution.plan.detail;
    expect(detail).toBeDefined();
    if (!detail) return;

    expect(detail.constructionRules).toMatchObject({
      mediaAssociationIds: "caller-local-pmed",
      variantImageReferences: "pmed-association-id",
      selectedOptionValueOrder: "merchant-axis-order",
      variantMatrix: "complete",
      skuIdentity: "global-lower-trim-unique",
      inventoryAuthority: "variant-only-no-product-stock",
      createMode: "single-atomic-products.create",
      uncertainCreateRecovery: "reread-before-retry",
    });
    expect(detail.requiredFacts.find((fact) => fact.id === "optionMatrix")).toMatchObject({
      description: "Ordered axes/values and complete SKU price, stock, and pmed image rows.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule: "Never add, omit, collapse, or reorder combinations.",
    });
    expect(detail.requiredFacts.find((fact) => fact.id === "categoryId")?.source).toMatchObject({
      kind: "operation",
      operationId: "dashboard.categories.form_options",
      alternatives: [{ operationId: "dashboard.categories.create", responsePointer: "/data/id" }],
    });

    const createSteps = detail.steps.filter((step) =>
      step.operationId === "dashboard.products.create"
    );
    expect(createSteps).toHaveLength(1);
    const create = createSteps[0]!;
    expect(create).toMatchObject({
      phaseId: "create",
      stepId: "product",
      mutation: "create",
      input: {
        template: {
          body: {
            media: [
              { id: "pmed_primary", mediaId: null, isPrimary: true },
              { id: "pmed_secondary", mediaId: null, isPrimary: false },
            ],
            optionMatrix: null,
          },
        },
      },
      policies: {
        revision: "none",
        idempotency: "none",
        confirmation: "required",
        stopConditions: ["Stop on conflict or uncertain write; reread."],
        nonInferenceRules: ["Use resolved or merchant facts only."],
      },
    });
    expect(create.input.dependencies).toEqual(expect.arrayContaining([
      {
        templatePointer: "/body/optionMatrix",
        source: { kind: "fact", factId: "optionMatrix" },
      },
      {
        templatePointer: "/body/media/0/mediaId",
        source: {
          kind: "step",
          phaseId: "media",
          stepId: "primary",
          responsePointer: "/data/file/id",
        },
      },
    ]));
    expect(create.input.defaults).toEqual(expect.arrayContaining([
      { templatePointer: "/body/isActive", value: true },
      { templatePointer: "/body/excludeFromSitemap", value: false },
      { templatePointer: "/body/excludeFromProductFeed", value: false },
    ]));
    expect(detail.steps.find((step) => step.stepId === "status")).toMatchObject({
      phaseId: "publish",
      operationId: "dashboard.categories.set_status",
      mutation: "lifecycle",
      condition: "Only if not published and ready.",
      policies: { revision: "required", confirmation: "required" },
    });
    expect(detail.phaseStopConditions.create).toEqual([
      "Stop on conflict; never fall back to per-SKU creation.",
    ]);
    expect(detail.steps.some((step) => step.operationId.includes("variants.create"))).toBe(false);
    expect(detail.verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationId: "dashboard.products.get_section",
        responsePointers: ["/data/aggregateRevision", "/data/items", "/data/total"],
        bounds: { maxCalls: 12, maxItems: 150, maxResponseBytes: 65_536 },
      }),
      expect.objectContaining({
        operationId: "storefront.products.get_section",
        proves: ["Buyer SKU price, variant image, and availability band."],
        bounds: { maxCalls: 10, maxItems: 150, maxResponseBytes: 61_440 },
      }),
    ]));

    expect(Object.keys(detail)).toEqual([
      "constructionRules",
      "requiredFacts",
      "phaseStopConditions",
      "steps",
      "verification",
    ]);
    const serialized = JSON.stringify(resolution);
    for (const wholesaleKey of ["cards", "routes", "controls", "coverage", "examples", "tags"]) {
      expect(serialized).not.toContain(`"${wholesaleKey}":`);
    }
  });

  it("preserves defaults in card detail and omits detail for multiple workflow IDs", () => {
    const dailyRoute = catalog.routes.find((candidate) =>
      candidate.id === "dashboard.daily-operations-snapshot"
    )!;
    const daily = resolveWorkflow({ prompt: dailyRoute.examples[0]!, surface: "dashboard" });
    expect(daily.kind).toBe("plan");
    if (daily.kind === "plan") {
      expect(daily.plan.detail?.requiredFacts.find((fact) => fact.id === "days")).toMatchObject({
        required: true,
        defaultValue: 1,
        source: { kind: "constant", value: 1 },
      });
    }

    const subsetResolver = createWorkflowResolver({
      catalog: {
        ...catalog,
        controls: [],
        routes: [{
          ...dailyRoute,
          id: "dashboard.daily-subset",
          operationIds: ["dashboard.home.activity"],
        }],
      },
      operations,
    });
    const subset = subsetResolver({ prompt: "dashboard.daily-subset", surface: "dashboard" });
    expect(subset.kind).toBe("plan");
    if (subset.kind === "plan") expect(subset.plan.detail).toBeUndefined();

    const composedResolver = createWorkflowResolver({
      catalog: {
        ...catalog,
        controls: [],
        routes: [
          {
            id: "dashboard.alpha-work",
            surface: "dashboard",
            kind: "read",
            title: "Alpha quasar",
            summary: "Read alpha quasar facts.",
            examples: ["alpha quasar"],
            tags: ["alpha", "quasar"],
            workflowId: "operations.daily-snapshot.v1",
            operationIds: ["dashboard.home.activity"],
            requiresFacts: false,
            requiresConfirmation: false,
            requiresVerification: false,
            rules: [],
          },
          {
            id: "dashboard.beta-work",
            surface: "dashboard",
            kind: "read",
            title: "Beta nebula",
            summary: "Read beta nebula facts.",
            examples: ["beta nebula"],
            tags: ["beta", "nebula"],
            workflowId: "catalog.optioned-product.v1",
            operationIds: ["dashboard.products.get_section"],
            requiresFacts: false,
            requiresConfirmation: false,
            requiresVerification: false,
            rules: [],
          },
        ],
      },
      operations,
    });
    const composed = composedResolver({
      prompt: "alpha quasar; beta nebula",
      surface: "dashboard",
    });
    expect(composed.kind).toBe("plan");
    if (composed.kind === "plan") {
      expect(composed.plan.source).toBe("composed-route");
      expect(composed.plan.workflowIds).toEqual([
        "operations.daily-snapshot.v1",
        "catalog.optioned-product.v1",
      ]);
      expect(composed.plan.detail).toBeUndefined();
    }
  });

  it("compiles only one exact closed detailed read card into ordered fixed steps", () => {
    const compiled = compileWorkflowRead({
      prompt: "dashboard.daily-operations-snapshot",
      surface: "dashboard",
    });
    expect(compiled).not.toBeNull();
    if (!compiled) return;
    expect(compiled).toMatchObject({
      version: "3.0.0",
      workflowId: "operations.daily-snapshot.v1",
      phases: [{ id: "activity" }, { id: "readiness" }],
    });
    expect(compiled.phases.flatMap((phase) => phase.steps.map((step) => ({
      namespace: step.namespace,
      operationId: step.operationId,
      input: step.input,
    })))).toEqual([
      {
        namespace: "activity.daily",
        operationId: "dashboard.home.activity",
        input: { query: { days: 1 } },
      },
      {
        namespace: "activity.currency",
        operationId: "dashboard.settings.currency_get",
        input: {},
      },
      {
        namespace: "activity.fulfillment",
        operationId: "dashboard.orders.list",
        input: {
          query: {
            page: 1,
            limit: 10,
            statusGroup: "open",
            fulfillmentStatus: "pending",
            sort: "createdAt",
            order: "desc",
          },
        },
      },
      {
        namespace: "readiness.alerts",
        operationId: "dashboard.inventory_alerts.list",
        input: { query: { status: "active" } },
      },
      {
        namespace: "readiness.checkout",
        operationId: "dashboard.checkout.readiness_get",
        input: {},
      },
      {
        namespace: "readiness.payments",
        operationId: "dashboard.payments.methods_get",
        input: {},
      },
      {
        namespace: "readiness.delivery",
        operationId: "dashboard.shipping_methods.list",
        input: { query: { page: 1, limit: 100, sort: "sortOrder", order: "asc" } },
      },
    ]);
    expect(compiled.phases[0]!.steps[2]!.output.selectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pointer: "/data/orders", alias: "orderQueue", maxItems: 10 }),
      ]),
    );

    expect(compileWorkflowRead({
      prompt: "dashboard.complex-product-create",
      surface: "dashboard",
    })).toBeNull();
    expect(compileWorkflowRead({
      prompt: "dashboard.sales-today",
      surface: "dashboard",
    })).toBeNull();
  });

  it("rejects absent projections, phase metadata, and non-closed read operations", () => {
    const dailyCard = catalog.cards.find((card) => card.id === "operations.daily-snapshot.v1")!;
    const dailyInput = {
      prompt: "dashboard.daily-operations-snapshot",
      surface: "dashboard" as const,
    };
    const replaceDaily = (replacement: WorkflowResolverCard) => ({
      ...catalog,
      cards: catalog.cards.map((card) => card.id === replacement.id ? replacement : card),
    });
    const missingOutput = {
      ...dailyCard,
      phases: dailyCard.phases.map((phase, phaseIndex) => ({
        ...phase,
        steps: phase.steps.map((step, stepIndex) =>
          phaseIndex === 0 && stepIndex === 0 ? { ...step, output: undefined } : step
        ),
      })),
    };
    expect(createWorkflowReadCompiler({
      catalog: replaceDaily(missingOutput),
      operations,
    })(dailyInput)).toBeNull();

    const missingDependencies = {
      ...dailyCard,
      phases: dailyCard.phases.map((phase, phaseIndex) =>
        phaseIndex === 0 ? { ...phase, dependsOn: undefined } : phase
      ),
    };
    expect(createWorkflowReadCompiler({
      catalog: replaceDaily(missingDependencies),
      operations,
    })(dailyInput)).toBeNull();

    const openWorldOperations = operations.map((operation) =>
      operation.operationId === "dashboard.orders.list"
        ? { ...operation, openWorld: true }
        : operation
    );
    expect(createWorkflowReadCompiler({
      catalog,
      operations: openWorldOperations,
    })(dailyInput)).toBeNull();
  });

  it("projects bounded scalar allowlists without carrying raw PII", () => {
    const compiled = compileWorkflowRead({
      prompt: "dashboard.daily-operations-snapshot",
      surface: "dashboard",
    })!;
    const projection = compiled.phases[0]!.steps.find((step) =>
      step.namespace === "activity.fulfillment"
    )!.output;
    const rawOrders = Array.from({ length: 12 }, (_, index) => ({
      id: `ord_${index}`,
      totalAmount: 100 + index,
      status: "processing",
      paymentStatus: "paid",
      paymentMethod: "cod",
      fulfillmentStatus: "pending",
      createdAt: "2026-08-18T00:00:00.000Z",
      itemCount: 1,
      totalQuantity: 1,
      customerName: "Private Buyer",
      email: "buyer@example.com",
      phone: "+8801700000000",
      shippingAddress: { line1: "Private address" },
    }));
    const projected = projectWorkflowReadResponse({
      data: {
        orders: rawOrders,
        pagination: { page: 1, limit: 10, total: 12, totalPages: 2 },
      },
    }, projection);
    const orderQueue = projected?.orderQueue;
    expect(Array.isArray(orderQueue)).toBe(true);
    if (!Array.isArray(orderQueue)) return;
    expect(orderQueue).toHaveLength(10);
    expect(orderQueue[0]).toEqual({
      id: "ord_0",
      totalAmount: 100,
      status: "processing",
      paymentStatus: "paid",
      paymentMethod: "cod",
      fulfillmentStatus: "pending",
      createdAt: "2026-08-18T00:00:00.000Z",
      itemCount: 1,
      totalQuantity: 1,
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /Private Buyer|buyer@example\.com|\+8801700000000|Private address/,
    );
    expect(projectWorkflowReadResponse({ data: {} }, projection)).toBeNull();
    expect(projectWorkflowReadResponse({ data: { orders: [] } }, {
      selectors: [{ pointer: "/data/__proto__/secret", alias: "unsafe" }],
    })).toBeNull();
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
    const ordinary = resolveWorkflow({
      prompt: catalog.routes.find((route) => route.id === "dashboard.sales-today")!.examples[0]!,
      surface: "dashboard",
    });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: daily }))).toBeLessThanOrEqual(12 * 1024);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: product }))).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: ordinary }))).toBeLessThanOrEqual(
      4 * 1024,
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
