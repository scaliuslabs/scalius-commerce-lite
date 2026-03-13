# Analytics

Manages third-party analytics script configurations (Google Analytics, Meta Pixel, etc.) and provides admin dashboard statistics.

## Exports

- `AnalyticsService` — CRUD for analytics script records (listScripts, createScript, toggleScript, etc.)
- `getDashboardStats()` — aggregated metrics: products, customers, revenue, month-over-month growth
- `getRecentOrders()` — latest N orders for the dashboard feed
- `getDailyActivityData()` — per-day order counts, revenue, and new customers over N days
- `analyticsSchema` — Zod validation schemas for analytics script input

## Dependencies

- `@scalius/database` — `analytics`, `products`, `customers`, `orders` tables

## API Routes

- `GET /api/v1/admin/analytics` — list analytics scripts
- `POST /api/v1/admin/analytics` — create analytics script
- `PUT /api/v1/admin/analytics/:id` — update analytics script
- `DELETE /api/v1/admin/analytics/:id` — delete analytics script
