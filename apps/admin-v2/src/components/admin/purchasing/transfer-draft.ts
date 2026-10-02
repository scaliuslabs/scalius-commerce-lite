// The transfer editor's working copy: origin, destination, details and one
// line per SKU with its quantity.
import type { InventoryVariant } from "~/lib/api-query-options/inventory";
import { PURCHASING_MAX_LINES, type Transfer, type TransferBody } from "~/lib/api-query-options/purchasing";
import { quantityValid } from "./purchase-order-draft";

export interface TransferDraftLine {
  variantId: string;
  productId: string;
  productName: string | null;
  optionLabel: string | null;
  sku: string;
  quantity: number | null;
  retired: boolean;
}

export interface TransferDraft {
  originId: string;
  destinationId: string;
  expectedOn: string;
  reference: string;
  notes: string;
  lines: TransferDraftLine[];
}

export function transferDraftFrom(transfer: Transfer | null, defaults: { originId: string; destinationId: string }): TransferDraft {
  return {
    originId: transfer?.origin.id ?? defaults.originId,
    destinationId: transfer?.destination.id ?? defaults.destinationId,
    expectedOn: transfer?.expectedOn ?? "",
    reference: transfer?.reference ?? "",
    notes: transfer?.notes ?? "",
    lines: (transfer?.lines ?? []).map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      productName: line.productName,
      optionLabel: line.optionLabel,
      sku: line.sku,
      quantity: line.quantity,
      retired: line.retired,
    })),
  };
}

export function transferLineFromVariant(variant: InventoryVariant): TransferDraftLine {
  return {
    variantId: variant.id,
    productId: variant.productId,
    productName: variant.productName,
    optionLabel: variant.optionLabel,
    sku: variant.sku,
    quantity: 1,
    retired: false,
  };
}

export interface TransferValidation {
  invalidLines: Set<string>;
  sameLocation: boolean;
  missingLocation: boolean;
  tooManyLines: boolean;
  valid: boolean;
}

export function validateTransferDraft(draft: TransferDraft): TransferValidation {
  const invalidLines = new Set(draft.lines.filter((line) => !quantityValid(line.quantity)).map((line) => line.variantId));
  const missingLocation = !draft.originId || !draft.destinationId;
  const sameLocation = !missingLocation && draft.originId === draft.destinationId;
  const tooManyLines = draft.lines.length > PURCHASING_MAX_LINES;
  return {
    invalidLines,
    sameLocation,
    missingLocation,
    tooManyLines,
    valid: invalidLines.size === 0 && !sameLocation && !missingLocation && !tooManyLines,
  };
}

export function transferBody(draft: TransferDraft): TransferBody {
  return {
    originLocationId: draft.originId,
    destinationLocationId: draft.destinationId,
    expectedOn: draft.expectedOn || null,
    reference: draft.reference.trim() || null,
    notes: draft.notes.trim() || null,
    lines: draft.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity ?? 0 })),
  };
}

export function transferFingerprint(draft: TransferDraft): string {
  return JSON.stringify(transferBody(draft));
}
