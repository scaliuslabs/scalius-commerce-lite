# Admin Workflows Audit

## Scope

This audit covers the TanStack Start admin route layer, major admin workflow screens/components, and the auth-adjacent routes that materially affect operator workflows:

- Admin route shell and route wiring in `apps/admin-v2/src/routes/admin*.tsx`
- Major CRUD/status-management screens for products, orders, pages, widgets, settings, customers, and account/team management
- Scanner and invoice routes outside the `/admin` shell
- TanStack Start `beforeLoad`, `loader`, server-function, query, and mutation wiring where it changes workflow behavior

I explicitly used the `tanstack-start` model for judging route conventions, loader/server-function boundaries, cache-prefetch behavior, and where workflow authorization is enforced at the route level versus deferred to backend API failures.

## Operator Workflow Map

- Auth and session entry
  - `/auth/setup` creates the first admin
  - `/auth/login` and `/auth/two-factor` gate dashboard entry
  - `/auth/setup-2fa` exists as a dedicated onboarding route, but is not wired into initial setup completion
- Admin shell
  - `/admin` uses a single TanStack Start `beforeLoad` guard in [apps/admin-v2/src/routes/admin.tsx](/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin.tsx:12)
  - The shell injects a `PermissionProvider`, but child routes generally do not enforce route-specific permission gates
- Catalog workflows
  - Products: `/admin/products`, `/admin/products/new`, `/admin/products/$productId/edit`, `/admin/products/$productId`
  - Categories, attributes, collections, and inventory follow the same list/detail/edit pattern
- Sales workflows
  - Orders list/detail/edit/new at `/admin/orders/**`
  - Bulk actions include delete, restore, export, status change, and bulk shipment
  - Customers, discounts, abandoned checkouts, analytics sit in the same section
- Content workflows
  - Pages list/new/edit/trash at `/admin/pages/**`
  - Widgets list/edit/create/trash at `/admin/widgets/**`
  - Media manager at `/admin/media`
- Settings workflows
  - General settings route is a large tabbed launcher that lazy-loads header/footer/SEO/storefront/email/currency/business/countries/auth/security/scanner/notification builders
  - Checkout settings route is another tabbed launcher for checkout flow, payment, languages, shipping, and delivery locations
  - Delivery providers, fraud checker, notifications, theme, cache, and account each have separate routes
- Special workflows
  - `/scanner` is a standalone mobile scanner app driven by a QR token
  - `/invoice/$orderId` renders printable invoice data outside the `/admin` route tree

## Findings

### 1. High: Admin API accepts password-only sessions for 2FA-enabled users, so 2FA is currently a frontend-only gate

The TanStack Start admin shell correctly redirects a session with `twoFactorVerified === false` to `/auth/two-factor`, but the backend admin API middleware accepts any valid Better Auth session without checking 2FA state. That means a user who has completed password auth but not second-factor verification can still hit `/api/v1/admin/*` directly, including privileged flows such as scanner token minting.

Refs:

- [apps/api/src/middleware/admin-auth.ts:27]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:27 )
- [apps/admin-v2/src/lib/auth.fns.ts:140]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/auth.fns.ts:140 )
- [apps/admin-v2/src/routes/api/scanner-token.tsx:46]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/scanner-token.tsx:46 )

Impact:

- The dashboard UI enforces 2FA, but the actual admin control plane does not
- Any alternate client, replayed request, or manually-crafted request can bypass the intended second-factor gate
- This weakens all downstream workflows, not just auth screens

### 2. High: Scanner tokens are not actually device-bound once used in the real inventory APIs

`/api/scanner-token` implements a cookie-based claim flow using `scanner_sid`, but the scanner app itself performs all real work with only `X-Scanner-Token`. The API middleware then accepts any claimed token from KV and never checks the binding cookie. If the token leaks from the QR URL, copied link, browser history, logs, or screenshots, another device can use it until expiry.

Refs:

- [apps/admin-v2/src/routes/api/scanner-token.tsx:110]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/api/scanner-token.tsx:110 )
- [apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx:140]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx:140 )
- [apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx:204]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx:204 )
- [apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx:278]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/scanner/ScannerApp.tsx:278 )
- [apps/api/src/middleware/admin-auth.ts:62]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:62 )
- [apps/admin-v2/src/components/admin/settings/ScannerTokenGenerator.tsx:41]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/settings/ScannerTokenGenerator.tsx:41 )
- [apps/admin-v2/src/components/admin/settings/ScannerTokenGenerator.tsx:130]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/settings/ScannerTokenGenerator.tsx:130 )

Impact:

- The UI promise that the QR is effectively single-device / one-time is false in practice
- Warehouse inventory mutation becomes a bearer-token workflow with a 6-hour replay window
- The copy-link affordance increases the blast radius of a leaked token

### 3. High: Order invoice access is under-protected because the invoice endpoint is missing from route-permission mapping

The invoice API route exists at `/:id/invoice`, but the RBAC route-permission table covers `/orders/*`, `/status`, `/shipments`, `/items`, `/payments`, and `/cod` without defining `/orders/*/invoice`. The admin API middleware only enforces fine-grained permissions when a route match exists. That means any authenticated admin who has any RBAC grant can reach the invoice endpoint, even without `orders.view`. The standalone TanStack Start invoice route also uses a custom `requireAuth()` guard instead of the admin shell guard.

Refs:

- [packages/core/src/auth/rbac/route-permissions.ts:139]( /Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:139 )
- [packages/core/src/auth/rbac/route-permissions.ts:184]( /Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/auth/rbac/route-permissions.ts:184 )
- [apps/api/src/routes/admin/orders-invoice.ts:74]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/orders-invoice.ts:74 )
- [apps/api/src/middleware/admin-auth.ts:123]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/middleware/admin-auth.ts:123 )
- [apps/admin-v2/src/routes/invoice.$orderId.tsx:18]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/invoice.$orderId.tsx:18 )

Impact:

- Low-privilege admins can access customer/order/business invoice data they should not see
- Because the page is outside `/admin`, this bypass is easier to miss in route reviews
- The loader also collapses all failures into a redirect, which hides the permission defect during manual testing

### 4. High: TanStack Start routes rely on hidden navigation and backend 403s instead of route-level permission guards

The admin shell’s `beforeLoad` only verifies “is authenticated admin with some RBAC.” It does not enforce per-screen permissions. Meanwhile navigation items do carry `requiredPermission`, so the product appears permission-aware in the sidebar while the actual routes remain deep-linkable. Large tabbed settings screens then mount whole builder surfaces without checking permission before rendering the tab set.

Refs:

- [apps/admin-v2/src/routes/admin.tsx:12]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin.tsx:12 )
- [apps/admin-v2/src/lib/auth.fns.ts:110]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/auth.fns.ts:110 )
- [apps/admin-v2/src/components/admin/layout/AdminNav.ts:80]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/layout/AdminNav.ts:80 )
- [apps/admin-v2/src/components/admin/settings/GeneralSettingsPage.tsx:54]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/settings/GeneralSettingsPage.tsx:54 )
- [apps/admin-v2/src/components/admin/settings/CheckoutSettingsPage.tsx:35]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/settings/CheckoutSettingsPage.tsx:35 )
- [apps/admin-v2/src/routes/admin/settings/checkout.tsx:6]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/settings/checkout.tsx:6 )

Impact:

- Unauthorized operators can still deep-link into settings and workflow routes
- Screen behavior depends on individual API calls failing rather than the route refusing entry up front
- This creates brittle UX, inconsistent error states, and weak defense-in-depth around sensitive admin workflows

### 5. High: Account settings replaces the inherited session/permission context with the wrong data

The account settings route does not load the current user profile. Instead it manufactures `userData` with `id: ""`, `email: ""`, and `name: "Admin"`. More importantly, it fetches the RBAC permission catalog from `/rbac/permissions` and installs a fresh `PermissionProvider` around the account screen. That means this route is no longer using the actual session user or the actual grants inherited from the admin shell. The Team/Roles/Profile flows then run against fabricated identity plus a likely over-broad permission set.

Refs:

- [apps/admin-v2/src/routes/admin/settings/account.tsx:23]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/settings/account.tsx:23 )
- [apps/admin-v2/src/lib/api.queries.ts:616]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/api.queries.ts:616 )
- [apps/admin-v2/src/lib/api.functions.ts:1343]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/api.functions.ts:1343 )
- [apps/admin-v2/src/components/admin/AccountSettingsWithPermissions.tsx:22]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/AccountSettingsWithPermissions.tsx:22 )
- [apps/admin-v2/src/components/admin/account-settings/AccountSettingsContainer.tsx:25]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/account-settings/AccountSettingsContainer.tsx:25 )
- [apps/admin-v2/src/components/admin/account-settings/AdminUsersManager.tsx:95]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/account-settings/AdminUsersManager.tsx:95 )
- [apps/admin-v2/src/components/admin/account-settings/AdminUsersManager.tsx:210]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/account-settings/AdminUsersManager.tsx:210 )
- [apps/admin-v2/src/components/admin/account-settings/AdminUsersManager.tsx:259]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/account-settings/AdminUsersManager.tsx:259 )
- [apps/admin-v2/src/components/admin/account-settings/ProfileHeader.tsx:26]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/account-settings/ProfileHeader.tsx:26 )
- [apps/api/src/routes/admin/auth-management.ts:234]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:234 )

Impact:

- Account/profile screens are working off synthetic identity, not actual session state
- Team/Roles affordances can render under the wrong authority because the route swaps in permission metadata instead of current-user grants
- Current user is not labeled correctly in the Team tab, and remove-self protection falls back to backend validation

### 6. High: Several settings save flows are wired to the wrong HTTP method, so operators can edit but not persist

The admin wrappers for allowed countries and both notification-channel save flows use `POST`, while the backend only exposes `PUT` routes. These settings screens can load current values and let operators change them, but the save path is wired to non-existent methods and should fail at the API boundary.

Refs:

- [apps/admin-v2/src/lib/api.functions.ts:1651]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/api.functions.ts:1651 )
- [apps/api/src/routes/admin/settings/site.ts:376]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/site.ts:376 )
- [apps/admin-v2/src/lib/api.functions.ts:1692]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/api.functions.ts:1692 )
- [apps/admin-v2/src/lib/api.functions.ts:1704]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/api.functions.ts:1704 )
- [apps/api/src/routes/admin/settings/notification-channels.ts:38]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/notification-channels.ts:38 )
- [apps/api/src/routes/admin/settings/notification-channels.ts:84]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/settings/notification-channels.ts:84 )
- [apps/admin-v2/src/components/admin/settings/NotificationChannelsBuilder.tsx:162]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/settings/NotificationChannelsBuilder.tsx:162 )

Impact:

- Allowed-country settings appear editable but should not save
- Customer and admin notification channel changes should fail to persist
- These are high-friction operator bugs because they present as normal editable admin surfaces

### 7. Medium-High: Manual order creation can compute the wrong sell price because the loader strips discount metadata

The new-order route only forwards `discountPercentage` for products and strips `discountType` / `discountAmount` plus all variant-level discount fields before handing the catalog to the form. `OrderItemsSection` expects those fields when it calculates line prices, so flat discounts and variant-specific discounts are lost in manual order entry.

Refs:

- [apps/admin-v2/src/routes/admin/orders/new.tsx:45]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/orders/new.tsx:45 )
- [apps/admin-v2/src/components/admin/order-form/OrderItemsSection.tsx:95]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/order-form/OrderItemsSection.tsx:95 )

Impact:

- Admin-created orders can charge the wrong amount
- Flat-discount products and variant-specific discount logic do not round-trip into the manual order workflow
- This is a business-logic bug, not just a UI mismatch

### 8. Medium: New order creation is incomplete for larger catalogs and scales badly

The TanStack Start loader for `/admin/orders/new` fetches only the first 100 products, then performs a detail query for each one to recover variants. The order item picker only searches and paginates inside that preloaded array, so products outside the initial 100 are unreachable from the UI. On larger catalogs, the screen also pays an N+1 cost before the form is usable.

Refs:

- [apps/admin-v2/src/routes/admin/orders/new.tsx:37]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/orders/new.tsx:37 )
- [apps/admin-v2/src/routes/admin/orders/new.tsx:40]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/orders/new.tsx:40 )
- [apps/admin-v2/src/routes/admin/orders/new.tsx:61]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/orders/new.tsx:61 )
- [apps/admin-v2/src/components/admin/order-form/OrderItemsSection.tsx:20]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/order-form/OrderItemsSection.tsx:20 )
- [apps/admin-v2/src/components/admin/order-form/OrderItemsSection.tsx:52]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/order-form/OrderItemsSection.tsx:52 )
- [apps/admin-v2/src/components/admin/order-form/ProductSearch.tsx:34]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/order-form/ProductSearch.tsx:34 )

Impact:

- Operators cannot create manual orders for catalog items outside the first 100 returned products
- The first render cost grows with catalog size
- A route-level loader failure degrades the screen to an empty picker instead of a targeted fallback

### 9. Medium: Bulk shipment UI ignores the dedicated bulk-ship API and performs serial per-order requests

The orders list has a bulk shipment dialog, but the submit handler loops through selected IDs and calls `createOrderShipment()` one order at a time. The backend already exposes `/bulk-ship` for this workflow. The current client design is slower, noisier, harder to recover, and more likely to leave partial state when something fails mid-run.

Refs:

- [apps/admin-v2/src/components/admin/order-list/BulkShipDialog.tsx:32]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/order-list/BulkShipDialog.tsx:32 )
- [apps/admin-v2/src/routes/admin/orders/index.tsx:425]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/orders/index.tsx:425 )
- [apps/api/src/routes/admin/orders.ts:183]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/orders.ts:183 )

Impact:

- Bulk ship latency increases linearly with selection size
- Partial success is normal rather than exceptional
- The frontend duplicates backend orchestration logic instead of using the domain API designed for that workflow

### 10. Medium: Widget trash uses the soft-delete mutation for the per-row “permanent delete” action

In the widget trash screen, both `onDelete` and `onPermanentDelete` call `useDeleteWidget()`. Bulk delete is permanent-aware, but the row-level destructive action is not. That means operators in trash can click a “permanent delete” affordance that just replays the normal delete path instead of the permanent-delete workflow.

Refs:

- [apps/admin-v2/src/routes/admin/widgets/trash.tsx:43]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/widgets/trash.tsx:43 )
- [apps/admin-v2/src/routes/admin/widgets/trash.tsx:58]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/widgets/trash.tsx:58 )
- [apps/admin-v2/src/routes/admin/widgets/trash.tsx:60]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/admin/widgets/trash.tsx:60 )
- [apps/admin-v2/src/lib/api.mutations.ts:1019]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/api.mutations.ts:1019 )
- [apps/admin-v2/src/lib/api.functions.ts:886]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/api.functions.ts:886 )

Impact:

- Per-row destructive behavior in widget trash does not match operator intent
- Bulk and row-level trash workflows disagree on permanence semantics

### 11. Medium: The page form drifts from the backend contract in two operator-visible ways

The page editor still carries both `featuredImage` and `publishedAt` concepts, but neither is wired end to end. `featuredImage` is rendered and selectable in the admin form without a matching API contract to persist it. `publishedAt` still exists in the schema and submit transform, yet the admin UI does not render a date/time field and public page reads ignore it entirely.

Refs:

- [apps/admin-v2/src/lib/form-schemas.ts:57]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/form-schemas.ts:57 )
- [apps/admin-v2/src/components/admin/PageForm.tsx:51]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/PageForm.tsx:51 )
- [apps/admin-v2/src/components/admin/PageForm.tsx:81]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/PageForm.tsx:81 )
- [apps/admin-v2/src/components/admin/PageForm.tsx:178]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/PageForm.tsx:178 )
- [packages/core/src/modules/pages/pages.validation.ts:8]( /Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/pages/pages.validation.ts:8 )
- [packages/core/src/modules/pages/pages.service.ts:107]( /Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/pages/pages.service.ts:107 )
- [packages/core/src/modules/pages/pages.service.ts:123]( /Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/pages/pages.service.ts:123 )

Impact:

- Operators can choose a featured image that is silently discarded on save
- Scheduled publishing is implied by the data model but not supported in the workflow
- The page form communicates capabilities the storefront/backend do not honor

### 12. Medium: Optional email removal is broken in both customer and order forms

Both forms render nullable emails as `""`, but their schemas still expect `z.email().nullable()`. Once an operator clears an existing email, the form state becomes an empty string rather than `null`, so validation rejects the save instead of removing the optional field.

Refs:

- [apps/admin-v2/src/components/admin/CustomerForm.tsx:207]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/CustomerForm.tsx:207 )
- [apps/admin-v2/src/components/admin/order-form/CustomerInfoSection.tsx:132]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/order-form/CustomerInfoSection.tsx:132 )
- [apps/admin-v2/src/lib/form-schemas.ts:87]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/lib/form-schemas.ts:87 )
- [apps/admin-v2/src/components/admin/order-form/types.ts:54]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/order-form/types.ts:54 )

Impact:

- Operators cannot cleanly remove an optional email from a customer or manual order
- This is especially confusing because the field looks optional in the UI

### 13. Medium: Notification settings UI lags behind the backend feature set

The notification-channel screen models only seven customer statuses, but backend defaults and dispatch also support `order_completed` and `order_refunded`. Once the save verb bug is fixed, this UI would still be incomplete and could overwrite stored configuration for statuses it does not render.

Refs:

- [apps/admin-v2/src/components/admin/settings/NotificationChannelsBuilder.tsx:21]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/settings/NotificationChannelsBuilder.tsx:21 )
- [packages/core/src/modules/settings/settings.service.ts:199]( /Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/settings/settings.service.ts:199 )
- [packages/core/src/modules/notifications/notifications.service.ts:134]( /Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/notifications/notifications.service.ts:134 )

Impact:

- Operators cannot configure all supported notification types from the admin UI
- Future successful saves risk flattening backend state back to the UI’s incomplete model

### 14. Low: Manual page slug edits are easy to lose during create

Unlike category and product creation, the page create flow has no `slugEdited` latch. If an operator edits the slug manually and then tweaks the title again, the auto-generated slug silently overwrites the manual value.

Refs:

- [apps/admin-v2/src/components/admin/PageForm.tsx:94]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/PageForm.tsx:94 )

Impact:

- Page URLs can change unexpectedly during creation
- Operators have to discover the overwrite behavior by trial and error

## Risky Flows

- First-admin onboarding says 2FA setup exists, but the setup form signs the new admin in and redirects straight to `/admin` instead of driving `/auth/setup-2fa`
  - Refs: [apps/admin-v2/src/components/auth/SetupForm.tsx:19]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/auth/SetupForm.tsx:19 ), [apps/admin-v2/src/components/auth/SetupForm.tsx:75]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/auth/SetupForm.tsx:75 ), [apps/admin-v2/src/routes/auth/setup-2fa.tsx:5]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/auth/setup-2fa.tsx:5 )
- The post-verify 2FA flow still looks fragile because `mark-verified` depends on `c.get("session")`, and I did not find a corresponding `c.set("session", ...)` producer in the API middleware stack
  - Refs: [apps/api/src/routes/admin/auth-management.ts:393]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:393 ), [apps/api/src/routes/admin/auth-management.ts:486]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/auth-management.ts:486 ), [apps/admin-v2/src/components/auth/TwoFactorForm.tsx:99]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/auth/TwoFactorForm.tsx:99 )
- Invoice loader errors are opaque because all failures redirect to `/admin/orders`
  - Refs: [apps/admin-v2/src/routes/invoice.$orderId.tsx:39]( /Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/routes/invoice.$orderId.tsx:39 )

## Prioritized Follow-Ups

1. Enforce `twoFactorVerified` in `adminAuthMiddleware` for session-cookie auth and for any route that can mint or elevate tokens.
2. Replace scanner bearer-token auth with real device-bound validation in the inventory APIs, or remove the cookie-binding claim language from the product until it is true.
3. Add an explicit `/api/v1/admin/orders/*/invoice` permission mapping and move `/invoice/$orderId` under the same admin permission model as the rest of the dashboard.
4. Add per-route `beforeLoad` permission guards for high-sensitivity TanStack Start routes, especially settings and account/team management screens.
5. Load the actual current user into account settings and thread that identity through the Team tab instead of fabricating `userData`.
6. Fix the settings wrappers that currently `POST` to `PUT`-only endpoints so allowed-country and notification-channel edits can actually persist.
7. Preserve product and variant discount metadata in the `/admin/orders/new` loader, then move that workflow to server-side search/pagination instead of a first-100 preload plus N+1 details.
8. Switch the bulk ship UI to the existing `/bulk-ship` endpoint so the workflow is atomic, faster, and easier to recover.
9. Fix widget trash so the row-level permanent-delete action uses the permanent-delete mutation.
10. Align the page form with the backend contract: either persist `featuredImage` and honor `publishedAt`, or remove those fields from the operator workflow.
11. Normalize optional email clears to `null` in customer/order forms, and expand notification settings to cover the full backend-supported status set before fixing the save path.
