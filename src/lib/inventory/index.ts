// src/lib/inventory/index.ts
// Public API for inventory management module

export { reserveStock, reserveMultiple } from "./reserve";
export { deductStock, deductMultiple } from "./deduct";
export { releaseReservation, releaseMultiple } from "./release";
export { recordMovement } from "./movements";
export { checkAndAlertLowStock } from "./alerts";
export type { StockOperationResult, ReservationEntry } from "./types";
