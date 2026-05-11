import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AI_PROVIDER_IDS,
  getWidgetAiAdminSettings,
  updateWidgetAiSettings,
} from "@scalius/core/modules/ai";
import { ok } from "../../../utils/api-response";
import { errorResponses, successEnvelope } from "../../../schemas/responses";
import { getEncryptionKey, requireEncryptionKey } from "../../../utils/encryption-key";

const app = new OpenAPIHono<{ Bindings: Env }>();

const providerEnum = z.enum(AI_PROVIDER_IDS);

const providerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  defaultModel: z.string().optional(),
  baseUrl: z.string().optional(),
  appName: z.string().optional(),
  appUrl: z.string().optional(),
  accountId: z.string().optional(),
});

const updateSchema = z.object({
  activeProvider: providerEnum.optional(),
  providers: z
    .object({
      openrouter: providerConfigSchema.optional(),
      openai: providerConfigSchema.optional(),
      gemini: providerConfigSchema.optional(),
      cloudflare: providerConfigSchema.optional(),
    })
    .partial()
    .optional(),
  generation: z
    .object({
      planningTemperature: z.number().min(0).max(2).optional(),
      generationTemperature: z.number().min(0).max(2).optional(),
      improvementTemperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().min(512).max(64000).optional(),
      stagedGenerationDefault: z.boolean().optional(),
    })
    .optional(),
  prompts: z
    .object({
      widget: z.string().optional(),
      "landing-page": z.string().optional(),
      collection: z.string().optional(),
    })
    .partial()
    .optional(),
  apiKeys: z
    .object({
      openrouter: z.string().optional(),
      openai: z.string().optional(),
      gemini: z.string().optional(),
      cloudflare: z.string().optional(),
    })
    .partial()
    .optional(),
  clearApiKeys: z.array(providerEnum).optional(),
});

const getSettingsRoute = createRoute({
  method: "get",
  path: "/widget-ai",
  tags: ["Admin - Settings"],
  summary: "Get widget AI provider and prompt settings",
  responses: {
    200: {
      description: "Widget AI settings",
      content: {
        "application/json": { schema: successEnvelope(z.object({}).passthrough()) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getSettingsRoute, async (c) => {
  const db = c.get("db");
  const encKey = getEncryptionKey(c.env);
  const settings = await getWidgetAiAdminSettings(db, c.env, encKey);
  return ok(c, settings);
});

const updateSettingsRoute = createRoute({
  method: "post",
  path: "/widget-ai",
  tags: ["Admin - Settings"],
  summary: "Update widget AI provider and prompt settings",
  request: {
    body: { content: { "application/json": { schema: updateSchema } } },
  },
  responses: {
    200: {
      description: "Updated widget AI settings",
      content: {
        "application/json": { schema: successEnvelope(z.object({}).passthrough()) },
      },
    },
    ...errorResponses,
  },
});

app.openapi(updateSettingsRoute, async (c) => {
  const db = c.get("db");
  const payload = c.req.valid("json");
  const hasSecretWrite =
    Object.values(payload.apiKeys ?? {}).some((value) => value?.trim()) ||
    (payload.clearApiKeys?.length ?? 0) > 0;
  const encKey = hasSecretWrite ? requireEncryptionKey(c.env) : getEncryptionKey(c.env);
  await updateWidgetAiSettings(db, payload, encKey);
  const settings = await getWidgetAiAdminSettings(db, c.env, encKey);
  return ok(c, settings);
});

export { app as aiSettingsRoutes };
