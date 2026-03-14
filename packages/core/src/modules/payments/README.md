# Payments

Multi-gateway payment processing with a unified `PaymentProvider` interface. Supports Stripe, SSLCommerz, Polar, and Cash on Delivery.

## Provider Interface

```typescript
// provider.ts
export interface PaymentProvider {
  readonly type: PaymentGateway; // "stripe" | "sslcommerz" | "polar" | "cod"
  readonly name: string;
  createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult>;
  createRefund(params: RefundParams): Promise<RefundResult>;
  verifyWebhook?(rawBody: string, headers: Record<string, string>): Promise<WebhookPayload>;
}
```

`CreatePaymentResult` returns either `clientSecret` (Stripe), `redirectUrl` (SSLCommerz/Polar), or neither (COD).

## Adding a New Provider

1. **Define settings type** in `gateway-settings.ts`:
   - Add a `MyGatewaySettings` interface with `enabled: boolean` + credentials
   - Add a `getMyGatewaySettings(db, kv?)` function reading from the `settings` DB table (category = your gateway name)
   - Add a `invalidateMyGatewayCache(kv?)` function
   - Add your gateway to the `PaymentMethodsConfig.enabledMethods` union and the `getActivePaymentMethods()` cross-check loop

2. **Create provider file** `my-gateway.ts`:
   - Export a class implementing `PaymentProvider`
   - Constructor takes your settings type
   - `createPayment` calls the gateway API and returns `{ transactionId, clientSecret?, redirectUrl? }`
   - `createRefund` calls the gateway refund API
   - `verifyWebhook` (optional) verifies signatures and returns `{ eventType, data }`
   - Throw `ServiceUnavailableError` on API failures, `ValidationError` on bad input

3. **Register in factory** (`factory.ts`):
   - Add your type to the `GatewayConfig` discriminated union
   - Add a `case` in `createPaymentProvider()` switch

4. **Register in gateway registry** (`gateway-registry.ts`):
   - Call `registerGateway({ id, name, settingsCategory, getSettings, getPublicConfig?, getCurrencies? })`

5. **Add to types** (`types.ts`):
   - Add your gateway to the `PaymentGateway` union type
   - Add gateway-specific param/result types

6. **Export from barrel** (`index.ts`):
   - Export your provider class, settings, and legacy function wrappers

7. **Handle in refund-service** (`refund-service.ts`):
   - Add an `else if (gateway === "my-gateway")` branch in `processRefund()`

8. **Wire up API routes** in `apps/api/src/routes/` for webhook endpoints

## Configuration

Settings are stored in the `settings` DB table with `category` matching the gateway name (e.g., `"stripe"`, `"sslcommerz"`). Each key/value pair stores one credential field. Settings are cached in KV for 5 minutes (`CACHE_TTL = 300`). Admin saves via `upsertSetting(db, category, key, value)`.

Payment method enablement is a separate category `"payment_methods"` with keys `enabled_methods` (JSON array) and `default_method`.

## Error Handling

Import from `@scalius/core/errors`:
- `ValidationError` -- bad input, missing fields, invalid webhook signatures
- `ServiceUnavailableError` -- gateway API failures, disabled gateways
- `NotFoundError` -- order/payment not found (used in refund-service)
- `ConflictError` -- already refunded

## Key Files

- `provider.ts` -- `PaymentProvider` interface and shared param/result types
- `factory.ts` -- `createPaymentProvider()` factory with exhaustive switch
- `gateway-registry.ts` -- dynamic `GatewayMeta` registry (Map-based)
- `gateway-settings.ts` -- DB settings readers, KV caching, `getActivePaymentMethods()`
- `types.ts` -- `PaymentGateway` union, gateway-specific types
- `stripe.ts` / `sslcommerz.ts` / `polar.ts` / `cod.ts` -- provider implementations
- `process-payment.ts` -- idempotent payment confirmation and inventory transitions
- `refund-service.ts` -- gateway-agnostic refund orchestrator
