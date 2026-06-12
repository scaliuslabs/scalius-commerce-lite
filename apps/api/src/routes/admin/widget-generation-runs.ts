import { OpenAPIHono, z } from "@hono/zod-openapi";
import { getAgentByName } from "agents";
import { GENERATION_CONFIG } from "@scalius/core/modules/ai";
import { enforceAiRateLimit } from "./ai";
import { optionalTimestampSchema } from "../../schemas/timestamps";

const app = new OpenAPIHono<{ Bindings: Env }>();

const promptTypeSchema = z.enum(["widget", "landing-page", "collection"]);
const providerSchema = z.enum(["openrouter", "openai", "gemini", "cloudflare"]);
const MAX_IMAGE_URL_LENGTH = 4096;

function isAllowedWidgetImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "data:";
  } catch {
    return false;
  }
}

const selectedImageSchema = z
  .object({
    id: z.string().max(200).optional(),
    url: z
      .string()
      .min(1)
      .max(MAX_IMAGE_URL_LENGTH)
      .refine(isAllowedWidgetImageUrl, "Image URLs must use HTTPS or data URLs."),
    filename: z.string().max(500).optional(),
    size: z.number().int().min(0).optional(),
    createdAt: optionalTimestampSchema,
    mimeType: z.string().max(120).optional(),
    alt: z.string().max(500).optional(),
    role: z.enum(["visual_reference", "product_media", "brand_asset", "merchant_upload"]).optional(),
    label: z.string().max(240).optional(),
  })
  .passthrough();

const widgetGenerationRunSchema = z.object({
  sessionId: z.string().max(160).optional(),
  provider: providerSchema.optional(),
  model: z.string().max(200).optional(),
  promptType: promptTypeSchema.default("widget"),
  operation: z.enum(["create", "improve"]).default("create"),
  userPrompt: z.string().min(1).max(20_000),
  existingHtml: z.string().max(200_000).optional(),
  existingCss: z.string().max(200_000).optional(),
  targetSection: z.number().int().min(0).optional(),
  sections: z
    .array(
      z.object({
        html: z.string().max(100_000),
        css: z.string().max(100_000).optional().default(""),
        description: z.string().max(240).optional(),
      }),
    )
    .max(20)
    .optional(),
  improvementHistory: z
    .array(
      z.object({
        section: z.number().int().min(0).optional(),
        prompt: z.string().max(2_000),
        timestamp: z.number().optional(),
        modelUsed: z.string().max(200).optional(),
      }),
    )
    .max(30)
    .optional(),
  selectedImages: z
    .array(selectedImageSchema)
    .max(GENERATION_CONFIG.context.maxImages)
    .optional(),
  productIds: z.array(z.string().max(200)).max(GENERATION_CONFIG.context.maxProducts).optional(),
  categoryIds: z.array(z.string().max(200)).max(GENERATION_CONFIG.context.maxCategories).optional(),
  collectionIds: z.array(z.string().max(200)).max(GENERATION_CONFIG.context.maxCollections).optional(),
  anchorCollectionIds: z.array(z.string().max(200)).max(GENERATION_CONFIG.context.maxCollections).optional(),
  allCategoriesSelected: z.boolean().optional(),
});

app.post("/", async (c) => {
  const payload = widgetGenerationRunSchema.parse(await c.req.json());
  await enforceAiRateLimit(c);

  const sessionName = payload.sessionId || `widget-${crypto.randomUUID()}`;
  const agent = await getAgentByName(c.env.WidgetDesignAgent, sessionName);
  const agentUrl = new URL("/run", c.req.url);

  return agent.fetch(
    new Request(agentUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: c.req.raw.signal,
    }),
  );
});

app.get("/sessions/:sessionId/status", async (c) => {
  const sessionId = c.req.param("sessionId");
  const agent = await getAgentByName(c.env.WidgetDesignAgent, sessionId);
  const agentUrl = new URL("/status", c.req.url);
  return agent.fetch(new Request(agentUrl, { method: "GET" }));
});

export { app as adminWidgetGenerationRunRoutes };
