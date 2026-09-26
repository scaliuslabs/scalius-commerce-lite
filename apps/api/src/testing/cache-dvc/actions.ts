/**
 * Curated real writes: the application's own services, so the harness also
 * covers the multi-table shapes they commit in one batch (projection
 * refreshes appended to product and stock writes, the category tree
 * triggers, soft-deletes and restores). Raw row mutations cover every table;
 * these cover the combinations.
 *
 * Every action reads the current revision it must claim, so it is valid
 * against whatever state the random walk produced; a refused write
 * (conflict, validation) is a no-op that the harness counts.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import {
  bulkUpdateProducts,
  catalogProjectionRefreshStatements,
  deleteProduct,
  rebuildCatalogProjections,
  restoreProduct,
} from "@scalius/core/modules/products";
import { adjustStock } from "@scalius/core/modules/inventory";
import { moveCategory } from "@scalius/core/modules/categories";
import { refreshProductRecommendations, refreshProductSalesStats } from "@scalius/core/modules/catalog";
import type { Rng } from "./rng";

export interface CuratedAction {
  readonly name: string;
  readonly weight: number;
  run(context: ActionContext): Promise<string | null>;
}

export interface ActionContext {
  readonly sqlite: DatabaseSync;
  readonly db: Database;
  readonly rng: Rng;
}

function ids(sqlite: DatabaseSync, sql: string): string[] {
  return (sqlite.prepare(sql).all() as Array<{ id: string }>).map((row) => row.id);
}

function productClaim(sqlite: DatabaseSync, id: string): { id: string; expectedAggregateRevision: number } | null {
  const row = sqlite.prepare("SELECT aggregate_revision AS revision FROM products WHERE id = ?").get(id) as { revision: number } | undefined;
  return row ? { id, expectedAggregateRevision: Number(row.revision) } : null;
}

export const CURATED_ACTIONS: readonly CuratedAction[] = [
  {
    name: "adjust-stock",
    weight: 6,
    async run({ sqlite, db, rng }) {
      const variants = sqlite.prepare(
        "SELECT id, stock, reserved_stock AS reserved FROM product_variants WHERE deleted_at IS NULL AND track_inventory = 1",
      ).all() as Array<{ id: string; stock: number; reserved: number }>;
      if (variants.length === 0) return null;
      const variant = rng.pick(variants);
      // Walk across the bands: to zero, to the low level, back above it.
      const available = variant.stock - variant.reserved;
      const target = rng.pick([0, 1, 2, 3, 5, 12, available + 1, Math.max(0, available - 1)]);
      const delta = target - available;
      if (delta === 0 || variant.stock + delta < 0) return null;
      await adjustStock(db, variant.id, delta, `dvc-adjust-${String(rng.int(0, 2 ** 30)).padStart(10, "0")}`, "dvc property");
      return `adjustStock ${variant.id} ${delta > 0 ? "+" : ""}${delta}`;
    },
  },
  {
    name: "publish-toggle",
    weight: 2,
    async run({ sqlite, db, rng }) {
      const products = ids(sqlite, "SELECT id FROM products WHERE deleted_at IS NULL");
      if (products.length === 0) return null;
      const claim = productClaim(sqlite, rng.pick(products));
      if (!claim) return null;
      const active = rng.chance(0.5);
      await bulkUpdateProducts(db, [claim], { isActive: active });
      return `bulkUpdateProducts ${claim.id} isActive=${active}`;
    },
  },
  {
    name: "product-category-move",
    weight: 2,
    async run({ sqlite, db, rng }) {
      const products = ids(sqlite, "SELECT id FROM products WHERE deleted_at IS NULL");
      const categories = ids(sqlite, "SELECT id FROM categories WHERE deleted_at IS NULL");
      if (products.length === 0 || categories.length === 0) return null;
      const claim = productClaim(sqlite, rng.pick(products));
      if (!claim) return null;
      const categoryId = rng.pick(categories);
      await bulkUpdateProducts(db, [claim], { categoryId });
      return `bulkUpdateProducts ${claim.id} categoryId=${categoryId}`;
    },
  },
  {
    name: "trash-restore",
    weight: 1,
    async run({ sqlite, db, rng }) {
      const products = sqlite.prepare("SELECT id, deleted_at AS deletedAt FROM products").all() as Array<{ id: string; deletedAt: number | null }>;
      if (products.length === 0) return null;
      const product = rng.pick(products);
      const claim = productClaim(sqlite, product.id)!;
      if (product.deletedAt === null) {
        await deleteProduct(db, product.id, claim.expectedAggregateRevision);
        return `deleteProduct ${product.id}`;
      }
      await restoreProduct(db, product.id, claim.expectedAggregateRevision);
      return `restoreProduct ${product.id}`;
    },
  },
  {
    name: "category-tree-move",
    weight: 2,
    async run({ sqlite, db, rng }) {
      const categories = sqlite.prepare("SELECT id, revision FROM categories WHERE deleted_at IS NULL").all() as Array<{ id: string; revision: number }>;
      if (categories.length < 2) return null;
      const category = rng.pick(categories);
      const parents = categories.filter((each) => each.id !== category.id).map((each) => each.id);
      const parentId = rng.chance(0.25) ? null : rng.pick(parents);
      await moveCategory(db, category.id, { expectedRevision: Number(category.revision), parentId } as never);
      return `moveCategory ${category.id} -> ${parentId ?? "(root)"}`;
    },
  },
  {
    name: "projection-refresh",
    weight: 3,
    async run({ sqlite, db, rng }) {
      const products = ids(sqlite, "SELECT id FROM products");
      if (products.length === 0) return null;
      const chosen = rng.sample(products, rng.int(1, 3));
      await db.batch(catalogProjectionRefreshStatements(db, chosen, { facets: true }) as never);
      return `catalogProjectionRefresh ${chosen.join(",")}`;
    },
  },
  {
    name: "projection-rebuild",
    weight: 0.3,
    async run({ db }) {
      await rebuildCatalogProjections(db);
      return "rebuildCatalogProjections";
    },
  },
  {
    name: "soft-refresh",
    weight: 0.5,
    async run({ sqlite, db, rng }) {
      if (rng.chance(0.5)) {
        await refreshProductSalesStats(db);
        return "refreshProductSalesStats";
      }
      const products = ids(sqlite, "SELECT id FROM products");
      await refreshProductRecommendations(db, rng.sample(products, 3));
      return "refreshProductRecommendations";
    },
  },
];
