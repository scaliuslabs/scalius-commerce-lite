// Inventory domain public API: reservations, deductions, releases, the ledger,
// low-stock alerts and the stock-adjustment services.

export {
  reserveStockBatch,
  prepareStockReservationBatch,
  selectReservationVariantStates,
  isInventoryReservationConflictError,
} from "./reserve";
export type {
  PreparedStockReservationBatch,
  ReservationVariantState,
  ReserveStockBatchResult,
} from "./reserve";
export {
  prepareReservedStockReleaseBatch,
  isPreparedReservedStockReleaseConflictError,
} from "./release";
export type {
  PreparedReservedStockReleaseBatch,
  ReleaseReservedStockBatchResult,
} from "./release";
export { checkAndAlertLowStock, setLowStockThreshold } from "./alerts";
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
  validatePositiveQuantity,
  validateSignedStockAdjustment,
  validateAbsoluteStockCount,
} from "./validation";
export type { StockOperationResult, ReservationEntry } from "./types";
export * from "./inventory.service";
export * from "./inventory.validation";
export * from "./inventory-operations";
export * from "./inventory-transitions";
export { adjustStock, setStock, lookupByBarcodeOrSku } from "./stock-adjustment";
export type { StockAdjustResult, StockSetResult } from "./stock-adjustment";
export * from "./inventory-label-artifacts";
export * from "./inventory-movement-artifacts";
export { acknowledgeLowStockAlert, setDefaultLowStockThreshold } from "./alerts";
export { buildStockMovementClaim } from "./stock-movement-claims";
export type { StockMovementClaimType } from "./stock-movement-claims";
export * from "./stock-commands";
export * from "./unit-costs";
export * from "./suppliers";
export * from "./purchase-orders";
export * from "./transfers";
export * from "./inventory-insights";
export * from "./locations";
export * from "./cost-visibility";
