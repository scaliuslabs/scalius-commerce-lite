# AI

Widget/page/collection generation is provider-neutral and dashboard-configurable.

## Runtime Flow

```
Admin widget form
  -> GET  /api/v1/admin/settings/widget-ai
  -> GET  /api/v1/admin/ai/models?provider=...
  -> GET  /api/v1/admin/ai-prompts?type=...
  -> POST /api/v1/admin/ai-context/batch-details
  -> POST /api/v1/admin/ai/generate or /api/v1/admin/ai/generate-staged
       -> Vercel AI SDK provider adapter
       -> OpenRouter | OpenAI | Gemini | Cloudflare Workers AI

Admin assistant panel
  -> POST /api/v1/admin/ai/chat
       -> resolves settings.ai.profiles.adminChat
       -> Vercel AI SDK provider adapter
       -> OpenRouter | OpenAI | Gemini | Cloudflare Workers AI
```

System prompts are stored in the `settings` table under category `ai`. The default prompt text lives in `default-prompts.ts`; the API no longer fetches prompts from third-party URLs.

Worker startup budget matters because the API worker exports `WidgetDesignAgent` and mounts `/admin/ai` with the main Hono app. Keep `ai`, `@ai-sdk/*`, `@openrouter/ai-sdk-provider`, and `workers-ai-provider` as request-time dynamic imports inside `apps/api/src/routes/admin/ai.ts`; only type-only imports are allowed at module scope. `apps/api/src/routes/admin/ai-startup-boundaries.test.ts` guards that importing the route does not initialize provider clients.

## Provider Settings

Canonical settings use:

- category: `ai`
- config key: `widget_generation_config`
- prompt keys: `prompt_widget`, `prompt_landing_page`, `prompt_collection`
- secret keys: `api_key_openrouter`, `api_key_openai`, `api_key_gemini`, `api_key_cloudflare`

Secrets are encrypted with the same credential encryption key used by payment providers. Non-secret provider details such as base URL, attribution URL, account ID, default model, generation temperatures, max output tokens, and staged generation default are stored in `widget_generation_config`.

Runtime and admin reads must use `readStoredCredentialStrict()` for saved provider keys. Legacy plaintext keys remain readable, but encrypted rows without the dedicated `CREDENTIAL_ENCRYPTION_KEY` or rows that fail decrypt must return no API key plus the safe per-provider `credentialErrors` message; do not catch decrypt failures and collapse them into a silent `hasApiKey: false`.

## Model Profiles

`widget_generation_config` also normalizes canonical model profiles for future assistant surfaces:

- `adminChat`
- `storefrontChat`
- `widgetGeneration`
- `imageGeneration`
- `voice`

Profiles other than `widgetGeneration` are disabled by default. `widgetGeneration` is synthesized from the legacy active provider and provider default model so existing widget generation settings keep their current behavior. Profile resolution is a settings-layer guard: `resolveAiModelProfile()` checks that the profile is enabled, the provider is enabled, and credentials are available through the strict credential path. Non-Cloudflare providers must use the provider's configured allowlist. Cloudflare accepts any well-formed Cloudflare AI catalog text-model ID at runtime, because the catalog changes faster than this repo; `@cf/vendor/model` IDs are passed through, and a pasted `@provider/model` catalog ID is normalized to `provider/model`.

`adminChat` now has a first stateless dashboard route and visible admin panel. With the Cloudflare Workers AI binding, the blank default `adminChat` profile may be synthesized without a stored provider key; explicit saved Cloudflare models are honored and provider/model errors are surfaced rather than silently falling back. The API keeps `@cf/...` Workers AI chat models on the Vercel AI SDK adapter, and adapts Cloudflare Gemini catalog IDs such as `google/gemini-3.5-flash` to Cloudflare's documented `contents`/`systemInstruction` Worker binding schema. A Cloudflare catalog model can still fail when the Cloudflare account/binding lacks access to that third-party model; return a safe provider error instead of a generic 500. The first route is guidance-only: it receives bounded conversation history plus sanitized page-state context and only uses MCP navigation context for click-confirmed safe dashboard navigation. It does not read live domain data beyond that bounded context and cannot mutate settings, products, orders, inventory, payments, cache, logs, or credentials.

## Files

- `ai-settings.service.ts` reads, normalizes, masks, encrypts, and updates dashboard-managed AI settings.
- `default-prompts.ts` contains local default prompts for widget, landing page, and collection generation.
- `ai-config.ts` contains non-secret constants, response-format instructions, model capability helpers, timeouts, retry settings, and shared messages.
- `prompt-helper-v2.ts` builds structured multimodal prompts with product/category/image context.
- `ai-context-schema.ts` validates widget-level saved AI context.

## API Routes

- `apps/api/src/routes/admin/settings/ai.ts`
  - `GET /api/v1/admin/settings/widget-ai`
  - `POST /api/v1/admin/settings/widget-ai`
- `apps/api/src/routes/admin/ai.ts`
  - `GET /api/v1/admin/ai/models`
  - `POST /api/v1/admin/ai/chat`
  - `POST /api/v1/admin/ai/generate`
  - `POST /api/v1/admin/ai/generate-staged`
- `apps/api/src/routes/admin/ai-prompts.ts`
  - `GET /api/v1/admin/ai-prompts?type=widget|landing-page|collection`

The generation routes use the Vercel AI SDK and preserve the OpenAI-style response shape expected by the widget editor parser. The chat route uses the same lazy provider-loading discipline but a separate assistant prompt and response DTO; do not reuse widget artifact generation/repair helpers for admin chat.
