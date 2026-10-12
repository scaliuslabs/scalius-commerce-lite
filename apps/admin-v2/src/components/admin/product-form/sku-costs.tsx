// Cost per item in the product editor. The page keeps the merchant's typed
// costs here (one store for the Pricing card and the variant table), and the
// page's Save sends the changed ones in the product's one write (`changes()`;
// a new variant by its draft id, a new product's costs with its SKUs). Each
// cost carries the value the merchant saw (`expectedCost`), so a cost a
// purchase order receipt or another tab changed meanwhile refuses the save
// instead of being overwritten. The variant editor on its own still sends them
// with PUT /inventory/costs (`save`).
//
// The store lives in the route, above the variant editor, so typed costs
// survive the editor remounting after a save (new variants get their ids), and
// it is the one source of the costs the editor shows.
import { createContext, useContext, useLayoutEffect, useMemo, useReducer, useRef, type MutableRefObject, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { productQueryOptions, type ProductDetailDto } from "~/lib/api-query-options/products";
import {
  costProblem,
  isSkuCostConflict,
  sameCost,
  saveSkuCosts,
  SKU_COST_BATCH_LIMIT,
  type SkuCostItem,
} from "~/lib/api-query-options/inventory-costs";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import { translate } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import { SaveNotCompleted } from "../shared/SaveBar";

const t = (key: ProductMessageKey) => translate(productMessages, key);

/** A new product's hidden SKU, before the product (and so the SKU) exists. */
export const NEW_SIMPLE_SKU = "new-simple-sku";

/** One SKU the variant editor shows: a saved one by its id, a new variant by its draft id. */
export interface SkuCostRow {
  key: string;
  /** The SKU code as typed; it finds a new variant once saved (codes are unique). */
  sku: string;
  /** The hidden SKU of a product without options. */
  isDefault: boolean;
}

type CostVariant = Pick<ProductDetailDto["variants"][number], "id" | "sku" | "isDefault" | "deletedAt"> & {
  cost?: number | null;
};

/** Not saved yet: no cost can be written until the save gives it an id. */
export const isUnsavedSkuKey = (key: string) => key === NEW_SIMPLE_SKU || key.startsWith("draft_");

const normalizedSku = (sku: string | null | undefined) => (sku ?? "").trim().toLowerCase();

function savedCostsOf(variants: readonly CostVariant[]): Map<string, number | null> {
  return new Map(variants.filter((variant) => !variant.deletedAt).map((variant) => [variant.id, variant.cost ?? null]));
}

/**
 * The changed costs among these saved SKUs, each with the cost the merchant
 * saw as `expectedCost`. Unsaved keys and unchanged costs are left out.
 */
export function changedCosts(
  keys: readonly string[],
  saved: ReadonlyMap<string, number | null>,
  edits: ReadonlyMap<string, number | null>,
): SkuCostItem[] {
  return [...new Set(keys)].flatMap((key) => {
    if (isUnsavedSkuKey(key) || !edits.has(key)) return [];
    const cost = edits.get(key) ?? null;
    const expectedCost = saved.get(key) ?? null;
    return sameCost(cost, expectedCost) ? [] : [{ variantId: key, cost, expectedCost }];
  });
}

/**
 * The saved id of each new SKU after a save: the product's live default SKU
 * for a product without options, else the live SKU with the same code.
 */
export function resolveSkuKeys(
  rows: readonly SkuCostRow[],
  variants: readonly CostVariant[],
): Map<string, string> {
  const live = variants.filter((variant) => !variant.deletedAt);
  const resolved = new Map<string, string>();
  for (const row of rows) {
    if (!isUnsavedSkuKey(row.key)) continue;
    const match = row.isDefault
      ? live.find((variant) => variant.isDefault)
      : live.find((variant) => !variant.isDefault && normalizedSku(variant.sku) === normalizedSku(row.sku));
    if (match) resolved.set(row.key, match.id);
  }
  return resolved;
}

export interface SkuCostStore {
  /** The key of a product without options: its hidden SKU's id, or `NEW_SIMPLE_SKU` before it exists. */
  simpleKey: string;
  /** The editor's typed cost, else saved (null: none). Viewers request savedOnly after edit permission changes. */
  costOf: (key: string, savedOnly?: boolean) => number | null;
  setCosts: (keys: Iterable<string>, cost: number | null) => void;
  /** A typed cost differs from the saved one among these SKUs. */
  isDirty: (keys: readonly string[]) => boolean;
  /** The first typed cost among these SKUs that can't be saved. */
  problemOf: (keys: readonly string[]) => { key: string; message: string } | null;
  /** The SKUs the variant editor shows; it publishes them after each render. */
  rows: MutableRefObject<readonly SkuCostRow[]>;
  /**
   * The changed costs of the shown SKUs for the product's write, a new variant
   * by its draft id (no cost to replace yet).
   */
  changes: () => SkuCostItem[];
  /** After the write that carried `changes()`: those costs are saved (a new variant's arrives with the reloaded product). */
  settle: (sent: readonly SkuCostItem[], productId: string) => void;
  /**
   * Sends the changed costs of the shown SKUs (new ones first find their ids).
   * Rejects with the banner's reason; a cost changed elsewhere is then shown
   * as it is now, so the merchant checks it before saving again.
   */
  save: (productId: string) => Promise<void>;
  /** Discard: forgets typed costs; with variants, also takes their saved costs (Reload). */
  reset: (variants?: readonly CostVariant[]) => void;
  /**
   * Takes the latest saved costs for SKUs without a typed cost. A typed cost
   * keeps the cost it was typed over, so one changed meanwhile is refused on save.
   */
  sync: (variants: readonly CostVariant[]) => void;
}

const SkuCostContext = createContext<SkuCostStore | null>(null);

/** The page's cost store, or null where costs aren't edited (tests, other editors). */
export function useSkuCosts(): SkuCostStore | null {
  return useContext(SkuCostContext);
}

/**
 * Costs per item reach the editor only for staff with "View product costs":
 * without it there is no store, so no cost field, margin or cost write
 * appears (the API leaves costs out of their reads and refuses cost writes).
 */
export function SkuCostProvider({ store, children }: { store: SkuCostStore; children: ReactNode }) {
  const { inventory: { canViewCosts } } = useCatalogActionPermissions();
  return <SkuCostContext.Provider value={canViewCosts ? store : null}>{children}</SkuCostContext.Provider>;
}

/**
 * Publishes the SKUs a variant editor shows, after each render, so a save
 * sends exactly the costs of the SKUs on screen.
 */
export function usePublishSkuCostRows(store: SkuCostStore | null, rows: readonly SkuCostRow[]) {
  useLayoutEffect(() => {
    if (store) store.rows.current = rows;
  });
}

/**
 * The cost draft of one product page. `variants` seeds the saved costs (a new
 * product has none); the returned store changes identity on every edit, so
 * the fields reading it re-render.
 */
export function useSkuCostDraft(variants: readonly CostVariant[] = []): SkuCostStore {
  const queryClient = useQueryClient();
  // A ref is the source of truth so an async save reads (and rekeys) the latest draft.
  const data = useRef<{ saved: Map<string, number | null>; edits: Map<string, number | null> } | null>(null);
  data.current ??= { saved: savedCostsOf(variants), edits: new Map() };
  const rows = useRef<readonly SkuCostRow[]>([]);
  const [version, bump] = useReducer((count: number) => count + 1, 0);
  const simpleKey = variants.find((variant) => variant.isDefault && !variant.deletedAt)?.id ?? NEW_SIMPLE_SKU;

  return useMemo<SkuCostStore>(() => {
    const draft = () => data.current!;
    const update = (change: (saved: Map<string, number | null>, edits: Map<string, number | null>) => void) => {
      const saved = new Map(draft().saved);
      const edits = new Map(draft().edits);
      change(saved, edits);
      data.current = { saved, edits };
      bump();
    };
    const latestVariants = async (productId: string) =>
      (await queryClient.fetchQuery({ ...productQueryOptions(productId), staleTime: 0 })).variants as CostVariant[];

    const sendInBatches = async (items: SkuCostItem[]) => {
      for (let index = 0; index < items.length; index += SKU_COST_BATCH_LIMIT) {
        const batch = items.slice(index, index + SKU_COST_BATCH_LIMIT);
        const result = await saveSkuCosts(batch);
        const savedCost = new Map(result.items.map((item) => [item.variantId, item.cost] as const));
        update((saved, edits) => {
          for (const item of batch) {
            saved.set(item.variantId, savedCost.has(item.variantId) ? savedCost.get(item.variantId)! : item.cost);
            // A cost typed while the save was on its way stays unsaved.
            if (edits.has(item.variantId) && sameCost(edits.get(item.variantId), item.cost)) edits.delete(item.variantId);
          }
        });
      }
    };

    return {
      simpleKey,
      costOf: (key, savedOnly = false) => {
        const { saved, edits } = draft();
        return !savedOnly && edits.has(key) ? edits.get(key) ?? null : saved.get(key) ?? null;
      },
      setCosts: (keys, cost) => update((_saved, edits) => {
        for (const key of keys) edits.set(key, cost);
      }),
      isDirty: (keys) => {
        const { saved, edits } = draft();
        return keys.some((key) => edits.has(key) && !sameCost(edits.get(key), saved.get(key) ?? null));
      },
      problemOf: (keys) => {
        const { edits } = draft();
        for (const key of keys) {
          const problem = edits.has(key) ? costProblem(edits.get(key) ?? null) : null;
          if (problem) return { key, message: t(problem === "costInvalid" ? "issueCostInvalid" : "issueCostTooLarge") };
        }
        return null;
      },
      rows,
      changes: () => {
        const { saved, edits } = draft();
        const keys = [...new Set(rows.current.map((row) => row.key))];
        return keys.flatMap((key) => {
          if (key === NEW_SIMPLE_SKU || !edits.has(key)) return [];
          const cost = edits.get(key) ?? null;
          const expectedCost = isUnsavedSkuKey(key) ? null : saved.get(key) ?? null;
          return sameCost(cost, expectedCost) ? [] : [{ variantId: key, cost, expectedCost }];
        });
      },
      settle: (sent, productId) => {
        update((saved, edits) => {
          for (const item of sent) {
            if (!isUnsavedSkuKey(item.variantId)) saved.set(item.variantId, item.cost);
            // A cost typed while the save was on its way stays unsaved.
            if (edits.has(item.variantId) && sameCost(edits.get(item.variantId), item.cost)) edits.delete(item.variantId);
          }
        });
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all }),
          queryClient.invalidateQueries({ queryKey: queryKeys.products.detail(productId) }),
        ]);
      },
      save: async (productId) => {
        let shown = rows.current;
        try {
          const pending = shown.filter((row) => isUnsavedSkuKey(row.key) && draft().edits.get(row.key) != null);
          if (pending.length > 0) {
            // New SKUs got their ids in the save that just finished: move their typed costs there.
            const variants = await latestVariants(productId);
            const ids = resolveSkuKeys(pending, variants);
            const savedNow = savedCostsOf(variants);
            update((saved, edits) => {
              for (const [key, id] of ids) {
                edits.set(id, edits.get(key) ?? null);
                edits.delete(key);
                saved.set(id, savedNow.get(id) ?? null);
              }
            });
            shown = shown.map((row) => (ids.has(row.key) ? { ...row, key: ids.get(row.key)! } : row));
            rows.current = shown;
          }
          const { saved, edits } = draft();
          const items = changedCosts(shown.map((row) => row.key), saved, edits);
          if (items.length === 0) return;
          await sendInBatches(items);
        } catch (error) {
          if (!isSkuCostConflict(error)) {
            throw new SaveNotCompleted(`${t("costPerItem")}: ${getServerFnError(error, t("costsNotSaved"))}`);
          }
          // Show what the cost is now (receipts average it), so the merchant checks it first.
          try {
            const now = savedCostsOf(await latestVariants(productId));
            update((saved, edits) => {
              for (const [id, cost] of now) {
                if (sameCost(saved.get(id) ?? null, cost)) continue;
                saved.set(id, cost);
                edits.delete(id);
              }
            });
          } catch {
            // The banner still says why; Reload shows the latest.
          }
          throw new SaveNotCompleted(t("costChanged"));
        }
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.inventory.all }),
          queryClient.invalidateQueries({ queryKey: queryKeys.products.detail(productId) }),
        ]);
      },
      reset: (variants) => update((saved, edits) => {
        edits.clear();
        if (!variants) return;
        saved.clear();
        for (const [id, cost] of savedCostsOf(variants)) saved.set(id, cost);
      }),
      sync: (variants) => update((saved, edits) => {
        for (const [id, cost] of savedCostsOf(variants)) {
          if (!edits.has(id)) saved.set(id, cost);
        }
      }),
    };
    // `version` gives every edit a new store, so readers re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, simpleKey, version]);
}
