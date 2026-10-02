// The purchase order editor's working copy: the header fields as typed and
// one line per SKU. It turns into the API body only when valid, and its body
// is what "unsaved changes" compares.
import type { InventoryVariant } from "~/lib/api-query-options/inventory";
import {
  PURCHASING_MAX_LINES,
  PURCHASING_MAX_QUANTITY,
  type PurchaseOrder,
  type PurchaseOrderBody,
} from "~/lib/api-query-options/purchasing";
import { costMinor } from "./document-math";

export interface PurchaseOrderDraftLine {
  variantId: string;
  productId: string;
  productName: string | null;
  optionLabel: string | null;
  sku: string;
  quantity: number | null;
  unitCost: number | null;
  /** The SKU's cost per item now (a hint beside the line's cost). */
  currentCost: number | null;
  retired: boolean;
}

export interface PurchaseOrderDraft {
  supplier: { id: string; name: string } | null;
  /** "" until chosen: the API then uses the default location. */
  destinationId: string;
  /** YYYY-MM-DD or "". */
  expectedOn: string;
  reference: string;
  notes: string;
  shipping: number | null;
  otherCosts: number | null;
  tax: number | null;
  lines: PurchaseOrderDraftLine[];
}

export function draftFromOrder(order: PurchaseOrder | null): PurchaseOrderDraft {
  return {
    supplier: order?.supplier ? { id: order.supplier.id, name: order.supplier.name } : null,
    destinationId: order?.destination.id ?? "",
    expectedOn: order?.expectedOn ?? "",
    reference: order?.reference ?? "",
    notes: order?.notes ?? "",
    shipping: order && order.shipping > 0 ? order.shipping : null,
    otherCosts: order && order.otherCosts > 0 ? order.otherCosts : null,
    tax: order && order.tax > 0 ? order.tax : null,
    lines: (order?.lines ?? []).map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      productName: line.productName,
      optionLabel: line.optionLabel,
      sku: line.sku,
      quantity: line.quantity,
      unitCost: line.unitCost,
      currentCost: line.currentCost,
      retired: line.retired,
    })),
  };
}

/** A picked SKU as a new line: one unit at the SKU's cost per item now. */
export function lineFromVariant(variant: InventoryVariant): PurchaseOrderDraftLine {
  return {
    variantId: variant.id,
    productId: variant.productId,
    productName: variant.productName,
    optionLabel: variant.optionLabel,
    sku: variant.sku,
    quantity: 1,
    unitCost: variant.cost ?? null,
    currentCost: variant.cost ?? null,
    retired: false,
  };
}

export function quantityValid(quantity: number | null): boolean {
  return quantity !== null && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= PURCHASING_MAX_QUANTITY;
}

export function costValid(cost: number | null, decimals: number): boolean {
  return costMinor(cost, decimals) !== null;
}

/** An extra cost (shipping, other, tax) may be empty: that is nothing. */
export function extraCostValid(cost: number | null, decimals: number): boolean {
  return cost === null || costValid(cost, decimals);
}

export interface DraftValidation {
  /** Lines whose quantity or cost can't be sent, by SKU. */
  lines: Map<string, { quantity: boolean; cost: boolean }>;
  extras: { shipping: boolean; otherCosts: boolean; tax: boolean };
  tooManyLines: boolean;
  valid: boolean;
}

export function validateDraft(draft: PurchaseOrderDraft, decimals: number): DraftValidation {
  const lines = new Map<string, { quantity: boolean; cost: boolean }>();
  for (const line of draft.lines) {
    const quantity = !quantityValid(line.quantity);
    const cost = !costValid(line.unitCost, decimals);
    if (quantity || cost) lines.set(line.variantId, { quantity, cost });
  }
  const extras = {
    shipping: !extraCostValid(draft.shipping, decimals),
    otherCosts: !extraCostValid(draft.otherCosts, decimals),
    tax: !extraCostValid(draft.tax, decimals),
  };
  const tooManyLines = draft.lines.length > PURCHASING_MAX_LINES;
  return {
    lines,
    extras,
    tooManyLines,
    valid: lines.size === 0 && !extras.shipping && !extras.otherCosts && !extras.tax && !tooManyLines,
  };
}

/** The API body of a valid draft (create, or a draft's full save with its lines). */
export function draftBody(draft: PurchaseOrderDraft): PurchaseOrderBody {
  return {
    supplierId: draft.supplier?.id ?? null,
    ...(draft.destinationId ? { destinationLocationId: draft.destinationId } : {}),
    expectedOn: draft.expectedOn || null,
    reference: draft.reference.trim() || null,
    notes: draft.notes.trim() || null,
    shipping: draft.shipping ?? 0,
    otherCosts: draft.otherCosts ?? 0,
    tax: draft.tax ?? 0,
    lines: draft.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity ?? 0,
      unitCost: line.unitCost ?? 0,
    })),
  };
}

/** What "unsaved changes" compares: the body the draft would send. */
export function draftFingerprint(draft: PurchaseOrderDraft): string {
  return JSON.stringify(draftBody(draft));
}
