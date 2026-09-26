// EMI plans: the store's "EMI on card payment, from X/month" line on
// eligible products. Informational only; checkout offers no EMI.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getEmiSettings, saveEmiSettings } from "@scalius/core/modules/settings";
import { EMI_MAX_FEE_BPS, EMI_MAX_MONTHS, EMI_MAX_PLANS, EMI_MIN_MONTHS } from "@scalius/shared/emi";

import { ok } from "../../../utils/api-response";

import { conflictResponse, errorResponses, successEnvelope } from "../../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const emiPlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).openapi({ description: "A stable id the editor assigns (lowercase letters, numbers, - and _)." }),
  provider: z.string().trim().min(1).max(60).openapi({ description: "The bank or card as buyers know it (\"City Bank\")." }),
  months: z.number().int().min(EMI_MIN_MONTHS).max(EMI_MAX_MONTHS),
  feePercentage: z.number().min(0).max(EMI_MAX_FEE_BPS / 100).openapi({
    description: "The bank's total conversion fee over the tenure, in percent (0 for a 0% plan).",
  }),
  minAmount: z.number().min(0).openapi({ description: "The smallest price the plan applies to (whole taka in BDT)." }),
}).strict();

const emiSettingsSchema = z.object({
  enabled: z.boolean().openapi({ description: "Off by default; the line shows only when on and a plan applies." }),
  plans: z.array(emiPlanSchema).max(EMI_MAX_PLANS),
});
const emiSettingsDocumentSchema = emiSettingsSchema.extend({ revision: z.number().int().nonnegative() });

const getEmiRoute = createRoute({
  method: "get",
  path: "/emi",
  operationId: "dashboard.settings_emi.get",
  tags: ["Admin - Settings"],
  summary: "Get the store's EMI plans",
  description: "The plans behind \"EMI on card payment, from X/month\" on EMI-eligible products. Informational only: checkout does not offer EMI.",
  responses: {
    200: { description: "EMI plans", content: { "application/json": { schema: successEnvelope(emiSettingsDocumentSchema) } } },
    ...errorResponses,
  },
});

app.openapi(getEmiRoute, async (c) => ok(c, await getEmiSettings(c.get("db"))));

const saveEmiRoute = createRoute({
  method: "put",
  path: "/emi",
  operationId: "dashboard.settings_emi.update",
  tags: ["Admin - Settings"],
  summary: "Save the store's EMI plans",
  description: "Replaces the plans. Each plan's monthly amount is the price plus its fee, split over its months and rounded up to whole taka.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: emiSettingsSchema.extend({ expectedRevision: z.number().int().nonnegative() }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "EMI plans saved", content: { "application/json": { schema: successEnvelope(emiSettingsDocumentSchema) } } },
    ...errorResponses,
    409: conflictResponse,
  },
});

app.openapi(saveEmiRoute, async (c) => {
  const { expectedRevision, ...input } = c.req.valid("json");
  const saved = await saveEmiSettings(c.get("db"), input, expectedRevision);
  // Product pages show the EMI line.

  return ok(c, saved);
});

export { app as emiSettingsRoutes };
