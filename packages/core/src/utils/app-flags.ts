// An owner's app flags, in the statement that reads the owner: what an app's
// line input shown on some products or SKUs follows (`appLineInputApplies`
// in @scalius/shared/line-properties). Checkout, staff orders and app orders
// read them beside the product and the SKU, so every path applies one rule.
import { sql, type SQL } from "drizzle-orm";

/**
 * A JSON list of `<app id>.<key>=true|false`, one per storefront-visible
 * boolean field of an app the owner has a value for
 * (`parseAppLineInputFlags`); null without any. Read through the values'
 * owner index: one lookup per product or SKU row.
 */
export function appFlagsSql(ownerType: "product" | "variant", ownerId: SQL): SQL<string | null> {
    return sql<string | null>`(SELECT json_group_array(flag_definition.namespace || '.' || flag_definition.key || '=' || flag_value.value)
        FROM custom_field_values AS flag_value
        JOIN custom_field_definitions AS flag_definition ON flag_definition.id = flag_value.definition_id
        WHERE flag_value.owner_type = ${sql.raw(`'${ownerType}'`)} AND flag_value.owner_id = ${ownerId}
          AND flag_definition.type = 'boolean' AND flag_definition.storefront_visible = 1 AND flag_definition.namespace <> 'custom')`;
}
