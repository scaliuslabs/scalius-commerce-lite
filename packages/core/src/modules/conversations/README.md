# Conversations Module

Buyer↔store threads: order threads, store threads, messages, image attachments and support-request cases. Empty until Wave A fills it (see `audit/rewrite-2026-09-23/WAVE-A-DESIGN.md` §4); `orders/order-support-requests.ts` moves here then.

Public entries: `index.ts` and `browser.ts`. The API routers are already mounted: `apps/api/src/routes/customer-auth/conversations.ts`, `routes/storefront-orders/conversation.ts` and `routes/admin/conversations.ts`; the permission and agent-operation rows go in `packages/core/src/auth/rbac/route-permissions/conversations.ts` and `apps/api/src/openapi/operation-registry/{dashboard,storefront}-conversations.ts`.
