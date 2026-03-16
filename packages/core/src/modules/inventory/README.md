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
- `inventory-transitions.ts` -- inventory state transition helpers
- `types.ts` -- `StockOperationResult`, `ReservationEntry`

## Dependencies

- `@scalius/database` -- `productVariants`, `products`, `inventoryMovements`, `productLowStockAlerts`
