// Fulfilment domain: the real actions that hand an order's units over —
// own-courier parcels, courier bookings and their reconciliation, bulk
// shipping, and delivery outcomes (delivered, COD collected/failed/returned).
// Order status changes go through the orders lifecycle kernel.
export * from "./shipments";
export * from "./reconcile";
export * from "./bulk";
export * from "./delivery-outcomes";
export * from "./registry";
export * from "./ledger";
export * from "./pickup";
export * from "./auto-fulfil";
