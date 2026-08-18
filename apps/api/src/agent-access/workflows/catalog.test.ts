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
  validateAgentWorkflowCoverage,
  type AgentWorkflowCard,
} from ".";

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
    expect(Buffer.byteLength(JSON.stringify(OPTIONED_PRODUCT_WORKFLOW))).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(DAILY_OPERATING_SNAPSHOT_WORKFLOW))).toBeLessThanOrEqual(8 * 1024);
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
      workflowIds: ["catalog.optioned-product.v1"],
    });
    expect(
      catalog.coverage.operations.find(
        (entry) => entry.operationId === "dashboard.products.stats",
      ),
    ).toMatchObject({
      mode: "operation-fallback",
      workflowIds: ["operation.dashboard.products.stats"],
    });
    expect(
      buildAgentWorkflowCatalog([...manifest].reverse(), {
        requireCuratedCards: true,
      }).coverage,
    ).toEqual(catalog.coverage);

    expect(() =>
      validateAgentWorkflowCoverage(
        [...catalog.coverage.operations].reverse(),
        catalog.cards,
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
      "dashboard.inventory_alerts.list",
      "dashboard.checkout.readiness_get",
      "dashboard.payments.methods_get",
      "dashboard.shipping_methods.list",
    ]);
    expect(DAILY_OPERATING_SNAPSHOT_WORKFLOW.phases[0]!.steps[2]!.input.template).toMatchObject({
      query: { statusGroup: "open", fulfillmentStatus: "pending" },
    });
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
    expect(media.steps.map((step) => step.id)).toEqual(["primary", "secondary"]);
    const product = OPTIONED_PRODUCT_WORKFLOW.phases.find((phase) => phase.id === "create")!
      .steps[0]!;
    expect(
      product.input.dependencies
        .filter((dependency) => dependency.source.kind === "step")
        .map((dependency) => dependency.source.kind === "step" && dependency.source.stepId),
    ).toEqual(["primary", "secondary"]);
    const publish = OPTIONED_PRODUCT_WORKFLOW.phases.find((phase) => phase.id === "publish")!;
    expect(publish.steps.map((step) => step.id)).toEqual(["category", "readiness", "status"]);
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

  it("keeps only the two reviewed curated cards", () => {
    expect(CURATED_AGENT_WORKFLOW_CARDS).toEqual([
      OPTIONED_PRODUCT_WORKFLOW,
      DAILY_OPERATING_SNAPSHOT_WORKFLOW,
    ]);
  });
});
