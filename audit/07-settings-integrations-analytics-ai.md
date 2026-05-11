# Audit 07: Settings, Integrations, Analytics, AI

## Scope

Owned surface:

- `packages/core/src/modules/settings/**`
- `packages/core/src/modules/analytics/**`
- `packages/core/src/modules/ai/**`
- provider registries and provider abstractions for payment/email/sms/delivery
- `packages/core/src/integrations/**` relevant to email, SMS, Firebase, Meta, storage, analytics
- admin/API settings touchpoints only where needed to verify persistence and runtime consumption

This audit focused on:

- configuration storage patterns across `site_settings`, `settings`, `meta_conversions_settings`, and delivery-provider tables
- provider selection and registry behavior
- secret/encryption flows and whether runtime consumers actually decrypt what admin settings encrypt
- analytics and Meta Conversions runtime behavior
- OpenRouter/AI prompt configuration and runtime dependencies
- cross-cutting architecture complexity that can cause drift or silent breakage

## How This Layer Works

### Storage model

- `packages/database/src/schema/system.ts:10-58` defines two main config stores:
  - `settings`: generic `(category, key, value, type)` KV rows
  - `site_settings`: singleton row for typed site/auth/checkout/WhatsApp fields
- `packages/database/src/schema/marketing.ts:111-141` adds a second singleton config table for Meta CAPI plus its logs.
- Delivery providers bypass both and store credentials/config JSON directly in `delivery_providers`, then decrypt at instantiation time.

### Runtime flows

- Storefront layout/homepage reads settings directly from DB in `packages/core/src/modules/storefront/storefront.service.ts:70-179` and `:188-355`.
- Checkout assembles currency, auth mode, countries, and enabled gateways in `packages/core/src/modules/settings/checkout-config.service.ts:30-117`.
- Admin settings routes persist configuration in:
  - `apps/api/src/routes/admin/settings/site.ts`
  - `apps/api/src/routes/admin/settings/system.ts`
  - `apps/api/src/routes/admin/settings/payments.ts`
  - `apps/api/src/routes/admin/settings/sms.ts`
  - `apps/api/src/routes/admin/settings/integrations.ts`
  - `apps/api/src/routes/admin/settings/meta-conversions-admin.ts`
  - `apps/api/src/routes/admin/settings/delivery-providers.ts`
- Auth, order notifications, OTP delivery, push, and storefront rendering then consume those settings through a mix of legacy integrations and newer provider abstractions.

### Secret handling today

- Payment and SMS settings mostly follow the same AES-GCM helper path via `packages/core/src/utils/credential-encryption.ts:7-67`.
- Payment secrets are written/read through `packages/core/src/modules/payments/gateway-settings.ts:224-257` and `:89-218`.
- SMS secrets are written/read through `packages/core/src/integrations/sms/sms-settings.ts:103-199` and `:212-292`.
- Delivery encrypts its whole credentials blob in `packages/core/src/modules/delivery/delivery.service.ts:72-75` and decrypts in `packages/core/src/modules/delivery/factory.ts:31-35`.
- Email, Firebase, WhatsApp, and Meta do not consistently use the same secret path, which is the root of several bugs below.

### Provider architecture today

- Payments use two live abstractions:
  - checkout discovery via `packages/core/src/modules/payments/gateway-registry.ts:7-27`
  - runtime provider interface/factory via `packages/core/src/modules/payments/provider.ts:16-105`
- Email and SMS still run on the older `integrations/*` registries:
  - `packages/core/src/integrations/email/provider.ts:22-43`
  - `packages/core/src/integrations/sms/provider.ts:29-58`
- A newer universal provider registry exists in `packages/core/src/providers/registry.ts:1-170`, but only Stripe and Resend adapters are registered:
  - `packages/core/src/providers/payment/stripe-adapter.ts:104-114`
  - `packages/core/src/providers/email/resend-adapter.ts:119-129`
- Delivery remains table-driven with a switch-based factory in `packages/core/src/modules/delivery/factory.ts:21-79`.

## Findings

### P1. Encrypted Resend keys break the active email pipeline

The admin save path encrypts `email.resend_api_key`, but the live email sender still uses the legacy integration that reads the raw DB value and sends it directly as the Resend bearer token.

Why this matters:

- verification emails, password resets, admin 2FA emails, OTP emails, and order emails all route through the legacy `sendEmail()` path
- if `CREDENTIAL_ENCRYPTION_KEY` or `JWT_SECRET` is present, the stored API key becomes ciphertext and outbound email starts failing

Evidence:

- `apps/api/src/routes/admin/settings/system.ts:241-243` encrypts `resend_api_key`
- `apps/api/src/utils/encryption-key.ts:1-8` makes encryption likely by falling back to `JWT_SECRET`
- `packages/core/src/integrations/email/index.ts:15-18` registers the legacy `ResendEmailProvider`
- `packages/core/src/integrations/email/resend.ts:17-45` reads raw `settings` rows with no decrypt step
- `packages/core/src/integrations/email/resend.ts:65-68` uses that raw value as `Authorization: Bearer ...`
- consumers include `packages/core/src/auth/auth.ts:53-56`, `:81-84`, `:163-166` and `packages/core/src/modules/notifications/notifications.service.ts:203-219`

Impact:

- production email delivery can silently fail immediately after a normal admin settings save
- auth and recovery flows are directly affected, not just low-priority notifications

### P1. OpenRouter settings are encrypted on save but consumed as ciphertext at runtime

The admin settings route stores `openrouter_api_key` through the encrypted setting helper, but the actual generation endpoints read it raw from `settings` and never decrypt it. They also query only by `key`, not by `(key, category)`.

Why this matters:

- AI generation can break in environments where encryption is enabled
- the runtime path is inconsistent with the admin settings path and with the rest of the payment/SMS secret flow

Evidence:

- `apps/api/src/routes/admin/settings/integrations.ts:61-64` saves the key via `upsertEncryptedSetting(...)`
- `apps/api/src/routes/admin/openrouter.ts:102-111` reads `openrouter_api_key` directly from `settings.value` with no decrypt step
- `apps/api/src/routes/admin/openrouter.ts:243-251` repeats the same issue in staged generation
- `apps/api/src/routes/admin/openrouter.ts:105` and `:246` filter only on `settings.key`, not `settings.category`

Impact:

- the widget/page AI tools can fail after a valid admin save
- the runtime secret contract is currently "encrypted at rest only if the consumer remembers to decrypt", which is brittle and already broken here

### P1. Editing delivery providers can re-encrypt or replace existing secrets with unusable values

The delivery-provider update route tries to merge masked form fields back into the stored credentials, but it is doing that merge against already encrypted DB values. When credentials are omitted or masked, the update path can persist quoted ciphertext or masked placeholders, and `saveDeliveryProvider()` then encrypts that again.

I verified the failure mode with a small local repro: unchanged encrypted credentials become quoted ciphertext, and one decrypt later the factory sees a string instead of a credentials object.

Evidence:

- `apps/api/src/routes/admin/settings/delivery-providers.ts:15-33` assumes existing credentials are JSON objects, not encrypted blobs
- `apps/api/src/routes/admin/settings/delivery-providers.ts:207-220` builds `providerCredentials` from the existing stored value and reuses `unmaskedCredentials(...)`
- `packages/core/src/modules/delivery/delivery.service.ts:72-75` encrypts any string it is asked to save
- `packages/core/src/modules/delivery/factory.ts:31-35` decrypts once, then `JSON.parse`s the result and expects an object

Impact:

- editing a delivery provider without fully re-entering credentials can brick Pathao/Steadfast integrations
- shipment creation/testing then fails later and the breakage is hard to diagnose from the admin UI

### P1. Several high-value secrets are only masked in the UI but stored plaintext in D1

There is no consistent "secret at rest" rule across the settings layer. Payment and SMS mostly encrypt; Firebase service account JSON, WhatsApp access tokens, and Meta CAPI access tokens do not.

Why this matters:

- a DB dump exposes service account private keys and third-party tokens directly
- the UI creates a false sense of protection because these values are masked on GET

Evidence:

- WhatsApp token:
  - schema storage in `packages/database/src/schema/system.ts:47-49`
  - raw save in `apps/api/src/routes/admin/settings/system.ts:108-110`
  - queue payload copies raw token in `packages/core/src/modules/customers/otp-transport.ts:117-127`
- Firebase service account:
  - raw save in `apps/api/src/routes/admin/settings/system.ts:311-318`
  - raw read in `packages/core/src/modules/notifications/notifications.service.ts:34-45`
- Meta CAPI access token:
  - raw save in `apps/api/src/routes/admin/settings/meta-conversions-admin.ts:77-84`
  - table stores raw token in `packages/database/src/schema/marketing.ts:111-127`
  - UI claims it "will be encrypted when stored" in `apps/admin-v2/src/components/admin/meta-conversions/MetaConversionsSettingsForm.tsx:128-130`

Impact:

- Firebase is the highest-risk item here because the stored JSON includes a private key
- this inconsistency also explains why some consumers expect ciphertext and others expect plaintext

### P2. Order-status SMS notifications do not pass the encryption key, so encrypted SMS configs can work for OTP but fail for customer notifications

The queue consumer correctly resolves the SMS provider with an encryption key for OTP. The order-notification path does not.

Why this matters:

- the same store can have working SMS OTP delivery and broken order-status SMS delivery
- this is a particularly nasty operational split because the configuration appears valid in the admin UI

Evidence:

- OTP path passes the key in `apps/api/src/queue-consumer.ts:229-231`
- order-notification path omits it in `packages/core/src/modules/notifications/notifications.service.ts:228-237`
- decryption only happens when the optional key is provided in `packages/core/src/integrations/sms/sms-settings.ts:212-272`

Impact:

- SMS order confirmations, shipped notices, refunds, etc. can fail while OTP SMS continues to work

### P2. AI system prompts have built-in fallback config, but the runtime route duplicates URLs and ignores the fallbacks entirely

The AI module defines centralized prompt URLs and fallback prompt text, but the actual admin prompt route redefines the URLs and hard-fails on fetch issues instead of using the fallback.

Evidence:

- centralized config in `packages/core/src/modules/ai/ai-config.ts:13-34`
- duplicate prompt URLs in `apps/api/src/routes/admin/ai-prompts.ts:10-14`
- no fallback usage in `apps/api/src/routes/admin/ai-prompts.ts:37-62`

Impact:

- prompt availability depends on `text.wrygo.com` even though fallback content already exists in-repo
- this is a reliability problem and a configuration-governance problem: there are two sources of truth for the same setting

### P3. The provider/config architecture is split across multiple incomplete systems, which is already causing drift bugs

This layer currently mixes:

- legacy email and SMS registries
- payment gateway registry + payment provider interface
- table-driven delivery factory
- a newer universal provider registry that is mostly scaffolding

Evidence:

- universal registry exists in `packages/core/src/providers/registry.ts:1-170`
- only Stripe and Resend are registered there:
  - `packages/core/src/providers/payment/stripe-adapter.ts:104-114`
  - `packages/core/src/providers/email/resend-adapter.ts:119-129`
- live email still uses legacy integration registry in `packages/core/src/integrations/email/index.ts:15-18`
- live SMS still uses legacy integration registry in `packages/core/src/integrations/sms/index.ts:24-47`
- checkout gateway discovery still uses `packages/core/src/modules/payments/gateway-registry.ts:7-27`

Impact:

- secret handling rules are inconsistent
- adding a provider now requires knowing which of several systems is authoritative
- the bugs above are symptoms of this split, not isolated mistakes

### P3. AI context batch-detail resolution does unnecessary repeated storefront URL lookups

`/admin/ai-context/batch-details` resolves each product, buy-now, variant, and category URL by calling `getStorefrontPath()` repeatedly. `getStorefrontPath()` in turn re-fetches the storefront base URL each time.

Evidence:

- repeated per-path resolution in `apps/api/src/routes/admin/ai-context.ts:131-149` and `:225-229`
- base-url lookup happens inside `packages/core/src/modules/settings/settings.service.ts:37-43` and `:49-82`

Impact:

- on a KV miss or cold path, large AI context batches do more DB work than necessary
- the route is otherwise well-batched, so this stands out as the remaining avoidable hot path

## Complexity And Debt Notes

- `site_settings`, `settings`, `meta_conversions_settings`, and `delivery_providers` all behave like configuration stores, but they follow different lifecycle and security rules.
- `packages/core/src/modules/settings/site-settings.service.ts` and `packages/core/src/modules/settings/settings.service.ts` both depend on `packages/core/src/modules/payments/gateway-settings.ts` for generic `upsertSetting()` behavior, which couples unrelated domains through the payments module.
- `packages/core/src/integrations/email/resend.ts` is marked deprecated, but it is still the active runtime path because `packages/core/src/integrations/email/index.ts` registers it directly.
- `packages/core/src/integrations/meta/conversions-api.ts:165` puts the Meta access token in the request URL query string instead of an auth header. That is weaker operational hygiene even if the call still succeeds.
- `packages/core/src/middleware-helper/csp-handler.ts:142-181` keeps `'unsafe-inline'` and `'unsafe-eval'` in the main policy while also allowing wildcard-expanded custom domains. That is better treated as a compatibility policy than a strong CSP.

## Prioritized Follow-Ups

1. Fix the broken secret-consumer paths first:
   - decrypt `resend_api_key` in the active email sender or switch runtime email sending to the canonical provider adapter
   - decrypt `openrouter_api_key` in both admin generation endpoints and add the missing category filter
   - pass `encryptionKey` into the order-notification SMS path
2. Standardize secret-at-rest rules:
   - move Firebase service account, WhatsApp access token, and Meta access token onto the same encryption helper path as payment/SMS
   - stop storing secrets in `site_settings` when they need the same lifecycle as credential KV settings
3. Repair delivery-provider update semantics:
   - never merge masked form values against encrypted DB blobs
   - decrypt before merge, then re-encrypt once on write
   - add regression tests for "edit non-secret field without re-entering credentials"
4. Collapse to one provider architecture:
   - choose either the universal provider registry or the legacy/per-domain registries as the real target
   - remove or quarantine deprecated paths once the live call sites are migrated
5. Add focused regression coverage:
   - encrypted email send after admin save
   - encrypted OpenRouter key end-to-end generation
   - SMS OTP vs order-notification SMS with encryption enabled
   - delivery-provider edit with masked/unchanged credentials
   - AI prompt fetch fallback behavior when remote prompt host is unavailable
