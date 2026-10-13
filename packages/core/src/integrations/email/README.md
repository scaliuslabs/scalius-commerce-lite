# Email

Transactional email goes through the email port (`@scalius/shared/plugins/providers/messaging`). Every sender, built in or an installed app's, implements the same `send`. This document is for contributors and operators. Message content and delivery receipts are in the [notifications README](../../modules/notifications/README.md).

## Providers

| Id | Kind | Needs |
|---|---|---|
| `cloudflare` | Cloudflare Email Service (default) | The Workers `send_email` binding `EMAIL`, and a verified sending domain in the Cloudflare dashboard |
| `resend` | Resend HTTPS API | A Resend API key in the `email` document |
| `mailpit` | Local capture (development only, never a choice) | `LOCAL_MAILPIT_URL` |
| `<plugin id>:<provider id>` | An installed app's email provider | The app is active, approved, runnable and set up |

- The API Worker declares `"send_email": [{ "name": "EMAIL" }]` in `apps/api/wrangler.jsonc`. `apps/api/wrangler.local.jsonc` omits it and sets `LOCAL_MAILPIT_URL` to `http://127.0.0.1:8025`. `pnpm dev` starts or reuses Mailpit there.
- `LOCAL_MAILPIT_URL` must be an `http` loopback origin (`localhost`, `127.0.0.1`, `[::1]`) with no path or credentials. Any other value is ignored.
- Core reaches an app provider only through the `appProviders` lookup in the call context (`apps/api/src/plugins/providers/app-providers.ts`). Without the lookup, or while the app is not ready, it cannot send.

## Selection

`sendEmail(options, context?)` reads the `email` document on every send, then picks the first sender that can send:

1. `LOCAL_MAILPIT_URL` is set: Mailpit only.
2. Saved `provider` is `cloudflare`: Cloudflare, then Resend.
3. Saved `provider` is `resend`: Resend, then Cloudflare.
4. Saved `provider` is an app id: the app, then Cloudflare, then Resend.
5. Nothing saved: Resend when a readable key exists, otherwise Cloudflare.

Cloudflare can send when the binding exists. Resend can send when a readable key exists. If no sender can send, the call logs masked metadata only (never the content) and returns `{ success: false, provider: "log" }`.

The result carries `provider`, `providerRef` and `retryable`. `retryable: false` means the same message can never pass.

## Readiness

`getEmailProviderReadiness(context?)` is the shared check. The admin saves and the customer sign-in preflight use it. Email is ready only when both hold:

- A valid `sender` address is saved (`missing_email_sender`).
- The chosen sender can send: the Mailpit URL in development, the `EMAIL` binding, a key that `CREDENTIAL_ENCRYPTION_KEY` decrypts, or a ready app (`missing_email_provider_credentials`).

## Settings

The `email` settings document (`emailDocument` in `packages/core/src/modules/settings/documents.ts`):

| Field | Meaning |
|---|---|
| `provider` | `cloudflare`, `resend` or an app id. Empty means not chosen (see Selection). |
| `sender` | Default From address (up to 320 characters). The runtime falls back to `noreply@example.com`, and readiness stays not ready. |
| `resendApiKey` | Secret, encrypted at rest. Strict reads use `CREDENTIAL_ENCRYPTION_KEY`. Unreadable ciphertext counts as no key. |

- The sender name is the store name (`fromName`, else Business `companyName`, `legalName` or the Store URL host). It is stripped of quotes, angle brackets and line breaks and cut to 78 characters. Cloudflare and Mailpit take it as a separate field. Resend takes `"Name" <address>`.
- Only `List-Unsubscribe` and `List-Unsubscribe-Post` headers pass through (marketing mail).
- Resend gets `idempotencyKey` as `Idempotency-Key` (first 256 characters). Cloudflare returns a `messageId`.

## Admin routes

| Method and path | Permission |
|---|---|
| `GET /api/v1/admin/settings/email` (provider, masked key, sender, readiness, `revision`) | `settings.general.view` |
| `POST /api/v1/admin/settings/email` (saves `provider`, `sender`, `apiKey` with `expectedRevision`) | `settings.general.edit` |

- A stale `expectedRevision` returns 409.
- An app provider id must name an installed app's provider.
- A masked key value is ignored. An empty key clears the key. A new key needs `CREDENTIAL_ENCRYPTION_KEY` (503 without it).
- If customer sign-in uses email codes, the save is refused when it would leave email not ready.
- A save clears the email provider pause markers in the same batch.

## Call context

Callers inside Workers pass `{ db, env, encryptionKey, appProviders }` as the second argument (`requestAppProviders(c)`, or `detachedAppProviders(env, db, key)` in background work). The context gives the selector the `env.EMAIL` binding, the database for settings and the credential key.

## Adding a provider

1. Write an `EmailAdapter` with `configured()` and `send()`.
2. Add its id to `BUILT_IN_EMAIL_PROVIDER_IDS` in `provider.ts`, and the adapter to `BUILT_IN_EMAIL_ADAPTERS` in `index.ts`. Or ship it as an app provider instead.
3. Extend `emailDocument` and the settings route only if it needs credentials.
