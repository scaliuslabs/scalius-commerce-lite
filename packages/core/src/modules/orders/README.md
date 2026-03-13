# Orders

Full order lifecycle: creation, status transitions, fulfillment, payments, and delivery integration.

## Exports

- `listOrders()` — paginated, searchable order list with customer and shipment data
- `getOrderById()` — full order detail with items, variants, images, shipments, and payments
- `createOrder()` — create order with customer lookup/creation, inventory reservation, and discount application
- `updateOrderStatus()` — status transitions with inventory side-effects and email notifications
- `updateFulfillmentStatus()` / `updateItemFulfillmentStatus()` — item-level fulfillment tracking
- `deleteOrder()` / `bulkDeleteOrders()` / `restoreOrders()` — soft/permanent delete and restore
- `OrderListItem` / `CreateOrderInput` — TypeScript types and Zod validation

## Dependencies

- `@scalius/database` — `orders`, `orderItems`, `customers`, `customerHistory`, `products`, `productVariants`, `deliveryShipments` tables
- `inventory` module — stock reservation, deduction, and release
- `payments` module — COD collection/return
- `delivery` module — shipment creation and tracking
- `@scalius/core/search` — FTS5 full-text search

## API Routes

- `GET /api/v1/orders` — list orders (admin)
- `GET /api/v1/orders/:id` — get order detail
- `POST /api/v1/orders` — create order
- `PUT /api/v1/orders/:id/status` — update order status
