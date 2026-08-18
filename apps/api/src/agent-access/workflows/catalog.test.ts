import { describe, expect, it } from "vitest";

import app from "../../app";
import { finalizeOpenApiContract, type OpenApiDocument } from "../../openapi-contract";
import { buildAgentOperationManifest } from "../../openapi/agent-operation-manifest";
import { generateAgentOperationManifestSource } from "../../openapi/generate-agent-operation-manifest";
import {
  AGENT_PRODUCT_CONSTRUCTION_RULES,
  AGENT_WORKFLOW_CATALOG_VERSION,
  CURATED_AGENT_WORKFLOW_CARDS,
  DAILY_OPERATING_SNAPSHOT_WORKFLOW,
  OPTIONED_PRODUCT_WORKFLOW,
  buildAgentWorkflowCatalog,
  validateAgentWorkflowCards,
  validateAgentWorkflowControls,
  validateAgentWorkflowCoverage,
  validateAgentWorkflowRoutes,
  type AgentWorkflowCard,
  type AgentWorkflowControl,
  type AgentWorkflowIntentRoute,
} from ".";
import type { AgentWorkflowStep } from "./types";

function finalizedDocument(): OpenApiDocument {
  return finalizeOpenApiContract(
    app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Workflow catalog test", version: "1.0.0" },
    }),
  ) as unknown as OpenApiDocument;
}

function mutableCard(card: AgentWorkflowCard): AgentWorkflowCard {
  return structuredClone(card);
}

function mutableRoute(route: AgentWorkflowIntentRoute): AgentWorkflowIntentRoute {
  return structuredClone(route);
}

function mutableControl(control: AgentWorkflowControl): AgentWorkflowControl {
  return structuredClone(control);
}

function workflowStep(
  card: AgentWorkflowCard,
  phaseId: string,
  stepId: string,
): AgentWorkflowStep {
  return card.phases.find((phase) => phase.id === phaseId)!
    .steps.find((step) => step.id === stepId)!;
}

describe("agent workflow catalog", () => {
  const document = finalizedDocument();
  const manifest = buildAgentOperationManifest(document);
  const catalog = buildAgentWorkflowCatalog(manifest, {
    requireCuratedCards: true,
  });

  it("attaches a stable, bounded, generation-checked root extension", () => {
    expect(document["x-scalius-workflows"]).toEqual(catalog);
    expect(catalog.version).toBe(AGENT_WORKFLOW_CATALOG_VERSION);
    expect(catalog.cards.map((card) => card.id)).toEqual([
      "catalog.optioned-product.v1",
      "operations.daily-snapshot.v1",
    ]);
    expect(catalog.routes).toHaveLength(58);
    expect(catalog.controls).toHaveLength(8);
    for (const route of catalog.routes) {
      expect(Buffer.byteLength(JSON.stringify(route)), route.id).toBeLessThanOrEqual(2 * 1024);
    }
    for (const control of catalog.controls) {
      expect(Buffer.byteLength(JSON.stringify(control)), control.id).toBeLessThanOrEqual(2 * 1024);
    }
    expect(Buffer.byteLength(JSON.stringify(OPTIONED_PRODUCT_WORKFLOW))).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(DAILY_OPERATING_SNAPSHOT_WORKFLOW))).toBeLessThanOrEqual(10 * 1024);
    const generatedSource = generateAgentOperationManifestSource(document);
    expect(generatedSource).toContain("export const AGENT_WORKFLOW_CATALOG");
    expect(generatedSource).toContain(JSON.stringify(catalog, null, 2));

    const missing = structuredClone(document);
    delete missing["x-scalius-workflows"];
    expect(() => generateAgentOperationManifestSource(missing)).toThrowError(
      /x-scalius-workflows is missing or stale/,
    );
  });

  it("deterministically covers every runnable dashboard/storefront operation", () => {
    const runnable = manifest
      .filter((operation) =>
        ["dashboard", "storefront"].includes(operation.surface) &&
        ["execute", "continuation"].includes(operation.exposure)
      )
      .map((operation) => operation.operationId)
      .sort((left, right) => left.localeCompare(right));
    const covered = catalog.coverage.operations.map((entry) => entry.operationId);

    expect(covered).toEqual(runnable);
    expect(new Set(covered).size).toBe(covered.length);
    expect(
      catalog.coverage.operations.find(
        (entry) => entry.operationId === "dashboard.products.create",
      ),
    ).toMatchObject({
      mode: "curated",
      workflowIds: [
        "catalog.optioned-product.v1",
        "dashboard.complex-product-create",
      ],
    });
    const fallback = catalog.coverage.operations.find(
      (entry) => entry.mode === "operation-fallback",
    );
    expect(fallback).toMatchObject({
      mode: "operation-fallback",
    });
    expect(fallback?.workflowIds).toEqual([`operation.${fallback?.operationId}`]);
    expect(
      buildAgentWorkflowCatalog([...manifest].reverse(), {
        requireCuratedCards: true,
      }).coverage,
    ).toEqual(catalog.coverage);

    expect(() =>
      validateAgentWorkflowCoverage(
        [...catalog.coverage.operations].reverse(),
        catalog.cards,
        catalog.routes,
        manifest,
      )
    ).toThrowError(/exactly and deterministically represent/);
  });

  it("rejects unknown, excluded, and wrong-surface operations", () => {
    const unknown = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    unknown.phases[0]!.steps[0]!.operationId = "dashboard.unknown.read";
    expect(() => validateAgentWorkflowCards([unknown], manifest)).toThrowError(
      /unknown operation dashboard.unknown.read/,
    );

    const excluded = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    excluded.phases[0]!.steps[0]!.operationId = "dashboard.products.list";
    expect(() => validateAgentWorkflowCards([excluded], manifest)).toThrowError(
      /non-runnable operation dashboard.products.list/,
    );

    const wrongSurface = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    wrongSurface.phases[1]!.surface = "storefront";
    expect(() => validateAgentWorkflowCards([wrongSurface], manifest)).toThrowError(
      /wrong surface storefront/,
    );
  });

  it("rejects bad dependencies, mutation semantics, and duplicate IDs", () => {
    const badPhaseDependency = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    badPhaseDependency.phases[1]!.dependsOn = ["missing"];
    expect(() => validateAgentWorkflowCards([badPhaseDependency], manifest)).toThrowError(
      /invalid dependency missing/,
    );

    const badTemplateDependency = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    badTemplateDependency.phases[0]!.steps[0]!.input.dependencies[0]!.templatePointer = "/query/missing";
    expect(() => validateAgentWorkflowCards([badTemplateDependency], manifest)).toThrowError(
      /dependency pointer \/query\/missing is absent/,
    );

    const badMutation = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    badMutation.phases[0]!.steps[0]!.mutation = "create";
    expect(() => validateAgentWorkflowCards([badMutation], manifest)).toThrowError(
      /create semantics incompatible/,
    );

    expect(() =>
      validateAgentWorkflowCards(
        [
          mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW),
          mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW),
        ],
        manifest,
      )
    ).toThrowError(/Duplicate workflow card ID/);
  });

  it("accepts reviewed POST operations whose manifest risk is read", () => {
    const card = mutableCard(OPTIONED_PRODUCT_WORKFLOW);
    const phase = card.phases.find((item) => item.id === "storefrontVerify")!;
    const step = phase.steps[0]!;
    step.operationId = "storefront.checkout.quote";
    step.input = {
      template: { path: { contextId: null }, body: {} },
      dependencies: [],
      defaults: [],
    };

    expect(() => validateAgentWorkflowCards([card], manifest)).not.toThrow();
  });

  it("validates fact surfaces and constant/template defaults", () => {
    const wrongFactSurface = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    const currency = wrongFactSurface.requiredFacts.find((fact) => fact.id === "currency")!;
    currency.source = {
      kind: "operation",
      operationId: "storefront.products.get_section",
      responsePointer: "/data",
    };
    expect(() => validateAgentWorkflowCards([wrongFactSurface], manifest)).toThrowError(
      /wrong source surface storefront/,
    );

    const constantMismatch = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    constantMismatch.requiredFacts.find((fact) => fact.id === "days")!.defaultValue = 2;
    expect(() => validateAgentWorkflowCards([constantMismatch], manifest)).toThrowError(
      /constant source must match its default/,
    );

    const templateMismatch = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    templateMismatch.phases[0]!.steps[0]!.input.defaults[0]!.value = 2;
    expect(() => validateAgentWorkflowCards([templateMismatch], manifest)).toThrowError(
      /default does not match its template value/,
    );

    const wildcardPointer = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    const wildcardCurrency = wildcardPointer.requiredFacts.find(
      (fact) => fact.id === "currency",
    )!;
    if (wildcardCurrency.source.kind !== "operation") {
      throw new Error("Expected the currency fact to use an operation source.");
    }
    wildcardCurrency.source.responsePointer = "/data/items/*/currency";
    expect(() => validateAgentWorkflowCards([wildcardPointer], manifest)).toThrowError(
      /invalid JSON pointer/,
    );
  });

  it("uses the reviewed daily snapshot operations and filters", () => {
    expect(
      DAILY_OPERATING_SNAPSHOT_WORKFLOW.phases.flatMap((phase) =>
        phase.steps.map((step) => step.operationId)
      ),
    ).toEqual([
      "dashboard.home.activity",
      "dashboard.settings.currency_get",
      "dashboard.orders.list",
      "dashboard.orders.payment_recovery_list",
      "dashboard.orders.payment_recovery_list",
      "dashboard.inventory_alerts.list",
      "dashboard.checkout.readiness_get",
      "dashboard.payments.methods_get",
      "dashboard.shipping_methods.list",
    ]);
    expect(DAILY_OPERATING_SNAPSHOT_WORKFLOW.phases[0]!.steps[2]!.input.template).toMatchObject({
      query: { statusGroup: "open", fulfillmentStatus: "pending" },
    });
    expect(workflowStep(
      DAILY_OPERATING_SNAPSHOT_WORKFLOW,
      "activity",
      "paymentRecovery",
    ).input.template).toEqual({ query: { page: 1, limit: 1, state: "recoverable" } });
    expect(workflowStep(
      DAILY_OPERATING_SNAPSHOT_WORKFLOW,
      "activity",
      "paymentNeedsAttention",
    ).input.template).toEqual({ query: { page: 1, limit: 1, state: "needs_attention" } });

    const dailyRoute = catalog.routes.find((route) =>
      route.id === "dashboard.daily-operations-snapshot"
    )!;
    expect(dailyRoute.operationIds.filter((operationId) =>
      operationId === "dashboard.orders.payment_recovery_list"
    )).toHaveLength(1);
    expect(dailyRoute.rules).toEqual(expect.arrayContaining([
      expect.stringContaining("activity.daily.bookedRevenue"),
      expect.stringContaining("collected-cash"),
      expect.stringContaining("activity.paymentRecovery.total"),
      expect.stringContaining("parallel reads"),
    ]));
  });

  it("projects every daily read into bounded schema-valid operational fields", () => {
    expect(() =>
      validateAgentWorkflowCards(
        [mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW)],
        manifest,
      )
    ).not.toThrow();

    const daily = DAILY_OPERATING_SNAPSHOT_WORKFLOW;
    expect(daily.phases.flatMap((phase) => phase.steps).every((step) => step.output)).toBe(true);

    const activity = workflowStep(daily, "activity", "daily").output!.selectors[0]!;
    expect(activity).toMatchObject({
      pointer: "/data/dailyActivityData",
      alias: "activity",
      maxItems: 2,
    });
    expect(activity.fields?.map((field) => field.pointer)).toEqual([
      "/date",
      "/orders",
      "/revenue",
      "/newCustomers",
    ]);
    expect(activity.fields?.map((field) => field.alias)).toEqual([
      "date",
      "orders",
      "bookedRevenue",
      "newCustomers",
    ]);
    expect(JSON.stringify(activity)).not.toContain("collectedCash");

    expect(
      workflowStep(daily, "activity", "currency").output!.selectors.map(
        (selector) => selector.alias,
      ),
    ).toEqual(["currencyCode", "currencySymbol"]);

    const fulfillment = workflowStep(daily, "activity", "fulfillment").output!;
    const orderQueue = fulfillment.selectors.find((selector) =>
      selector.alias === "orderQueue"
    )!;
    expect(orderQueue.maxItems).toBe(10);
    expect(orderQueue.fields?.map((field) => field.pointer)).toEqual([
      "/id",
      "/totalAmount",
      "/status",
      "/paymentStatus",
      "/paymentMethod",
      "/fulfillmentStatus",
      "/createdAt",
      "/itemCount",
      "/totalQuantity",
    ]);
    expect(
      fulfillment.selectors.find((selector) => selector.alias === "pagination")
        ?.fields?.map((field) => field.pointer),
    ).toEqual(["/page", "/limit", "/total", "/totalPages"]);
    for (const pii of [
      "customerName",
      "customerPhone",
      "customerEmail",
      "customerId",
      "address",
      "city",
      "zone",
      "area",
    ]) {
      expect(JSON.stringify(orderQueue)).not.toContain(pii);
    }

    for (const stepId of ["paymentRecovery", "paymentNeedsAttention"]) {
      expect(workflowStep(daily, "activity", stepId).output!.selectors).toEqual([
        { pointer: "/data/pagination/total", alias: "total" },
      ]);
      expect(JSON.stringify(workflowStep(daily, "activity", stepId).output)).not.toContain(
        "/data/orders",
      );
    }

    const alerts = workflowStep(daily, "readiness", "alerts").output!.selectors[0]!;
    expect(alerts.maxItems).toBe(20);
    expect(alerts.fields?.map((field) => field.pointer)).toEqual([
      "/productId",
      "/productName",
      "/variantId",
      "/variantSku",
      "/variantLabel",
      "/currentQty",
      "/threshold",
      "/alertStatus",
    ]);

    const checkout = workflowStep(daily, "readiness", "checkout").output!.selectors;
    expect(checkout.map((selector) => selector.alias)).toEqual([
      "ready",
      "hasActiveShippingMethod",
      "hasActiveDeliveryHierarchy",
      "customerSignInRequired",
      "hasUsableCustomerSignIn",
      "issues",
    ]);
    expect(checkout.find((selector) => selector.alias === "issues")?.maxItems).toBe(20);

    const payments = workflowStep(daily, "readiness", "payments").output!.selectors;
    expect(payments.map((selector) => selector.alias)).toEqual([
      "enabledMethods",
      "activeMethods",
      "defaultMethod",
      "activeDefaultMethod",
      "gatewayStatus",
    ]);
    expect(payments.find((selector) => selector.alias === "enabledMethods")?.maxItems).toBe(4);
    expect(payments.find((selector) => selector.alias === "activeMethods")?.maxItems).toBe(4);
    expect(
      payments.find((selector) => selector.alias === "gatewayStatus")
        ?.fields?.map((field) => field.pointer),
    ).toEqual([
      "/stripe/configured",
      "/stripe/usable",
      "/stripe/checkoutVisible",
      "/sslcommerz/configured",
      "/sslcommerz/usable",
      "/sslcommerz/checkoutVisible",
      "/polar/configured",
      "/polar/usable",
      "/polar/checkoutVisible",
      "/cod/configured",
      "/cod/usable",
      "/cod/checkoutVisible",
    ]);

    const delivery = workflowStep(daily, "readiness", "delivery").output!;
    const methods = delivery.selectors.find((selector) =>
      selector.alias === "shippingMethods"
    )!;
    expect(methods.maxItems).toBe(100);
    expect(methods.fields?.map((field) => field.pointer)).toEqual([
      "/id",
      "/name",
      "/fee",
      "/isActive",
      "/sortOrder",
    ]);
    expect(
      delivery.selectors.find((selector) => selector.alias === "pagination")
        ?.fields?.map((field) => field.pointer),
    ).toEqual(["/page", "/limit", "/total", "/totalPages"]);
  });

  it("rejects unsafe or non-declarative output projection shapes", () => {
    for (const pointer of [
      "/data/*",
      "/data/-",
      "/data/$filter",
      "/data/__proto__/polluted",
    ]) {
      const card = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
      workflowStep(card, "activity", "currency").output!.selectors[0]!.pointer = pointer;
      expect(() => validateAgentWorkflowCards([card], manifest), pointer).toThrowError(
        /invalid JSON pointer|wildcard, pseudo, or prototype/,
      );
    }

    const unknownField = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    workflowStep(unknownField, "activity", "fulfillment")
      .output!.selectors[0]!.fields![0]!.pointer = "/unknownField";
    expect(() => validateAgentWorkflowCards([unknownField], manifest)).toThrowError(
      /unknown output field/,
    );

    const duplicateAlias = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    const currencySelectors = workflowStep(duplicateAlias, "activity", "currency")
      .output!.selectors;
    currencySelectors[1]!.alias = currencySelectors[0]!.alias;
    expect(() => validateAgentWorkflowCards([duplicateAlias], manifest)).toThrowError(
      /duplicate projection alias/,
    );

    const unboundedArray = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    delete workflowStep(unboundedArray, "readiness", "checkout")
      .output!.selectors.find((selector) => selector.alias === "issues")!.maxItems;
    expect(() => validateAgentWorkflowCards([unboundedArray], manifest)).toThrowError(
      /requires bounded maxItems/,
    );

    const schemaOverflow = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    workflowStep(schemaOverflow, "activity", "daily").output!.selectors[0]!.maxItems = 91;
    expect(() => validateAgentWorkflowCards([schemaOverflow], manifest)).toThrowError(
      /maxItems exceeds the operation output schema/,
    );

    const tooManySelectors = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    const currencyOutput = workflowStep(tooManySelectors, "activity", "currency").output!;
    currencyOutput.selectors = Array.from({ length: 13 }, (_, index) => ({
      pointer: "/data/currencyCode",
      alias: `currency${index}`,
    }));
    expect(() => validateAgentWorkflowCards([tooManySelectors], manifest)).toThrowError(
      /too many output selectors/,
    );

    const tooManyFields = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    workflowStep(tooManyFields, "activity", "daily").output!.selectors[0]!.fields =
      Array.from({ length: 17 }, (_, index) => ({
        pointer: "/date",
        alias: `date${index}`,
      }));
    expect(() => validateAgentWorkflowCards([tooManyFields], manifest)).toThrowError(
      /too many selected fields/,
    );

    const hiddenArray = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    workflowStep(hiddenArray, "readiness", "payments")
      .output!.selectors.find((selector) => selector.alias === "gatewayStatus")!
      .fields![0]!.pointer = "/stripe/missingFields";
    expect(() => validateAgentWorkflowCards([hiddenArray], manifest)).toThrowError(
      /must select one scalar output field/,
    );

    const filterLanguage = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
    Object.assign(
      workflowStep(filterLanguage, "activity", "daily").output!.selectors[0]!,
      { filter: "item.status === 'paid'" },
    );
    expect(() => validateAgentWorkflowCards([filterLanguage], manifest)).toThrowError(
      /unsupported declarative key filter/,
    );
  });

  it("makes product construction and conditional outputs explicit", () => {
    expect(OPTIONED_PRODUCT_WORKFLOW.constructionRules).toEqual(
      AGENT_PRODUCT_CONSTRUCTION_RULES,
    );
    const category = OPTIONED_PRODUCT_WORKFLOW.requiredFacts.find(
      (fact) => fact.id === "categoryId",
    )!;
    expect(category.source).toMatchObject({
      kind: "operation",
      alternatives: [
        { operationId: "dashboard.categories.create", responsePointer: "/data/id" },
      ],
    });
    const media = OPTIONED_PRODUCT_WORKFLOW.phases.find((phase) => phase.id === "media")!;
    expect(media.steps.map((step) => step.id)).toEqual(["asset"]);
    expect(media.steps[0]).toMatchObject({
      operationId: "dashboard.media.import_url",
      condition: expect.stringContaining("dashboard.media-upload"),
      input: { dependencies: [] },
      repeat: {
        factId: "mediaSet",
        orderPointer: "/order",
        itemMapPointer: "/byId",
        minItems: 1,
        maxItems: 250,
        bindings: [{ templatePointer: "/body/sourceUrl", itemPointer: "/sourceUrl" }],
        capture: { responsePointer: "/data/file/id", itemPointer: "/mediaId" },
      },
    });
    const product = OPTIONED_PRODUCT_WORKFLOW.phases.find((phase) => phase.id === "create")!
      .steps[0]!;
    expect((product.input.template as { body: { media: unknown } }).body.media).toBeNull();
    expect(product.input.dependencies.some((dependency) =>
      dependency.templatePointer.startsWith("/body/media/")
    )).toBe(false);
    const publish = OPTIONED_PRODUCT_WORKFLOW.phases.find((phase) => phase.id === "publish")!;
    expect(publish.steps.map((step) => step.id)).toEqual(["category", "readiness", "status"]);
  });

  it("models shared, Navy, and White media by exact associations without positional inference", () => {
    const mediaSet = {
      order: ["pmed_shared_primary", "pmed_navy", "pmed_white"],
      byId: {
        pmed_shared_primary: { mediaId: "media_shared", isPrimary: true },
        pmed_navy: { mediaId: "media_navy", isPrimary: false },
        pmed_white: { mediaId: "media_white", isPrimary: false },
      },
    } as const;
    const variantRows = [
      ["Navy", "S", "pmed_navy"],
      ["Navy", "M", "pmed_navy"],
      ["Navy", "L", "pmed_navy"],
      ["White", "S", "pmed_white"],
      ["White", "M", "pmed_white"],
      ["White", "L", "pmed_white"],
    ];
    const associationIds = new Set<string>(mediaSet.order);
    const assets = Object.values(mediaSet.byId);

    expect(assets.filter((asset) => asset.isPrimary)).toHaveLength(1);
    expect(new Set(assets.map((asset) => asset.mediaId)).size).toBe(mediaSet.order.length);
    expect(variantRows.every((row) => associationIds.has(row[2]!))).toBe(true);
    expect(new Set(variantRows.filter((row) => row[0] === "Navy").map((row) => row[2]))).toEqual(
      new Set(["pmed_navy"]),
    );
    expect(new Set(variantRows.filter((row) => row[0] === "White").map((row) => row[2]))).toEqual(
      new Set(["pmed_white"]),
    );

    const mediaFact = OPTIONED_PRODUCT_WORKFLOW.requiredFacts.find(
      (fact) => fact.id === "mediaSet",
    )!;
    expect(mediaFact.description).toContain("byId:{pmed:");
    expect(mediaFact.description).toContain("1-250 unique assets");
    expect(mediaFact.description).not.toContain("localFile");
    expect(mediaFact.nonInferenceRule).toContain("never infer count, order, role, or position");
    const mediaStep = OPTIONED_PRODUCT_WORKFLOW.phases.find((phase) => phase.id === "media")!
      .steps[0]!;
    expect(mediaStep.condition).toContain(
      "local files must complete dashboard.media-upload and re-enter as ready.",
    );
    const product = OPTIONED_PRODUCT_WORKFLOW.phases.find((phase) => phase.id === "create")!
      .steps[0]!;
    expect(product.condition).toContain("exact pmed key/mediaId");
    expect(product.policies.nonInferenceRules).toContain(
      "Every variant imageId must equal a mediaSet pmed key; never map by position.",
    );
    expect(JSON.stringify(product)).not.toMatch(/pmed_(?:primary|secondary)|\/body\/media\/\d/u);
  });

  it("rejects malformed, ambiguous, or schema-unsafe repeat contracts", () => {
    const cases: Array<[string, (card: AgentWorkflowCard) => void, RegExp]> = [
      ["pseudo dependency", (card) => {
        workflowStep(card, "media", "asset").input.dependencies = [{
          templatePointer: "/body/sourceUrl",
          source: {
            kind: "fact",
            factId: "mediaSet",
            factPointer: "/byId/{associationId}/sourceUrl",
          },
        }];
      }, /invalid JSON pointer/],
      ["pseudo repeat pointer", (card) => {
        workflowStep(card, "media", "asset").repeat!.orderPointer = "/{associationId}";
      }, /wildcard, pseudo, or prototype JSON pointer segment|invalid JSON pointer/],
      ["unknown fact", (card) => {
        workflowStep(card, "media", "asset").repeat!.factId = "missingFact";
      }, /repeat references unknown fact/],
      ["non-merchant fact", (card) => {
        workflowStep(card, "media", "asset").repeat!.factId = "categoryId";
      }, /must be merchant-authoritative/],
      ["bad lower bound", (card) => {
        workflowStep(card, "media", "asset").repeat!.minItems = 0;
      }, /repeat bounds/],
      ["bad upper bound", (card) => {
        workflowStep(card, "media", "asset").repeat!.maxItems = 251;
      }, /repeat bounds/],
      ["duplicate binding", (card) => {
        const repeat = workflowStep(card, "media", "asset").repeat!;
        repeat.bindings.push({ ...repeat.bindings[0]! });
      }, /duplicate binding pointers/],
      ["missing binding target", (card) => {
        workflowStep(card, "media", "asset").repeat!.bindings[0]!.templatePointer =
          "/body/missing";
      }, /absent from its template/],
      ["unknown capture", (card) => {
        workflowStep(card, "media", "asset").repeat!.capture.responsePointer =
          "/data/file/missing";
      }, /references unknown output field/],
      ["non-scalar capture", (card) => {
        workflowStep(card, "media", "asset").repeat!.capture.responsePointer = "/data/file";
      }, /must select one scalar output field/],
      ["extra declarative key", (card) => {
        Object.assign(workflowStep(card, "media", "asset").repeat!, { filter: "/ready" });
      }, /unsupported declarative key filter/],
    ];

    for (const [name, mutate, error] of cases) {
      const card = mutableCard(OPTIONED_PRODUCT_WORKFLOW);
      mutate(card);
      expect(
        () => validateAgentWorkflowCards([card], manifest),
        name,
      ).toThrowError(error);
    }
  });

  it("scopes feed verification to evidence the bounded operations actually expose", () => {
    const dashboard = OPTIONED_PRODUCT_WORKFLOW.phases.find(
      (phase) => phase.id === "dashboardVerify",
    )!;
    expect(dashboard.stopConditions).toContain(
      "No bounded product/SKU feed-row read exists; do not claim emitted price/image/availability.",
    );
    expect(OPTIONED_PRODUCT_WORKFLOW.verification.find((item) => item.id === "feed")?.proves)
      .toEqual([
        "Feed policy, eligibility totals, and sampled exclusions only.",
      ]);
    expect(OPTIONED_PRODUCT_WORKFLOW.verification.find((item) => item.id === "buyer")?.proves)
      .toEqual([
        "Buyer SKU price, exact image, and availability band; excludes feed rows.",
      ]);
  });

  it("rejects revision, idempotency, and confirmation policy drift", () => {
    const policyCases = [
      ["revision", "required", /revision policy does not match/],
      ["idempotency", "supported", /idempotency policy does not match/],
      ["confirmation", "required", /confirmation policy does not match/],
    ] as const;

    for (const [policy, value, error] of policyCases) {
      const card = mutableCard(DAILY_OPERATING_SNAPSHOT_WORKFLOW);
      Object.assign(card.phases[0]!.steps[0]!.policies, { [policy]: value });
      expect(() => validateAgentWorkflowCards([card], manifest)).toThrowError(error);
    }
  });

  it("rejects unsafe, ambiguous, and stale compact routes", () => {
    const source = catalog.routes.find((route) => route.id === "dashboard.sales-today")!;

    const unknown = mutableRoute(source);
    unknown.operationIds[0] = "dashboard.unknown.read";
    expect(() => validateAgentWorkflowRoutes([unknown], catalog.cards, manifest)).toThrowError(
      /unknown operation dashboard\.unknown\.read/,
    );

    const wrongSurface = mutableRoute(source);
    wrongSurface.surface = "storefront";
    expect(() => validateAgentWorkflowRoutes([wrongSurface], catalog.cards, manifest)).toThrowError(
      /wrong-surface operation/,
    );

    const badKind = mutableRoute(source);
    badKind.kind = "write";
    expect(() => validateAgentWorkflowRoutes([badKind], catalog.cards, manifest)).toThrowError(
      /kind does not match/,
    );

    const staleCard = mutableRoute(
      catalog.routes.find((route) => route.id === "dashboard.complex-product-create")!,
    );
    staleCard.workflowId = "catalog.missing.v1";
    expect(() => validateAgentWorkflowRoutes([staleCard], catalog.cards, manifest)).toThrowError(
      /unknown card catalog\.missing\.v1/,
    );

    expect(() => validateAgentWorkflowRoutes([source, source], catalog.cards, manifest)).toThrowError(
      /Duplicate workflow route ID/,
    );
  });

  it("rejects malformed or cross-surface safety controls", () => {
    const source = catalog.controls.find((control) =>
      control.id === "storefront.no-exact-stock"
    )!;

    const missingTrigger = mutableControl(source);
    missingTrigger.trigger.allOf = [];
    expect(() => validateAgentWorkflowControls([missingTrigger], manifest)).toThrowError(
      /invalid trigger groups/,
    );

    const wrongSurface = mutableControl(source);
    wrongSurface.safeOperationIds = ["dashboard.products.stats"];
    expect(() => validateAgentWorkflowControls([wrongSurface], manifest)).toThrowError(
      /wrong-surface safe operation/,
    );

    const overlap = mutableControl(source);
    overlap.forbiddenOperationIds = [...overlap.safeOperationIds];
    expect(() => validateAgentWorkflowControls([overlap], manifest)).toThrowError(
      /overlapping safe and forbidden operations/,
    );

    expect(() => validateAgentWorkflowControls([source, source], manifest)).toThrowError(
      /Duplicate workflow control ID/,
    );
  });

  it("keeps only the two reviewed curated cards", () => {
    expect(CURATED_AGENT_WORKFLOW_CARDS).toEqual([
      OPTIONED_PRODUCT_WORKFLOW,
      DAILY_OPERATING_SNAPSHOT_WORKFLOW,
    ]);
  });
});
