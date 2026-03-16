# Payments

Multi-gateway payment processing with unified provider interface and gateway registry.

## Files

- `provider.ts` -- `PaymentProvider` interface, `CreatePaymentParams`, `CreatePaymentResult`, `RefundParams`, `RefundResult`, `WebhookPayload`
- `factory.ts` -- `createPaymentProvider()`, `GatewayConfig`
- `gateway-registry.ts` -- `registerGateway()`, `getRegisteredGateways()`, `getGatewayMeta()`, `GatewayMeta`
- `gateway-settings.ts` -- `getStripeSettings()`, `getSSLCommerzSettings()`, `getPolarSettings()`, `getActivePaymentMethods()`, `upsertSetting()`, cache invalidation helpers
- `types.ts` -- `PaymentGateway` union, gateway-specific param/result types
- `stripe.ts` -- `StripeProvider`, legacy wrappers (createPaymentIntent, capturePaymentIntent, etc.)
- `sslcommerz.ts` -- `SSLCommerzProvider`, legacy wrappers
- `polar.ts` -- `PolarProvider`, legacy wrappers
- `cod.ts` -- `CODProvider`, legacy wrappers (initCODTracking, recordCODCollection, etc.)
- `process-payment.ts` -- `processPaymentConfirmed()` (idempotent, checks duplicate first), `processPaymentFailed()`, `releaseOrderInventory()`, `recordWebhookEvent()`
- `refund-service.ts` -- `processRefund()`, `processReturn()`

## Key patterns

- `processPaymentConfirmed()` is idempotent: checks for duplicate payment before processing
- State machine validation before status transitions
- Gateway registry for dynamic provider discovery
- Settings cached in KV (5 min TTL)
- Refund validation: amount must be positive, cannot exceed `paidAmount`, and cumulative refunds (existing + new) cannot exceed `paidAmount`. Partial refunds do NOT restore inventory — admin must manually adjust stock after a physical return.

## Dependencies

- `@scalius/database` -- `orders`, `orderItems`, `payments`, `settings`
- `@scalius/core/errors` -- `ValidationError`, `ServiceUnavailableError`, `NotFoundError`, `ConflictError`
