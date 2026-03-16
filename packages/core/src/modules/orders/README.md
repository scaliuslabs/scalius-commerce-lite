# Orders

Full order lifecycle with state machine validation, optimistic locking, batch writes, and notification returns.

## Files

- `index.ts` -- barrel exports
- `orders.service.ts` -- `getOrders()`, `getOrderDetails()`, `createOrder()`, `updateOrder()`, `updateOrderStatus()`, `deleteOrder()`, `restoreOrder()`, `permanentlyDeleteOrder()`, `bulkDeleteOrders()`, `bulkShipOrders()`, `processCodAction()`, `getOrderShipments()`, `createFulfillmentShipment()`, `createStorefrontOrder()`
- `orders.validation.ts` -- `CreateOrderInput`, `UpdateOrderData`, Zod schemas
- `order-state-machine.ts` -- `canTransitionTo()`, `validateTransition()`, `getAvailableTransitions()` for order/payment/fulfillment dimensions
- `orders.queue.ts` -- `handleOrderIngestBatch()`, `setCheckoutStatus()`

## Key patterns

- `db.batch()` for atomic multi-table writes (order + items + inventory)
- Optimistic locking via `version` column on orders table
- `updateOrderStatus()` returns `StatusUpdateResult` with notification data
- State machine enforces valid transitions; throws `ValidationError` on illegal moves

## Dependencies

- `@scalius/database` -- `orders`, `orderItems`, `customers`, `customerHistory`, `products`, `productVariants`, `deliveryShipments`
- `inventory` module -- reservation, deduction, release
- `payments` module -- COD collection/return
- `delivery` module -- shipment creation
- `@scalius/core/search` -- FTS5
