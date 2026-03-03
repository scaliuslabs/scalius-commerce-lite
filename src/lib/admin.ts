// src/lib/admin.ts
// ⚠️ LEGACY SHIM — All functions have been moved to domain modules.
// This file re-exports everything so existing callers continue to work.
// Do NOT add new code here. Use the appropriate module instead:
//
//   getDashboardStats / getRecentOrders / getDailyActivityData
//     → src/modules/analytics/dashboard.service.ts
//
//   getProducts / getProductDetails / getProductStats / getCategoryStats
//   ProductListItem / ProductWithDetails
//     → src/modules/products/products.service.ts
//
//   getOrders / getOrderDetails
//   OrderListItem / OrderShipmentSummary / OrderDetails
//     → src/modules/orders/orders.service.ts
//
//   getDiscounts
//     → src/modules/marketing/discounts.service.ts

export * from "@/modules/analytics/dashboard.service";
export * from "@/modules/products/products.service";
export * from "@/modules/orders/orders.service";
export * from "@/modules/marketing/discounts.service";
