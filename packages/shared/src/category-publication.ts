import { z } from "zod";

/**
 * Category publication is one state machine, not a pair of flags. This avoids
 * contradictory states such as an inactive public category.
 */
export const CATEGORY_STATUSES = ["draft", "published", "internal"] as const;

export const categoryStatusSchema = z.enum(CATEGORY_STATUSES);

export type CategoryStatus = z.infer<typeof categoryStatusSchema>;

export function isPublishedCategoryStatus(
  status: CategoryStatus,
): status is "published" {
  return status === "published";
}
