// src/lib/inventory/index.ts
// Public API for inventory management module

export {
  reserveStock,
  reserveMultiple,
  reserveStockBatch,
  prepareStockReservationBatch,
  isInventoryReservationConflictError,
  validateStockBatchAvailability,
} from "./reserve";
export type {
  PreparedStockReservationBatch,
  ReserveStockBatchResult,
  StockReservationAvailabilitySubject,
} from "./reserve";
export { deductStock, deductMultiple } from "./deduct";
export { releaseReservation, releaseMultiple, releaseReservedStockBatch } from "./release";
export type { ReleaseReservedStockBatchResult } from "./release";
export { restoreDeductedStock, restoreDeductedMultiple } from "./restore";
export { recordMovement } from "./movements";
export { checkAndAlertLowStock } from "./alerts";
export type { LowStockAlertResult } from "./alerts";
export { releaseExpiredReservations } from "./expiry";
export {
  foldInventoryLedgerV2,
  buildInventoryLedgerV2Edge,
  getActiveReservationGeneration,
  getNextReservationGeneration,
  getReservationGenerationBalances,
  validateInventoryLedgerV2Event,
  InventoryLedgerDiscontinuityError,
} from "./ledger-v2";
export type {
  InventoryCounterState,
  InventoryLedgerPool,
  InventoryLedgerV2Event,
  InventoryLedgerV2EdgeFields,
  ReservationGenerationBalance,
} from "./ledger-v2";
export type { ExpiryResult } from "./expiry";
export {
  validateStockNonNegative,
  validateBackorderLimit,
  validateReservedStockConsistency,
  validatePositiveQuantity,
  validateSignedStockAdjustment,
  validateAbsoluteStockCount,
  calculateFinalPrice,
} from "./validation";
export type { StockOperationResult, ReservationEntry } from "./types";
export * from "./inventory.service";
export * from "./inventory.validation";
export * from "./inventory-operations";
export * from "./inventory-transitions";
export { adjustStock, setStock, lookupByBarcodeOrSku } from "./stock-adjustment";
export type { StockAdjustResult, StockSetResult } from "./stock-adjustment";
