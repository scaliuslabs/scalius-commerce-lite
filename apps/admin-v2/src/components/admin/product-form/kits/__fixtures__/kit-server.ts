// An in-memory product API for the bundle and page-offer cards' tests: the
// kits and page_offers sections, their writes under the product revision,
// and the SKU picker's search, priced the way core prices them.
import { AdminApiResponseError } from "~/lib/admin-api-error";

export interface FakeSku {
  variantId: string;
  productId: string;
  productName: string;
  productActive: boolean;
  sku: string;
  options: Array<{ name: string; value: string }>;
  imageUrl: string | null;
  price: number;
  available: number | null;
  isKit: boolean;
  isGiftCard: boolean;
  /** A problem the kit read reports for this SKU as an item. */
  problem?: "component_deleted" | "component_inactive" | "component_product_deleted" | "component_unpublished" | "component_gift_card" | null;
}

const problemOf = (sku: FakeSku) => sku.problem ?? (sku.productActive ? null : "component_inactive" as const);

export function createKitServer(skus: FakeSku[]) {
  const catalog = new Map(skus.map((sku) => [sku.variantId, sku]));
  const state = {
    revision: 7,
    kits: new Map<string, Array<{ variantId: string; quantity: number }>>(),
    offers: new Map<string, string[]>(),
    /** The next write fails with this error (once). */
    refuse: null as Error | null,
    writes: [] as Array<Record<string, unknown>>,
    /** While set, writes wait for it (a save still on its way). */
    hold: null as Promise<void> | null,
  };

  const kitRead = (productId: string) => ({
    section: "kits" as const,
    aggregateRevision: state.revision,
    items: [...state.kits.entries()].filter(([id]) => catalog.get(id)?.productId === productId).map(([id, parts]) => {
      const own = catalog.get(id)!;
      const components = parts.map((part) => {
        const sku = catalog.get(part.variantId)!;
        return {
          variantId: sku.variantId, productId: sku.productId, productName: sku.productName, sku: sku.sku, options: sku.options,
          quantity: part.quantity, price: sku.price, stock: sku.available, problem: problemOf(sku),
        };
      });
      const compareAt = components.reduce((total, component) => total + (component.problem ? 0 : component.price * component.quantity), 0);
      const saving = Math.max(0, compareAt - own.price);
      const unavailable = components.flatMap((component) => (component.problem ? [{ componentVariantId: component.variantId, reason: component.problem }] : []));
      const tracked = components.filter((component) => component.stock !== null);
      return {
        variantId: id, sku: own.sku, ownPrice: own.price, price: own.price, compareAtPrice: compareAt, saving,
        savingPercent: compareAt > 0 && saving > 0 ? Math.round((saving * 100) / compareAt) : 0,
        availableQuantity: unavailable.length > 0 ? 0 : tracked.length === 0 ? null : Math.min(...tracked.map((component) => Math.floor(Math.max(0, component.stock!) / component.quantity))),
        unavailable,
        components,
      };
    }),
  });

  const offersRead = (productId: string) => ({
    section: "page_offers" as const,
    aggregateRevision: state.revision,
    items: (state.offers.get(productId) ?? []).map((variantId, position) => {
      const sku = catalog.get(variantId)!;
      return {
        variantId, productId: sku.productId, productName: sku.productName, sku: sku.sku, options: sku.options, position,
        isKit: state.kits.has(variantId) || sku.isKit, price: sku.price, problem: problemOf(sku),
      };
    }),
  });

  const refusal = (reason: string, variantId?: string) =>
    new AdminApiResponseError("Refused", 400, "validation_error", { reason, field: "components", ...(variantId ? { variantId } : {}) });

  return {
    state,
    refusal,
    staleRevision: () => new AdminApiResponseError("Changed", 409, "product_revision_conflict", { expectedRevision: 7, currentRevision: 8 }),
    getSection: async ({ path }: { path: { id: string; section: string } }) =>
      path.section === "kits" ? kitRead(path.id) : offersRead(path.id),
    patchSection: async ({ path, body }: { path: { id: string; section: string }; body: Record<string, unknown> }) => {
      state.writes.push(body);
      if (state.hold) await state.hold;
      if (state.refuse) {
        const error = state.refuse;
        state.refuse = null;
        throw error;
      }
      if (body.expectedAggregateRevision !== state.revision) {
        throw new AdminApiResponseError("Changed", 409, "product_revision_conflict", { expectedRevision: body.expectedAggregateRevision, currentRevision: state.revision });
      }
      if (path.section === "kits") {
        const components = body.components as Array<{ variantId: string; quantity: number }>;
        if (components.length === 0) state.kits.delete(body.variantId as string);
        else state.kits.set(body.variantId as string, components);
      } else {
        const ids = body.variantIds as string[];
        const own = ids.find((id) => catalog.get(id)?.productId === path.id);
        if (own) throw refusal("page_offer_own_sku", own);
        state.offers.set(path.id, ids);
      }
      state.revision += 1;
      return { aggregateRevision: state.revision };
    },
    searchSkus: async ({ query }: { query: { search?: string; page?: number; limit?: number } }) => {
      const term = query.search?.toLowerCase() ?? "";
      const items = skus
        .map((sku) => ({ ...sku, isKit: sku.isKit || state.kits.has(sku.variantId) }))
        .filter((sku) => !term || `${sku.productName} ${sku.sku} ${sku.options.map((option) => option.value).join(" ")}`.toLowerCase().includes(term))
        .map(({ problem: _problem, ...sku }) => sku);
      return { items, page: query.page ?? 1, hasMore: false };
    },
  };
}

/** Lets queries, debounces and portals settle. */
export async function settle(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.resolve();
}
