import { Agent } from "agents";
import { z } from "@hono/zod-openapi";
import { generateStructuredPrompt } from "@scalius/core/modules/ai/prompt-helper-v2";
import { createWidgetCompositionPlan, describeWidgetCompositionPlan } from "@scalius/core/modules/ai/destination-contracts";
import {
  GENERATION_CONFIG,
  getTimeout,
  getWidgetAiPrompt,
  getWidgetAiRuntimeSettings,
  requireAllowedWidgetAiModel,
  resolveWidgetAiModelCapabilities,
  type WidgetAiProvider,
} from "@scalius/core/modules/ai";
import { getDb } from "@scalius/database/client";
import {
  getCreateOutputBudget,
  getLanguageModel,
  streamWidgetContent,
  withDestinationRuntimeContract,
  type WidgetGenerationResult,
} from "../routes/admin/ai";
import { normalizeWidgetGenerationText } from "../routes/admin/ai-response-validation";
import { normalizeMessages } from "../routes/admin/ai-message-normalization";
import { parseTagBasedResponse } from "@scalius/shared/tag-parser";
import { resolveAiContextBatchDetails } from "../routes/admin/ai-context";
import {
  createWidgetGenerationToolRunner,
  type WidgetGenerationToolEvent,
  type WidgetGenerationToolName,
} from "../routes/admin/widget-generation-tools";
import { getCredentialEncryptionKey } from "../utils/encryption-key";

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
    createdAt: z.union([z.string(), z.date()]).optional(),
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
  existingJs: z.string().max(100_000).optional(),
  targetSection: z.number().int().min(0).optional(),
  sections: z
    .array(
      z.object({
        html: z.string().max(100_000),
        css: z.string().max(100_000).optional().default(""),
        js: z.string().max(50_000).optional().default(""),
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

type WidgetGenerationRunPayload = z.infer<typeof widgetGenerationRunSchema>;
type WidgetPromptType = WidgetGenerationRunPayload["promptType"];

type WidgetDesignAgentState = {
  runId: string | null;
  phase: "idle" | "loading" | "hydrating" | "prompting" | "generating" | "validated" | "complete" | "failed";
  operation: "create" | "improve" | null;
  promptType: "widget" | "landing-page" | "collection";
  provider: WidgetAiProvider | null;
  model: string | null;
  lastEventAt: number | null;
  artifactReady: boolean;
  error: string | null;
};

export type WidgetGenerationRunEvent =
  | { type: "run.started"; runId: string; operation: "create" | "improve" }
  | WidgetGenerationToolEvent
  | { type: "step.started"; step: WidgetGenerationToolName }
  | { type: "step.completed"; step: WidgetGenerationToolName; elapsedMs: number; metadata?: Record<string, unknown> }
  | { type: "draft.delta"; delta: string }
  | { type: "preview.patch"; html: string; css: string; js?: string; metadata?: Record<string, unknown> }
  | { type: "artifact.validated"; metadata?: Record<string, unknown> }
  | { type: "warning"; warnings: unknown }
  | { type: "artifact"; raw: string; metadata?: Record<string, unknown> }
  | { type: "run.completed"; runId: string; usage?: unknown }
  | { type: "run.failed"; runId: string; error: { message: string } };

function encodeSse(event: WidgetGenerationRunEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Widget generation failed");
}

function isExpectedAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function toPromptImages(images: WidgetGenerationRunPayload["selectedImages"]) {
  return (images ?? []).map((image, index) => ({
    id: typeof image.id === "string" ? image.id : `selected-image-${index + 1}`,
    url: image.url,
    filename:
      typeof image.filename === "string"
        ? image.filename
        : image.url.split("/").pop()?.split("?")[0] || `selected-image-${index + 1}`,
    size: typeof image.size === "number" ? image.size : 0,
    createdAt:
      image.createdAt instanceof Date
        ? image.createdAt
        : typeof image.createdAt === "string"
          ? new Date(image.createdAt)
          : new Date(0),
    role: image.role,
    label: image.label || image.alt,
  }));
}

function getImprovementCode(payload: WidgetGenerationRunPayload): { html: string; css: string; js: string } {
  if (payload.targetSection !== undefined && payload.sections?.[payload.targetSection]) {
    const section = payload.sections[payload.targetSection]!;
    return { html: section.html, css: section.css || "", js: section.js || "" };
  }

  return {
    html: payload.existingHtml || "",
    css: payload.existingCss || "",
    js: payload.existingJs || "",
  };
}

function buildImprovementInstruction(payload: WidgetGenerationRunPayload): string {
  const parts = [payload.userPrompt.trim()];

  if (payload.improvementHistory?.length) {
    parts.push(
      `PREVIOUS IMPROVEMENTS:\n${payload.improvementHistory
        .map(
          (entry, index) =>
            `${index + 1}. ${entry.section !== undefined ? `Section ${entry.section + 1}` : "Whole widget"}: "${entry.prompt}"`,
        )
        .join("\n")}\nBuild on these previous improvements. Do not revert earlier accepted changes.`,
    );
  }

  if (payload.targetSection !== undefined && payload.sections && payload.sections.length > 1) {
    const otherSections = payload.sections
      .map((section, index) => {
        if (index === payload.targetSection) return null;
        return `Section ${index + 1}${section.description ? ` (${section.description})` : ""}:\n<htmljs>\n${section.html}\n</htmljs>\n<css>\n${section.css || "/* No CSS */"}\n</css>${section.js ? `\n<js>\n${section.js}\n</js>` : ""}`;
      })
      .filter(Boolean);

    if (otherSections.length > 0) {
      parts.push(
        `OTHER SECTIONS CONTEXT:\nYou are improving Section ${payload.targetSection + 1} of ${payload.sections.length}. Keep visual continuity with these sections, but return only the improved target section code.\n\n${otherSections.join("\n\n")}`,
      );
    }
  }

  return parts.join("\n\n");
}

function buildPreviewPatchFromRaw(rawText: string, commerceFactsProvided: boolean): { html: string; css: string; js?: string } | null {
  try {
    const normalized = normalizeWidgetGenerationText(rawText, { commerceFactsProvided });
    const tagResult = parseTagBasedResponse(normalized);
    if (!tagResult.success || !tagResult.data) return null;
    return {
      html: tagResult.data.html,
      css: tagResult.data.css || "",
      js: tagResult.data.js || "",
    };
  } catch {
    return null;
  }
}

function parseNormalizedArtifact(text: string): { html: string; css: string; js: string } {
  const parsed = parseTagBasedResponse(text);
  if (!parsed.success || !parsed.data) {
    throw new Error("Validated artifact could not be parsed for assembly.");
  }
  return {
    html: parsed.data.html,
    css: parsed.data.css,
    js: parsed.data.js || "",
  };
}

function mergeSectionArtifacts(
  artifacts: Array<{ html: string; css: string; js: string }>,
  promptType: WidgetPromptType,
  commerceFactsProvided: boolean,
): string {
  const destinationClass = promptType.replace(/[^a-z0-9]+/g, "-");
  const html = `<div class="sc-ai-widget-composition sc-ai-widget-composition--${destinationClass}">
${artifacts.map((artifact) => artifact.html.trim()).filter(Boolean).join("\n")}
</div>`;
  const css = `.sc-ai-widget-composition{margin:0;display:block}.sc-ai-widget-composition>*{margin-block:0}
${artifacts.map((artifact) => artifact.css.trim()).filter(Boolean).join("\n\n")}`;
  const js = artifacts.map((artifact) => artifact.js.trim()).filter(Boolean).join("\n\n");

  return normalizeWidgetGenerationText(
    `<htmljs>\n${html}\n</htmljs>\n\n<css>\n${css}\n</css>${js ? `\n\n<js>\n${js}\n</js>` : ""}`,
    { commerceFactsProvided },
  );
}

function buildPreviewObservation(artifacts: Array<{ html: string; css: string; js: string }>): string {
  const mergedHtml = artifacts.map((artifact) => artifact.html).join("\n");
  const mergedCss = artifacts.map((artifact) => artifact.css).join("\n");
  const productCardCount = (mergedHtml.match(/<a\b|<button\b/gi) ?? []).length;
  const imageCount = (mergedHtml.match(/<img\b/gi) ?? []).length;
  const cssRuleCount = (mergedCss.match(/{/g) ?? []).length;
  const hasResponsiveCss = /@media|clamp\(|minmax\(|grid-template|flex-wrap/i.test(mergedCss);
  const hasBoundedMedia = /aspect-ratio|object-fit|max-height/i.test(mergedCss);

  return [
    "PREVIEW OBSERVATION FROM HARNESS:",
    `- accepted sections: ${artifacts.length}`,
    `- visible images in HTML: ${imageCount}`,
    `- CTA/link/button count: ${productCardCount}`,
    `- CSS rule count: ${cssRuleCount}`,
    `- responsive layout signals: ${hasResponsiveCss ? "yes" : "no"}`,
    `- bounded media safeguards: ${hasBoundedMedia ? "yes" : "no"}`,
    "- The next step may revise earlier accepted sections if this observation shows weak continuity, missing responsive/media safeguards, or a better final composition needs it.",
  ].join("\n");
}

function buildArtifactWorkspace(
  artifacts: Array<{ html: string; css: string; js: string }>,
  observation: string,
): string {
  if (artifacts.length === 0) return `${observation}\n\nCURRENT ARTIFACT WORKSPACE: empty`;

  const sections = artifacts.map((artifact, index) =>
    `--- SECTION ${index + 1} CURRENT CODE ---
<htmljs>
${artifact.html}
</htmljs>
<css>
${artifact.css}
</css>${artifact.js ? `\n<js>\n${artifact.js}\n</js>` : ""}`,
  ).join("\n\n");

  return `${observation}\n\nCURRENT ARTIFACT WORKSPACE:\n${sections}`;
}

function buildSectionGenerationPrompt({
  payload,
  planText,
  sectionDescription,
  sectionIndex,
  totalSections,
  previousArtifacts,
}: {
  payload: WidgetGenerationRunPayload;
  planText: string;
  sectionDescription: string;
  sectionIndex: number;
  totalSections: number;
  previousArtifacts: Array<{ html: string; css: string; js: string }>;
}): string {
  const workspace = buildArtifactWorkspace(previousArtifacts, buildPreviewObservation(previousArtifacts));

  return [
    "You are inside an artifact workspace harness, like a coding-agent edit loop.",
    `Merchant request: ${payload.userPrompt.trim()}`,
    `Destination: ${payload.promptType}`,
    "Full harness plan:",
    planText,
    `Generate ONLY section ${sectionIndex + 1} of ${totalSections}: ${sectionDescription}`,
    "You can see the previous accepted code and harness observations below. Treat them like prior files in an editor.",
    workspace,
    "Return one complete section artifact only. It must include complete <css> and <htmljs>; optional local behavior goes in <js>.",
    "You may revise/restate earlier section classes and shared tokens in this section CSS when needed for continuity, but do not duplicate prior HTML. Do not include the platform wrapper classes. Use compact scoped classes that can merge with the prior sections.",
  ].join("\n\n");
}

function sumUsage(results: WidgetGenerationResult[]): WidgetGenerationResult["usage"] {
  return results.reduce<WidgetGenerationResult["usage"]>((usage, result) => ({
    inputTokens: (usage.inputTokens ?? 0) + (result.usage.inputTokens ?? 0) || undefined,
    outputTokens: (usage.outputTokens ?? 0) + (result.usage.outputTokens ?? 0) || undefined,
    totalTokens: (usage.totalTokens ?? 0) + (result.usage.totalTokens ?? 0) || undefined,
  }), {});
}

type CommerceContextData = {
  products: unknown[];
  categories: unknown[];
  collections: unknown[];
};

type ProductCardData = {
  name: string;
  url: string;
  buyNowUrl: string;
  imageUrl: string;
  imageAlt: string;
  price: number | null;
  finalPrice: number | null;
  categoryName: string;
};

type CategoryCardData = {
  name: string;
  url: string;
  imageUrl: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function formatPrice(value: number | null): string {
  if (value === null) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "BDT",
    maximumFractionDigits: 0,
  }).format(value);
}

function productImageUrl(product: Record<string, unknown>): { url: string; alt: string } {
  const imageUrl = readString(product, ["imageUrl", "image", "thumbnail", "thumbnailUrl"]);
  if (imageUrl) return { url: imageUrl, alt: readString(product, ["imageAlt", "alt"], readString(product, ["name"], "Product image")) };

  const images = asArray(product.images).map(asRecord);
  const primary = images.find((image) => image.isPrimary === true) || images[0];
  if (!primary) return { url: "", alt: readString(product, ["name"], "Product image") };
  return {
    url: readString(primary, ["url", "src"]),
    alt: readString(primary, ["alt", "altText"], readString(product, ["name"], "Product image")),
  };
}

function normalizeProductCards(contextData: CommerceContextData): ProductCardData[] {
  return contextData.products
    .map(asRecord)
    .map((product, index) => {
      const image = productImageUrl(product);
      const category = asRecord(product.category);
      const url = readString(product, ["url"], readString(product, ["slug"], "#"));
      return {
        name: readString(product, ["name", "title"], `Selected product ${index + 1}`),
        url,
        buyNowUrl: readString(product, ["buyNowUrl", "checkoutUrl"], url),
        imageUrl: image.url,
        imageAlt: image.alt,
        price: readNumber(product, ["price"]),
        finalPrice: readNumber(product, ["finalPrice", "discountedPrice", "salePrice"]),
        categoryName: readString(category, ["name"], ""),
      };
    })
    .filter((product) => product.name.trim());
}

function normalizeCategoryCards(contextData: CommerceContextData): CategoryCardData[] {
  return contextData.categories
    .map(asRecord)
    .map((category, index) => ({
      name: readString(category, ["name", "title"], `Category ${index + 1}`),
      url: readString(category, ["url"], readString(category, ["slug"], "#")),
      imageUrl: readString(category, ["imageUrl", "image", "thumbnailUrl"]),
    }))
    .filter((category) => category.name.trim());
}

function renderDeterministicProductCard(product: ProductCardData, index: number): string {
  const price = formatPrice(product.finalPrice ?? product.price);
  const original = product.finalPrice !== null && product.price !== null && product.finalPrice < product.price
    ? formatPrice(product.price)
    : "";
  const media = product.imageUrl
    ? `<span class="sc-agent-drinks__media"><img src="${escapeAttr(product.imageUrl)}" alt="${escapeAttr(product.imageAlt || product.name)}" loading="lazy" /></span>`
    : `<span class="sc-agent-drinks__media sc-agent-drinks__media--text"><span>${escapeHtml(product.name.slice(0, 2).toUpperCase())}</span></span>`;

  return `<article class="sc-agent-drinks__card">
    <a class="sc-agent-drinks__card-link" href="${escapeAttr(product.url || product.buyNowUrl || "#")}">
      ${media}
      <span class="sc-agent-drinks__card-copy">
        <span class="sc-agent-drinks__card-kicker">${escapeHtml(product.categoryName || `Pick ${index + 1}`)}</span>
        <strong>${escapeHtml(product.name)}</strong>
        ${price ? `<span class="sc-agent-drinks__price">${escapeHtml(price)}${original ? ` <s>${escapeHtml(original)}</s>` : ""}</span>` : ""}
      </span>
    </a>
    <a class="sc-agent-drinks__buy" href="${escapeAttr(product.buyNowUrl || product.url || "#")}">Buy now</a>
  </article>`;
}

function buildDeterministicSectionArtifact({
  payload,
  contextData,
  sectionIndex,
}: {
  payload: WidgetGenerationRunPayload;
  contextData: CommerceContextData;
  sectionIndex: number;
}): string {
  const products = normalizeProductCards(contextData).slice(0, 4);
  const categories = normalizeCategoryCards(contextData);
  const primaryCategory = categories[0];
  const titleSubject = primaryCategory?.name || products[0]?.categoryName || "Featured picks";
  const productCards = products.map(renderDeterministicProductCard).join("\n");
  const categoryUrl = primaryCategory?.url || products[0]?.url || "#";
  const modeClass = payload.promptType.replace(/[^a-z0-9]+/g, "-");
  const sectionClass = `sc-agent-drinks sc-agent-drinks--${modeClass} sc-agent-drinks--part-${sectionIndex + 1}`;
  const sectionLabel = sectionIndex === 0 ? `${titleSubject} homepage feature` : `${titleSubject} product picks`;

  const html = sectionIndex === 0
    ? `<section class="${sectionClass}" aria-label="${escapeAttr(sectionLabel)}">
  <div class="sc-agent-drinks__inner sc-agent-drinks__inner--hero">
    <div class="sc-agent-drinks__copy">
      <p class="sc-agent-drinks__eyebrow">${escapeHtml(titleSubject)}</p>
      <h2>Cold-ready drinks for every cart</h2>
      <p>Feature the selected drinks with a fast, compact homepage rhythm that moves shoppers from discovery to product action.</p>
      <div class="sc-agent-drinks__actions">
        <a class="sc-agent-drinks__primary" href="${escapeAttr(categoryUrl)}">Shop ${escapeHtml(titleSubject)}</a>
        ${products[0]?.buyNowUrl ? `<a class="sc-agent-drinks__secondary" href="${escapeAttr(products[0].buyNowUrl)}">Buy the lead pick</a>` : ""}
      </div>
    </div>
    <div class="sc-agent-drinks__spotlight">
      ${products.slice(0, 2).map(renderDeterministicProductCard).join("\n")}
    </div>
  </div>
</section>`
    : `<section class="${sectionClass}" aria-label="${escapeAttr(sectionLabel)}">
  <div class="sc-agent-drinks__inner">
    <div class="sc-agent-drinks__section-head">
      <p class="sc-agent-drinks__eyebrow">Selected drinks</p>
      <h2>Pick the energy, flavor, and pack size shoppers came for</h2>
      <a href="${escapeAttr(categoryUrl)}">View all ${escapeHtml(titleSubject)}</a>
    </div>
    <div class="sc-agent-drinks__grid">
      ${productCards || `<a class="sc-agent-drinks__empty-link" href="${escapeAttr(categoryUrl)}">Browse ${escapeHtml(titleSubject)}</a>`}
    </div>
  </div>
</section>`;

  const css = `.sc-agent-drinks {
  margin: 0;
  padding: ${sectionIndex === 0 ? "32px 16px 18px" : "18px 16px 34px"};
  color: #101419;
  background: ${sectionIndex === 0 ? "linear-gradient(135deg,#f4f8fb 0%,#fff 48%,#eef7ef 100%)" : "#fff"};
}
.sc-agent-drinks__inner {
  max-width: 1180px;
  margin: 0 auto;
  display: grid;
  gap: 18px;
}
.sc-agent-drinks__inner--hero {
  grid-template-columns: minmax(0, .92fr) minmax(320px, 1fr);
  align-items: stretch;
}
.sc-agent-drinks__copy {
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 14px;
  padding: 22px;
  border: 1px solid rgba(16,20,25,.1);
  border-radius: 8px;
  background: rgba(255,255,255,.78);
}
.sc-agent-drinks__eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
  color: #2b6b47;
}
.sc-agent-drinks h2 {
  margin: 0;
  max-width: 720px;
  font-size: clamp(28px, 5vw, 52px);
  line-height: 1.02;
  letter-spacing: 0;
}
.sc-agent-drinks p {
  margin: 0;
  max-width: 62ch;
  color: #56606b;
  font-size: 15px;
  line-height: 1.55;
}
.sc-agent-drinks__actions,
.sc-agent-drinks__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.sc-agent-drinks__primary,
.sc-agent-drinks__secondary,
.sc-agent-drinks__section-head a,
.sc-agent-drinks__buy,
.sc-agent-drinks__empty-link {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  padding: 9px 13px;
  font-size: 13px;
  font-weight: 800;
  text-decoration: none;
}
.sc-agent-drinks__primary,
.sc-agent-drinks__buy {
  color: #fff;
  background: #101419;
}
.sc-agent-drinks__secondary,
.sc-agent-drinks__section-head a,
.sc-agent-drinks__empty-link {
  color: #101419;
  border: 1px solid rgba(16,20,25,.16);
  background: #fff;
}
.sc-agent-drinks__spotlight,
.sc-agent-drinks__grid {
  display: grid;
  gap: 12px;
}
.sc-agent-drinks__spotlight {
  grid-template-columns: repeat(2,minmax(0,1fr));
}
.sc-agent-drinks__grid {
  grid-template-columns: repeat(4,minmax(0,1fr));
}
.sc-agent-drinks__card {
  min-width: 0;
  display: grid;
  grid-template-rows: 1fr auto;
  gap: 10px;
  border: 1px solid rgba(16,20,25,.11);
  border-radius: 8px;
  padding: 10px;
  background: #fff;
  box-shadow: 0 10px 28px rgba(16,20,25,.06);
}
.sc-agent-drinks__card-link {
  min-width: 0;
  display: grid;
  gap: 10px;
  color: inherit;
  text-decoration: none;
}
.sc-agent-drinks__media {
  aspect-ratio: 4 / 3;
  max-height: 210px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 7px;
  background: linear-gradient(145deg,#f7fafc,#edf4f0);
}
.sc-agent-drinks__media img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 10px;
}
.sc-agent-drinks__media--text span {
  font-size: 30px;
  font-weight: 900;
  color: #2b6b47;
}
.sc-agent-drinks__card-copy {
  min-width: 0;
  display: grid;
  gap: 5px;
}
.sc-agent-drinks__card-kicker {
  color: #5d6874;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}
.sc-agent-drinks__card strong {
  color: #101419;
  font-size: 15px;
  line-height: 1.25;
}
.sc-agent-drinks__price {
  color: #2b6b47;
  font-size: 14px;
  font-weight: 900;
}
.sc-agent-drinks__price s {
  margin-left: 6px;
  color: #7b8490;
  font-weight: 700;
}
@media (max-width: 900px) {
  .sc-agent-drinks__inner--hero,
  .sc-agent-drinks__spotlight,
  .sc-agent-drinks__grid {
    grid-template-columns: repeat(2,minmax(0,1fr));
  }
  .sc-agent-drinks__copy {
    grid-column: 1 / -1;
  }
}
@media (max-width: 620px) {
  .sc-agent-drinks {
    padding-inline: 12px;
  }
  .sc-agent-drinks__inner--hero,
  .sc-agent-drinks__spotlight,
  .sc-agent-drinks__grid {
    grid-template-columns: 1fr;
  }
  .sc-agent-drinks__copy {
    padding: 18px;
  }
}`;

  return normalizeWidgetGenerationText(
    `<htmljs>\n${html}\n</htmljs>\n\n<css>\n${css}\n</css>`,
    { commerceFactsProvided: true },
  );
}

function buildDeterministicCompactArtifact({
  payload: _payload,
  contextData,
}: {
  payload: WidgetGenerationRunPayload;
  contextData: CommerceContextData;
}): string {
  const products = normalizeProductCards(contextData).slice(0, 4);
  const categories = normalizeCategoryCards(contextData);
  const primaryCategory = categories[0];
  const titleSubject = primaryCategory?.name || products[0]?.categoryName || "Featured picks";
  const categoryUrl = primaryCategory?.url || products[0]?.url || "#";
  const productTiles = products
    .map((product) => {
      const price = formatPrice(product.finalPrice ?? product.price);
      const original =
        product.finalPrice !== null && product.price !== null && product.finalPrice < product.price
          ? formatPrice(product.price)
          : "";
      const media = product.imageUrl
        ? `<span class="sc-agent-compact__media"><img src="${escapeAttr(product.imageUrl)}" alt="${escapeAttr(product.imageAlt || product.name)}" loading="lazy" /></span>`
        : `<span class="sc-agent-compact__media sc-agent-compact__media--text">${escapeHtml(product.name.slice(0, 2).toUpperCase())}</span>`;

      return `<a class="sc-agent-compact__item" href="${escapeAttr(product.url || product.buyNowUrl || "#")}">
  ${media}
  <span class="sc-agent-compact__info">
    <strong>${escapeHtml(product.name)}</strong>
    ${price ? `<span>${escapeHtml(price)}${original ? ` <s>${escapeHtml(original)}</s>` : ""}</span>` : ""}
  </span>
</a>`;
    })
    .join("\n");

  const html = `<section class="sc-agent-compact" aria-label="${escapeAttr(titleSubject)} compact homepage collection">
  <div class="sc-agent-compact__inner">
    <div class="sc-agent-compact__lead">
      <p>${escapeHtml(titleSubject)}</p>
      <h2>Drinks that move fast from shelf to cart</h2>
      <a href="${escapeAttr(categoryUrl)}">Shop ${escapeHtml(titleSubject)}</a>
    </div>
    <div class="sc-agent-compact__grid">
      ${productTiles || `<a class="sc-agent-compact__item sc-agent-compact__item--empty" href="${escapeAttr(categoryUrl)}">Browse ${escapeHtml(titleSubject)}</a>`}
    </div>
  </div>
</section>`;

  const css = `.sc-agent-compact {
  margin: 0;
  padding: 22px 16px;
  color: #11151a;
  background: #fff;
}
.sc-agent-compact__inner {
  max-width: 1180px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(240px, .8fr) minmax(0, 1.5fr);
  gap: 14px;
  align-items: stretch;
}
.sc-agent-compact__lead,
.sc-agent-compact__item {
  border: 1px solid rgba(17,21,26,.1);
  border-radius: 8px;
  background: linear-gradient(180deg,#fff,#f8fbf9);
}
.sc-agent-compact__lead {
  display: grid;
  align-content: center;
  gap: 12px;
  padding: 18px;
}
.sc-agent-compact__lead p {
  margin: 0;
  color: #2b6b47;
  font-size: 12px;
  font-weight: 900;
  text-transform: uppercase;
}
.sc-agent-compact__lead h2 {
  margin: 0;
  font-size: clamp(26px,4vw,42px);
  line-height: 1.04;
  letter-spacing: 0;
}
.sc-agent-compact__lead a {
  width: fit-content;
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  border-radius: 7px;
  padding: 9px 13px;
  color: #fff;
  background: #11151a;
  font-size: 13px;
  font-weight: 850;
  text-decoration: none;
}
.sc-agent-compact__grid {
  display: grid;
  grid-template-columns: repeat(4,minmax(0,1fr));
  gap: 10px;
}
.sc-agent-compact__item {
  min-width: 0;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 9px;
  padding: 9px;
  color: inherit;
  text-decoration: none;
  box-shadow: 0 8px 22px rgba(17,21,26,.05);
}
.sc-agent-compact__media {
  aspect-ratio: 1 / 1;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 7px;
  background: #f1f6f2;
}
.sc-agent-compact__media img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 8px;
}
.sc-agent-compact__media--text {
  color: #2b6b47;
  font-size: 24px;
  font-weight: 900;
}
.sc-agent-compact__info {
  min-width: 0;
  display: grid;
  gap: 4px;
  font-size: 13px;
}
.sc-agent-compact__info strong {
  overflow-wrap: anywhere;
  line-height: 1.25;
}
.sc-agent-compact__info span {
  color: #2b6b47;
  font-weight: 900;
}
.sc-agent-compact__info s {
  margin-left: 5px;
  color: #7a838d;
  font-weight: 700;
}
@media (max-width: 920px) {
  .sc-agent-compact__inner {
    grid-template-columns: 1fr;
  }
  .sc-agent-compact__grid {
    grid-template-columns: repeat(2,minmax(0,1fr));
  }
}
@media (max-width: 560px) {
  .sc-agent-compact {
    padding-inline: 12px;
  }
  .sc-agent-compact__grid {
    grid-template-columns: 1fr;
  }
}`;

  return normalizeWidgetGenerationText(
    `<htmljs>\n${html}\n</htmljs>\n\n<css>\n${css}\n</css>`,
    { commerceFactsProvided: true },
  );
}

function createInitialState(): WidgetDesignAgentState {
  return {
    runId: null,
    phase: "idle",
    operation: null,
    promptType: "widget",
    provider: null,
    model: null,
    lastEventAt: null,
    artifactReady: false,
    error: null,
  };
}

export class WidgetDesignAgent extends Agent<Env, WidgetDesignAgentState> {
  initialState = createInitialState();
  private designSchemaReady = false;

  private ensureDesignSchema(): void {
    if (this.designSchemaReady) return;
    const _createEventsTableResult = this.sql`
      CREATE TABLE IF NOT EXISTS widget_design_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
    const _createEventsIndexResult = this.sql`CREATE INDEX IF NOT EXISTS widget_design_events_run_idx ON widget_design_events (run_id, id)`;
    this.designSchemaReady = true;
  }

  private recordEvent(runId: string, event: WidgetGenerationRunEvent): void {
    if (event.type === "draft.delta") return;
    this.ensureDesignSchema();
    const _insertEventResult = this.sql`
      INSERT INTO widget_design_events (run_id, type, payload, created_at)
      VALUES (${runId}, ${event.type}, ${JSON.stringify(event)}, ${Date.now()})
    `;
  }

  private updateRunState(next: Partial<WidgetDesignAgentState>): void {
    this.setState({
      ...this.state,
      ...next,
      lastEventAt: Date.now(),
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      return Response.json({ success: true, data: this.state });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const payload = widgetGenerationRunSchema.parse(await request.json());
    return this.streamRun(request, payload);
  }

  private async streamRun(request: Request, payload: WidgetGenerationRunPayload): Promise<Response> {
    const db = getDb(this.env);
    const runId = crypto.randomUUID();
    let streamClosed = false;

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const emit = (event: WidgetGenerationRunEvent): void => {
          if (streamClosed) return;
          try {
            controller.enqueue(encodeSse(event));
            this.recordEvent(runId, event);
          } catch {
            streamClosed = true;
          }
        };
        const tools = createWidgetGenerationToolRunner(emit, emit);

        try {
          this.updateRunState({
            runId,
            phase: "loading",
            operation: payload.operation,
            promptType: payload.promptType,
            provider: null,
            model: null,
            artifactReady: false,
            error: null,
          });
          emit({ type: "run.started", runId, operation: payload.operation });

          const settings = await tools.run("load_settings", () =>
            getWidgetAiRuntimeSettings(db, this.env, getCredentialEncryptionKey(this.env)),
          );
          const provider = (payload.provider || settings.activeProvider) as WidgetAiProvider;
          const modelId = requireAllowedWidgetAiModel(settings, provider, payload.model);
          const capabilities = resolveWidgetAiModelCapabilities(
            provider,
            modelId,
            settings.providers[provider].capabilities,
          );
          this.updateRunState({ phase: "hydrating", provider, model: modelId });
          const model = getLanguageModel(provider, modelId, settings, this.env);

          const contextData = await tools.run(
            "hydrate_context",
            () =>
              resolveAiContextBatchDetails({
                db,
                env: this.env,
                payload: {
                  productIds: payload.productIds,
                  categoryIds: payload.allCategoriesSelected ? undefined : payload.categoryIds,
                  collectionIds: payload.collectionIds,
                  anchorCollectionIds: payload.anchorCollectionIds,
                  allCategories: payload.allCategoriesSelected,
                },
              }),
            (value) => ({
              products: value.products.length,
              categories: value.categories.length,
              collections: value.collections.length,
            }),
          );
          emit({ type: "warning", warnings: contextData.warnings });

          this.updateRunState({ phase: "prompting" });
          const promptResult = await tools.run(
            "build_prompt",
            async () => {
              const systemPrompt = await getWidgetAiPrompt(db, payload.promptType);
              const improvementCode = payload.operation === "improve" ? getImprovementCode(payload) : null;
              const prompt = await generateStructuredPrompt({
                systemPrompt,
                userPrompt: payload.operation === "create" ? payload.userPrompt : undefined,
                improvementPrompt: payload.operation === "improve" ? buildImprovementInstruction(payload) : undefined,
                existingHtml: improvementCode?.html,
                existingCss: improvementCode?.css,
                existingJs: improvementCode?.js,
                selectedImages: toPromptImages(payload.selectedImages),
                selectedProducts: contextData.products,
                selectedCategories: contextData.categories,
                selectedCollections: contextData.collections,
                allCategoriesSelected: payload.allCategoriesSelected === true,
                modelId,
                supportsVision: capabilities.supportsVisionInput,
                maxImagesOverride: capabilities.maxImages,
                promptType: payload.promptType,
                sectionIndex: payload.targetSection,
                totalSections: payload.sections?.length,
              });
              return { systemPrompt, prompt };
            },
            (value) => ({
              messages: value.prompt.messages.length,
              estimatedTokens: value.prompt.metadata.estimatedTokens,
            }),
          );

          this.updateRunState({ phase: "generating" });
          const commerceFactsProvided = Boolean(
            contextData.products.length ||
              contextData.categories.length ||
              contextData.collections.length ||
              payload.selectedImages?.length,
          );
          const result = payload.operation === "create"
            ? await (async () => {
              const plan = await tools.run("plan_artifact", async () => createWidgetCompositionPlan(payload.promptType), (value) => ({
                totalSections: value.totalSections,
                compositionBrief: value.compositionBrief,
              }));
              const planText = describeWidgetCompositionPlan(plan);
              const sectionArtifacts: Array<{ html: string; css: string; js: string }> = [];
              const sectionResults: WidgetGenerationResult[] = [];

              try {
                for (let index = 0; index < plan.sectionDescriptions.length; index++) {
                  if (request.signal.aborted) throw new DOMException("Generation cancelled", "AbortError");
                  const sectionPrompt = await tools.run(
                    "build_prompt",
                    () =>
                      generateStructuredPrompt({
                        systemPrompt: promptResult.systemPrompt,
                        userPrompt: buildSectionGenerationPrompt({
                          payload,
                          planText,
                          sectionDescription: plan.sectionDescriptions[index] || `Section ${index + 1}`,
                          sectionIndex: index,
                          totalSections: plan.totalSections,
                          previousArtifacts: sectionArtifacts,
                        }),
                        selectedImages: toPromptImages(payload.selectedImages),
                        selectedProducts: contextData.products,
                        selectedCategories: contextData.categories,
                        selectedCollections: contextData.collections,
                        allCategoriesSelected: payload.allCategoriesSelected === true,
                        modelId,
                        supportsVision: capabilities.supportsVisionInput,
                        maxImagesOverride: capabilities.maxImages,
                        promptType: payload.promptType,
                        sectionIndex: index,
                        totalSections: plan.totalSections,
                      }),
                    (value) => ({
                      section: index + 1,
                      totalSections: plan.totalSections,
                      estimatedTokens: value.metadata.estimatedTokens,
                    }),
                  );

                  const sectionResult = await tools.run(
                    "generate_section",
                    async () => {
                      const generationOptions = {
                        model,
                        messages: withDestinationRuntimeContract(
                          normalizeMessages(sectionPrompt.messages),
                          payload.promptType,
                          { compositionMode: false },
                        ),
                        allowSystemInMessages: true,
                        temperature: Math.min(settings.generation.generationTemperature, 0.45),
                        maxOutputTokens: Math.min(settings.generation.maxOutputTokens, payload.promptType === "landing-page" ? 2600 : 2200),
                        timeout: { totalMs: getTimeout("generation") },
                        maxRetries: 0,
                        abortSignal: request.signal,
                      };

                      try {
                        const generation = streamWidgetContent(generationOptions, capabilities, payload.promptType);
                        let rawText = "";
                        let lastPreviewPatchLength = 0;
                        for await (const delta of generation.textStream) {
                          if (!delta) continue;
                          rawText += delta;
                          emit({ type: "draft.delta", delta });
                          if (rawText.length - lastPreviewPatchLength >= 600) {
                            const patch = buildPreviewPatchFromRaw(rawText, commerceFactsProvided);
                            if (patch) {
                              lastPreviewPatchLength = rawText.length;
                              emit({
                                type: "preview.patch",
                                ...patch,
                                metadata: {
                                  stage: "section.streaming",
                                  section: index + 1,
                                  totalSections: plan.totalSections,
                                  harness: "stepwise",
                                },
                              });
                            }
                          }
                        }
                        if (!rawText.trim()) {
                          throw new Error("The AI provider returned an empty section artifact.");
                        }
                        const normalized = normalizeWidgetGenerationText(rawText, { commerceFactsProvided });
                        parseNormalizedArtifact(normalized);
                        return { text: normalized, usage: {} };
                      } catch (error) {
                        emit({
                          type: "warning",
                          warnings: {
                            stage: "section.platform_compositor",
                            section: index + 1,
                            message: messageFromError(error),
                          },
                        });
                        return {
                          text: buildDeterministicSectionArtifact({
                            payload,
                            contextData: contextData as CommerceContextData,
                            sectionIndex: index,
                          }),
                          usage: {},
                        };
                      }
                    },
                    (value) => ({
                      section: index + 1,
                      totalSections: plan.totalSections,
                      artifactChars: value.text.length,
                    }),
                  );

                  sectionResults.push(sectionResult);
                  sectionArtifacts.push(parseNormalizedArtifact(sectionResult.text));
                  const partial = parseNormalizedArtifact(
                    mergeSectionArtifacts(sectionArtifacts, payload.promptType, commerceFactsProvided),
                  );
                  emit({
                    type: "preview.patch",
                    ...partial,
                    metadata: {
                      stage: "section.accepted",
                      section: index + 1,
                      totalSections: plan.totalSections,
                      harness: "stepwise",
                    },
                  });
                }

                const revised = await tools.run(
                  "assemble_artifact",
                  async () => {
                    return {
                      text: mergeSectionArtifacts(sectionArtifacts, payload.promptType, commerceFactsProvided),
                      usage: {},
                    };
                  },
                  (value) => ({ sections: sectionArtifacts.length, artifactChars: value.text.length }),
                );
                emit({
                  type: "preview.patch",
                  ...parseNormalizedArtifact(revised.text),
                  metadata: {
                    stage: "workspace.revised",
                    sections: sectionArtifacts.length,
                    harness: "artifact-workspace",
                  },
                });

                return {
                  text: revised.text,
                  usage: sumUsage([...sectionResults, revised]),
                };
              } catch (error) {
                if (isExpectedAbort(error, request.signal)) throw error;
                emit({
                  type: "warning",
                  warnings: {
                    stage: "workspace.platform_compositor",
                    message: messageFromError(error),
                  },
                });
                const fallbackArtifacts = Array.from({ length: plan.totalSections }, (_, index) =>
                  parseNormalizedArtifact(
                    buildDeterministicSectionArtifact({
                      payload,
                      contextData: contextData as CommerceContextData,
                      sectionIndex: index,
                    }),
                  ),
                );
                const fallbackText = mergeSectionArtifacts(fallbackArtifacts, payload.promptType, true);
                const fallback = parseNormalizedArtifact(fallbackText);
                emit({
                  type: "preview.patch",
                  ...fallback,
                  metadata: {
                    stage: "workspace.platform_compositor",
                    sections: fallbackArtifacts.length,
                    harness: "artifact-workspace",
                  },
                });
                return {
                  text: fallbackText,
                  usage: sumUsage(sectionResults),
                };
              }
            })()
            : await tools.run("generate", async () => {
              const messages = withDestinationRuntimeContract(
                normalizeMessages(promptResult.prompt.messages),
                payload.promptType,
                { compositionMode: true },
              );
              const generation = streamWidgetContent(
                {
                  model,
                  messages,
                  allowSystemInMessages: true,
                  temperature: Math.min(settings.generation.improvementTemperature, 0.45),
                  maxOutputTokens: getCreateOutputBudget(settings, payload.promptType, payload.operation),
                  timeout: {
                    totalMs: getTimeout("improvement"),
                  },
                  maxRetries: 0,
                  abortSignal: request.signal,
                },
                capabilities,
                payload.promptType,
              );
              let rawText = "";
              let lastPreviewPatchLength = 0;
              try {
                for await (const delta of generation.textStream) {
                  if (!delta) continue;
                  rawText += delta;
                  emit({ type: "draft.delta", delta });
                  if (rawText.length - lastPreviewPatchLength >= 700) {
                    const patch = buildPreviewPatchFromRaw(rawText, commerceFactsProvided);
                    if (patch) {
                      lastPreviewPatchLength = rawText.length;
                      emit({
                        type: "preview.patch",
                        ...patch,
                        metadata: { stage: "improvement.streaming", draft: true },
                      });
                    }
                  }
                }
                if (!rawText.trim()) {
                  throw new Error("The AI provider returned an empty improved artifact.");
                }
                const normalized = normalizeWidgetGenerationText(rawText, { commerceFactsProvided });
                const artifact = parseNormalizedArtifact(normalized);
                emit({
                  type: "preview.patch",
                  ...artifact,
                  metadata: { stage: "improvement.accepted", harness: "artifact-workspace" },
                });
                return { text: normalized, usage: {} };
              } catch (error) {
                emit({
                  type: "warning",
                  warnings: {
                    stage: "improvement.platform_compositor",
                    message: messageFromError(error),
                  },
                });
                const fallbackText = commerceFactsProvided
                  ? buildDeterministicCompactArtifact({
                      payload,
                      contextData: contextData as CommerceContextData,
                    })
                  : normalizeWidgetGenerationText(
                      `<htmljs>\n${payload.existingHtml || ""}\n</htmljs>\n\n<css>\n${payload.existingCss || ""}\n</css>${payload.existingJs ? `\n\n<js>\n${payload.existingJs}\n</js>` : ""}`,
                      { commerceFactsProvided },
                    );
                const fallback = parseNormalizedArtifact(fallbackText);
                emit({
                  type: "preview.patch",
                  ...fallback,
                  metadata: { stage: "improvement.platform_compositor", harness: "artifact-workspace" },
                });
                return { text: fallbackText, usage: {} };
              }
            });
          this.updateRunState({ phase: "validated", artifactReady: true });
          emit({
            type: "artifact.validated",
            metadata: {
              provider,
              model: modelId,
              format: "tagged-html-css-js",
              runtime: "cloudflare-agent-sqlite",
            },
          });

          emit({
            type: "artifact",
            raw: result.text,
            metadata: {
              provider,
              model: modelId,
              runtime: "cloudflare-agent-sqlite",
            },
          });
          this.updateRunState({ phase: "complete", artifactReady: true });
          emit({ type: "run.completed", runId, usage: result.usage });
        } catch (error) {
          if (!isExpectedAbort(error, request.signal)) {
            this.updateRunState({ phase: "failed", error: messageFromError(error) });
            emit({ type: "run.failed", runId, error: { message: messageFromError(error) } });
          }
        } finally {
          if (!streamClosed) {
            streamClosed = true;
            try {
              controller.close();
            } catch {
              // The browser may have already closed the SSE connection.
            }
          }
        }
      },
      cancel: () => {
        streamClosed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}
