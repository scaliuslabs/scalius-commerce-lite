// What a Metaobjects theme section reads (docs/platform/PLUGINS.md,
// "Metaobjects"): the named content types, only while they allow storefront
// access, and their published entries in order, a few per type. Two
// statements a page puts into the batch it already sends; the read declares
// `mo:<definition id>` for each type, so any change to the type or its
// entries refreshes it and nothing else does.
//
// Values are in the custom-field HTTP contract, as public custom fields are
// (`customFieldWireValue`: money in decimal major units of the store currency,
// integers as numbers, lists as arrays, a media reference its media id): the
// storefront formats them and looks images up by id.

import type { Database } from "@scalius/database/client";
import { metaobjectDefinitions, metaobjectEntries } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, sql } from "drizzle-orm";
import {
  customFieldReferenceIds,
  customFieldReferenceTarget,
  customFieldWireValue,
  type CustomFieldType,
  type CustomFieldWireValue,
} from "@scalius/shared/custom-fields";
import {
  METAOBJECT_SECTION_ENTRIES_MAX,
  metaobjectDisplayField,
  metaobjectFieldListSchema,
  type MetaobjectFieldDefinition,
} from "@scalius/shared/metaobjects";
import { deps } from "../../cache-deps";
import { storeCurrencyCodeSql, storeCurrencyFromCode, storeDecimalPlacesFromCode } from "../settings";

type BatchStatement = BatchItem<"sqlite">;

/** One entry as a section shows it. */
export interface StorefrontMetaobjectEntry {
  handle: string;
  /** The display field's text, else the handle. */
  title: string;
  /** Every other field with a value, in the definition's order. */
  fields: Array<{ key: string; name: string; type: CustomFieldType; value: CustomFieldWireValue }>;
}

/** One content type a section shows, with its published entries. */
export interface StorefrontMetaobjectType {
  id: string;
  name: string;
  entries: StorefrontMetaobjectEntry[];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The statements and the resolver of the content types these sections name
 * (`limit` entries each, at most METAOBJECT_SECTION_ENTRIES_MAX).
 */
export function planStorefrontMetaobjects(
  db: Database,
  requests: ReadonlyArray<{ definitionId: string; limit: number }>,
): {
  statements: BatchStatement[];
  resolve(results: readonly unknown[], offset: number): { types: StorefrontMetaobjectType[]; mediaIds: string[] };
} {
  if (requests.length === 0) return { statements: [], resolve: () => ({ types: [], mediaIds: [] }) };
  const ids = [...new Set(requests.map((request) => request.definitionId))];
  deps.metaobjects(ids);
  const limits = new Map(requests.map((request) => [request.definitionId, Math.min(Math.max(request.limit, 1), METAOBJECT_SECTION_ENTRIES_MAX)]));
  const idSet = sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
  const definitions = db.select({
    id: metaobjectDefinitions.id,
    name: metaobjectDefinitions.name,
    fields: metaobjectDefinitions.fields,
    displayField: metaobjectDefinitions.displayField,
    currencyCode: storeCurrencyCodeSql(),
  }).from(metaobjectDefinitions)
    .where(and(sql`${metaobjectDefinitions.id} IN ${idSet}`, eq(metaobjectDefinitions.storefrontAccess, true)));
  // The first entries of each type in order: a window keeps the read bounded per type.
  const entries = db.select({
    definitionId: sql<string>`ranked.definition_id`,
    handle: sql<string>`ranked.handle`,
    fields: sql<string>`ranked.fields`,
    rank: sql<number>`ranked.rank`,
  }).from(sql`(SELECT ${metaobjectEntries.definitionId} AS definition_id, ${metaobjectEntries.handle} AS handle,
      ${metaobjectEntries.fields} AS fields,
      ROW_NUMBER() OVER (PARTITION BY ${metaobjectEntries.definitionId} ORDER BY ${metaobjectEntries.position}, ${metaobjectEntries.id}) AS rank
    FROM ${metaobjectEntries}
    WHERE ${metaobjectEntries.definitionId} IN ${idSet} AND ${metaobjectEntries.status} = 'published') AS ranked`)
    .where(sql`ranked.rank <= ${METAOBJECT_SECTION_ENTRIES_MAX}`)
    .orderBy(sql`ranked.definition_id`, sql`ranked.rank`);
  return {
    statements: [definitions as unknown as BatchStatement, entries as unknown as BatchStatement],
    resolve(results, offset) {
      const definitionRows = (results[offset] ?? []) as Array<{ id: string; name: string; fields: string; displayField: string | null; currencyCode: string | null }>;
      const entryRows = (results[offset + 1] ?? []) as Array<{ definitionId: string; handle: string; fields: string; rank: number }>;
      const mediaIds = new Set<string>();
      const types = ids.flatMap((id): StorefrontMetaobjectType[] => {
        const row = definitionRows.find((candidate) => candidate.id === id);
        if (!row) return [];
        const parsed = metaobjectFieldListSchema.safeParse(parseJson(row.fields));
        const fields: MetaobjectFieldDefinition[] = parsed.success ? parsed.data : [];
        const display = metaobjectDisplayField(fields, row.displayField);
        const context = { decimalPlaces: storeDecimalPlacesFromCode(row.currencyCode), currencyCode: storeCurrencyFromCode(row.currencyCode) };
        const limit = limits.get(id) ?? METAOBJECT_SECTION_ENTRIES_MAX;
        const entries = entryRows.filter((entry) => entry.definitionId === id && Number(entry.rank) <= limit).map((entry) => {
          const stored = parseJson(entry.fields);
          const values = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
          const title = display && typeof values[display] === "string" && (values[display] as string).trim() ? (values[display] as string).trim() : entry.handle;
          const shown = fields.flatMap((field) => {
            const value = values[field.key];
            if (field.key === display || typeof value !== "string" || !value) return [];
            // Not canonical for its type (never guessed at): left out.
            const wire = customFieldWireValue(field.type, value, context);
            if (wire === null) return [];
            if (customFieldReferenceTarget(field.type) === "media") for (const mediaId of customFieldReferenceIds(field.type, value)) mediaIds.add(mediaId);
            return [{ key: field.key, name: field.name, type: field.type, value: wire }];
          });
          return { handle: entry.handle, title: title.slice(0, 200), fields: shown };
        });
        return [{ id, name: row.name, entries }];
      });
      return { types, mediaIds: [...mediaIds] };
    },
  };
}
