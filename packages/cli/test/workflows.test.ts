import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import type { OpenApiDocument, OpenApiOperation } from "../src/types.js";
import resolveWorkflow, { prepareWorkflowRead } from "../src/workflows.js";
import { AGENT_INTENT_EVAL_CASES } from "./fixtures/agent-intents.js";

type TestCatalog = {
  version: string;
  cards: unknown[];
  routes: Array<Record<string, unknown>>;
  controls: Array<Record<string, unknown>>;
  coverage: { operations: Array<Record<string, unknown>> };
  [key: string]: unknown;
};

type MutableWorkflowOutputSelector = {
  pointer: string;
  alias: string;
  maxItems?: number;
  fields?: Array<{ pointer: string; alias: string }>;
};

type MutableWorkflowCard = {
  id: string;
  phases: Array<{
    id: string;
    dependsOn: string[];
    steps: Array<{
      id: string;
      output?: { selectors: MutableWorkflowOutputSelector[] };
    }>;
  }>;
};

async function loadLiveDocument(): Promise<OpenApiDocument> {
  const path = fileURLToPath(new URL("../../api-client/openapi.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as OpenApiDocument;
}

function operation(
  operationId: string,
  surface: "dashboard" | "storefront",
  risk: "read" | "write" = "read",
  summary = operationId,
): OpenApiOperation {
  return {
    operationId,
    summary,
    description: `${summary}.`,
    tags: operationId.split(".").slice(1, 2),
    ...(risk === "write" ? { requestBody: { required: true } } : {}),
    "x-scalius-agent": {
      surface,
      exposure: "execute",
      principals: surface === "dashboard" ? ["admin"] : ["visitor"],
      risk,
      openWorld: false,
      idempotency: "none",
      revision: "none",
      batch: risk === "read" ? "parallel" : "forbidden",
      transport: "json",
      maximumResponseBytes: 16_384,
      maxRequestBytes: 16_384,
      sensitiveOutput: false,
      oneTimeSecretOutput: false,
    },
  };
}

function route(): Record<string, unknown> {
  return {
    id: "dashboard.sales-today",
    surface: "dashboard",
    kind: "read",
    title: "Read today's booked sales",
    summary: "Return today's booked sales and order count from merchant-calendar activity.",
    examples: ["What are today's booked sales and order count?"],
    tags: ["sales", "orders", "today"],
    operationIds: ["dashboard.home.activity"],
    requiresFacts: false,
    requiresConfirmation: false,
    requiresVerification: false,
    rules: ["Describe the amount as booked sales, not profit."],
  };
}

function control(): Record<string, unknown> {
  return {
    id: "storefront.no-exact-stock",
    surface: "storefront",
    title: "Protect exact inventory",
    summary: "Buyer surfaces expose availability bands, not exact stock quantities.",
    examples: ["Tell the buyer the exact units remaining for this variant."],
    tags: ["inventory", "availability"],
    disposition: "refuse",
    reasonCode: "exact_stock_not_buyer_visible",
    trigger: {
      allOf: [
        ["exact units", "exact stock"],
        ["buyer", "variant"],
      ],
      ignoreWhenNegated: true,
    },
    safeOperationIds: ["storefront.products.get_section"],
    forbiddenOperationIds: ["dashboard.inventory.list"],
    requiresFacts: true,
    requiresConfirmation: false,
    requiresVerification: false,
    rules: ["Return only buyer-visible availabilityBand.", "Do not expose dashboard stock."],
  };
}

function catalog(): TestCatalog {
  return {
    version: "2.0.0",
    cards: [],
    routes: [route()],
    controls: [control()],
    coverage: {
      operations: [
        "dashboard.home.activity",
        "dashboard.inventory.list",
        "dashboard.inventory_alerts.list",
        "storefront.products.get_section",
      ].map((operationId) => ({
        operationId,
        surface: operationId.startsWith("storefront.") ? "storefront" : "dashboard",
        mode: operationId === "dashboard.home.activity" || operationId === "storefront.products.get_section"
          ? "curated"
          : "operation-fallback",
        workflowIds: [operationId === "dashboard.home.activity"
          ? "dashboard.sales-today"
          : `operation.${operationId}`],
      })),
    },
  };
}

function document(override?: (catalog: TestCatalog) => void): OpenApiDocument {
  const workflows = catalog();
  override?.(workflows);
  return {
    openapi: "3.1.0",
    paths: {
      "/api/v1/admin/home/activity": {
        get: operation("dashboard.home.activity", "dashboard", "read", "Read daily booked sales"),
      },
      "/api/v1/admin/inventory": {
        get: operation("dashboard.inventory.list", "dashboard", "read", "List inventory"),
      },
      "/api/v1/admin/inventory/alerts": {
        get: operation("dashboard.inventory_alerts.list", "dashboard", "read", "List inventory alerts"),
      },
      "/api/v1/storefront/products/{id}": {
        get: operation("storefront.products.get_section", "storefront", "read", "Read product availability"),
      },
    },
    "x-scalius-workflows": workflows,
  };
}

function expectInvalidOpenApi(run: () => unknown): void {
  try {
    run();
    throw new Error("Expected invalid OpenAPI contract.");
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ exitCode: 8, errorCode: "invalid_openapi" });
  }
}

function mutableWorkflowCard(document: OpenApiDocument, id: string): MutableWorkflowCard {
  const extension = document["x-scalius-workflows"] as { cards: MutableWorkflowCard[] };
  const card = extension.cards.find((candidate) => candidate.id === id);
  if (!card) throw new Error(`Missing workflow card ${id}.`);
  return card;
}

function mutableWorkflowStep(
  card: MutableWorkflowCard,
  phaseId: string,
  stepId: string,
): MutableWorkflowCard["phases"][number]["steps"][number] {
  const phase = card.phases.find((candidate) => candidate.id === phaseId);
  const step = phase?.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Missing workflow step ${phaseId}.${stepId}.`);
  return step;
}

describe("CLI workflow resolver adapter", () => {
  it("accepts the checked-in live catalog and preserves all 65 reviewed outcomes", async () => {
    const liveDocument = await loadLiveDocument();

    for (const testCase of AGENT_INTENT_EVAL_CASES) {
      const result = resolveWorkflow(liveDocument, {
        prompt: testCase.prompt,
        surface: testCase.surface,
      });
      const operationIds = result.kind === "plan"
        ? result.plan.operationIds
        : result.kind === "control"
          ? result.safePlan?.operationIds ?? []
          : [];
      expect(result.disposition, testCase.id).toBe(testCase.expectedDisposition ?? "execute");
      expect(operationIds, testCase.id).toEqual(testCase.expectedOperationIds);
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength, testCase.id)
        .toBeLessThanOrEqual(16 * 1024);
    }
  });

  it("returns validated live product and daily card detail without the catalog", async () => {
    const liveDocument = await loadLiveDocument();
    const productCase = AGENT_INTENT_EVAL_CASES.find((testCase) =>
      testCase.id === "dashboard.complex-product-create"
    )!;
    const product = resolveWorkflow(liveDocument, {
      prompt: productCase.prompt,
      surface: productCase.surface,
    });
    expect(product.kind).toBe("plan");
    if (product.kind !== "plan") return;
    const detail = product.plan.detail;
    expect(detail).toBeDefined();
    if (!detail) return;

    expect(detail.constructionRules).toMatchObject({
      mediaAssociationIds: "caller-local-pmed",
      variantImageReferences: "pmed-association-id",
      selectedOptionValueOrder: "merchant-axis-order",
      variantMatrix: "complete",
      inventoryAuthority: "variant-only-no-product-stock",
      createMode: "single-atomic-products.create",
    });
    expect(detail.requiredFacts.find((fact) => fact.id === "optionMatrix")).toMatchObject({
      description: "Ordered axes/values and complete SKU price, stock, and pmed image rows.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule: "Never add, omit, collapse, or reorder combinations.",
    });
    const create = detail.steps.find((step) =>
      step.operationId === "dashboard.products.create"
    );
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
        idempotency: "none",
        confirmation: "required",
        nonInferenceRules: ["Use resolved or merchant facts only."],
      },
    });
    expect(detail.steps.filter((step) => step.operationId === "dashboard.products.create"))
      .toHaveLength(1);
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
    expect(new TextEncoder().encode(JSON.stringify({ ok: true, result: product })).byteLength)
      .toBeLessThanOrEqual(16 * 1024);

    const dailyCase = AGENT_INTENT_EVAL_CASES.find((testCase) =>
      testCase.id === "dashboard.daily-operations-snapshot"
    )!;
    const daily = resolveWorkflow(liveDocument, {
      prompt: dailyCase.prompt,
      surface: dailyCase.surface,
    });
    expect(daily.kind).toBe("plan");
    if (daily.kind === "plan") {
      expect(daily.plan.detail?.requiredFacts.find((fact) => fact.id === "days")).toMatchObject({
        description: "Use 1 today; use 2 and select the earlier key yesterday.",
        defaultValue: 1,
        source: { kind: "constant", value: 1 },
      });
    }

    const serialized = JSON.stringify(product);
    for (const wholesaleKey of ["cards", "routes", "controls", "coverage", "examples", "tags"]) {
      expect(serialized).not.toContain(`"${wholesaleKey}":`);
    }
  });

  it("prepares the exact fixed daily read with bounded inputs and output projections", async () => {
    const prepared = prepareWorkflowRead(await loadLiveDocument(), {
      prompt: "dashboard.daily-operations-snapshot",
      surface: "dashboard",
    });

    expect(prepared).toMatchObject({
      version: "3.0.0",
      workflowId: "operations.daily-snapshot.v1",
      phases: [
        {
          id: "activity",
          steps: [
            {
              namespace: "activity.daily",
              operationId: "dashboard.home.activity",
              input: { query: { days: 1 } },
              output: {
                selectors: [{
                  pointer: "/data/dailyActivityData",
                  alias: "activity",
                  maxItems: 2,
                }],
              },
            },
            {
              namespace: "activity.currency",
              operationId: "dashboard.settings.currency_get",
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
          ],
        },
        {
          id: "readiness",
          steps: [
            { namespace: "readiness.alerts", operationId: "dashboard.inventory_alerts.list" },
            { namespace: "readiness.checkout", operationId: "dashboard.checkout.readiness_get" },
            { namespace: "readiness.payments", operationId: "dashboard.payments.methods_get" },
            { namespace: "readiness.delivery", operationId: "dashboard.shipping_methods.list" },
          ],
        },
      ],
    });
    expect(prepared?.phases.flatMap((phase) => phase.steps)).toHaveLength(7);
    expect(JSON.stringify(prepared)).not.toContain('"cards"');
    expect(new TextEncoder().encode(JSON.stringify(prepared)).byteLength).toBeLessThan(8 * 1024);
  });

  it("rejects malformed reviewed output projections and phase dependencies", async () => {
    const mutations: Array<[string, (card: MutableWorkflowCard) => void]> = [
      ["prototype selector alias", (card) => {
        mutableWorkflowStep(card, "activity", "daily").output!.selectors[0]!.alias = "__proto__";
      }],
      ["wildcard pointer", (card) => {
        mutableWorkflowStep(card, "activity", "daily").output!.selectors[0]!.pointer = "/data/*";
      }],
      ["unknown response field", (card) => {
        mutableWorkflowStep(card, "activity", "daily").output!.selectors[0]!.pointer = "/data/missing";
      }],
      ["schema maxItems overflow", (card) => {
        mutableWorkflowStep(card, "activity", "daily").output!.selectors[0]!.maxItems = 91;
      }],
      ["duplicate selected field alias", (card) => {
        const fields = mutableWorkflowStep(card, "activity", "daily").output!.selectors[0]!.fields!;
        fields[1]!.alias = fields[0]!.alias;
      }],
      ["forward phase dependency", (card) => {
        card.phases[0]!.dependsOn = ["readiness"];
      }],
    ];

    for (const [name, mutate] of mutations) {
      const liveDocument = await loadLiveDocument();
      mutate(mutableWorkflowCard(liveDocument, "operations.daily-snapshot.v1"));
      try {
        expectInvalidOpenApi(() => resolveWorkflow(liveDocument, {
          prompt: "dashboard.daily-operations-snapshot",
          surface: "dashboard",
        }));
      } catch (error) {
        throw new Error(`Malformed case '${name}' was not rejected.`, { cause: error });
      }
    }
  });

  it("rejects malformed nested live card detail as invalid OpenAPI", async () => {
    const liveDocument = await loadLiveDocument();
    const extension = liveDocument["x-scalius-workflows"] as {
      cards: Array<{ phases: Array<{ steps: Array<{ policies: unknown }> }> }>;
    };
    extension.cards[0]!.phases[0]!.steps[0]!.policies = null;

    expectInvalidOpenApi(() => resolveWorkflow(liveDocument, {
      prompt: "dashboard.complex-product-create",
      surface: "dashboard",
    }));
  });

  it("resolves an exact route without returning the catalog", () => {
    const result = resolveWorkflow(document(), {
      prompt: "dashboard.sales-today",
      surface: "dashboard",
    });

    expect(result).toMatchObject({
      kind: "plan",
      disposition: "execute",
      version: "2.0.0",
      plan: {
        source: "route",
        routeIds: ["dashboard.sales-today"],
        operationIds: ["dashboard.home.activity"],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('"routes"');
    expect(serialized).not.toContain('"controls"');
    expect(serialized).not.toContain('"coverage"');
    expect(serialized).not.toContain('"cards"');
  });

  it("resolves a natural-language paraphrase through the generated core", () => {
    const result = resolveWorkflow(document(), {
      prompt: "Give me today's revenue total and number of orders",
      surface: "dashboard",
    });

    expect(result).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { source: "route", operationIds: ["dashboard.home.activity"] },
    });
  });

  it("uses the exact live operation fallback when no curated route owns it", () => {
    const result = resolveWorkflow(document(), {
      prompt: "dashboard.inventory_alerts.list",
      surface: "dashboard",
    });

    expect(result).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: {
        source: "operation-fallback",
        operationIds: ["dashboard.inventory_alerts.list"],
      },
    });
  });

  it("returns unsupported for an unrelated request", () => {
    expect(resolveWorkflow(document(), {
      prompt: "Compose a symphony about lunar geology",
      surface: "dashboard",
    })).toMatchObject({
      kind: "unsupported",
      disposition: "unsupported",
      classification: { code: "no_supported_workflow" },
    });
  });

  it("returns a refusal control with bounded safe evidence", () => {
    expect(resolveWorkflow(document(), {
      prompt: "Tell the buyer the exact units remaining for this variant",
      surface: "storefront",
    })).toMatchObject({
      kind: "control",
      disposition: "refuse",
      classification: { controlId: "storefront.no-exact-stock" },
      safePlan: { operationIds: ["storefront.products.get_section"] },
      forbiddenOperationIds: ["dashboard.inventory.list"],
    });
  });

  it("rejects malformed and oversized workflow extensions consistently", () => {
    const malformed = document();
    malformed["x-scalius-workflows"] = { version: "2.0.0", routes: "invalid", controls: [] };
    expectInvalidOpenApi(() => resolveWorkflow(malformed, {
      prompt: "dashboard.sales-today",
      surface: "dashboard",
    }));

    const oversized = document((workflows) => {
      workflows.padding = "x".repeat(512 * 1024);
    });
    expectInvalidOpenApi(() => resolveWorkflow(oversized, {
      prompt: "dashboard.sales-today",
      surface: "dashboard",
    }));
  });

  it("enforces collection limits and unique stable IDs", () => {
    const tooManyRoutes = document((workflows) => {
      workflows.routes = Array.from({ length: 201 }, () => route());
    });
    expectInvalidOpenApi(() => resolveWorkflow(tooManyRoutes, {
      prompt: "dashboard.sales-today",
      surface: "dashboard",
    }));

    const duplicate = document((workflows) => {
      workflows.controls = [{ ...control(), id: "dashboard.sales-today", surface: "dashboard" }];
    });
    expectInvalidOpenApi(() => resolveWorkflow(duplicate, {
      prompt: "dashboard.sales-today",
      surface: "dashboard",
    }));
  });

  it("rejects every catalog reference to a missing or excluded operation", () => {
    const missing = document((workflows) => {
      workflows.routes[0]!.operationIds = ["dashboard.orders.missing"];
    });
    expectInvalidOpenApi(() => resolveWorkflow(missing, {
      prompt: "dashboard.sales-today",
      surface: "dashboard",
    }));
  });

  it("keeps every successful resolver result below the compact-output limit", () => {
    const results = [
      resolveWorkflow(document(), { prompt: "dashboard.sales-today", surface: "dashboard" }),
      resolveWorkflow(document(), { prompt: "dashboard.inventory_alerts.list", surface: "dashboard" }),
      resolveWorkflow(document(), {
        prompt: "Tell the buyer the exact units remaining for this variant",
        surface: "storefront",
      }),
    ];

    for (const result of results) {
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(16 * 1024);
    }
  });
});
