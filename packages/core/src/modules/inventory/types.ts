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

