// src/modules/attributes/number-display.ts
// A number value's display text written in SQL: its canonical number and the
// unit its attribute names when the statement runs (the unit in force), so a
// write that races a unit change never stores the unit that change replaced.
import { productAttributes } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";

import { canonicalAttributeNumberSql } from "../../utils/attribute-number-sql";

/** `<canonical number>[ <unit in force>]` for a number and the id of its attribute. */
export function numberDisplayWithUnitInForce(number: SQL, attributeId: SQL): SQL<string> {
    return sql<string>`(${canonicalAttributeNumberSql(number)}
        || COALESCE(' ' || (SELECT number_attribute.unit FROM ${productAttributes} AS number_attribute
            WHERE number_attribute.id = ${attributeId}), ''))`;
}
