import { describe, expect, it } from "vitest";

import {
  AGENT_INTENT_EVAL_CASES,
  BANGLADESH_SETUP_ADVERSARIAL_CASES,
} from "../../../../../packages/cli/test/fixtures/agent-intents";
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

function createSyntheticWriteResolver(input: {
  id: string;
  title: string;
  summary: string;
  tags: string[];
}) {
  const operationId = `dashboard.synthetic.${input.id}`;
  return createWorkflowResolver({
    catalog: {
      version: "compound-guard-test",
      cards: [],
      controls: [],
      routes: [{
        id: `dashboard.synthetic-${input.id}`,
        surface: "dashboard",
        kind: "write",
        title: input.title,
        summary: input.summary,
        examples: ["Run this reviewed synthetic write."],
        tags: input.tags,
        operationIds: [operationId],
        requiresFacts: true,
        requiresConfirmation: true,
        requiresVerification: true,
        rules: ["Preserve unrelated state."],
      }],
    },
    operations: [
      {
        operationId,
        surface: "dashboard",
        exposure: "execute",
        risk: "write",
        summary: input.title,
        description: input.summary,
        tags: input.tags,
        inputSchema: { type: "object" },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        operationId: `dashboard.synthetic.decoy_${index}`,
        surface: "dashboard",
        exposure: "execute",
        risk: "read",
        summary: `Observe quasar nebula ${index}`,
        description: "Read unrelated astronomy facts.",
        tags: ["astronomy"],
        inputSchema: {},
      })),
    ],
  });
}

describe("reviewed agent workflow resolver", () => {
  it("returns the exact smallest reviewed outcome for every reviewed case", () => {
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
          expect(resolution.classification.controlId, testCase.id).toBe(
            testCase.expectedControlId ?? testCase.id,
          );
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
          expect(resolution.plan.routeIds, testCase.id).toEqual([
            testCase.expectedRouteId ?? testCase.id,
          ]);
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

  it.each([
    "Make a shirt with sizes and colors, unique SKUs, images per color, and publish it.",
    "Create a published shirt with rich copy, slug, canonical path, SEO, saved condition, and base price; Size S/M/L by Color Navy/White with six exact SKUs, prices, and stocks; three distinct assets for shared primary, Navy, and White with exact alt text and roles; Cotton attribute and conditional category creation; sitemap and feed inclusion; bounded admin and storefront verification.",
    "Create an optioned jacket with size and color lists, exact SKU prices and stock, product images and meta description, then publish its category and verify the storefront.",
  ])("preserves one reviewed rich-product workflow for coherent specifications", (prompt) => {
    const resolution = resolveWorkflow({ surface: "dashboard", prompt });
    expect(resolution).toMatchObject({
      kind: "plan",
      plan: {
        source: "route",
        routeIds: ["dashboard.complex-product-create"],
      },
    });
  });

  it("fails conditional guest checkout closed on authoritative payment or delivery gaps", () => {
    const resolution = resolveWorkflow({
      surface: "dashboard",
      prompt: "Enable guest checkout only if payment and shipping really work, preserving everything else.",
    });
    expect(resolution.kind).toBe("plan");
    if (resolution.kind !== "plan") return;
    expect(resolution.plan).toMatchObject({
      routeIds: ["dashboard.guest-checkout-conditional-enable"],
      requiresFacts: true,
      requiresConfirmation: true,
      requiresVerification: true,
    });
    expect(resolution.plan.operationIds).toEqual([
      "dashboard.checkout.flow_get",
      "dashboard.checkout.readiness_get",
      "dashboard.payments.methods_get",
      "dashboard.shipping_methods.list",
      "dashboard.checkout.flow_update",
      "storefront.checkout.get_config",
    ]);
    expect(resolution.plan.rules).toEqual(expect.arrayContaining([
      expect.stringContaining("active buyer-usable payment method"),
      expect.stringContaining("Fail closed without a change"),
      expect.stringContaining("Merge only the guest-checkout field"),
    ]));
  });

  it("keeps the accepted campaign subset guidance-only and closed to overreach", () => {
    const expectedRouteId = "dashboard.campaign-content-supported-setup";
    for (const caseId of [expectedRouteId, `${expectedRouteId}-paraphrase`]) {
      const testCase = AGENT_INTENT_EVAL_CASES.find((candidate) => candidate.id === caseId)!;
      const resolution = resolveWorkflow({ prompt: testCase.prompt, surface: testCase.surface });
      expect(resolution, caseId).toMatchObject({
        kind: "plan",
        disposition: "execute",
        plan: {
          source: "route",
          routeIds: [expectedRouteId],
          workflowIds: [],
          operationIds: testCase.expectedOperationIds,
          requiresFacts: true,
          requiresConfirmation: true,
          requiresVerification: true,
        },
      });
      if (resolution.kind !== "plan") continue;
      expect(Object.hasOwn(resolution.plan, "detail"), caseId).toBe(false);
      const operationIds = resolution.plan.operationIds;
      expect(operationIds.indexOf("dashboard.content.create"), caseId).toBeLessThan(
        operationIds.indexOf("dashboard.content.get"),
      );
      expect(operationIds.indexOf("dashboard.content.get"), caseId).toBeLessThan(
        operationIds.indexOf("dashboard.content.bulk_publish"),
      );
      expect(operationIds.indexOf("dashboard.media.list"), caseId).toBeLessThan(
        operationIds.indexOf("dashboard.media.import_url"),
      );
      expect(operationIds.indexOf("dashboard.media.import_url"), caseId).toBeLessThan(
        operationIds.indexOf("dashboard.content.create"),
      );
      expect(operationIds.indexOf("dashboard.navigation.items_search"), caseId).toBeLessThan(
        operationIds.indexOf("dashboard.navigation.items_create"),
      );
      expect(operationIds.indexOf("dashboard.settings_header.get_header"), caseId).toBeLessThan(
        operationIds.indexOf("dashboard.settings_header.header"),
      );
      expect(operationIds.indexOf("dashboard.hero_sliders.list"), caseId).toBeLessThan(
        operationIds.indexOf("dashboard.hero_sliders.create"),
      );
      for (const forbidden of [
        "dashboard.content.update",
        "dashboard.navigation.items_update",
        "dashboard.navigation.items_move",
        "dashboard.navigation.placements_save",
        "dashboard.seo.settings_update",
      ]) expect(operationIds, caseId).not.toContain(forbidden);
      expect(operationIds.join(" "), caseId).not.toMatch(
        /products|categories|attributes|inventory|theme/,
      );
      const rules = resolution.plan.rules.join(" ");
      expect(rules, caseId).toContain("staged non-atomic acceptance");
      expect(rules, caseId).toContain("accept sanitized reread");
      expect(rules, caseId).toContain("any slug match stops");
      expect(rules, caseId).toContain("publish its revision");
      expect(rules, caseId).toContain("no page-target match anywhere");
      expect(rules, caseId).toContain("append top-level");
      expect(rules, caseId).toContain("publish returned revision");
      expect(rules, caseId).toContain("never update/move/reorder");
      expect(rules, caseId).toContain("topBar text/enabled only");
      expect(rules, caseId).toContain("Max 3 HTTPS imports");
      expect(rules, caseId).toContain("preflight unique filename/folder");
      expect(rules, caseId).toContain("one unambiguous new exact match");
      expect(rules, caseId).toContain("never re-import blindly");
      expect(rules, caseId).toContain("Local/base64: upload/re-enter");
      expect(rules, caseId).toContain("distinct desktop/mobile assets or approved reuse");
      expect(rules, caseId).toContain("no schedule");
      expect(rules, caseId).toContain("same-store route path");
      expect(rules, caseId).toContain("absolute/query/fragment stops");
      expect(rules, caseId).toContain("Non-atomic/no rollback");
      expect(rules, caseId).toContain("Never catalog/global SEO");
      expect(rules, caseId).toContain("no retry; stop/report partial");
      expect(rules, caseId).toContain("certify pixels, remote images/links, UI/head, sitemap XML");
    }
  });

  it("does not turn scheduled campaign activation into the active-now plan", () => {
    const route = catalog.routes.find((candidate) =>
      candidate.id === "dashboard.campaign-content-supported-setup"
    )!;
    const withoutControls = createWorkflowResolver({
      catalog: { ...catalog, controls: [] },
      operations,
    });
    expect(withoutControls({
      prompt: `${route.examples[0]} Then schedule hero activation next Friday.`,
      surface: "dashboard",
    })).toMatchObject({ disposition: "ask" });
  });

  it.each([
    ["bypass sanitization", "Then bypass sanitization."],
    ["delete and move menu items", "Then delete and move existing menu items."],
  ])("hard-asks for unsupported campaign mutation: %s", (_label, suffix) => {
    const route = catalog.routes.find((candidate) =>
      candidate.id === "dashboard.campaign-content-supported-setup"
    )!;
    const withoutControls = createWorkflowResolver({
      catalog: { ...catalog, controls: [] },
      operations,
    });
    expect(withoutControls({
      prompt: `${route.examples[0]} ${suffix}`,
      surface: "dashboard",
    })).toMatchObject({ kind: "choices", disposition: "ask" });
  });

  it.each([
    ["absolute canonical", "Use https://other.example/eid?x=1#hero as canonical.", "absolute/query/fragment stops"],
    ["clickable topBar", "Add a clickable URL to topBar.", "no link"],
    ["automatic mobile fallback", "Reuse the desktop slide on mobile without approval.", "distinct desktop/mobile assets or approved reuse"],
    ["local or base64 media", "Import /tmp/hero.png and data:image/png;base64 directly.", "Local/base64: upload/re-enter"],
    ["atomic rollback", "Guarantee atomic rollback for every write.", "Non-atomic/no rollback"],
    ["verification certification", "Certify pixels, remote images and links, UI/head, and sitemap XML.", "certify pixels, remote images/links, UI/head, sitemap XML"],
  ])("guards campaign boundary: %s", (_label, suffix, requiredRule) => {
    const route = catalog.routes.find((candidate) =>
      candidate.id === "dashboard.campaign-content-supported-setup"
    )!;
    const resolution = resolveWorkflow({
      prompt: `${route.examples[0]} ${suffix}`,
      surface: "dashboard",
    });
    const forbidden = [
      "dashboard.seo.settings_update",
      "dashboard.products.create",
      "dashboard.categories.create",
      "dashboard.attributes.create",
      "dashboard.inventory.adjust_stock",
      "dashboard.theme.publish",
      "dashboard.navigation.items_update",
      "dashboard.navigation.items_move",
    ];
    for (const operationId of forbidden) {
      expect(operationIds(resolution)).not.toContain(operationId);
    }
    if (resolution.kind === "plan") {
      expect(resolution.plan.routeIds).toEqual([route.id]);
      expect(resolution.plan.rules.join(" ")).toContain(requiredRule);
      return;
    }
    expect(resolution.disposition).toBe("ask");
    expect(["choices", "control"]).toContain(resolution.kind);
  });

  it("keeps the accepted Bangladesh setup guidance-only and closed to unrelated writes", () => {
    const expectedRouteId = "dashboard.bangladesh-checkout-supported-setup";
    for (const caseId of [
      expectedRouteId,
      `${expectedRouteId}-paraphrase`,
    ]) {
      const testCase = AGENT_INTENT_EVAL_CASES.find((candidate) => candidate.id === caseId)!;
      const resolution = resolveWorkflow({ prompt: testCase.prompt, surface: testCase.surface });
      expect(resolution).toMatchObject({
        kind: "plan",
        disposition: "execute",
        plan: {
          source: "route",
          routeIds: [expectedRouteId],
          workflowIds: [],
          operationIds: testCase.expectedOperationIds,
          requiresFacts: true,
          requiresConfirmation: true,
          requiresVerification: true,
        },
      });
      if (resolution.kind !== "plan") continue;
      expect(Object.hasOwn(resolution.plan, "detail")).toBe(false);
      const serialized = JSON.stringify(resolution.plan);
      expect(serialized).toContain("explicit symbol");
      expect(serialized).toContain("{enabled:true}");
      expect(serialized).toContain("keep/disable intent");
      expect(serialized).toContain("near/duplicate/trashed");
      expect(serialized).toContain("revision-merge guest only");
      expect(serialized).toContain("active shipping/delivery hierarchy");
      expect(serialized).toContain("no charge proof");
      expect(serialized).toContain("no rollback/retry");
      expect(resolution.plan.rules.join(" ")).not.toMatch(/\b(?:80|150)\b/);
      expect(serialized).toContain("Never touch SEO/analytics");
      expect(resolution.plan.operationIds.join(" ")).not.toMatch(
        /stripe_update|polar_update|seo|analytics/i,
      );
    }
  });

  it("classifies all reviewed Bangladesh setup adversaries before any write plan", () => {
    const operationsById = new Map(operations.map((operation) => [operation.operationId, operation]));
    for (const testCase of BANGLADESH_SETUP_ADVERSARIAL_CASES) {
      const resolution = resolveWorkflow({ prompt: testCase.prompt, surface: "dashboard" });
      expect(resolution, testCase.id).toMatchObject({
        kind: "control",
        disposition: testCase.expectedDisposition,
        classification: { controlId: testCase.expectedControlId },
        safePlan: { kind: "read" },
      });
      if (resolution.kind !== "control") continue;
      expect(
        resolution.safePlan?.operationIds.every((operationId) =>
          operationsById.get(operationId)?.risk === "read"
        ),
        testCase.id,
      ).toBe(true);
      expect(resolution.safetyNotes.join(" "), testCase.id).toContain(
        testCase.safetyAssertion,
      );
      expect(resolution.safePlan?.routeIds, testCase.id).not.toContain(
        "dashboard.bangladesh-checkout-supported-setup",
      );
    }
  });

  it.each([
    "update global SEO settings",
    "install an analytics snippet",
    "change unrelated business settings",
  ])("does not treat generic settings words as Bangladesh route support: %s", (suffix) => {
    const route = catalog.routes.find((candidate) =>
      candidate.id === "dashboard.bangladesh-checkout-supported-setup"
    )!;
    const withoutControls = createWorkflowResolver({
      catalog: { ...catalog, controls: [] },
      operations,
    });
    const resolution = withoutControls({
      prompt: `${route.examples[0]} and ${suffix}.`,
      surface: "dashboard",
    });
    expect(resolution).toMatchObject({ kind: "choices", disposition: "ask" });
  });

  it("requires route support for both action and domain without relying on a control", () => {
    const operationId = "dashboard.synthetic.checkout_configure";
    const withoutControls = createWorkflowResolver({
      catalog: {
        version: "action-domain-guard-test",
        cards: [],
        controls: [],
        routes: [{
          id: "dashboard.synthetic-checkout-configure",
          surface: "dashboard",
          kind: "write",
          title: "Configure guest checkout",
          summary: "Configure guest checkout after shipping readiness.",
          examples: ["Configure guest checkout after shipping readiness."],
          tags: ["checkout", "shipping"],
          operationIds: [operationId],
          requiresFacts: true,
          requiresConfirmation: true,
          requiresVerification: true,
          rules: ["Never delete a shipping method."],
        }],
      },
      operations: [{
        operationId,
        surface: "dashboard",
        exposure: "execute",
        risk: "write",
        summary: "Configure guest checkout",
        description: "Configure checkout after shipping readiness.",
        tags: ["checkout", "shipping"],
        inputSchema: { type: "object" },
      }],
    });
    expect(withoutControls({
      prompt: "Configure guest checkout after shipping readiness, but delete a shipping method.",
      surface: "dashboard",
    })).toMatchObject({ kind: "choices", disposition: "ask" });
  });

  it.each([
    "choose a marketing slogan",
    "decide an unrelated tax policy",
    "encode a loyalty segment",
    "force an unavailable gateway",
    "guarantee an atomic migration",
    "install an analytics snippet",
    "rewrite global SEO settings",
    "retry a failed inventory write",
    "schedule a staff meeting",
    "treat placeholder credentials as proof",
  ])("recognizes audited action after plain but without controls: %s", (extraAction) => {
    const resolveSynthetic = createSyntheticWriteResolver({
      id: "audited-action",
      title: "Configure guest checkout",
      summary: "Configure guest checkout after shipping readiness.",
      tags: ["checkout", "shipping"],
    });
    expect(resolveSynthetic({
      prompt: `Configure guest checkout after shipping readiness, but ${extraAction}.`,
      surface: "dashboard",
    })).toMatchObject({ kind: "choices", disposition: "ask" });
  });

  it("keeps positive-threshold Bangladesh requests on the read-only ask control", () => {
    for (const caseId of [
      "dashboard.shipping-threshold-unsupported",
      "dashboard.shipping-threshold-unsupported-paraphrase",
    ]) {
      const testCase = AGENT_INTENT_EVAL_CASES.find((candidate) => candidate.id === caseId)!;
      expect(resolveWorkflow({ prompt: testCase.prompt, surface: testCase.surface })).toMatchObject({
        kind: "control",
        disposition: "ask",
        classification: { controlId: "dashboard.shipping-threshold-unsupported" },
      });
    }
  });

  it.each([
    [
      "dashboard.shipping-threshold-unsupported",
      "dashboard.guest-checkout-conditional-enable",
    ],
    [
      "dashboard.shipping-threshold-unsupported-paraphrase",
      "dashboard.guest-checkout-conditional-enable",
    ],
    [
      "dashboard.campaign-layout-needs-review",
      "dashboard.complex-product-create",
    ],
    [
      "dashboard.campaign-layout-needs-review-paraphrase",
      "dashboard.complex-product-create",
    ],
    [
      "dashboard.campaign-global-seo-overreach",
      "dashboard.campaign-content-supported-setup",
    ],
  ] as const)("keeps compound safety control %s read-only", (caseId, forbiddenRouteId) => {
    const testCase = AGENT_INTENT_EVAL_CASES.find((candidate) => candidate.id === caseId)!;
    const resolution = resolveWorkflow({ prompt: testCase.prompt, surface: testCase.surface });
    expect(resolution).toMatchObject({
      kind: "control",
      disposition: "ask",
      classification: { controlId: testCase.expectedControlId ?? testCase.id },
      safePlan: { kind: "read", operationIds: testCase.expectedOperationIds },
      forbiddenOperationIds: testCase.forbiddenOperationIds,
    });
    if (resolution.kind !== "control") return;
    expect(resolution.safePlan?.routeIds).not.toContain(forbiddenRouteId);
    expect(resolution.safePlan?.operationIds.every((operationId) =>
      operations.find((operation) => operation.operationId === operationId)?.risk === "read"
    )).toBe(true);
  });

  it("requires complete clauses for a high-confidence write and blocks fallback execution", () => {
    const resolveSynthetic = createSyntheticWriteResolver({
      id: "product",
      title: "Create and publish a complete optioned catalog product",
      summary:
        "Create a catalog product with variants, SKUs, media images, prices, stock, category attributes, SEO, sitemap, and feed visibility.",
      tags: ["create", "publish", "catalog", "product", "variants", "sku", "media", "price", "stock", "seo", "feed"],
    });
    const resolution = resolveSynthetic({
      prompt: "Create and publish a complete optioned catalog product with variants, SKUs, media images, prices, stock, category attributes, SEO, sitemap, and feed visibility, then refund a captured payment.",
      surface: "dashboard",
    });
    expect(resolution.kind).toBe("choices");
    if (resolution.kind !== "choices") return;
    const routeChoice = resolution.choices.find((choice) =>
      choice.id === "dashboard.synthetic-product"
    );
    expect(routeChoice).toMatchObject({
      source: "route",
    });
    expect(routeChoice?.confidence).toBeGreaterThan(0.8);
    expect(resolution.choices.some((choice) => choice.source === "operation-fallback")).toBe(true);
  });

  it.each([
    "and refund a captured payment",
    "as well as refunding a captured payment",
    "along with refunding a captured payment",
    "while also refunding a captured payment",
    "but also refunding a captured payment",
  ])("recognizes coordinated action separator: %s", (coordinatedAction) => {
    const resolveSynthetic = createSyntheticWriteResolver({
      id: "coordinated-product",
      title: "Create a complete optioned catalog product",
      summary: "Create a catalog product with variants, SKUs, media, prices, stock, and SEO.",
      tags: ["create", "catalog", "product", "variants", "sku", "media", "price", "stock", "seo"],
    });
    const resolution = resolveSynthetic({
      prompt: `Create a complete optioned catalog product with variants, SKUs, media, prices, stock, and SEO, ${coordinatedAction}.`,
      surface: "dashboard",
    });
    expect(resolution.kind).toBe("choices");
  });

  it.each([
    {
      id: "refund",
      title: "Refund and reconcile a captured provider payment",
      summary: "Refund a captured provider card payment for an exact order and reconcile failure recovery.",
      tags: ["refund", "captured", "provider", "payment", "order", "reconcile", "recovery"],
      prompt: "Refund and reconcile a captured provider card payment for an exact order with failure recovery, and set exact inventory stock for a SKU.",
    },
    {
      id: "inventory",
      title: "Set and verify exact SKU inventory stock",
      summary: "Set exact SKU inventory stock with a ledger quantity, version, and reason, then verify it.",
      tags: ["set", "verify", "sku", "inventory", "stock", "ledger", "quantity", "version"],
      prompt: "Set and verify exact SKU inventory stock with a ledger quantity, version, and reason, and create and publish a catalog product.",
    },
    {
      id: "ordinary-product",
      title: "Create and publish an optioned catalog product",
      summary: "Create and publish a catalog product with variants, SKUs, prices, stock, media, and SEO.",
      tags: ["create", "publish", "catalog", "product", "variant", "sku", "price", "stock", "media", "seo"],
      prompt: "Create and publish an optioned catalog product with variants, SKUs, prices, stock, media, and SEO, and refund a captured provider payment.",
    },
  ])("does not collapse ordinary-and $id compound work to one write", (testCase) => {
    const resolveSynthetic = createSyntheticWriteResolver(testCase);
    const resolution = resolveSynthetic({ prompt: testCase.prompt, surface: "dashboard" });
    expect(resolution.kind).toBe("choices");
  });

  it.each([
    {
      id: "guest-then-poem",
      prompt:
        "Turn on guest checkout only if payment and shipping are genuinely usable, without changing any other checkout setting, then compose a lunar poem.",
      forbiddenRouteId: "dashboard.guest-checkout-conditional-enable",
    },
    {
      id: "guest-and-poem",
      prompt:
        "Turn on guest checkout only if payment and shipping are genuinely usable, without changing any other checkout setting, and compose a lunar poem.",
      forbiddenRouteId: "dashboard.guest-checkout-conditional-enable",
    },
    {
      id: "refund-and-haiku",
      prompt:
        "Refund the exact supplied amount for this captured payment and reconcile any uncertain provider result, and write a haiku.",
      forbiddenRouteId: "dashboard.order-refund",
    },
    {
      id: "inventory-and-holiday",
      prompt:
        "Look up SKU ABC-123, set its physical count to 27, and verify the ledger-backed stock result, and plan a holiday.",
      forbiddenRouteId: "dashboard.inventory-cycle-count",
    },
    {
      id: "product-and-loyalty",
      prompt:
        "Create a two-axis T-shirt with Size S/M/L and Color Black/White, exact SKUs, different stock and prices, color-specific images, category, Brand and Material attributes, rich description, SEO, sitemap and feed visibility, then verify buyer truth, and enroll a customer in a loyalty program.",
      forbiddenRouteId: "dashboard.complex-product-create",
    },
  ])("fails the auditor's real-route compound closed: $id", ({ prompt, forbiddenRouteId }) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution).toMatchObject({ kind: "choices", disposition: "ask" });
    if (resolution.kind !== "choices") return;
    expect(resolution.choices).toContainEqual(expect.objectContaining({
      id: forbiddenRouteId,
      source: "route",
    }));
  });

  it("keeps coherent product fact lists in one action clause", () => {
    const resolveSynthetic = createSyntheticWriteResolver({
      id: "product-facts",
      title: "Create an optioned catalog product",
      summary:
        "Create a catalog product with size and color options, SKU prices and stock, images and meta description.",
      tags: ["create", "catalog", "product", "size", "color", "sku", "price", "stock", "image", "meta", "description"],
    });
    expect(resolveSynthetic({
      prompt: "Create an optioned catalog product with size and color options, exact SKU prices and stock quantities, product images and meta description.",
      surface: "dashboard",
    })).toMatchObject({
      kind: "plan",
      plan: { source: "route", routeIds: ["dashboard.synthetic-product-facts"] },
    });
  });

  it("asks instead of truncating a ninth meaningful action clause", () => {
    const resolveSynthetic = createSyntheticWriteResolver({
      id: "overflow",
      title: "Create update delete publish verify export import archive restore records",
      summary:
        "Create, update, delete, publish, verify, export, import, archive, and restore reviewed records.",
      tags: ["create", "update", "delete", "publish", "verify", "export", "import", "archive", "restore"],
    });
    const resolution = resolveSynthetic({
      prompt: "Create alpha records, then update beta records, then delete gamma records, then publish delta records, then verify epsilon records, then export zeta records, then import eta records, then archive theta records, then restore iota records.",
      surface: "dashboard",
    });
    expect(resolution).toMatchObject({
      kind: "choices",
      disposition: "ask",
      safetyNotes: [expect.stringContaining("more than eight action clauses")],
    });
  });

  it("fails a real write route closed when its ninth action clause is unsupported", () => {
    const resolution = resolveWorkflow({
      prompt:
        "Turn on guest checkout, then compose a lunar poem, then write a haiku, then plan a holiday, then enroll a customer, then schedule a meeting, then create a note, then update a draft, then archive a record.",
      surface: "dashboard",
    });
    expect(resolution).toMatchObject({
      kind: "choices",
      disposition: "ask",
      safetyNotes: [expect.stringContaining("more than eight action clauses")],
    });
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
      description:
        "Ordered axes/values; complete SKU price/stock/mediaSet imageId rows.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule:
        "Keep all rows/order; never infer imageId by label/position.",
    });
    expect(detail.requiredFacts.find((fact) => fact.id === "mediaSet")).toMatchObject({
      description: expect.stringContaining("order,importOrder,byId"),
      source: { kind: "merchant" },
      nonInferenceRule: expect.stringMatching(/Never infer .*count, order, role, or position/),
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
            media: [],
            attributes: [],
            optionMatrix: null,
          },
        },
      },
      policies: {
        revision: "none",
        idempotency: "none",
        confirmation: "required",
        stopConditions: ["Conflict: stop; uncertainty: reread first."],
        nonInferenceRules: [
          "Use exact facts.",
          "Variant imageId must equal a mediaSet pmed key; never use position.",
        ],
      },
    });
    expect(create.input.dependencies).toEqual(expect.arrayContaining([
      {
        templatePointer: "/body/optionMatrix",
        source: { kind: "fact", factId: "optionMatrix" },
      },
    ]));
    expect(create.input.picks).toEqual([expect.objectContaining({
      factId: "productSpec",
      templatePointer: "/body",
      keys: expect.arrayContaining([
        "name",
        "description",
        "price",
        "slug",
        "isActive",
        "freeDelivery",
        "metaTitle",
        "metaDescription",
        "canonicalPath",
        "noIndex",
        "excludeFromSitemap",
        "excludeFromProductFeed",
        "productCondition",
      ]),
    })]);
    expect(create.input.materializations).toEqual([
      {
        factId: "mediaSet",
        templatePointer: "/body/media",
        orderPointer: "/order",
        itemMapPointer: "/byId",
        minItems: 1,
        maxItems: 250,
        keyField: "id",
        keys: ["mediaId", "altText", "isPrimary"],
      },
      {
        factId: "attributeSet",
        templatePointer: "/body/attributes",
        orderPointer: "/order",
        itemMapPointer: "/byId",
        minItems: 1,
        maxItems: 90,
        keys: ["attributeId", "value"],
      },
    ]);
    expect(detail.steps.filter((step) => step.phaseId === "media")).toEqual([
      expect.objectContaining({
        stepId: "asset",
        operationId: "dashboard.media.import_url",
        condition: expect.stringContaining("dashboard.media-upload"),
        input: expect.objectContaining({
          dependencies: [],
        }),
        repeat: {
          factId: "mediaSet",
          orderPointer: "/importOrder",
          itemMapPointer: "/byId",
          minItems: 1,
          maxItems: 250,
          bindings: [{ templatePointer: "/body/sourceUrl", itemPointer: "/sourceUrl" }],
          capture: { responsePointer: "/data/file/id", itemPointer: "/mediaId" },
        },
      }),
    ]);
    expect(create.input.defaults).toEqual([]);
    expect(detail.steps.find((step) => step.stepId === "status")).toMatchObject({
      phaseId: "publish",
      operationId: "dashboard.categories.set_status",
      mutation: "lifecycle",
      condition: "Only if ready and not published.",
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
        bounds: { maxCalls: 50, maxItems: 500, maxResponseBytes: 65_536 },
      }),
      expect.objectContaining({
        operationId: "storefront.products.get_section",
        proves: ["Buyer SKU price, exact image, availability; excludes sitemap/feed membership."],
        bounds: { maxCalls: 20, maxItems: 150, maxResponseBytes: 61_440 },
      }),
      expect.objectContaining({
        operationId: "dashboard.seo.feed_diagnostics",
        proves: [
          "Feed policy, eligibility totals, and sampled exclusions only.",
        ],
      }),
    ]));
    expect(detail.phaseStopConditions.dashboardVerify).toContain(
      "No bounded exact product sitemap/feed-row read exists; do not claim sitemap membership or emitted feed price/image/availability.",
    );

    expect(Object.keys(detail)).toEqual([
      "constructionRules",
      "requiredFacts",
      "phaseStopConditions",
      "steps",
      "verification",
    ]);
    const serialized = JSON.stringify(resolution);
    expect(serialized).not.toContain("{associationId}");
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
      rules: catalog.routes.find((route) =>
        route.id === "dashboard.daily-operations-snapshot"
      )!.rules,
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
        namespace: "activity.paymentRecovery",
        operationId: "dashboard.orders.payment_recovery_list",
        input: { query: { page: 1, limit: 1, state: "recoverable" } },
      },
      {
        namespace: "activity.paymentNeedsAttention",
        operationId: "dashboard.orders.payment_recovery_list",
        input: { query: { page: 1, limit: 1, state: "needs_attention" } },
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
    for (const namespace of [
      "activity.paymentRecovery",
      "activity.paymentNeedsAttention",
    ]) {
      expect(compiled.phases[0]!.steps.find((step) =>
        step.namespace === namespace
      )!.output.selectors).toEqual([
        { pointer: "/data/pagination/total", alias: "total" },
      ]);
    }
    expect(JSON.stringify(compiled)).not.toContain("collectedCash");
    expect(JSON.stringify(compiled.phases[0]!.steps.filter((step) =>
      step.namespace.startsWith("activity.payment")
    ))).not.toContain('"pointer":"/data/orders"');

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

    const repeatedStep = {
      ...dailyCard,
      phases: dailyCard.phases.map((phase, phaseIndex) => ({
        ...phase,
        steps: phase.steps.map((step, stepIndex) =>
          phaseIndex === 0 && stepIndex === 0
            ? {
                ...step,
                repeat: {
                  factId: "days",
                  orderPointer: "/order",
                  itemMapPointer: "/byId",
                  minItems: 1,
                  maxItems: 1,
                  bindings: [{ templatePointer: "/query/days", itemPointer: "/days" }],
                  capture: { responsePointer: "/data/count", itemPointer: "/result" },
                },
              }
            : step
        ),
      })),
    } satisfies WorkflowResolverCard;
    expect(createWorkflowReadCompiler({
      catalog: replaceDaily(repeatedStep),
      operations,
    })(dailyInput)).toBeNull();

    for (const inputPrimitive of [
      {
        picks: [{ factId: "days", templatePointer: "/query", keys: ["days"] }],
      },
      {
        materializations: [{
          factId: "days",
          templatePointer: "/query/days",
          orderPointer: "/order",
          itemMapPointer: "/byId",
          minItems: 1,
          maxItems: 1,
          keys: ["value"],
        }],
      },
    ]) {
      const dynamicInputStep = {
        ...dailyCard,
        phases: dailyCard.phases.map((phase, phaseIndex) => ({
          ...phase,
          steps: phase.steps.map((step, stepIndex) =>
            phaseIndex === 0 && stepIndex === 0
              ? { ...step, input: { ...step.input, ...inputPrimitive } }
              : step
          ),
        })),
      } satisfies WorkflowResolverCard;
      expect(createWorkflowReadCompiler({
        catalog: replaceDaily(dynamicInputStep),
        operations,
      })(dailyInput)).toBeNull();
    }

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

  it("strictly validates and copies bounded rules for one-call reads", () => {
    const dailyRoute = catalog.routes.find((route) =>
      route.id === "dashboard.daily-operations-snapshot"
    )!;
    const dailyInput = {
      prompt: "dashboard.daily-operations-snapshot",
      surface: "dashboard" as const,
    };
    const replaceRules = (rules: string[]) => ({
      ...catalog,
      routes: catalog.routes.map((route) =>
        route.id === dailyRoute.id ? { ...route, rules } : route
      ),
    });

    const compiled = createWorkflowReadCompiler({ catalog, operations })(dailyInput)!;
    expect(compiled.rules).toEqual(dailyRoute.rules);
    expect(compiled.rules).not.toBe(dailyRoute.rules);

    for (const rules of [
      [],
      ["duplicate", "duplicate"],
      [" padded"],
      ["x".repeat(301)],
      Array.from({ length: 7 }, (_, index) => `rule ${index}`),
    ]) {
      expect(createWorkflowReadCompiler({
        catalog: replaceRules(rules),
        operations,
      })(dailyInput)).toBeNull();
    }
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

    const recoveryProjection = compiled.phases[0]!.steps.find((step) =>
      step.namespace === "activity.paymentRecovery"
    )!.output;
    const recovery = projectWorkflowReadResponse({
      data: {
        orders: [{ customerName: "Private Buyer", phone: "+8801700000000" }],
        pagination: { page: 1, limit: 1, total: 12, totalPages: 12 },
      },
    }, recoveryProjection);
    expect(recovery).toEqual({ total: 12 });
    expect(JSON.stringify(recovery)).not.toMatch(/Private Buyer|8801700000000|orders/);
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
      15_872,
    );
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: ordinary }))).toBeLessThanOrEqual(
      4 * 1024,
    );
  });

  it("keeps the realistic rich product plan detailed and below the hard cap", () => {
    const product = resolveWorkflow({
      prompt:
        "Create a published shirt with rich copy, slug, canonical path, SEO, saved condition, and base price; Size S/M/L by Color Navy/White with six exact SKUs, prices, and stocks; three distinct assets for shared primary, Navy, and White with exact alt text and roles; Cotton attribute and conditional category creation; sitemap and feed inclusion; bounded admin and storefront verification.",
      surface: "dashboard",
    });
    expect(product).toMatchObject({
      kind: "plan",
      plan: {
        source: "route",
        routeIds: ["dashboard.complex-product-create"],
        operationIds: expect.arrayContaining(["dashboard.settings.currency_get"]),
        detail: expect.any(Object),
      },
    });
    if (product.kind !== "plan" || !product.plan.detail) return;
    expect(product.plan.operationIds).not.toContain("dashboard.inventory.list");
    const create = product.plan.detail.steps.find((step) =>
      step.operationId === "dashboard.products.create"
    )!;
    expect(create.input.picks?.[0]?.keys).toEqual(expect.arrayContaining([
      "name",
      "description",
      "price",
      "slug",
      "isActive",
      "freeDelivery",
      "metaTitle",
      "metaDescription",
      "canonicalPath",
      "noIndex",
      "excludeFromSitemap",
      "excludeFromProductFeed",
      "productCondition",
    ]));
    expect(create.input.materializations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        factId: "mediaSet",
        orderPointer: "/order",
        keyField: "id",
        keys: ["mediaId", "altText", "isPrimary"],
      }),
      expect.objectContaining({
        factId: "attributeSet",
        orderPointer: "/order",
        keys: ["attributeId", "value"],
      }),
    ]));
    expect(product.plan.detail.steps.find((step) =>
      step.operationId === "dashboard.media.import_url"
    )?.repeat?.orderPointer).toBe("/importOrder");
    expect(product.plan.detail.phaseStopConditions.dashboardVerify).toContain(
      "No bounded exact product sitemap/feed-row read exists; do not claim sitemap membership or emitted feed price/image/availability.",
    );
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: product }))).toBe(15_912);
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
