# Customers

Customer management and OTP-based storefront authentication with pluggable transports.

## Files

- `index.ts` -- barrel exports (re-exports `customers.service`)
- `customers.service.ts` -- admin CRUD (list, create, update, delete, bulk ops)
- `customers.validation.ts` -- Zod schemas
- `customer-auth.service.ts` -- `sendOtp()`, `verifyOtp()`, session management, rate limiting
- `otp-transport.ts` -- `OtpTransport` interface, Email/SMS/WhatsApp implementations, `getOtpTransport()` factory

## Auth flow

1. `sendOtp()` validates, rate-limits, generates 6-digit code, stores in KV (5 min TTL)
2. Queue consumer delivers via selected transport (email/SMS/WhatsApp)
3. `verifyOtp()` creates KV session (30-day TTL) on success

## Phone normalization

Phone numbers are normalized to E.164 format (e.g., `+8801XXXXXXXXX`) via `normalizePhone()` from `@scalius/shared/customer-utils` before all DB lookups and writes. This prevents duplicate customer records from different phone formats.

## Dependencies

- `@scalius/database` -- `customers`, `customerHistory`
- `@scalius/core/errors` -- `ValidationError`, `ForbiddenError`, `RateLimitError`, `ServiceUnavailableError`
