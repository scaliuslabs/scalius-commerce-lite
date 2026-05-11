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
```

System prompts are stored in the `settings` table under category `ai`. The default prompt text lives in `default-prompts.ts`; the API no longer fetches prompts from third-party URLs.

## Provider Settings

Canonical settings use:

- category: `ai`
- config key: `widget_generation_config`
- prompt keys: `prompt_widget`, `prompt_landing_page`, `prompt_collection`
- secret keys: `api_key_openrouter`, `api_key_openai`, `api_key_gemini`, `api_key_cloudflare`

Secrets are encrypted with the same credential encryption key used by payment providers. Non-secret provider details such as base URL, attribution URL, account ID, default model, generation temperatures, max output tokens, and staged generation default are stored in `widget_generation_config`.

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
  - `POST /api/v1/admin/ai/generate`
  - `POST /api/v1/admin/ai/generate-staged`
- `apps/api/src/routes/admin/ai-prompts.ts`
  - `GET /api/v1/admin/ai-prompts?type=widget|landing-page|collection`

The generation routes use the Vercel AI SDK and preserve the OpenAI-style response shape expected by the widget editor parser.

