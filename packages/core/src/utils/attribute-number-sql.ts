// The canonical text of an attribute number in SQL: the twin of
// `canonicalAttributeNumber` (@scalius/shared/catalog-attributes), character
// for character, on D1, Turso and PostgreSQL, for every number an attribute
// may hold (|value| < 1e12, six decimals).
//
// Both sides take the same IEEE double steps: the whole part (exact), the
// fraction left over (exact), the fraction's millionths rounded half away from
// zero (floor of x 1e6 + 0.5, a value below a million), then the digits by
// 64-bit integer division, so no step depends on a provider's rounding and a
// large number never picks up digits a scaled double would. SQLite's CAST
// truncates toward zero and PostgreSQL's rounds, so a floor is the cast minus
// one where the cast went up. Every integer here fits a BIGINT (the old
// INTEGER cast overflowed PostgreSQL's 32 bits from 2,147.483648 on).
import { sql, type SQL } from "drizzle-orm";

/** The floor of a non-negative number as a BIGINT, the same on every provider. */
function floorOfNonNegative(value: SQL): SQL {
    const cast = sql`CAST(${value} AS BIGINT)`;
    return sql`(${cast} - CASE WHEN ${cast} > ${value} THEN 1 ELSE 0 END)`;
}

/** Canonical number text of a REAL column or expression (null in, null out). */
export function canonicalAttributeNumberSql(value: SQL): SQL<string> {
    const absolute = sql`abs(${value})`;
    const whole = floorOfNonNegative(absolute);
    const millionths = floorOfNonNegative(sql`((${absolute} - ${whole}) * 1000000 + 0.5)`);
    // The magnitude in millionths: a fraction that rounds up to a million carries into the whole part.
    const magnitude = sql`(${whole} * 1000000 + ${millionths})`;
    const fraction = sql`(${magnitude} % 1000000)`;
    return sql<string>`(CASE WHEN ${value} < 0 AND ${magnitude} > 0 THEN '-' ELSE '' END
        || CAST(${magnitude} / 1000000 AS TEXT)
        || CASE WHEN ${fraction} = 0 THEN ''
            ELSE '.' || rtrim(substr(CAST(1000000 + ${fraction} AS TEXT), 2), '0') END)`;
}
