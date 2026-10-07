// The theme routes' shared answer shapes (site.ts and theme-builder.ts):
// revisions and status only, with ISO times and bounded strings, so every
// agent result stays small.
import { z } from "@hono/zod-openapi";
import type { themeStatus } from "@scalius/core/modules/settings";

const revisionSchema = z.number().int().nonnegative();

/** A stored timestamp, sent as its ISO string. */
export const themeDateTimeSchema = z.string().openapi({ format: "date-time" });
export const themeIso = (date: Date) => date.toISOString();

export const themeDraftReceiptSchema = z.object({
  revision: revisionSchema,
  basePublishedRevision: revisionSchema,
  updatedAt: themeDateTimeSchema.nullable(),
});

/** A draft's revisions, with its save time as the contract states it. */
export const themeDraftReceipt = <Draft extends { updatedAt: Date | null }>(draft: Draft) =>
  ({ ...draft, updatedAt: draft.updatedAt && themeIso(draft.updatedAt) });

export const themeStatusSchema = z.object({
  published: z.object({ revision: revisionSchema }),
  draft: themeDraftReceiptSchema,
  draftDiffersFromLive: z.boolean(),
  lastPublished: z.object({
    revision: revisionSchema,
    publishedBy: z.string().max(160).nullable(),
    publishedByName: z.string().max(200).nullable(),
    createdAt: themeDateTimeSchema,
  }).nullable(),
});

type ThemeStatusValue = ReturnType<typeof themeStatus>;

/** The status as the contract states it: ISO times, and bounded strings for agent results (a user's name has no length limit of its own). */
export function boundedThemeStatus(status: ThemeStatusValue) {
  return {
    ...status,
    draft: themeDraftReceipt(status.draft),
    lastPublished: status.lastPublished && {
      ...status.lastPublished,
      publishedBy: status.lastPublished.publishedBy?.slice(0, 160) ?? null,
      publishedByName: status.lastPublished.publishedByName?.slice(0, 200) ?? null,
      createdAt: themeIso(status.lastPublished.createdAt),
    },
  };
}
