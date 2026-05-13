// src/lib/inventory/index.ts
// Public API for inventory management module

export { reserveStock, reserveMultiple, reserveStockBatch, validateStockBatchAvailability } from "./reserve";
export { deductStock, deductMultiple } from "./deduct";
export { releaseReservation, releaseMultiple } from "./release";
export { restoreDeductedStock, restoreDeductedMultiple } from "./restore";
export { recordMovement } from "./movements";
export { checkAndAlertLowStock } from "./alerts";
export type { LowStockAlertResult } from "./alerts";
export { releaseExpiredReservations } from "./expiry";
export type { ExpiryResult } from "./expiry";
export {
  validateStockNonNegative,
  validateBackorderLimit,
  validateReservedStockConsistency,
  validatePositiveQuantity,
  calculateFinalPrice,
} from "./validation";
export type { StockOperationResult, ReservationEntry } from "./types";
export * from "./inventory.service";
export * from "./inventory.validation";
export * from "./inventory-transitions";
export { adjustStock, setStock, lookupByBarcodeOrSku } from "./stock-adjustment";
export type { StockAdjustResult, StockSetResult } from "./stock-adjustment";
