# Analytics

Third-party analytics script management and admin dashboard statistics.

## Files

- `index.ts` -- barrel exports
- `analytics.service.ts` -- `AnalyticsService` (listScripts, createScript, toggleScript, etc.)
- `dashboard.service.ts` -- `getDashboardStats()`, `getRecentOrders()`, `getDailyActivityData()`
- `analytics.schema.ts` -- Zod validation schemas

## Dependencies

- `@scalius/database` -- `analytics`, `products`, `customers`, `orders`
