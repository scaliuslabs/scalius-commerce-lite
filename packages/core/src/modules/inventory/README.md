# Inventory

Stock management with reservation-based concurrency control. Handles stock reservations at checkout, deductions on payment, and releases on cancellation.

## Exports

- `reserveStock()` / `reserveMultiple()` — reserve stock for an order (optimistic locking via version column)
- `deductStock()` / `deductMultiple()` — permanently deduct reserved stock
- `releaseReservation()` / `releaseMultiple()` — release reserved stock back to available
- `recordMovement()` — log inventory movement audit trail
- `checkAndAlertLowStock()` — create low-stock alerts when thresholds are crossed
- `InventoryService.getInventoryOverview()` — paginated view of variants, movements, or alerts
- `InventoryService.adjustInventory()` — manual stock adjustment with audit logging

## Dependencies

- `@scalius/database` — `productVariants`, `products`, `inventoryMovements`, `productLowStockAlerts` tables

## API Routes

- `GET /api/v1/admin/inventory` — inventory overview (variants/movements/alerts)
- `POST /api/v1/admin/inventory/:variantId/adjust` — manual stock adjustment
