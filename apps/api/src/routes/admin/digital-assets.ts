// Dashboard digital-goods routes (admin catalog family): assets, multipart
// uploads and licence-key pools mounted at /admin/digital-assets, creating an
// asset on a product (POST /admin/products/{id}/digital-assets) mounted at
// /admin/products after the product router, and entitlement reset/revoke
// mounted at /admin/digital-entitlements. Empty until
// B3 (Wave B design §7.2); permissions live in
// packages/core/src/auth/rbac/route-permissions/digital.ts.
import { OpenAPIHono } from "@hono/zod-openapi";

export const adminDigitalAssetRoutes = new OpenAPIHono<{ Bindings: Env }>();
export const adminProductDigitalAssetRoutes = new OpenAPIHono<{ Bindings: Env }>();
export const adminDigitalEntitlementRoutes = new OpenAPIHono<{ Bindings: Env }>();
