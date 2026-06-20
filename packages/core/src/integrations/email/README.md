# Email

Transactional email abstraction with a small provider registry and runtime settings from the `settings` table.

## Providers

Built-in providers:

- `cloudflare` -- default Cloudflare Email Service provider using the Workers `send_email` binding named `EMAIL`.
- `resend` -- optional HTTP fallback using a dashboard-saved Resend API key.

Every email path calls `sendEmail(options, context?)`. The selector reads `email_provider` from DB settings and tries providers in this order:

- Saved provider is `cloudflare`: Cloudflare binding first, then Resend if a key exists.
- Saved provider is `resend`: Resend first, then Cloudflare if the binding exists.
- No saved provider: existing Resend keys preserve legacy behavior; otherwise Cloudflare is preferred.
- No configured provider: logs masked metadata only, returns a non-delivered result, and does not leak OTPs, reset links, or invite secrets to logs.

Cloudflare Email Service is the native/default option. Do not add another paid/external email provider without keeping Cloudflare available in API, runtime, UI, and docs.

`getEmailProviderReadiness(context?)` is the shared readiness check for admin policy saves and customer OTP send-time preflights. Email OTP is ready only when a valid `email_sender` is saved and either the Cloudflare `EMAIL` binding is present or a Resend key decrypts with `CREDENTIAL_ENCRYPTION_KEY`. An unreadable Resend key is not considered configured, but Cloudflare remains a valid native fallback when the binding exists.

## Settings

Category `email` keys:

- `email_provider` -- `cloudflare` or `resend`.
- `email_sender` -- default From address, falling back to `noreply@example.com` at runtime.
- `resend_api_key` -- encrypted Resend key. Runtime reads use strict credential resolution with the dedicated `CREDENTIAL_ENCRYPTION_KEY`; unreadable ciphertext returns `hasResendApiKey=false` instead of falling through to Resend with ciphertext. Writes of real keys must require `CREDENTIAL_ENCRYPTION_KEY`.

Admin API:

- `GET /api/v1/admin/settings/email` returns provider, masked Resend key status, sender, Cloudflare binding status, and Email OTP readiness.
- `POST /api/v1/admin/settings/email` saves provider/sender, skips masked keys, encrypts new Resend keys, and allows blank key clearing.

## Runtime Context

Callers that run inside Workers must pass context:

```typescript
await sendEmail(message, {
  db,
  env,
  encryptionKey,
});
```

The context lets the selector detect `env.EMAIL`, read DB settings without relying on global singleton initialization, and decrypt provider credentials with the dedicated credential key. Queue consumers, Better Auth callbacks, order notifications, and admin invitations all pass this context.

## Cloudflare Binding

The API and admin Workers declare:

```jsonc
"send_email": [{ "name": "EMAIL" }]
```

Cloudflare Email Service requires domain onboarding in the Cloudflare dashboard before arbitrary production sends. Local API config intentionally does not declare the binding; local development logs emails unless a provider is explicitly configured.

## Key Files

- `provider.ts` -- provider interfaces, runtime context types, and registry.
- `settings.ts` -- DB/runtime settings loader and Resend credential decryption.
- `cloudflare.ts` -- Workers `EMAIL.send()` provider.
- `resend.ts` -- Resend HTTP provider.
- `index.ts` -- provider registration, selection/fallback logic, and convenience templates.

## Adding a Provider

1. Add a provider implementing `EmailProvider`.
2. Register it in `index.ts`.
3. Extend `EmailRuntimeSettings` and admin settings only if it needs runtime configuration.
4. Keep Cloudflare Email Service as a first-class/default option.
5. Add focused provider-selection tests before shipping.
