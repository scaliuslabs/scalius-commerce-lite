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

function createSyntheticReadResolver(input: {
  id: string;
  title: string;
  summary: string;
  tags: string[];
}) {
  const operationId = `dashboard.synthetic.${input.id}`;
  return createWorkflowResolver({
    catalog: {
      version: "read-mutation-guard-test",
      cards: [],
      controls: [],
      routes: [{
        id: `dashboard.synthetic-${input.id}`,
        surface: "dashboard",
        kind: "read",
        title: input.title,
        summary: input.summary,
        examples: ["Read this reviewed synthetic report."],
        tags: input.tags,
        operationIds: [operationId],
        requiresFacts: false,
        requiresConfirmation: false,
        requiresVerification: false,
        rules: ["Return bounded aggregate facts only."],
      }],
    },
    operations: [
      {
        operationId,
        surface: "dashboard",
        exposure: "execute",
        risk: "read",
        summary: input.title,
        description: input.summary,
        tags: input.tags,
        inputSchema: {},
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        operationId: `dashboard.synthetic.read_decoy_${index}`,
        surface: "dashboard",
        exposure: "execute",
        risk: "read",
        summary: `Observe meteor spectrum ${index}`,
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

  it("routes cooperative 30-day gaps but asks before demanded or unsafe expansion", () => {
    for (const caseId of [
      "dashboard.thirty-day-booked-operations-brief",
      "dashboard.thirty-day-booked-operations-brief-paraphrase",
    ]) {
      const testCase = AGENT_INTENT_EVAL_CASES.find((candidate) => candidate.id === caseId)!;
      expect(resolveWorkflow({ prompt: testCase.prompt, surface: "dashboard" }), caseId)
        .toMatchObject({
          kind: "plan",
          plan: {
            routeIds: ["dashboard.thirty-day-booked-operations-brief"],
            workflowIds: ["operations.thirty-day-booked-brief.v1"],
            operationIds: testCase.expectedOperationIds,
          },
        });
    }

    const negatedDemand = resolveWorkflow({
      surface: "dashboard",
      prompt: "Give a PII-free 30-day owner brief using booked activity and current stock, abandoned, and recovery totals; do not estimate unavailable paid cash, status, SKU, margin, traffic, or conversion facts.",
    });
    expect(negatedDemand).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });

    const unseenPrompt =
      "Summarize 30 days of PII-free booked order activity with saved currency and current low/out-of-stock, abandoned-checkout, recoverable-payment, and needs-attention totals; clearly leave unsupported economics and traffic unavailable.";
    expect(resolveWorkflow({ surface: "dashboard", prompt: unseenPrompt })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ surface: "dashboard", prompt: unseenPrompt }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });

    const conditionalSupportedPrompt =
      "Give the PII-free 30-day owner brief with booked activity and current stock/abandoned/recovery totals; calculate paid cash if supported, otherwise mark it unavailable.";
    expect(resolveWorkflow({ surface: "dashboard", prompt: conditionalSupportedPrompt }))
      .toMatchObject({
        kind: "plan",
        plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
      });

    expect(resolveWorkflow({
      surface: "dashboard",
      prompt:
        "Give the exact PII-free 30-day booked revenue brief with current stock and recovery totals; mark unsupported metrics unavailable.",
    })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });

    for (const caseId of [
      "dashboard.thirty-day-owner-briefing-hard-demand",
      "dashboard.thirty-day-owner-briefing-no-unavailable-label",
    ]) {
      const testCase = AGENT_INTENT_EVAL_CASES.find((candidate) => candidate.id === caseId)!;
      expect(resolveWorkflow({ prompt: testCase.prompt, surface: "dashboard" }), caseId)
        .toMatchObject({
          kind: "control",
          disposition: "ask",
          classification: { controlId: "dashboard.thirty-day-owner-briefing-needs-scope" },
          safePlan: { kind: "read", operationIds: testCase.expectedOperationIds },
        });
    }

    for (const hardDemand of [
      "Approximate paid cash for my 30-day owner briefing.",
      "Fill in collected cash for my 30-day owner briefing even without authority.",
      "Derive gross margin for my 30-day owner briefing from whatever exists.",
      "Infer paid revenue for 30 days.",
      "Infer collected revenue for 30 days.",
      "Infer settled revenue for 30 days.",
      "Give exact status counts for 30 days.",
      "Give exact order aging totals for the last 30 days.",
      "Give cash for the last 30 days; not if supported—give it anyway.",
      "For the last 30 days show settled cash; not if supported—give it anyway.",
      "Show traffic for the past 30 days if supported, but give it anyway.",
      "Give ROAS for the last 30 days if supported, but give it regardless.",
      "Estimate profit and net revenue for my last 30 days owner brief.",
      "Give exact AOV and average order value for the past 30 days.",
      "Infer LTV, lifetime value, CAC, and customer acquisition cost for the 30-day brief.",
      "Give exact repeat-customer and returning-customer rates for the last 30 days.",
      "Derive ad spend, impressions, and clicks for the 30-day report.",
      "Give exact visitors and sessions for the last 30 days.",
      "Give exact session totals for the previous 30 days.",
      "Estimate profit and conversion rate for the last 30 days.",
      "Estimate profit for the previous 30 days.",
      "Give exact ad spend for the rolling 30 days.",
      "Infer conversion rate for 30 calendar days.",
      "Give exact refund, chargeback, return, and cancellation counts and amounts for the last 30 days.",
    ]) {
      expect(resolveWorkflow({ surface: "dashboard", prompt: hardDemand })).toMatchObject({
        kind: "control",
        disposition: "ask",
        classification: { controlId: "dashboard.thirty-day-owner-briefing-needs-scope" },
      });
    }

    expect(resolveWorkflow({
      surface: "dashboard",
      prompt: "Give cash for the last 30 days if supported, but give cash anyway.",
    })).toMatchObject({
      kind: "control",
      disposition: "ask",
      classification: {
        controlId: "dashboard.thirty-day-owner-briefing-override-demand",
      },
    });

    for (const unsupportedOnly of [
      "Show me collected cash for last 30 days.",
      "Show traffic and conversion for the past 30 days.",
      "Give paid cash for 30 days.",
      "Show settled revenue for the last 30 days.",
      "Show settlement cash for the past 30 days.",
      "Give best-selling products and ROAS for the last 30 days.",
      "List the best selling products and ROAS for the last 30 days.",
      "Show visitors, sessions, and conversion for the past 30 days.",
      "Show profit, AOV, LTV, CAC, and returning-customer rates for the last 30 days.",
      "Show ad spend, impressions, and clicks for the past 30 days.",
      "Show refund, chargeback, return, and cancellation totals for the last 30 days.",
    ]) {
      expect(resolveWorkflow({ surface: "dashboard", prompt: unsupportedOnly })).toMatchObject({
        kind: "control",
        disposition: "ask",
        classification: {
          controlId: "dashboard.thirty-day-owner-briefing-unsupported-only",
        },
      });
    }

    for (const deniedUnavailable of [
      "Give the 30-day owner brief and never say unavailable.",
      "For the last 30 days, unavailable is not acceptable.",
      "For the past 30 days, unavailable unacceptable.",
    ]) {
      expect(resolveWorkflow({ surface: "dashboard", prompt: deniedUnavailable }))
        .toMatchObject({
          kind: "control",
          disposition: "ask",
          classification: {
            controlId: "dashboard.thirty-day-owner-briefing-unavailable-denied",
          },
        });
    }
  });

  it("keeps non-30-day profit and conversion requests on their global controls", () => {
    expect(resolveWorkflow({
      surface: "dashboard",
      prompt: "What was my net profit this month?",
    })).toMatchObject({
      kind: "control",
      disposition: "unsupported",
      classification: { controlId: "dashboard.unsupported-net-profit" },
    });
    expect(resolveWorkflow({
      surface: "dashboard",
      prompt: "What was my storefront conversion rate yesterday?",
    })).toMatchObject({
      kind: "control",
      disposition: "unsupported",
      classification: { controlId: "dashboard.unsupported-conversion-rate" },
    });

    for (const prompt of [
      "Show conversion analytics overall.",
      "How is storefront conversion performance overall?",
      "Give overall conversion numbers.",
      "Show conversion metrics this quarter.",
    ]) {
      expect(resolveWorkflow({ surface: "dashboard", prompt })).toMatchObject({
        kind: "control",
        disposition: "unsupported",
        classification: { controlId: "dashboard.unsupported-conversion-rate" },
      });
    }

    for (const prompt of [
      "Configure Meta Conversions API with supplied credentials and verify settings without provider payload logs.",
      "Configure Meta CAPI conversion tracking with supplied credentials and verify bounded safe logs.",
    ]) {
      expect(resolveWorkflow({ surface: "dashboard", prompt })).toMatchObject({
        kind: "plan",
        plan: { routeIds: ["dashboard.meta-capi"] },
      });
    }

    expect(resolveWorkflow({
      surface: "dashboard",
      prompt: "Update the conversion event configuration.",
    })).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({ id: "dashboard.notification-rules" })],
    });
    expect(resolveWorkflow({
      surface: "dashboard",
      prompt: "Update customer SMS notification rules for shipped orders.",
    })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.notification-rules"] },
    });
    for (const prompt of [
      "Configure WhatsApp order-confirmation notifications.",
      "Enable email order-delivered notifications.",
      "Configure email refund_failed messages.",
      "Use SMS alerts for payment balance paid.",
    ]) {
      const resolution = resolveWorkflow({ surface: "dashboard", prompt });
      expect(resolution, prompt).toMatchObject({
        kind: "plan",
        plan: {
          routeIds: ["dashboard.notification-rules"],
          requiresFacts: true,
          requiresConfirmation: true,
        },
      });
      if (resolution.kind === "plan") {
        expect(resolution.plan.rules.join(" ")).toContain("payment_balance_paid");
        expect(resolution.plan.rules.join(" ")).toMatch(/event is absent, ask\/no write/i);
      }
    }
    expect(resolveWorkflow({
      surface: "dashboard",
      prompt: "Configure WhatsApp payment-failed alerts.",
    })).toMatchObject({ kind: "choices", disposition: "ask" });
    for (const prompt of [
      "Enable SMS chargeback_opened messages.",
      "Set email shipment_delayed notifications.",
      "Notify by SMS when a shipment is delayed.",
      "Email customers for payment_failed events.",
    ]) {
      const resolution = resolveWorkflow({ surface: "dashboard", prompt });
      expect(resolution, prompt).toMatchObject({
        kind: "plan",
        plan: {
          routeIds: ["dashboard.notification-rules"],
          requiresFacts: true,
          requiresConfirmation: true,
        },
      });
      if (resolution.kind === "plan") {
        const rules = resolution.plan.rules.join(" ");
        expect(rules).toMatch(/event is absent, ask\/no write/i);
        expect(rules).not.toMatch(/shipment_delayed|payment_failed|chargeback_opened/);
      }
    }
    for (const prompt of [
      "Configure Stripe with the merchant-supplied secret key.",
      "Replace the Stripe secret key credential.",
      "Update Stripe secret-key credentials.",
      "Update the Stripe secret key.",
      "Set Stripe secretKey.",
      "Rotate the Stripe secret key.",
      "Enable Stripe.",
      "Disable Stripe.",
      "Turn Stripe on.",
      "Turn Stripe off.",
      "Activate Stripe payments.",
      "Put a new publishableKey into Stripe settings.",
      "Replace Stripe publishable_key with the merchant-supplied value.",
      "Rotate the Stripe signing webhookSecret now.",
      "Update the Stripe webhook signing secret.",
    ]) {
      const resolution = resolveWorkflow({ surface: "dashboard", prompt });
      expect(resolution, prompt).toMatchObject({
        kind: "plan",
        plan: {
          routeIds: ["dashboard.stripe-settings"],
          operationIds: [
            "dashboard.payments.stripe_get",
            "dashboard.payments.stripe_update",
          ],
          requiresFacts: true,
          requiresConfirmation: true,
        },
      });
      if (resolution.kind === "plan") {
        expect(resolution.plan.rules.join(" ")).toMatch(
          /stripe_update declares only enabled, publishableKey, secretKey, and webhookSecret.*Ask\/no write/i,
        );
      }
    }
    for (const prompt of [
      "Configure Stripe with an account SID credential.",
      "Replace Stripe password.",
      "Update Stripe clientId.",
    ]) {
      const resolution = resolveWorkflow({ surface: "dashboard", prompt });
      expect(resolution, prompt).toMatchObject({
        kind: "plan",
        plan: {
          routeIds: ["dashboard.stripe-settings"],
          requiresFacts: true,
          requiresConfirmation: true,
        },
      });
      if (resolution.kind === "plan") {
        expect(resolution.plan.rules.join(" ")).toMatch(/Ask\/no write for any absent field/i);
      }
    }
    for (const prompt of [
      "Change the SMS provider sender ID and credentials.",
      "Update the Twilio SMS account SID and auth token.",
      "Configure the email provider API key and sender address.",
      "Configure WhatsApp provider credentials and sender account.",
      "Configure Stripe SMTP host and password.",
      "Update Stripe smtpHost.",
      "Configure Meta CAPI with a Twilio auth token.",
    ]) {
      expect(resolveWorkflow({ surface: "dashboard", prompt }), prompt).toMatchObject({
        kind: "choices",
        disposition: "ask",
      });
    }
  });

  it.each([
    [
      "raw PII and queue rows",
      "Give a PII-free 30-day owner brief using booked activity and current stock, abandoned, and recovery totals, but also return raw customer and abandoned-checkout records.",
      "dashboard.thirty-day-owner-briefing-row-expansion",
    ],
    [
      "customer contacts",
      "Give the 30-day owner brief, then include customer details, names, emails, and phones.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "buyer details",
      "Give the 30-day owner brief and return buyer details.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "buyer contact",
      "Give the 30-day owner brief and include buyer contact information.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "customer identities",
      "Give the 30-day owner brief and include customer identities.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "standalone names and emails",
      "Give the 30-day owner brief and include names and emails.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "shopper phone and address",
      "Give the 30-day owner brief and include shopper phone and address.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "buyer address",
      "Give the 30-day owner brief and include the buyer address.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "buyer addresses",
      "Give the 30-day owner brief and include buyer addresses.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "abandoned shopper email",
      "For the last 30 days include every abandoned shopper's email address.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "abandoned shopper identities",
      "Give the last 30 days owner briefing with abandoned shopper identities.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "shopper phonebook",
      "Give the last 30 days owner briefing with the abandoned shopper phonebook.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "customer directory",
      "Give the last 30 days owner briefing and include a customer directory.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "buyer contact list",
      "Give the last 30 days owner briefing and include the buyer contact list.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "shopper roster",
      "Give the last 30 days owner briefing and include a shopper roster.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "raw operational rows",
      "Give the 30-day owner brief and return raw records plus checkout, order, and recovery rows.",
      "dashboard.thirty-day-owner-briefing-row-expansion",
    ],
    [
      "every checkout record",
      "Give the 30-day owner brief and include every checkout record.",
      "dashboard.thirty-day-owner-briefing-row-expansion",
    ],
    [
      "unrelated SEO write and delete",
      "Give the 30-day booked operations brief, then rewrite global SEO and delete an old shipping method.",
      "dashboard.thirty-day-owner-briefing-mutation-expansion",
    ],
    [
      "SEO update",
      "Give the 30-day owner brief and update SEO settings.",
      "dashboard.thirty-day-owner-briefing-mutation-expansion",
    ],
    [
      "SEO change",
      "Give the 30-day owner brief and change SEO settings.",
      "dashboard.thirty-day-owner-briefing-mutation-expansion",
    ],
    [
      "product trash",
      "Give the 30-day owner brief and trash a product.",
      "dashboard.thirty-day-owner-briefing-mutation-expansion",
    ],
    [
      "shipping update",
      "Give the 30-day owner brief and update shipping.",
      "dashboard.thirty-day-owner-briefing-mutation-expansion",
    ],
    [
      "customer export",
      "Give the 30-day owner brief and export customer records.",
      "dashboard.thirty-day-owner-briefing-pii-expansion",
    ],
    [
      "conditional unrelated mutation",
      "Give the 30-day booked operations brief and, if conversion is low, delete draft products.",
      "dashboard.thirty-day-owner-briefing-mutation-expansion",
    ],
    [
      "homepage hero",
      "Give the 30-day owner brief and update the homepage hero.",
      "dashboard.thirty-day-owner-briefing-mutation-expansion",
    ],
  ])("does not expand the fixed 30-day read for %s", (_name, prompt, controlId) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution).toMatchObject({
      kind: "control",
      disposition: "ask",
      classification: {
        controlId,
      },
    });
    expect(operationIds(resolution)).toEqual([
      "dashboard.home.activity",
      "dashboard.settings.currency_get",
      "dashboard.inventory.list",
      "dashboard.abandoned_checkouts.summaries_list",
      "dashboard.orders.payment_recovery_list",
    ]);
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "Create a PII-free 30-day booked-operations report with current stock, abandoned, and recovery totals; mark unsupported metrics unavailable.",
    "Build a PII-free 30-day booked report with current stock, abandoned, and recovery totals; mark unsupported metrics unavailable.",
    "Generate a PII-free 30-day booked report with current stock, abandoned, and recovery totals; mark unsupported metrics unavailable.",
    "Make a PII-free 30-day booked report with current stock, abandoned, and recovery totals; mark unsupported metrics unavailable.",
    "Give the 30-day booked report with refunds and returns marked unavailable.",
    "Give the 30-day booked report with refunded orders and returns marked unavailable.",
    "Give the 30-day report; mark collected cash unavailable.",
    "Give the 30-day booked report and do not create a discount.",
    "Give the 30-day booked report but never change the theme.",
    "Give the 30-day booked report and make it concise.",
    "Give the 30-day booked report and generate a Markdown table.",
    "Give the 30-day booked report and build a short summary.",
    "Give the 30-day booked report and create a chart.",
    "Give the 30-day booked report and write a short summary.",
    "Give the 30-day booked report and create an order summary table.",
    "Give the 30-day booked report and create a table of orders.",
    "Give the 30-day booked report and generate a product chart.",
    "Give the 30-day booked report; do not update SEO, delete products, or change settings.",
    "Give the 30-day booked report and do not update SEO and delete products or change settings.",
    "Give the 30-day booked report and never update SEO, delete products, or change settings.",
    "Give the 30-day booked report and include https://example.com/reports/current as a formatting note.",
    "Give the 30-day booked report with an order/recovery ratio left unavailable.",
    "Give the 30-day booked report and create a table with revenue / order ratios.",
    "Give the previous 30-day owner operations brief as a concise Markdown table.",
    "Give the rolling 30-day owner operations brief as bullets and a small chart.",
    "Give the current 30-day owner operations brief in compact JSON formatting.",
    "Give the 30 calendar-day owner brief with headings for booked activity, currency, stock, and backlogs.",
    "Give the previous 30-day owner operations brief in compact YAML style.",
    "Give the rolling 30-day booked brief as two short prose paragraphs.",
    "Give the current 30-day owner operations brief as a two-column table.",
    "Give the 30 calendar-day owner operations brief as dashboard cards.",
    "Give the thirty-day owner operations brief as a numbered list with section titles.",
    "Give the previous 30-day owner operations brief as a plain-text grid.",
    "Give the rolling 30-day booked brief in an HTML table.",
    "Give the current 30-day owner operations brief as compact key-value blocks.",
    "Give the 30 calendar-day owner operations brief with one line per section.",
    "Give the thirty-day owner operations brief as a JSON object.",
    "Give the 30-day booked brief in CSV-style columns.",
    "Give the previous 30-day owner operations brief in TSV-style columns.",
    "Give the rolling 30-day booked brief as an indented outline.",
    "Give the current 30-day owner operations brief as a compact matrix.",
    "Give the 30 calendar-day owner operations brief as plain sentences.",
    "Give the thirty-day owner operations brief inside a code block.",
    "Give the 30-day booked brief as labeled cards with icons.",
  ])("keeps noun-led report requests and refund/return fact lists read-only: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it.each([
    "Give the 30-day booked owner briefing, then create a discount.",
    "Give the 30-day booked owner briefing, then publish a product.",
    "Give the 30-day booked owner briefing, then adjust inventory.",
    "Give the 30-day booked owner briefing, then refund an order.",
    "Give the 30-day booked owner briefing, then change the theme.",
    "Give the 30-day booked owner briefing, then send recovery emails.",
    "Give the 30-day booked owner briefing, and email me the summary.",
    "Give the 30-day booked owner briefing, and mark an order fulfilled.",
    "Give the 30-day booked owner briefing, and mark an order paid.",
    "Give the 30-day booked owner briefing, and launch a campaign.",
    "Give the 30-day booked owner briefing, and build a campaign page.",
    "Give the 30-day booked owner briefing, and build a campaign summary page.",
    "Give the 30-day booked owner briefing, and create a product report page.",
    "Give the 30-day booked owner briefing, and create a summary page.",
    "Give the 30-day booked owner briefing, and generate a coupon.",
    "Give the 30-day booked owner briefing, and make a shipping method.",
    "30-day booked brief: create a discount.",
    "30-day booked brief\n- create a discount.",
    "30-day booked brief & create a discount.",
    "30-day booked brief — create a discount.",
    "30-day booked brief / adjust stock by 5.",
    "Give the 30-day booked report; do not update SEO, but delete products.",
    "Give the 30-day booked report; do not update SEO, then delete products.",
    "Give the 30-day booked report; do not update SEO, also delete products.",
    "Give the 30-day booked report; do not update SEO; delete products.",
    "Give the 30-day booked report; do not update SEO\n- delete products.",
    "Give the 30-day booked report; do not update SEO. Delete products.",
    "30-day booked owner brief with current backlogs, then create a discount.",
    "Current 30-day owner booked commerce; afterward create a percentage-off coupon.",
    "Current 30-day owner booked commerce subsequently publish a product.",
    "Current 30-day owner booked commerce, later adjust inventory.",
    "Current 30-day owner booked commerce\n- thereafter change the theme.",
    "Current 30-day owner booked commerce followed by refund an order.",
    "Current 30-day owner booked commerce, but next send recovery emails.",
    "Current 30-day owner booked commerce — finally delete a shipping method.",
  ])("asks before a secondary briefing mutation: %s", (prompt) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution.disposition).toBe("ask");
    expect(["choices", "control"]).toContain(resolution.kind);
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "Current 30-day owner booked commerce; do not create a coupon afterward.",
    "Current 30-day owner booked commerce; afterward do not create a coupon.",
    "Current 30-day owner booked commerce; never subsequently publish a product.",
    "Current 30-day owner booked commerce; do not ever adjust inventory later.",
    "Current 30-day owner booked commerce with later payment totals and subsequent recovery counts marked unavailable.",
    "Current 30-day owner booked commerce; afterward create a concise Markdown table.",
    "Current 30-day owner booked commerce; later mark warehouse efficiency unavailable.",
  ])("preserves negated, nominal, presentation, and cooperative temporal clauses: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it("guards a high-confidence synthetic read before composition or fallback", () => {
    const resolveSynthetic = createSyntheticReadResolver({
      id: "owner-report",
      title: "Read a bounded booked operations report",
      summary: "Read booked operations activity, inventory risk, and recovery backlog totals.",
      tags: ["read", "booked", "operations", "activity", "inventory", "recovery", "report"],
    });
    const resolution = resolveSynthetic({
      prompt:
        "Give a bounded booked operations report with activity, inventory risk, and recovery backlog totals, then create a discount.",
      surface: "dashboard",
    });
    expect(resolution).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({ id: "dashboard.synthetic-owner-report" })],
      safetyNotes: [expect.stringContaining("cannot absorb a separate mutation")],
    });
    if (resolution.kind === "choices") {
      expect(resolution.choices[0]!.confidence).toBeGreaterThan(0.8);
    }
  });

  it.each([
    ["bare over 30", "Give the brief over 30 days.", "dashboard.thirty-day-booked-operations-brief"],
    ["bare across 30", "Give the brief across 30 days.", "dashboard.thirty-day-booked-operations-brief"],
    ["vague cooperative", "Give a report over 30 days with warehouse humidity unavailable.", "dashboard.thirty-day-booked-operations-brief"],
    ["7", "Give the accepted PII-free 7-day owner brief with booked activity and current backlog totals.", "dashboard.thirty-day-booked-operations-brief"],
    ["14", "Give the accepted PII-free 14-day owner brief with booked activity and current backlog totals.", "dashboard.thirty-day-booked-operations-brief"],
    ["60", "Give the accepted PII-free 60-day owner brief with booked activity and current backlog totals.", "dashboard.thirty-day-booked-operations-brief"],
    ["90", "Give the accepted PII-free 90-day owner brief with booked activity and current backlog totals.", "dashboard.thirty-day-booked-operations-brief"],
    ["1000", "Give the accepted PII-free 1000-day owner brief with booked activity and current backlog totals.", "dashboard.thirty-day-booked-operations-brief"],
    ["seven", "Give an owner activity report for seven days with current backlog totals.", "dashboard.thirty-day-booked-operations-brief"],
    ["fourteen", "Give an owner activity report for fourteen days with current backlog totals.", "dashboard.thirty-day-booked-operations-brief"],
    ["sixty", "Give a sixty-day owner briefing with booked activity and backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["ninety", "Give a ninety-day owner briefing with booked activity and backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["30 business", "Give a 30-business-day owner briefing with booked activity and backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["30.0", "Give a PII-free 30.0-day owner briefing with booked activity and backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["last month", "Give a last-month owner briefing with booked activity and backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["calendar month", "Give an owner activity summary for the previous calendar month.", "dashboard.thirty-day-booked-operations-brief"],
    ["30 then 60", "Give the 30-day owner brief but use 60 days instead.", "dashboard.thirty-day-booked-operations-brief"],
    ["30 then 90", "Give the 30-day owner brief; make this 90 instead.", "dashboard.thirty-day-booked-operations-brief"],
    ["over 14", "Give the owner operations report over 14 days with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["across seven", "Give the owner activity summary across seven days with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["positioned decimal", "Give booked activity and current backlogs for the 30.0-day owner briefing.", "dashboard.thirty-day-booked-operations-brief"],
    ["this week", "Give the owner operations report for this week with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["MTD", "Give the owner operations report MTD with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["ISO range", "Give the owner operations report for 2026-08-01→18 with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["named range", "Give the owner operations report for August 1→18 with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["4 weeks", "Give the owner operations report over 4 weeks with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["720 hours", "Give the owner operations report for 720 hours with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["Q3", "Give the owner operations report for Q3 with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["YTD", "Give the owner operations report YTD with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["one month", "Give the owner operations report for one month with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["ISO range without report noun", "Show booked operations for 2026-08-01→18 with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["named range without report noun", "Show owner operations for Aug 1→18 with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["quarter without report noun", "Show booked operations this quarter with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["YTD without report noun", "Show owner operations YTD with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["year-to-date owner operations", "Show the owner's operations year-to-date with current backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["invented named range", "Show PII-free owner operations from Sep 2 through 15 with current stock and recovery backlogs.", "dashboard.thirty-day-booked-operations-brief"],
    ["daily two", "Give me a daily operations snapshot for two days with orders and checkout readiness.", "dashboard.daily-operations-snapshot"],
    ["daily yesterday", "Give me the daily operations snapshot for yesterday with orders and checkout readiness.", "dashboard.daily-operations-snapshot"],
    ["daily rolling day", "Give me the daily operations snapshot for the last 1 day with orders and checkout readiness.", "dashboard.daily-operations-snapshot"],
  ])("asks instead of coercing the %s window", (_window, prompt, routeId) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({ id: routeId })],
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "Compare the latest thirty days of merchant booked operations with the previous fiscal quarter.",
    "Compare the rolling 30-day owner operations brief with the prior financial year.",
    "Show the current thirty-day merchant booked report versus the earlier accounting month.",
    "Compare the preceding calendar quarter with the latest 30-day booked operations brief.",
    "Give the latest 30-day proprietor commerce summary alongside the prior fiscal week.",
    "Compare the previous 60 days with the current 30-day owner operations brief.",
  ])("collects every explicit report period before fixed-read routing: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({
        id: "dashboard.thirty-day-booked-operations-brief",
      })],
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "Alongside a rolling thirty-day merchant booked recap, show the preceding accounting month.",
    "Alongside the current 30-day owner booked synopsis, show the prior financial year.",
    "Compare the earlier accounting month with the latest thirty-day merchant operations update.",
    "Return a rolling 30-day proprietor commerce overview plus the preceding calendar quarter.",
    "Show the prior fiscal week alongside the current thirty-day booked result-set.",
  ])("collects relative periods without relying on report-noun vocabulary: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({
        id: "dashboard.thirty-day-booked-operations-brief",
      })],
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it("keeps relative-period labels and weak unrelated text out of fixed routing", () => {
    const labelPrompt =
      "Alongside a rolling thirty-day merchant booked recap, label a column \"Accounting Month\".";
    expect(resolveWorkflow({ prompt: labelPrompt, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt: labelPrompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });

    for (const prompt of [
      "Show the \"Accounting Month\" label in a payroll form.",
      "Explain a glossary entry named \"Financial Year\" for HR.",
    ]) {
      const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
      if (resolution.kind === "plan") {
        expect(resolution.plan.routeIds, prompt).not.toContain(
          "dashboard.thirty-day-booked-operations-brief",
        );
      } else if (resolution.kind === "choices") {
        expect(resolution.choices.map((choice) => choice.id), prompt).not.toContain(
          "dashboard.thirty-day-booked-operations-brief",
        );
      }
      expect(compileWorkflowRead({ prompt, surface: "dashboard" }), prompt).toBeNull();
    }
  });

  it.each([
    "Owner booked commerce during the thirty calendar days just completed.",
    "Merchant booked operations within the thirty calendar days most recently completed.",
    "Booked commerce covering 30 calendar days ending today.",
    "Owner operations throughout the thirty days just finished.",
    "Merchant booked activity: 30 calendar days recently ended.",
    "Booked owner commerce spanning the 30 days ending now.",
  ])("recognizes concise exact calendar windows without report nouns: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it("keeps bounded tab-heavy phrase and window matching linear and deterministic", () => {
    const tabs = "\t".repeat(384);
    const supported =
      `Give the current${tabs}30${tabs}calendar${tabs}days owner booked operations brief ` +
      `with low${tabs}on${tabs}hand, unfinished${tabs}checkout${tabs}flows, and ` +
      `hosted${tabs}payment continuations; mark other facts unavailable.`;
    const concise =
      `Owner booked commerce during the thirty${tabs}calendar${tabs}days${tabs}just completed.`;
    const localAge =
      `Give the current${tabs}30${tabs}day owner operations brief with payments ` +
      `older than two${tabs}weeks marked unavailable.`;
    const nearMiss =
      `Give the owner booked operations brief for current${"\t".repeat(3_500)}30 nights.`;
    const prompts = [supported, concise, localAge, nearMiss];
    for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(4_000);

    const startedAt = performance.now();
    for (const prompt of [supported, concise, localAge]) {
      expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
        kind: "plan",
        disposition: "execute",
        plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
      });
      expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
        .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
    }
    expect(resolveWorkflow({ prompt: nearMiss, surface: "dashboard" })).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({
        id: "dashboard.thirty-day-booked-operations-brief",
      })],
    });
    expect(compileWorkflowRead({ prompt: nearMiss, surface: "dashboard" })).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it.each([
    "Owner booked commerce during the 30 business days just completed.",
    "Owner booked operations with invoices open for 30 days.",
    "Owner booked commerce with a label \"30 calendar days just completed\".",
    "Owner booked commerce during the 30 calendar days just completed compared with the prior fiscal quarter.",
    "Weather observations during the 30 calendar days just completed.",
  ])("keeps incompatible, local, labeled, compound, or weak day scopes non-executable: %s", (prompt) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution.disposition).toBe("ask");
    if (resolution.kind === "plan") {
      expect(resolution.plan.routeIds).not.toContain(
        "dashboard.thirty-day-booked-operations-brief",
      );
    }
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "Give the latest 30-day owner operations brief and label a column \"Fiscal Quarter\".",
    "Give the current 30-day merchant booked report with a note called \"Accounting Month\".",
    "Show the rolling thirty-day owner operations brief and use \"Financial Year\" as a heading.",
    "Give the current 30-day owner operations brief; mark the previous fiscal quarter unavailable.",
  ])("does not confuse period labels or cooperative local gaps with report scopes: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it("does not confuse top-N or aging facts with the fixed report window", () => {
    const testCase = AGENT_INTENT_EVAL_CASES.find((candidate) =>
      candidate.id === "dashboard.thirty-day-booked-operations-brief"
    )!;
    expect(compileWorkflowRead({ prompt: testCase.prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
    const topDays = "Give a 30-day owner brief with top 10 days by booked orders and current backlogs; mark unsupported metrics unavailable.";
    expect(resolveWorkflow({ prompt: topDays, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });

    const agingDemand = "Give the 30-day owner brief and show how many orders have been stuck for 7 days.";
    expect(resolveWorkflow({ prompt: agingDemand, surface: "dashboard" })).toMatchObject({
      kind: "control",
      disposition: "ask",
      classification: {
        controlId: "dashboard.thirty-day-owner-briefing-unsupported-only",
      },
    });
    expect(compileWorkflowRead({ prompt: agingDemand, surface: "dashboard" })).toBeNull();

    const cooperativeAging = `${agingDemand} Leave that unavailable in the fixed brief.`;
    expect(resolveWorkflow({ prompt: cooperativeAging, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });

    for (const localAging of [
      "Give the 30-day owner brief with orders over 7 days marked unavailable.",
      "Give the 30-day owner brief with abandoned checkouts older than 5 days marked unavailable.",
      "Give the 30-day owner brief with payments stuck for 3 days marked unavailable.",
      "Give the 30-day owner brief with recovery for fourteen days marked unavailable.",
      "Give the 30-day owner brief with fulfillments pending for 2 weeks marked unavailable.",
      "Give the 30 calendar-day owner brief; mark recovery cases over 2 weeks unavailable.",
      "Give the thirty-day owner brief; mark fulfillment backlog older than 3 days unavailable.",
      "Give the rolling 30-day owner brief; mark payment attempts over several days unavailable.",
      "Give the rolling 30-day owner brief; mark checkout sessions abandoned for 14 days unavailable.",
      "Give the current 30-day owner brief; mark failed payment attempts older than five days unavailable.",
      "Give the 30 calendar-day owner brief; mark payment-recovery cases needing attention over 2 weeks unavailable.",
      "Give the thirty-day owner brief; mark recoverable recovery items stuck for seven days unavailable.",
      "Give the 30-day owner brief; mark pending fulfillment backlog older than three days unavailable.",
      "Give the rolling 30-day owner brief; include checkout items over two weeks if known, otherwise mark unavailable.",
      "Give the 30-day owner operations brief; mark courier parcels over 5 kg unavailable.",
      "Give the 30-day owner operations brief; mark fulfillment by Pathao for 3 delivery zones unavailable.",
    ]) {
      expect(resolveWorkflow({ prompt: localAging, surface: "dashboard" }), localAging).toMatchObject({
        kind: "plan",
        plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
      });
      expect(compileWorkflowRead({ prompt: localAging, surface: "dashboard" }), localAging)
        .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
    }

    const hardLocalAging =
      "Give the 30-day owner brief and show how many abandoned checkouts are stuck for 5 days.";
    expect(resolveWorkflow({ prompt: hardLocalAging, surface: "dashboard" })).toMatchObject({
      kind: "control",
      disposition: "ask",
      classification: { controlId: "dashboard.thirty-day-owner-briefing-unsupported-only" },
    });
    expect(compileWorkflowRead({ prompt: hardLocalAging, surface: "dashboard" })).toBeNull();

    for (const hardAgeDemand of [
      "Give the rolling 30-day owner brief with the exact count of checkouts older than 14 days.",
      "Count payments over 5 days in the current 30-day owner brief.",
      "Show recovery cases over 2 weeks in the 30-day owner brief.",
      "List fulfillment backlog older than 3 days in the rolling 30-day owner brief.",
      "Give the rolling 30-day owner brief with the exact count of checkout sessions abandoned for 14 days.",
      "Show failed payment attempts older than five days in the current 30-day owner brief.",
      "Count payment-recovery cases needing attention over 2 weeks in the 30 calendar-day owner brief.",
      "List recoverable recovery items stuck for seven days in the thirty-day owner brief.",
      "Give the exact pending fulfillment backlog older than three days in the 30-day owner brief.",
    ]) {
      expect(resolveWorkflow({ prompt: hardAgeDemand, surface: "dashboard" })).toMatchObject({
        kind: "control",
        disposition: "ask",
        classification: {
          controlId: expect.stringMatching(
            /^dashboard\.thirty-day-owner-briefing-(?:needs-scope|unsupported-only)$/,
          ),
        },
      });
      expect(compileWorkflowRead({ prompt: hardAgeDemand, surface: "dashboard" })).toBeNull();
    }

    const operationsWindow =
      "Give the booked owner operations over 7 days with current backlogs.";
    expect(resolveWorkflow({ prompt: operationsWindow, surface: "dashboard" })).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({
        id: "dashboard.thirty-day-booked-operations-brief",
      })],
    });
    expect(compileWorkflowRead({ prompt: operationsWindow, surface: "dashboard" })).toBeNull();

    expect(resolveWorkflow({
      prompt:
        "Give the 30-day owner brief with overdue orders over 4 weeks left unavailable and current backlogs.",
      surface: "dashboard",
    })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });

    for (const localFactWindow of [
      "Show owner operations with 30-day-old stuck orders and current backlogs.",
      "Show owner operations with a 30-day return window and current backlogs.",
    ]) {
      expect(resolveWorkflow({ prompt: localFactWindow, surface: "dashboard" }))
        .toMatchObject({
          kind: "choices",
          disposition: "ask",
          choices: [expect.objectContaining({
            id: "dashboard.thirty-day-booked-operations-brief",
          })],
        });
      expect(compileWorkflowRead({ prompt: localFactWindow, surface: "dashboard" }))
        .toBeNull();
    }
  });

  it("keeps undeclared fixed-read facts unavailable without expanding the projection", () => {
    for (const prompt of [
      "Give exact products over 12 kg in the previous 30-day owner operations brief.",
      "List SKUs over 20 units in the current 30-day owner operations brief.",
      "Give exact warehouse temperature in the previous 30-day owner operations brief.",
      "Count courier SLA breaches in the rolling 30-day owner operations brief.",
      "List supplier lead times in the current 30-day owner operations brief.",
      "Show exact loyalty-points liability in the 30 calendar-day owner operations brief.",
      "List product review sentiment rows in the 30-day owner operations brief.",
      "Give warehouse temperature in the previous 30-day owner operations brief.",
      "Include supplier lead times in the current 30-day owner operations brief.",
      "Return loyalty-points liability in the 30-day owner operations brief.",
      "Provide courier SLA breaches in the rolling 30-day owner operations brief.",
      "Add product review sentiment to the 30-day owner operations brief.",
      "Show payment-method counts in the 30-day owner operations brief.",
      "Show checkout state totals in the 30-day owner operations brief.",
      "Show payment provider totals in the 30-day owner operations brief.",
    ]) {
      const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
      expect(resolution, prompt).toMatchObject({
        kind: "plan",
        disposition: "execute",
        plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
      });
      if (resolution.kind === "plan") {
        expect(resolution.plan.rules.join(" "), prompt)
          .toMatch(/absent from fixed selectors.*unavailable.*never infer.*claim coverage/i);
        if (/payment provider/i.test(prompt)) {
          expect(JSON.stringify(resolution.plan.detail)).not.toMatch(/providerBreakdown/i);
        }
      }
      expect(compileWorkflowRead({ prompt, surface: "dashboard" }), prompt)
        .toMatchObject({
          workflowId: "operations.thirty-day-booked-brief.v1",
          rules: expect.arrayContaining([
            expect.stringMatching(/absent from fixed selectors.*unavailable/i),
          ]),
        });
    }

    for (const prompt of [
      "Show booked revenue and current recovery totals in the 30-day owner brief.",
      "Give current stock and abandoned checkout totals in the 30-day owner brief.",
      "Give the previous 30-day owner brief with daily booked gross sales and order counts.",
      "Give the current 30-day owner brief with current low-stock and zero-stock inventory counts.",
      "Give the 30 calendar-day owner brief with the current abandoned-cart total.",
      "Give the thirty-day owner brief with the current recoverable hosted-payment backlog total.",
      "Give the 30-day owner brief with the current payments-needing-attention total.",
      "Give the previous 30-day owner brief with current stock-risk, abandoned-checkout, and payment-recovery totals.",
      "Give the rolling 30-day booked-activity brief with saved display currency and current operational backlog counts.",
      "Give the previous 30-day owner brief with daily booked gross turnover and order volumes.",
      "Give the rolling 30-day owner brief with saved currency denomination and sign.",
      "Give the current 30-day owner brief with scarce-stock and zero-inventory tallies.",
      "Give the 30 calendar-day owner brief with the abandoned-baskets count.",
      "Give the thirty-day owner brief with recoverable-payment cases total.",
      "Give the previous 30-day booked-activity summary with money denomination, inventory-risk tallies, abandoned baskets, and recovery backlogs.",
      "Give the previous 30-day owner operations brief with order-day booked sales totals and order volumes.",
      "Give the rolling 30-day booked brief with the saved display-money code and glyph.",
      "Give the 30 calendar-day operations brief with the deserted-checkouts count.",
      "Give the thirty-day owner brief with total recoverable payment work.",
      "Give the 30-day booked brief with the action-needed recovery count.",
      "Give the previous 30-day operations summary with daily sales booked, currency glyph, inventory shortages, deserted carts, and recoverable payments.",
      "Give the previous 30-day owner operations brief with merchant-day order totals and gross booking values.",
      "Give the rolling 30-day booked brief with orders booked per day and their gross value.",
      "Give the current 30-day owner brief with the store currency identifier and mark.",
      "Give the 30 calendar-day operations brief with low-on-hand and out-of-stock counts.",
      "Give the thirty-day owner brief with stock-shortage and exhausted-SKU tallies.",
      "Give the 30-day booked brief with the uncompleted-cart count.",
      "Give the current 30-day operations summary with daily order booking values, currency mark, depleted inventory counts, unfinished carts, and payment recovery totals.",
      "Give the previous 30-day owner operations brief with merchant-calendar dates, placed-order counts, and gross booked amounts.",
      "Give the current 30-day owner brief with the shop money abbreviation and symbol.",
      "Give the thirty-day owner brief with near-empty and sold-out SKU tallies.",
      "Give the 30-day booked brief with the incomplete-checkout total.",
      "Give the previous 30-day owner operations brief with the unconverted-cart tally.",
      "Give the rolling 30-day booked brief with hosted-payment recoverable total and manual-attention recovery tally.",
      "Give the current 30-day operations summary with daily placed orders and booked amounts, shop currency, scarce stock, incomplete checkouts, and recoverable payment work.",
      "Give the rolling 30-day owner operations brief; exclude supplier lead times.",
      "Give the rolling 30-day owner operations brief; omit warehouse temperature.",
      "Give the rolling 30-day owner operations brief; leave out loyalty-points liability.",
    ]) {
      expect(resolveWorkflow({ prompt, surface: "dashboard" }), prompt).toMatchObject({
        kind: "plan",
        plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
      });
      expect(compileWorkflowRead({ prompt, surface: "dashboard" }), prompt)
        .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
    }

    for (const prompt of [
      "Give the previous 30-day owner operations brief; include staff hours if known, otherwise mark unavailable.",
      "Give the 30-day owner operations brief; mark supplier warranties lasting 14 days unavailable.",
      "Give the rolling 30-day owner operations brief; include a campaign active for 2 weeks if available.",
      "Give the 30-day owner operations brief; mark a delivery SLA of 7 days unavailable.",
      "Give the 30-day owner operations brief; mark a page published yesterday unavailable.",
      "Give the rolling 30-day owner operations brief with supplier delays over two weeks if supported, otherwise mark unavailable.",
    ]) {
      expect(resolveWorkflow({ prompt, surface: "dashboard" }), prompt).toMatchObject({
        kind: "plan",
        disposition: "execute",
        plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
      });
      expect(compileWorkflowRead({ prompt, surface: "dashboard" }), prompt)
        .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
    }
  });

  it("keeps the frozen owner-brief synonyms inside the reviewed projection", () => {
    for (const prompt of [
      "Summarize the last 30 calendar days of owner operations with one merchant-local row per business date, purchase placements, and gross value committed at order time.",
      "For the rolling thirty-day booked-operations brief, include the stored tender ISO code and display mark.",
      "Give the current 30-day owner brief with scant-stock and zero-available sellable-variant totals.",
      "Give the previous 30-day booked brief with the current unfinished cart-flow count.",
      "Give the rolling 30-day operations brief with hosted-payment continuations still available.",
      "Give the current 30-day owner brief with payment rescues requiring operator intervention.",
      "Give the last 30-day owner operations brief with daily purchase volume and booked value, saved denomination, inventory-risk totals, unfinished checkout count, and both payment-recovery totals.",
      "Give the previous 30-day owner brief with one merchant-local row per business date, purchase placements, and gross value committed at order time.",
      "Give the rolling 30-day owner brief with daily purchase placements and gross value committed at order time.",
      "Give the current 30-day owner brief with the unfinished cart-flow total.",
      "Give the 30 calendar-day owner brief with hosted-payment continuations and manual-attention totals.",
      "Give the thirty-day owner brief with stored tender ISO code, display mark, and depleted inventory counts.",
      "Give the previous 30-day owner brief with daily purchase placements, booked value, and unfinished cart-flow totals.",
      "Give the 30-day owner brief with daily purchase placements, booked value, saved currency, depleted inventory, unfinished cart-flow, and hosted-payment continuation totals.",
    ]) {
      expect(resolveWorkflow({ prompt, surface: "dashboard" }), prompt).toMatchObject({
        kind: "plan",
        disposition: "execute",
        plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
      });
      expect(compileWorkflowRead({ prompt, surface: "dashboard" }), prompt)
        .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
    }
  });

  it("keeps harmless frozen presentation variants outside fact matching", () => {
    for (const prompt of [
      "Give the current 30-day owner operations brief as a pipe-delimited table.",
      "Give the rolling 30-day booked brief as a key-value list.",
      "Give the previous 30-day owner operations brief with headings and nested bullets.",
      "Give the current thirty-day owner operations brief as a monospaced grid.",
      "Give the 30 calendar-day booked brief as JSON-shaped prose.",
      "Give the previous 30-day owner operations brief as a concise Markdown table.",
      "Give the rolling 30-day owner operations brief in a short bullet list.",
      "Return the current 30-day owner operations brief as compact JSON.",
      "Give the 30 calendar-day owner operations brief as two compact columns.",
      "Summarize the thirty-day owner operations brief in one plain-text paragraph.",
    ]) {
      expect(resolveWorkflow({ prompt, surface: "dashboard" }), prompt).toMatchObject({
        kind: "plan",
        disposition: "execute",
        plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
      });
      expect(compileWorkflowRead({ prompt, surface: "dashboard" }), prompt)
        .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
    }
  });

  it("does not treat cooperative language as fixed-route domain evidence", () => {
    const prompt =
      "Give a 30-day brief, and if known include humidity; otherwise mark it unavailable.";
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({
        id: "dashboard.thirty-day-booked-operations-brief",
      })],
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();

    const unrelated = resolveWorkflow({
      prompt: "Give a brief explanation of warehouse humidity sensor calibration.",
      surface: "dashboard",
    });
    if (unrelated.kind === "plan") {
      expect(unrelated.plan.routeIds).not.toContain(
        "dashboard.thirty-day-booked-operations-brief",
      );
    } else if (unrelated.kind === "choices") {
      expect(unrelated.choices.map((choice) => choice.id)).not.toContain(
        "dashboard.thirty-day-booked-operations-brief",
      );
    }
    expect(compileWorkflowRead({
      prompt: "Give a brief explanation of warehouse humidity sensor calibration.",
      surface: "dashboard",
    })).toBeNull();
  });

  it("executes the literal fixed-projection audit requests without expanding selectors", () => {
    for (const prompt of [
      "In the current 30-day merchant operations digest, show the configured currency identifier and display sign.",
      "For the rolling thirty-day shop-owner digest, add present counts of variants running low and variants with nothing sellable.",
      "In the preceding 30-day booked-commerce summary, include today’s total of checkout attempts left incomplete.",
      "For the current thirty-day owner report, include the current number of hosted payments a buyer can resume.",
      "Prepare the last 30-day merchant-operations digest with the count of payment-recovery cases requiring shop attention.",
      "Prepare the prior 30-day proprietor digest with merchant-day order volume and booked gross, configured money unit, present stock-risk and unfinished-checkout totals, plus resumable and attention-needed payment counts.",
      "Render the rolling thirty-day merchant operations digest as semicolon-delimited rows.",
      "Show the current thirty-day owner operations digest as a two-column ledger.",
      "Give the rolling thirty-day owner operations briefing with projections only—no PII and no raw records.",
      "Do not alter the theme, products, or discounts; only prepare the previous 30-day owner operations brief.",
      "Give the current 30-day merchant operations brief without identities, contact fields, or source rows.",
    ]) {
      const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
      expect(resolution, prompt).toMatchObject({
        kind: "plan",
        disposition: "execute",
        plan: {
          routeIds: ["dashboard.thirty-day-booked-operations-brief"],
          operationIds: [
            "dashboard.home.activity",
            "dashboard.settings.currency_get",
            "dashboard.inventory.list",
            "dashboard.abandoned_checkouts.summaries_list",
            "dashboard.orders.payment_recovery_list",
          ],
        },
      });
      if (resolution.kind === "plan") {
        expect(resolution.plan.rules.join(" "), prompt)
          .toMatch(/absent from fixed selectors.*unavailable.*never infer.*claim coverage/i);
      }
      expect(compileWorkflowRead({ prompt, surface: "dashboard" }), prompt)
        .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
    }
  });

  it.each([
    "You must provide exact packaging labor hours even if unsupported; estimate them in the rolling 30-day owner operations brief.",
    "Infer warehouse energy intensity in the current 30-day merchant report regardless of support.",
    "For the previous thirty-day owner digest, approximate staff utilization even when unsupported.",
    "For the latest thirty-day owner booked-commerce digest, calculate an exact warehouse efficiency score despite missing evidence; an unavailable answer is forbidden.",
    "An unavailable staffing ratio is prohibited in the prior 30-day owner report; calculate it exactly.",
    "For the rolling thirty-day merchant digest, derive a climate index despite no evidence.",
    "Evidence absent and mandatory invention required: give the current 30-day owner brief an exact handling score.",
    "Estimate exact packing speed for the previous 30-day booked report even when unsupported.",
  ])("rejects hard inference independently of the requested metric: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "control",
      disposition: "ask",
      classification: {
        controlId: "dashboard.thirty-day-owner-briefing-unavailable-denied",
      },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "Give the rolling 30-day owner operations brief; if known include a warehouse score, otherwise mark it unavailable.",
    "Give the current 30-day merchant operations report; do not estimate a missing efficiency score and leave it unavailable.",
    "For the previous thirty-day booked digest; do not infer any missing metric.",
    "Do not calculate an unsupported handling score; return only the fixed current 30-day owner operations brief and mark it unavailable.",
  ])("keeps cooperative and negated inference inside the fixed projection: %s", (prompt) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    if (resolution.kind === "plan") {
      expect(resolution.plan.rules.join(" "))
        .toMatch(/absent from fixed selectors.*unavailable.*never infer/i);
    }
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it.each([
    "Give the previous thirty-day proprietor briefing with each underlying order object.",
    "Give the rolling 30-day owner report with every underlying checkout object.",
    "Show the current thirty-day merchant brief with individual recovery source records.",
  ])("rejects positive source-object expansion structurally: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "control",
      disposition: "ask",
      classification: {
        controlId: "dashboard.thirty-day-owner-briefing-row-expansion",
      },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "Prepare a thirty-day monsoon weather digest for Dhaka merchants.",
    "Prepare a rolling 30-day cyclone weather report for store owners.",
    "Give the previous thirty-day rainfall operations digest for merchants.",
  ])("does not let merchant wording override a foreign report head: %s", (prompt) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution).toMatchObject({ kind: "choices", disposition: "ask" });
    if (resolution.kind === "choices") {
      expect(resolution.choices).toContainEqual(expect.objectContaining({
        id: "dashboard.thirty-day-booked-operations-brief",
      }));
    }
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "Prepare a rolling thirty-day owner review of contract disputes and court deadlines.",
    "Prepare the previous 30-day merchant review of employee performance and leave balances.",
    "Give a current thirty-day proprietor digest of regulatory compliance deadlines.",
    "Show the rolling 30-day store-owner review of litigation filings.",
    "Give the current 30-day merchant review; do not alter personnel files.",
  ])("does not treat an audience marker as fixed-read subject evidence: %s", (prompt) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution).toMatchObject({ kind: "choices", disposition: "ask" });
    if (resolution.kind === "choices") {
      expect(resolution.choices).toContainEqual(expect.objectContaining({
        id: "dashboard.thirty-day-booked-operations-brief",
      }));
    }
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "Give the current 30-day owner operations brief.",
    "Give the rolling thirty-day merchant booked brief.",
    "Prepare the previous 30-day proprietor commerce summary.",
    "Show the current thirty-day shop operations digest with a concise formatting note.",
  ])("accepts an explicit audience plus commerce subject compound: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it.each([
    "List merchant invoices that have remained open for thirty days.",
    "List supplier tickets that have been outstanding for thirty days.",
    "Show vendor invoices older than 30 days.",
  ])("treats state-bearing generic entity durations as local age: %s", (prompt) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution.disposition).toBe("ask");
    if (resolution.kind === "plan") {
      expect(resolution.plan.routeIds).not.toContain(
        "dashboard.thirty-day-booked-operations-brief",
      );
    }
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it.each([
    "In the current 30-day shop-owner brief, include the saved monetary code and its storefront glyph.",
    "For the previous 30-day owner report, show the configured monetary identifier and buyer-facing glyph.",
    "Give the rolling thirty-day booked digest with its saved monetary unit and display sign.",
  ])("maps currency schema vocabulary without literal prompt routes: %s", (prompt) => {
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it("keeps arbitrary cooperative extras bounded by the fixed projection", () => {
    const prompt =
      "Give the rolling 30-day owner operations brief; if known include packaging labor hours, otherwise mark them unavailable.";
    const resolution = resolveWorkflow({ prompt, surface: "dashboard" });
    expect(resolution).toMatchObject({
      kind: "plan",
      disposition: "execute",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    if (resolution.kind === "plan") {
      expect(resolution.plan.rules.join(" "))
        .toMatch(/absent from fixed selectors.*unavailable.*never infer/i);
    }
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it("keeps fixed projection scope explicit for wrong domains and undeclared breakdowns", () => {
    const weather =
      "Prepare a rolling 30-day weather-operations brief for the city.";
    expect(resolveWorkflow({ prompt: weather, surface: "dashboard" })).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({
        id: "dashboard.thirty-day-booked-operations-brief",
      })],
    });
    expect(compileWorkflowRead({ prompt: weather, surface: "dashboard" })).toBeNull();

    const providerBreakdown =
      "Prepare the prior thirty-day booked report with order totals broken down by payment provider.";
    const resolution = resolveWorkflow({ prompt: providerBreakdown, surface: "dashboard" });
    expect(resolution).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    if (resolution.kind === "plan") {
      expect(resolution.plan.rules.join(" "))
        .toMatch(/absent from fixed selectors.*unavailable/i);
      expect(JSON.stringify(resolution.plan.detail)).not.toMatch(/providerBreakdown/i);
    }
    const compiled = compileWorkflowRead({ prompt: providerBreakdown, surface: "dashboard" });
    expect(compiled).toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
    expect(JSON.stringify(compiled?.phases)).not.toMatch(/provider/i);
  });

  it.each([
    "Give the current 30-day owner report with booked activity and current backlogs.",
    "Give a rolling 30-day owner report with booked activity and current backlogs.",
    "Give the past 30-day owner report with booked activity and current backlogs.",
    "Give the calendar 30-day owner report with booked activity and current backlogs.",
    "Give the previous 30 days owner report with booked activity and current backlogs.",
    "Give the 30 calendar days owner report with booked activity and current backlogs.",
  ])("keeps an explicit supported 30-day calendar window executable: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it("keeps today's daily snapshot executable", () => {
    expect(resolveWorkflow({
      prompt: "Give today's daily operations snapshot with orders and checkout readiness.",
      surface: "dashboard",
    })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.daily-operations-snapshot"] },
    });
  });

  it.each([
    "Show PII-free booked owner operations with current stock and recovery totals; leave unsupported economics unavailable.",
    "Show booked owner operations since launch with current stock and recovery totals.",
  ])("asks when a non-exact fixed workflow has no compatible window: %s", (prompt) => {
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "choices",
      disposition: "ask",
      choices: [expect.objectContaining({
        id: "dashboard.thirty-day-booked-operations-brief",
      })],
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" })).toBeNull();
  });

  it("keeps session vocabulary scoped to the owner brief", () => {
    const hard = resolveWorkflow({
      prompt: "Give exact sessions for the last 30 days.",
      surface: "dashboard",
    });
    expect(hard).toMatchObject({
      kind: "control",
      disposition: "ask",
      classification: { controlId: "dashboard.thirty-day-owner-briefing-needs-scope" },
    });

    const cooperative =
      "Give a PII-free rolling 30-day owner brief with sessions unavailable and current backlogs.";
    expect(resolveWorkflow({ prompt: cooperative, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt: cooperative, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });

    const unrelated = resolveWorkflow({
      prompt: "Show current checkout-session readiness and payment-recovery session status.",
      surface: "dashboard",
    });
    if (unrelated.kind === "plan") {
      expect(unrelated.plan.routeIds).not.toContain(
        "dashboard.thirty-day-booked-operations-brief",
      );
    }
    if (unrelated.kind === "choices") {
      expect(unrelated.choices.map((choice) => choice.id)).not.toContain(
        "dashboard.thirty-day-booked-operations-brief",
      );
    }
    if (unrelated.kind === "control") {
      expect(unrelated.safePlan?.routeIds ?? []).not.toContain(
        "dashboard.thirty-day-booked-operations-brief",
      );
    }
    expect(compileWorkflowRead({
      prompt: "Show current checkout-session readiness and payment-recovery session status.",
      surface: "dashboard",
    })).toBeNull();
  });

  it("keeps explicitly excluded PII out of the fixed brief", () => {
    const prompt =
      "Give a PII-free 30-day owner brief without buyer names, emails, phones, or addresses; give current backlog totals and mark unsupported metrics unavailable.";
    expect(resolveWorkflow({ prompt, surface: "dashboard" })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
    });
    expect(compileWorkflowRead({ prompt, surface: "dashboard" }))
      .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
  });

  it("does not let a weak fixed-window candidate block a stronger unrelated read", () => {
    const resolveSynthetic = createWorkflowResolver({
      catalog: {
        version: "weak-window-candidate-test",
        cards: [],
        controls: [],
        routes: [
          {
            id: "dashboard.synthetic-fixed-owner-report",
            surface: "dashboard",
            kind: "read",
            title: "Read a booked owner report",
            summary: "Read booked owner activity for thirty merchant-calendar days.",
            examples: ["Read the fixed owner report."],
            tags: ["owner", "activity", "report"],
            fixedCalendarDays: 30,
            operationIds: ["dashboard.synthetic.owner_report"],
            requiresFacts: false,
            requiresConfirmation: false,
            requiresVerification: false,
            rules: ["Use thirty merchant-calendar days."],
          },
          {
            id: "dashboard.synthetic-lunar-report",
            surface: "dashboard",
            kind: "read",
            title: "Read lunar orbit research",
            summary: "Summarize lunar orbit research observations across requested windows.",
            examples: ["Read lunar observations."],
            tags: ["lunar", "orbit", "research", "observation"],
            operationIds: ["dashboard.synthetic.lunar_report"],
            requiresFacts: false,
            requiresConfirmation: false,
            requiresVerification: false,
            rules: ["Return lunar research only."],
          },
        ],
      },
      operations: [
        {
          operationId: "dashboard.synthetic.owner_report",
          surface: "dashboard",
          exposure: "execute",
          risk: "read",
          summary: "Read booked owner activity",
          tags: ["owner", "activity"],
          inputSchema: {},
        },
        {
          operationId: "dashboard.synthetic.lunar_report",
          surface: "dashboard",
          exposure: "execute",
          risk: "read",
          summary: "Read lunar orbit research",
          tags: ["lunar", "orbit", "research"],
          inputSchema: {},
        },
      ],
    });
    expect(resolveSynthetic({
      prompt: "Summarize lunar orbit research observations across sixty days.",
      surface: "dashboard",
    })).toMatchObject({
      kind: "plan",
      plan: { routeIds: ["dashboard.synthetic-lunar-report"] },
    });
  });

  it("keeps harmless briefing words and cooperative unavailable product metrics executable", () => {
    for (const prompt of [
      "Give a detailed PII-free brief for the last 30 days with recorded booked revenue and current backlogs; say traffic growth unavailable.",
      "Give a PII-free 30-day owner brief with booked activity; leave unsupported product metrics unavailable.",
      "Summarize the last thirty days of booked activity and current stock, abandoned, and recovery totals; if economics are unavailable, say unavailable.",
      "Give a PII-free 30-day owner operations brief with profit, net revenue, AOV, LTV, CAC, and returning customers if supported; otherwise mark them unavailable.",
      "Give the 30-day owner operations report with ad spend, impressions, clicks, ROAS, traffic, and conversion if available; leave unsupported metrics unavailable.",
      "Give the 30-day owner operations brief with refund, chargeback, return, and cancellation counts if supported; otherwise say unavailable.",
      "Give the PII-free 30-day owner operations briefing with no shopper phonebook, directory, contact list, roster, or raw rows.",
      "Give a PII-free 30-day owner operations brief with average order value, lifetime value, customer acquisition cost, and returning customers if supported; otherwise unavailable.",
      "Give the 30-day owner operations report with paid revenue, collected revenue, and settled revenue if known; leave them unavailable when unsupported.",
      "Give the 30-day owner operations report with visitors and sessions if supported; otherwise mark traffic unavailable.",
      "Give the 30-day owner operations report with profit and conversion rate if supported; otherwise mark both unavailable.",
    ]) {
      expect(resolveWorkflow({ prompt, surface: "dashboard" }), prompt).toMatchObject({
        kind: "plan",
        plan: { routeIds: ["dashboard.thirty-day-booked-operations-brief"] },
      });
      expect(compileWorkflowRead({ prompt, surface: "dashboard" }), prompt)
        .toMatchObject({ workflowId: "operations.thirty-day-booked-brief.v1" });
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
        operationId: "dashboard.seo.feed_row_preview",
        responsePointers: ["/data/entries", "/data/pagination", "/data/semantics"],
        proves: [
          "Exact emitted row or omission reason; oversize is unverified.",
        ],
        bounds: { maxCalls: 25, maxItems: 250, maxResponseBytes: 47_104 },
      }),
    ]));
    expect(detail.phaseStopConditions.dashboardVerify).toContain(
      "Preview proves rows only; not sitemap membership, cache propagation, or provider acceptance.",
    );
    expect(detail.phaseStopConditions.dashboardVerify).toContain(
      "Oversize preview: report row unverified; do not claim feed parity.",
    );
    expect(detail.steps.find((step) =>
      step.operationId === "dashboard.seo.feed_row_preview"
    )).toMatchObject({
      input: {
        template: { path: { productId: null }, query: { limit: 10 } },
        dependencies: [{
          templatePointer: "/path/productId",
          source: {
            kind: "step",
            phaseId: "create",
            stepId: "product",
            responsePointer: "/data/id",
          },
        }],
      },
    });

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

  it("compiles and projects the fixed 30-day brief without raw queue or customer data", () => {
    const compiled = compileWorkflowRead({
      prompt: "dashboard.thirty-day-booked-operations-brief",
      surface: "dashboard",
    });
    expect(compiled).not.toBeNull();
    if (!compiled) return;
    expect(compiled).toMatchObject({
      workflowId: "operations.thirty-day-booked-brief.v1",
      phases: [{ id: "brief" }],
    });
    expect(compiled.rules).toEqual(catalog.routes.find((route) =>
      route.id === "dashboard.thirty-day-booked-operations-brief"
    )!.rules);
    expect(compiled.phases[0]!.steps.map((step) => ({
      namespace: step.namespace,
      operationId: step.operationId,
      input: step.input,
    }))).toEqual([
      {
        namespace: "brief.daily",
        operationId: "dashboard.home.activity",
        input: { query: { days: 30 } },
      },
      {
        namespace: "brief.currency",
        operationId: "dashboard.settings.currency_get",
        input: {},
      },
      {
        namespace: "brief.stock",
        operationId: "dashboard.inventory.list",
        input: {
          query: {
            section: "variants",
            page: 1,
            limit: 1,
            search: "",
            status: "all",
            sort: "available",
            order: "asc",
          },
        },
      },
      {
        namespace: "brief.abandoned",
        operationId: "dashboard.abandoned_checkouts.summaries_list",
        input: { query: { page: 1, limit: 1, search: "", order: "desc" } },
      },
      {
        namespace: "brief.paymentRecovery",
        operationId: "dashboard.orders.payment_recovery_list",
        input: { query: { page: 1, limit: 1, state: "recoverable", order: "desc" } },
      },
      {
        namespace: "brief.paymentNeedsAttention",
        operationId: "dashboard.orders.payment_recovery_list",
        input: { query: { page: 1, limit: 1, state: "needs_attention", order: "desc" } },
      },
    ]);
    expect(new TextEncoder().encode(JSON.stringify(compiled)).byteLength).toBeLessThan(16 * 1024);

    const byNamespace = new Map(compiled.phases[0]!.steps.map((step) => [
      step.namespace,
      step.output,
    ]));
    const activityRows = Array.from({ length: 30 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 6, 20 + index)).toISOString().slice(0, 10),
      orders: index === 10 ? 0 : 2,
      revenue: index === 10 ? 0 : 250 + index,
      customerEmail: `private-${index}@example.com`,
    }));
    const projectedActivity = projectWorkflowReadResponse({
      data: {
        dailyActivityData: activityRows,
      },
    }, byNamespace.get("brief.daily")!);
    expect(projectedActivity).not.toBeNull();
    const projectedRows = projectedActivity!.activity as Array<Record<string, unknown>>;
    expect(projectedRows).toHaveLength(30);
    expect(projectedRows[0]).toEqual({
      date: "2026-07-20",
      orders: 2,
      bookedRevenue: 250,
    });
    expect(projectedRows[10]).toEqual({
      date: "2026-07-30",
      orders: 0,
      bookedRevenue: 0,
    });
    expect(projectedRows[29]).toEqual({
      date: "2026-08-18",
      orders: 2,
      bookedRevenue: 279,
    });
    expect(JSON.stringify(projectedActivity)).not.toContain("private-");
    for (const cardinality of [29, 31]) {
      const rows = cardinality === 31
        ? [...activityRows, { ...activityRows[29]!, date: "2026-08-19" }]
        : activityRows.slice(0, cardinality);
      expect(projectWorkflowReadResponse({
        data: { dailyActivityData: rows },
      }, byNamespace.get("brief.daily")!), String(cardinality)).toBeNull();
    }
    expect(projectWorkflowReadResponse({
      data: {
        stats: { lowStockCount: 4, outOfStockCount: 2 },
        variants: [{ sku: "SECRET", customerPhone: "+8801700000000" }],
      },
    }, byNamespace.get("brief.stock")!)).toEqual({ lowStockCount: 4, outOfStockCount: 2 });
    for (const namespace of [
      "brief.abandoned",
      "brief.paymentRecovery",
      "brief.paymentNeedsAttention",
    ]) {
      expect(projectWorkflowReadResponse({
        data: {
          pagination: { total: 7 },
          orders: [{ customerName: "Private Buyer" }],
          checkouts: [{ email: "private@example.com" }],
        },
      }, byNamespace.get(namespace)!)).toEqual({ total: 7 });
    }
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
      "Preview proves rows only; not sitemap membership, cache propagation, or provider acceptance.",
    );
    expect(product.plan.detail.phaseStopConditions.dashboardVerify).toContain(
      "Oversize preview: report row unverified; do not claim feed parity.",
    );
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: product }))).toBe(15_948);
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
