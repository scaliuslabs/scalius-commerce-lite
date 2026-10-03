import { media } from "@scalius/database/schema";
import { isBatchGuardError, type Database } from "@scalius/database/client";
import { sql, type SQL } from "drizzle-orm";

export const MEDIA_REFERENCE_DELETING_MESSAGE =
  "The selected media is being deleted. Choose another image and try again.";

export function isMediaReferenceDeletingGuardError(error: unknown): boolean {
  return isBatchGuardError(error, "MEDIA_REFERENCE_DELETING");
}

/** Reject a URL-bearing write once its referenced media object is being deleted. */
export function noDeletingMediaReferences(value: string): SQL | undefined {
  // Media object keys are generated under this namespace.
  if (!value.includes("media/")) return undefined;
  return sql`NOT EXISTS (
    SELECT 1 FROM ${media}
    WHERE ${media.status} IN ('deleting', 'deleted')
      AND instr(${value}, ${media.objectKey}) > 0
  )`;
}

export async function hasDeletingMediaReference(
  db: Database,
  value: string,
): Promise<boolean> {
  if (!value.includes("media/")) return false;
  const row = await db
    .select({ id: media.id })
    .from(media)
    .where(sql`${media.status} IN ('deleting', 'deleted') AND instr(${value}, ${media.objectKey}) > 0`)
    .limit(1)
    .get();
  return Boolean(row);
}
