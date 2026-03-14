# Email

Email delivery abstraction with a provider registry. Ships with Resend; extensible for SendGrid, Mailgun, etc.

## Provider Interface

```typescript
// provider.ts
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
   See `resend.ts` for the reference implementation. It reads `resend_api_key` and `email_sender` from the `settings` table (category `"email"`) via dynamic imports to avoid circular deps.

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

## Configuration

Credentials are stored in the `settings` DB table with `category = "email"`:
- `resend_api_key` -- Resend API key
- `email_sender` -- default sender address (falls back to `noreply@example.com`)

New providers should follow this pattern: read credentials from the `settings` table using the same `"email"` category with provider-prefixed key names (e.g., `sendgrid_api_key`).

When no API key is configured, `ResendEmailProvider` falls back to console logging for development.

## Convenience Functions

`index.ts` exports pre-built email senders that use the active provider:
- `sendEmail(options)` -- generic send
- `sendVerificationEmail(email, name, url)` -- email verification
- `sendPasswordResetEmail(email, name, url)` -- password reset
- `sendAdminInviteEmail(email, inviterName, tempPassword, loginUrl)` -- admin invitation

## Key Files

- `provider.ts` -- `EmailProvider` interface, registry (`registerEmailProvider`, `getEmailProvider`, `setActiveEmailProvider`)
- `resend.ts` -- `ResendEmailProvider` implementation (reads settings from DB, calls Resend API)
- `index.ts` -- barrel exports, provider registration at load time, convenience email functions
