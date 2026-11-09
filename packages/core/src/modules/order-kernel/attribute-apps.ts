// What a reader of an order needs to word its app checkout answers
// (`presentCheckoutAttributes`): each app's name, declared attributes and
// their translations, from the installations the answers name, whatever
// their status (an order keeps its words after its app stops). One indexed
// statement, made only when the order has answers. Shared by the order page,
// the receipt, the account order, emails and invoices.
import type { Database } from "@scalius/database/client";
import { orders, pluginInstallations } from "@scalius/database/schema";
import { sql } from "drizzle-orm";
import { checkoutAttributeAppFromManifest, type CheckoutAttributeApp } from "@scalius/shared/plugins/checkout-attribute-text";

/** The apps `<app id>.<key>` answers name. */
export function attributeAppIds(values: Readonly<Record<string, string>>): string[] {
  return [...new Set(Object.keys(values).map((key) => key.slice(0, Math.max(0, key.lastIndexOf(".")))).filter(Boolean))].sort();
}

/** The installations' statement: one row per app the answers name (at most a few: 8 KiB of answers). */
export function selectCheckoutAttributeApps(db: Database, appIds: readonly string[]) {
  return db.select({ pluginId: pluginInstallations.pluginId, manifestJson: pluginInstallations.manifestJson }).from(pluginInstallations)
    .where(sql`${pluginInstallations.pluginId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(appIds)}))`);
}

/**
 * The same words as one column of a statement that reads the order (an order
 * message reads its facts in one batch, at no extra statement): a JSON array of
 * the installations whose id prefixes one of the order's answer names, `[]`
 * without answers. Read it with `checkoutAttributeAppsFromJson`.
 */
export function orderAttributeAppsColumn() {
  // An answer's app id is its name up to the last dot: `rtrim(name, <its non-dot characters>)` keeps
  // "<app id>." (SQLite and PostgreSQL alike), and the second `rtrim` drops the dot. Each id is a
  // primary-key lookup; an order without answers looks up nothing.
  return sql<string | null>`(SELECT coalesce(json_group_array(json_object('pluginId', app.plugin_id, 'manifestJson', app.manifest_json)), '[]')
    FROM plugin_installations AS app
    WHERE app.plugin_id IN (SELECT rtrim(rtrim(answer.key, replace(answer.key, '.', '')), '.') FROM json_each(${orders.attributes}) AS answer))`;
}

/** `orderAttributeAppsColumn`'s value, worded for `presentCheckoutAttributes`. */
export function checkoutAttributeAppsFromJson(value: string | null | undefined): CheckoutAttributeApp[] {
  let rows: unknown;
  try { rows = value ? JSON.parse(value) : []; } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return checkoutAttributeAppsFromRows(rows.filter((row): row is { pluginId: string; manifestJson: string | null } =>
    typeof row === "object" && row !== null && typeof (row as { pluginId?: unknown }).pluginId === "string"));
}

export function checkoutAttributeAppsFromRows(rows: ReadonlyArray<{ pluginId: string; manifestJson: string | null }>): CheckoutAttributeApp[] {
  return rows.flatMap((row) => {
    const app = checkoutAttributeAppFromManifest(row.pluginId, row.manifestJson);
    return app ? [app] : [];
  });
}

/** The apps an order's answers name, worded for `presentCheckoutAttributes`; no read when there are none. */
export async function readCheckoutAttributeApps(db: Database, values: Readonly<Record<string, string>>): Promise<CheckoutAttributeApp[]> {
  const ids = attributeAppIds(values);
  if (ids.length === 0) return [];
  return checkoutAttributeAppsFromRows(await selectCheckoutAttributeApps(db, ids).all());
}
