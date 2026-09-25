/**
 * An independent reading of the dependency registry: given one committed row
 * change (old and new image), the keys `CACHE_DEP_TABLES` says it advances.
 *
 * It is written from the registry's documented semantics, not from S1's
 * trigger generator, so it serves two roles:
 * - the clock of the property harness before the generated triggers exist
 *   (the `ReferenceClock` in clocks.ts), and
 * - a cross-check of the generated triggers once they do: for every random
 *   mutation the harness compares the keys the triggers advanced with the
 *   keys this oracle derives.
 *
 * Lookups (parent ids, listing scopes, `where.exists`) are evaluated against
 * the database after the statement committed, which is what a trigger sees
 * for single-statement writes. Multi-statement batches that change a lookup
 * target and the row in one transaction can differ; the cross-check reports
 * such keys as `oracle-only` instead of failing.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { resolveBuyerAvailabilityBand } from "@scalius/shared/buyer-availability";
import {
  CACHE_DEP_TABLES,
  cacheDep,
  isCacheDepTable,
  type CacheDepKeyTemplate,
  type CacheDepRule,
  type CacheDepTableSpec,
} from "@scalius/shared/cache-deps";
import { changedColumns, sameValue, type LoggedChange, type RowImage, type SqlValue } from "./row-log";

function toText(value: SqlValue): string | null {
  if (value === null) return null;
  if (value instanceof Uint8Array) return null;
  return String(value);
}

function bindable(value: SqlValue): SQLInputValue {
  return value as SQLInputValue;
}

export class ReferenceOracle {
  constructor(private readonly sqlite: DatabaseSync) {}

  /** Keys advanced by one change, or an empty set for an unregistered table. */
  keysFor(change: LoggedChange): Set<string> {
    const keys = new Set<string>();
    if (!isCacheDepTable(change.table)) return keys;
    const spec: CacheDepTableSpec = CACHE_DEP_TABLES[change.table];
    let fired = false;
    for (const rule of spec.rules as readonly CacheDepRule[]) {
      if (rule.event !== change.op) continue;
      if (!this.ruleFires(rule, spec, change)) continue;
      const image = rule.image === "new" ? change.new : change.old;
      if (!image) continue;
      if (!this.whereHolds(rule, image)) continue;
      fired = true;
      for (const template of rule.keys) for (const key of this.expand(template, image)) keys.add(key);
    }
    // `t:<table>` advances with any rule of the table, as the generated
    // triggers do: a change no rule covers (a non-public buyer-state row) is
    // invisible to every public read.
    if (fired) keys.add(cacheDep.table(change.table));
    return keys;
  }

  /** Whether an update changed any non-noise column, or is an insert/delete. */
  visibleChange(spec: CacheDepTableSpec, change: LoggedChange): boolean {
    if (change.op !== "update") return true;
    const noise = new Set<string>(spec.noise);
    return changedColumns(change.old!, change.new!).some((column) => !noise.has(column))
      || (change.table === "product_variants" && this.bandChanged(change.old!, change.new!));
  }

  private ruleFires(rule: CacheDepRule, spec: CacheDepTableSpec, change: LoggedChange): boolean {
    if (change.op !== "update") return true;
    const before = change.old!;
    const after = change.new!;
    if (rule.bandChanged) return this.bandChanged(before, after);
    if (rule.changed === undefined) return true;
    if (rule.changed === "visible") {
      const noise = new Set<string>(spec.noise);
      return changedColumns(before, after).some((column) => !noise.has(column));
    }
    return rule.changed.some((column) => !sameValue(before[column] ?? null, after[column] ?? null));
  }

  private whereHolds(rule: CacheDepRule, image: RowImage): boolean {
    const equals = rule.where?.equals;
    if (equals) {
      for (const [column, expected] of Object.entries(equals)) {
        const actual = image[column] ?? null;
        if (actual === null || String(actual) !== String(expected)) return false;
      }
    }
    const exists = rule.where?.exists;
    if (exists) {
      const values: SQLInputValue[] = [];
      const sql = exists.replace(/\bR\.([A-Za-z_][A-Za-z0-9_]*)/g, (_match, column: string) => {
        values.push(bindable(image[column] ?? null));
        return "?";
      });
      const row = this.sqlite.prepare(`SELECT EXISTS (${sql}) AS hit`).get(...values) as { hit: number };
      if (Number(row.hit) !== 1) return false;
    }
    return true;
  }

  /** Store default low-stock level (settings `inventory/document`). */
  private storeDefaultThreshold(): number | null {
    const row = this.sqlite.prepare(`SELECT CASE WHEN json_valid(value)
        THEN CAST(json_extract(value, '$.defaultLowStockThreshold') AS INTEGER) END AS threshold
      FROM settings WHERE category = 'inventory' AND key = 'document'`).get() as { threshold: number | null } | undefined;
    return row?.threshold ?? null;
  }

  private band(image: RowImage, storeDefault: number | null): string {
    const threshold = image.low_stock_threshold ?? storeDefault;
    return resolveBuyerAvailabilityBand({
      stock: Number(image.stock ?? 0),
      reservedStock: Number(image.reserved_stock ?? 0),
      trackInventory: Number(image.track_inventory ?? 1) !== 0,
      lowStockThreshold: threshold === null ? null : Number(threshold),
    });
  }

  bandChanged(before: RowImage, after: RowImage): boolean {
    const storeDefault = this.storeDefaultThreshold();
    return this.band(before, storeDefault) !== this.band(after, storeDefault);
  }

  private expand(template: CacheDepKeyTemplate, image: RowImage): string[] {
    if ("dep" in template) return [template.dep];
    if ("columns" in template) {
      const parts = template.columns.map((column) => toText(image[column] ?? null));
      if (parts.some((part) => part === null)) return [];
      return [`${template.prefix}${parts.join(":")}`];
    }
    if ("lookup" in template) {
      const { table, select, key, column } = template.lookup;
      const value = image[column] ?? null;
      if (value === null) return [];
      const row = this.sqlite.prepare(`SELECT "${select}" AS v FROM "${table}" WHERE "${key}" = ?`).get(bindable(value)) as { v: SqlValue } | undefined;
      const text = row ? toText(row.v) : null;
      return text === null ? [] : [`${template.prefix}${text}`];
    }
    // Listing scopes.
    let state: { category_id: SqlValue; brand_id: SqlValue } | null;
    if ("row" in template.from) {
      state = { category_id: image.category_id ?? null, brand_id: image.brand_id ?? null };
    } else {
      const productId = image[template.from.product] ?? null;
      if (productId === null) return [];
      const row = this.sqlite.prepare(
        "SELECT category_id, brand_id FROM product_buyer_state WHERE product_id = ? AND is_public = 1",
      ).get(bindable(productId)) as { category_id: SqlValue; brand_id: SqlValue } | undefined;
      state = row ?? null;
    }
    if (state === null) return [];
    const prefix = template.scopes;
    const keys = [`${prefix}:all`];
    const categoryId = toText(state.category_id);
    if (categoryId !== null) {
      const ancestors = this.sqlite.prepare(
        "SELECT ancestor_id FROM category_closure WHERE descendant_id = ?",
      ).all(categoryId) as Array<{ ancestor_id: string }>;
      // The closure holds the category's own row (depth 0) while it exists; a
      // deleted category has no listing to invalidate.
      const scopes = new Set(ancestors.map((row) => String(row.ancestor_id)));
      for (const scope of scopes) keys.push(`${prefix}:cat:${scope}`);
    }
    const brandId = toText(state.brand_id);
    if (brandId !== null) keys.push(`${prefix}:brand:${brandId}`);
    return keys;
  }
}
