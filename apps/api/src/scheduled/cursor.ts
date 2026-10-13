import type { Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";

/** A wrapping scan hint, never authority for a commerce mutation. CAS prevents
 * overlapping/replayed ticks from moving a newer scan position backwards. */
export async function readMaintenanceCursor(db: Database, key: string) {
  const row = await db
    .select({ value: settings.value, revision: settings.revision })
    .from(settings)
    .where(and(eq(settings.category, "maintenance"), eq(settings.key, key)))
    .get();
  let value: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(row?.value ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      value = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
  } catch {
    /* A corrupt hint restarts a bounded scan; writes still recheck domain state. */
  }
  return {
    value,
    async save(next: Record<string, string | null | undefined>) {
      const serialized = JSON.stringify(next);
      if (row) {
        const updated = await db
          .update(settings)
          .set({
            value: serialized,
            revision: sql`${settings.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(settings.category, "maintenance"),
              eq(settings.key, key),
              eq(settings.revision, row.revision),
            ),
          ).returning({ revision: settings.revision });
        return updated.length === 1;
      } else {
        const inserted = await db
          .insert(settings)
          .values({
            id: `maintenance:${key}`,
            category: "maintenance",
            key,
            type: "json",
            value: serialized,
          })
          .onConflictDoNothing().returning({ revision: settings.revision });
        return inserted.length === 1;
      }
    },
  };
}
