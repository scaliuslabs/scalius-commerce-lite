# Inventory

Stock management with reservation-based concurrency control, batch operations, validation, and expiry.

## Files

- `index.ts` -- barrel exports
- `reserve.ts` -- `reserveStock()`, `reserveMultiple()`, `reserveStockBatch()`
- `deduct.ts` -- `deductStock()`, `deductMultiple()`
- `release.ts` -- `releaseReservation()`, `releaseMultiple()`
- `expiry.ts` -- `releaseExpiredReservations()` (cron), `ExpiryResult`
- `validation.ts` -- `validateStockNonNegative()`, `validateBackorderLimit()`, `validateReservedStockConsistency()`, `validatePositiveQuantity()`, `calculateFinalPrice()`
- `stock-adjustment.ts` -- `adjustStock()`, `setStock()`, `lookupByBarcodeOrSku()`
- `movements.ts` -- `recordMovement()` audit trail
- `alerts.ts` -- `checkAndAlertLowStock()`, `LowStockAlertResult`
- `inventory.service.ts` -- `InventoryService` (getInventoryOverview, adjustInventory)
- `inventory.schema.ts` -- Zod validation schemas
- `inventory-transitions.ts` -- `buildInventoryStatements()` returns SQL statements for batching into caller's `db.batch()`, `applyInventoryForStatusChange()` wraps it for standalone use
- `types.ts` -- `StockOperationResult`, `ReservationEntry`

## Schema notes

- `stockVersion` column on `productVariants` — separate optimistic locking counter for stock operations, independent from the general `version` column used for non-stock updates like price changes

## Dependencies

- `@scalius/database` -- `productVariants`, `products`, `inventoryMovements`, `productLowStockAlerts`
