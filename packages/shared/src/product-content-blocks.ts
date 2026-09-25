/**
 * Product content blocks (migration 0090 `product_content_blocks`): typed,
 * versioned blocks with a strict settings schema per type, shaped like the
 * theme's page-section registry (`storefront-theme/sections.ts`).
 *
 * - `rich-text` in the `tabs` placement replaces `product_rich_content`
 *   (0090 mirrors every legacy tab into one until the table is dropped).
 * - The landing types (video, gallery-strip, statement, comparison,
 *   pack-picker, cta-band, order-form, guarantee) build the Showcase landing
 *   page (SYNTHESIS §4.1). `order-form` is a placement marker: the form is
 *   checkout's own, never a second order path, so it has no field settings.
 * - Media are `media` ids, so renditions and alt text apply; nothing here is
 *   a URL except same-store paths, https links and video embeds.
 * - Nothing fabricated: a `cta-band` countdown needs a real `endsAt`.
 */
import { z } from "zod";
import { normalizeVideoEmbedUrl } from "./video-embed";

export const PRODUCT_CONTENT_BLOCK_PLACEMENTS = ["tabs", "after-buy-box", "after-description", "before-reviews"] as const;
export type ProductContentBlockPlacement = (typeof PRODUCT_CONTENT_BLOCK_PLACEMENTS)[number];

/** Per product, across placements. */
export const PRODUCT_CONTENT_BLOCKS_MAX = 40;
/** The database bound on one block's settings JSON. */
export const PRODUCT_CONTENT_BLOCK_SETTINGS_MAX_LENGTH = 262_144;
export const PRODUCT_CONTENT_BLOCK_ID_PREFIX = "pcb_";

const heading = z.string().trim().max(120);
const title = z.string().trim().max(80);
const mediaId = z.string().trim().min(1).max(64);
/** A same-store path or an https URL (the theme sections' rule). */
const href = z.string().trim().max(300).regex(/^(\/(?!\/)\S*|https:\/\/\S+)$/, "Use a store path or an https:// link.");
const cta = z.object({ label: z.string().trim().min(1).max(40), href }).strict();
const videoEmbedUrl = z.string().trim().max(500).refine((value) => normalizeVideoEmbedUrl(value) !== null, {
  message: "Use a YouTube or Vimeo link.",
});

function block<const Type extends string, Settings extends z.ZodType>(spec: {
  type: Type;
  settings: Settings;
  defaults: z.infer<Settings>;
  /** Placements the block may use; every placement when omitted. */
  placements?: readonly ProductContentBlockPlacement[];
}) {
  return {
    version: 1 as const,
    settings: spec.settings,
    defaults: spec.defaults,
    placements: spec.placements ?? PRODUCT_CONTENT_BLOCK_PLACEMENTS,
    schema: z.object({
      type: z.literal(spec.type),
      version: z.literal(1),
      settings: spec.settings,
    }).strict(),
  };
}

const bodyPlacements = ["after-buy-box", "after-description", "before-reviews"] as const;

export const PRODUCT_CONTENT_BLOCK_REGISTRY = {
  /** Titled HTML (sanitised on write and render); a tab or a body section. */
  "rich-text": block({
    type: "rich-text",
    settings: z.object({ title: z.string().trim().max(200), html: z.string().max(200_000) }).strict(),
    defaults: { title: "", html: "" },
  }),
  "image-with-text": block({
    type: "image-with-text",
    settings: z.object({
      heading,
      body: z.string().trim().max(2000),
      mediaId: mediaId.nullable(),
      imageSide: z.enum(["start", "end"]),
      cta: cta.nullable(),
    }).strict(),
    defaults: { heading: "", body: "", mediaId: null, imageSide: "start", cta: null },
    placements: bodyPlacements,
  }),
  /** Benefits / why us: an icon-less list or 3-4 cards. */
  "feature-list": block({
    type: "feature-list",
    settings: z.object({
      heading,
      style: z.enum(["list", "cards"]),
      items: z.array(z.object({ title: z.string().trim().min(1).max(60), text: z.string().trim().max(240) }).strict()).min(1).max(8),
    }).strict(),
    defaults: { heading: "", style: "list", items: [{ title: "Feature", text: "" }] },
    placements: bodyPlacements,
  }),
  faq: block({
    type: "faq",
    settings: z.object({
      heading,
      items: z.array(z.object({
        question: z.string().trim().min(1).max(200),
        answer: z.string().trim().min(1).max(1000),
      }).strict()).min(1).max(20),
    }).strict(),
    defaults: { heading: "", items: [{ question: "Question", answer: "Answer" }] },
  }),
  /** Poster first, the player loads on click (never an eager iframe). */
  video: block({
    type: "video",
    settings: z.object({
      heading,
      source: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("embed"), url: videoEmbedUrl, posterMediaId: mediaId.nullable() }).strict(),
        z.object({ kind: z.literal("media"), mediaId }).strict(),
      ]),
    }).strict(),
    defaults: { heading: "", source: { kind: "media", mediaId: "" } },
    placements: bodyPlacements,
  }),
  "gallery-strip": block({
    type: "gallery-strip",
    settings: z.object({ heading, mediaIds: z.array(mediaId).min(1).max(12) }).strict(),
    defaults: { heading: "", mediaIds: [""] },
    placements: bodyPlacements,
  }),
  /** A large sentence with one accent phrase taken from it. */
  statement: block({
    type: "statement",
    settings: z.object({ text: z.string().trim().min(1).max(240), accent: z.string().trim().max(60) }).strict()
      .refine((value) => value.accent === "" || value.text.includes(value.accent), {
        path: ["accent"],
        message: "The accent must be words from the statement.",
      }),
    defaults: { text: "Statement", accent: "" },
    placements: bodyPlacements,
  }),
  /** Products or variants against the same attributes. */
  comparison: block({
    type: "comparison",
    settings: z.object({
      heading,
      columns: z.array(z.object({ label: z.string().trim().min(1).max(40) }).strict()).min(2).max(4),
      rows: z.array(z.object({
        label: z.string().trim().min(1).max(60),
        values: z.array(z.string().trim().max(80)).min(2).max(4),
      }).strict()).min(1).max(20),
    }).strict().refine((value) => value.rows.every((row) => row.values.length === value.columns.length), {
      path: ["rows"],
      message: "Every row has one value per column.",
    }),
    defaults: { heading: "", columns: [{ label: "This" }, { label: "Other" }], rows: [{ label: "Row", values: ["", ""] }] },
    placements: bodyPlacements,
  }),
  /** Pack cards from the product's own variants or quantity bundles (priced by checkout). */
  "pack-picker": block({
    type: "pack-picker",
    settings: z.object({ heading, source: z.enum(["variants", "bundles"]) }).strict(),
    defaults: { heading: "", source: "variants" },
    placements: bodyPlacements,
  }),
  /** A headline and a big button; a countdown only with a real `endsAt`. */
  "cta-band": block({
    type: "cta-band",
    settings: z.object({
      heading,
      text: z.string().trim().max(300),
      label: z.string().trim().min(1).max(40),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("order-form") }).strict(),
        z.object({ kind: z.literal("buy-box") }).strict(),
        z.object({ kind: z.literal("link"), href }).strict(),
      ]),
      endsAt: z.iso.datetime().nullable(),
    }).strict(),
    defaults: { heading: "", text: "", label: "Order now", target: { kind: "order-form" }, endsAt: null },
    placements: bodyPlacements,
  }),
  /** Where checkout's inline order form renders on a landing page. */
  "order-form": block({
    type: "order-form",
    settings: z.object({ heading, submitLabel: z.string().trim().max(40) }).strict(),
    defaults: { heading: "", submitLabel: "" },
    placements: bodyPlacements,
  }),
  guarantee: block({
    type: "guarantee",
    settings: z.object({ heading, text: z.string().trim().min(1).max(600) }).strict(),
    defaults: { heading: "", text: "Guarantee" },
    placements: bodyPlacements,
  }),
  "size-chart": block({
    type: "size-chart",
    settings: z.object({
      heading,
      columns: z.array(title.min(1)).min(2).max(8),
      rows: z.array(z.array(z.string().trim().max(40)).min(2).max(8)).min(1).max(30),
    }).strict().refine((value) => value.rows.every((row) => row.length === value.columns.length), {
      path: ["rows"],
      message: "Every row has one cell per column.",
    }),
    defaults: { heading: "", columns: ["Size", "Chest"], rows: [["M", ""]] },
  }),
  /** Where the product's grouped spec table renders (its rows come from the attributes). */
  "spec-table": block({
    type: "spec-table",
    settings: z.object({ heading }).strict(),
    defaults: { heading: "" },
  }),
};

type Registry = typeof PRODUCT_CONTENT_BLOCK_REGISTRY;
export type ProductContentBlockType = keyof Registry;
export const PRODUCT_CONTENT_BLOCK_TYPES = Object.keys(PRODUCT_CONTENT_BLOCK_REGISTRY) as ProductContentBlockType[];
export type ProductContentBlockValue = {
  [Type in ProductContentBlockType]: z.infer<Registry[Type]["schema"]>;
}[ProductContentBlockType];
export type ProductContentBlockOf<Type extends ProductContentBlockType> = Extract<ProductContentBlockValue, { type: Type }>;

export function isProductContentBlockType(value: string): value is ProductContentBlockType {
  return Object.hasOwn(PRODUCT_CONTENT_BLOCK_REGISTRY, value);
}

/** Validates `{type, version, settings}` strictly against its type's schema. */
export function parseProductContentBlock(
  value: unknown,
): { success: true; data: ProductContentBlockValue } | { success: false; error: string } {
  const type = (value as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !isProductContentBlockType(type)) {
    return { success: false, error: "Unknown content block type." };
  }
  const result = PRODUCT_CONTENT_BLOCK_REGISTRY[type].schema.safeParse(value);
  if (!result.success) return { success: false, error: result.error.issues[0]?.message ?? "Invalid content block." };
  if (JSON.stringify(result.data.settings).length > PRODUCT_CONTENT_BLOCK_SETTINGS_MAX_LENGTH) {
    return { success: false, error: "The block is too large." };
  }
  return { success: true, data: result.data as ProductContentBlockValue };
}

/** A stored row (`type`, `version`, `settings` JSON text) as a validated block, or null. */
export function parseStoredProductContentBlock(row: { type: string; version: number; settings: string }): ProductContentBlockValue | null {
  let settings: unknown;
  try {
    settings = JSON.parse(row.settings);
  } catch {
    return null;
  }
  const result = parseProductContentBlock({ type: row.type, version: row.version, settings });
  return result.success ? result.data : null;
}

export function isProductContentBlockPlacementAllowed(
  type: ProductContentBlockType,
  placement: ProductContentBlockPlacement,
): boolean {
  return (PRODUCT_CONTENT_BLOCK_REGISTRY[type].placements as readonly string[]).includes(placement);
}

/** A new block of a type with its default settings. */
export function productContentBlockDefault<Type extends ProductContentBlockType>(type: Type): ProductContentBlockOf<Type> {
  const spec = PRODUCT_CONTENT_BLOCK_REGISTRY[type];
  return { type, version: spec.version, settings: structuredClone(spec.defaults) } as ProductContentBlockOf<Type>;
}
