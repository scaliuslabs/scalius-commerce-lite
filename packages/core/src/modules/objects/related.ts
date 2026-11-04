import { sql, type SQL } from "drizzle-orm";
import { encodeIndexTuple, indexPrefixUpperBound } from "./index-encoding";
import { OBJECT_TITLE_FIELD_TYPES, type RelatedObjectRecord } from "@scalius/shared/plugins/objects";

export const RELATED_OBJECTS_LIMIT = 25;

/**
 * `objectTitleField()` in SQL: the display field, else the first single- or
 * multi-line text field. The type names are code constants, written inline so
 * the detail read it folds into binds no more parameters.
 */
const titleField = sql`COALESCE(related_type.display_field, (SELECT json_extract(title_field.value, '$.key')
  FROM json_each(related_type.fields_json) AS title_field
  WHERE json_extract(title_field.value, '$.type') IN (${sql.raw(OBJECT_TITLE_FIELD_TYPES.map((type) => `'${type}'`).join(", "))})
  ORDER BY title_field.id LIMIT 1))`;

/**
 * The field an index slot leads with: `indexes_json` holds, per slot, a field
 * key or a compound list of keys (its first leads). Read through json_each by
 * position, never an array-index path: PostgreSQL's JSON compat takes member names only.
 */
export function objectIndexFieldSql(indexesJson: SQL, slot: number): SQL {
  return sql`(SELECT CASE WHEN object_index.type = 'array'
      THEN (SELECT object_index_first.value FROM json_each(object_index.value) AS object_index_first WHERE CAST(object_index_first.key AS INTEGER) = 0)
      ELSE object_index.value END
    FROM json_each(${indexesJson}) AS object_index WHERE CAST(object_index.key AS INTEGER) = ${slot})`;
}

/** Fold into the resource's existing read; unused types never read records. */
export function relatedObjectsJson(resource: "product" | "order" | "customer", id: string): SQL<string | null> {
  const encoded = encodeIndexTuple([id], [resource]);
  const upper = indexPrefixUpperBound(encoded);
  const slots = [1, 2, 3, 4].map((slot) => {
    const field = objectIndexFieldSql(sql.raw("related_type.indexes_json"), slot - 1);
    const column = sql.raw(`related_record.k${slot}`);
    return sql`SELECT entry FROM (SELECT json_object(
        'typeId', related_type.id,
        'typeHandle', related_type.namespace || '.' || related_type.type,
        'typeName', related_type.name,
        'recordId', related_record.id,
        'displayName', COALESCE(NULLIF(TRIM(CAST(json_extract(related_record.data_json, '$.' || ${titleField}) AS TEXT)), ''), related_record.handle, related_record.id)
      ) AS entry
      FROM object_types AS related_type CROSS JOIN object_records AS related_record
      WHERE related_type.admin <> 'none' AND EXISTS (
        SELECT 1 FROM json_each(related_type.fields_json) AS related_field
        WHERE json_extract(related_field.value, '$.type') = ${`${resource}_reference`}
          AND json_extract(related_field.value, '$.key') = ${field}
      ) AND related_record.type_id = related_type.id
        AND ${column} >= ${encoded} AND ${column} < ${upper}
      LIMIT ${RELATED_OBJECTS_LIMIT}
    ) AS ${sql.raw(`related_slot_${slot}`)}`;
  });
  return sql<string | null>`(SELECT '[' || group_concat(related_rows.entry, ',') || ']' FROM (
    ${sql.join(slots, sql` UNION `)}
    LIMIT ${RELATED_OBJECTS_LIMIT}
  ) AS related_rows)`;
}

/** SQL builds this small projection; no app record data leaves the detail read. */
export function parseRelatedObjects(value: string | null | undefined): RelatedObjectRecord[] {
  return value ? JSON.parse(value) as RelatedObjectRecord[] : [];
}
