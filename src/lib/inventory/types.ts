// src/lib/inventory/types.ts

export interface StockOperationResult {
  success: boolean;
  variantId: string;
  previousStock: number;
  newStock: number;
  error?: string;
}

export interface ReservationEntry {
  variantId: string;
  quantity: number;
  pool?: "regular" | "preorder" | "backorder";
}

export interface MovementEntry {
  variantId: string;
  orderId?: string;
  type:
    | "reserved"
    | "deducted"
    | "released"
    | "adjusted"
    | "preorder_reserved"
    | "preorder_deducted";
  quantity: number;
  previousStock: number;
  newStock: number;
  notes?: string;
  createdBy?: string;
}
