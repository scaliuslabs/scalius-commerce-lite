# Customers

Customer management and OTP-based storefront authentication. OTP delivery is abstracted via `OtpTransport` providers.

## OTP Transport Interface

```typescript
// otp-transport.ts
export interface OtpTransport {
  readonly method: "email" | "phone";
  readonly label: string;
  buildQueuePayload(code: string, identifier: string, name: string, settings: SiteSettings): OtpQueuePayload;
  validateConfig(settings: SiteSettings): string | null;
}
```

Transports build queue payloads; actual delivery happens asynchronously via the queue consumer in `apps/api/src/queue-consumer.ts`.

## Adding a New OTP Transport

1. **Create transport class** in `otp-transport.ts`:
   - Implement `OtpTransport` with `method` set to `"email"` or `"phone"`
   - `buildQueuePayload()` returns an `OtpQueuePayload` with `type: "auth.send_otp"`, the appropriate `method`, and `allowedMethod` for routing
   - `validateConfig()` checks `SiteSettings` for required credentials; return error string or `null`

2. **Instantiate and register** in the transport registry at the bottom of `otp-transport.ts`:
   ```typescript
   const myTransport = new MyOtpTransport();
   ```

3. **Update `getOtpTransport()` factory** in `otp-transport.ts`:
   - Add routing logic based on `method` and `allowedMethod` to return your transport

4. **Update queue consumer** in `apps/api/src/queue-consumer.ts`:
   - Add a handler for your transport's `allowedMethod` value to actually send the OTP (e.g., call an SMS API)

5. **Update `getAllowedInternalMethods()`** in `customer-auth.service.ts` if your transport introduces a new `authVerificationMethod` value

## Authentication Flow

1. Customer calls `sendOtp()` with `method` ("email"/"phone") + identifier
2. Service validates input, checks rate limits (5 req/10min per IP, 2min cooldown per identifier)
3. Generates 6-digit OTP, stores in KV (`cust_otp:{identifier}`, TTL 5 min, max 5 attempts)
4. Resolves transport via `getOtpTransport()`, builds queue payload
5. Route handler sends payload to `AUTH_OTP_QUEUE`
6. Queue consumer dispatches to the correct delivery channel
7. Customer calls `verifyOtp()` with code; on success, a KV session is created (30-day TTL)

## Configuration

- OTP method is controlled by `site_settings.authVerificationMethod`: `"email"`, `"phone"`, `"whatsapp_otp"`, `"sms_otp"`, or `"both"`
- WhatsApp requires `whatsappAccessToken` and `whatsappPhoneNumberId` in `site_settings`
- Sessions stored in KV with prefix `cust_session:`, OTPs with prefix `cust_otp:`

## Error Handling

Import from `@scalius/core/errors`:
- `ValidationError` -- bad identifier format, expired/wrong OTP
- `ForbiddenError` -- requested method disabled by admin
- `RateLimitError` -- IP or identifier rate limit exceeded (includes `retryAfter`)
- `ServiceUnavailableError` -- transport misconfigured

## Key Files

- `otp-transport.ts` -- `OtpTransport` interface, Email/SMS/WhatsApp implementations, `getOtpTransport()` factory
- `customer-auth.service.ts` -- `sendOtp()`, `verifyOtp()`, session management, rate limiting
- `customers.service.ts` -- admin CRUD operations
- `customers.validation.ts` -- Zod schemas
