# Email

Email delivery abstraction with a provider registry. Ships with Resend; extensible for SendGrid, Mailgun, etc.

## Connection Status

| Caller | Connected |
|--------|-----------|
| Order notification emails (queue consumer) | Yes |
| OTP login codes (queue consumer) | Yes |
| Email verification (Better Auth) | Yes |
| Password reset (Better Auth) | Yes |
| Admin invitation | Yes |

All callers use the `sendEmail()` convenience function from `index.ts`, which delegates to the active provider. When no Resend API key is configured, emails are logged to the console (development fallback).

## Provider: Resend

The only built-in provider. Calls the Resend HTTP API directly via `fetch("https://api.resend.com/emails")`.

Credentials are read from the `settings` DB table on every send (no caching):
- `resend_api_key` (category `email`) -- Resend API key
- `email_sender` (category `email`) -- Default sender address (falls back to `noreply@example.com`)

The `getEmailSettings()` function uses dynamic imports (`await import("@scalius/database/client")`) to avoid circular dependencies and enable tree-shaking.

### Admin Settings UI

Configured via the integrations settings page:
- `GET /api/v1/admin/settings/email` -- Returns masked API key status and sender address
- `POST /api/v1/admin/settings/email` -- Saves API key and/or sender to `settings` table

## Provider Interface

```typescript
export interface EmailProvider {
  readonly name: string;
  sendEmail(options: SendEmailOptions): Promise<void>;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  text?: string;
}
```

## Adding a New Provider

1. **Create provider file** `my-provider.ts`:
   ```typescript
   import type { EmailProvider, SendEmailOptions } from "./provider";

   export class MyEmailProvider implements EmailProvider {
     readonly name = "my-provider";

     async sendEmail({ to, subject, html, from, text }: SendEmailOptions): Promise<void> {
       // Read credentials from DB settings table (category "email")
       // Call your email API
       // Throw Error on failure
     }
   }
   ```
   See `resend.ts` for the reference implementation.

2. **Register in `index.ts`**:
   ```typescript
   import { registerEmailProvider } from "./provider";
   import { MyEmailProvider } from "./my-provider";
   registerEmailProvider("my-provider", new MyEmailProvider());
   ```

3. **Set as active** (optional): Call `setActiveEmailProvider("my-provider")` to make it the default. The active provider name defaults to `"resend"`.

4. **No other code changes needed.** The `sendEmail()` convenience function in `index.ts` uses `getEmailProvider()` which returns the active provider. All callers throughout the codebase use this function.

## Registry Pattern

- `providers` is a module-level `Map<string, EmailProvider>`
- `registerEmailProvider(name, provider)` adds a provider
- `getEmailProvider(name?)` retrieves by name, defaults to `activeProviderName`
- `setActiveEmailProvider(name)` changes the default
- Resend is registered at module load in `index.ts`

## Convenience Functions

`index.ts` exports pre-built email senders that use the active provider:
- `sendEmail(options)` -- generic send (used by queue consumer for OTP and order notifications)
- `sendVerificationEmail(email, name, url)` -- email verification with 24-hour expiry
- `sendPasswordResetEmail(email, name, url)` -- password reset with 1-hour expiry
- `sendAdminInviteEmail(email, inviterName, tempPassword, loginUrl)` -- admin invitation with temp credentials

All functions use inline HTML templates with basic responsive styling. No template engine.

## Key Files

- `provider.ts` -- `EmailProvider` interface, registry (`registerEmailProvider`, `getEmailProvider`, `setActiveEmailProvider`)
- `resend.ts` -- `ResendEmailProvider` implementation (reads settings from DB per-send, calls Resend API, console fallback)
- `index.ts` -- barrel exports, provider registration at load time, convenience email functions
