# Customers

Customer management (admin CRUD) and customer authentication (OTP-based login for the storefront).

## Exports

- `listCustomers()` / `createCustomer()` / `updateCustomer()` / `deleteCustomer()` — admin CRUD
- `getCustomerById()` / `bulkDeleteCustomers()` / `restoreCustomer()` — lookup and bulk ops
- `sendOtp()` / `verifyOtp()` — OTP-based customer auth with rate limiting
- `getCustomerBySession()` / `deleteCustomerSession()` — KV session management
- `updateCustomerProfile()` — update customer record and refresh session
- `createCustomerSchema` / `updateCustomerSchema` — Zod validation

## Dependencies

- `@scalius/database` — `customers`, `customerHistory`, `deliveryLocations`, `siteSettings` tables
- Cloudflare KV — OTP storage and session management
- `@scalius/core/search` — FTS5 full-text search

## API Routes

- `GET /api/v1/customers` — list customers (admin)
- `POST /api/v1/customers` — create customer (admin)
- `POST /api/v1/customer-auth/send-otp` — send OTP to customer
- `POST /api/v1/customer-auth/verify-otp` — verify OTP and create session
- `GET /api/v1/customer-auth/me` — get current customer session
