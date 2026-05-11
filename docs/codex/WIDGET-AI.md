# Widget AI Notes

Last updated: 2026-05-12

## Current Shape

Widget generation is provider-neutral and dashboard-configurable.

- Admin settings tab: `apps/admin-v2/src/components/admin/settings/WidgetAiSettingsBuilder.tsx`
- Admin widget hooks:
  - `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts`
  - `apps/admin-v2/src/components/admin/widgets/widget-form/useAiImprover.ts`
  - `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts`
- API generation route: `apps/api/src/routes/admin/ai.ts`
- API settings route: `apps/api/src/routes/admin/settings/ai.ts`
- Prompt resolver: `apps/api/src/routes/admin/ai-prompts.ts`
- Core settings service: `packages/core/src/modules/ai/ai-settings.service.ts`
- Local default prompts: `packages/core/src/modules/ai/default-prompts.ts`

## Important Contracts

- System prompts never come from third-party prompt URLs.
- Provider keys are stored encrypted in `settings` category `ai`.
- Saving provider keys requires `CREDENTIAL_ENCRYPTION_KEY`; there is no JWT-secret fallback for AI secrets.
- Non-secret provider configuration is stored in key `widget_generation_config`.
- Runtime generation uses Vercel AI SDK providers for OpenRouter, OpenAI, Gemini, and Cloudflare Workers AI.
- The generation API preserves the OpenAI-style `choices[].message.content` and streaming `choices[].delta.content` shapes because the widget editor parser consumes that shape.
- Widget previews are sanitized and scriptless. Generated widgets should be HTML/CSS only; scripts are stripped before preview/storefront rendering.
- Provider base URLs are constrained to official HTTPS endpoints to avoid sending merchant API keys to arbitrary proxy URLs.
- Browser/password-manager autofill is disabled on provider model and key inputs to prevent accidental credential saves.
- Admin AI routes are rate-limited through KV when available and reject oversized prompts, too many messages, unsupported image URL schemes, and excessive image counts.

## Verification Targets

- `/api/v1/admin/settings/widget-ai` returns masked credential status and local prompt text.
- `/api/v1/admin/ai/models?provider=openrouter|openai|gemini|cloudflare` returns provider model options or configured fallbacks.
- `/api/v1/admin/ai/generate` streams text/event-stream for simple generation.
- `/api/v1/admin/ai/generate-staged` returns JSON with `choices[0].message.content`.
- Admin `General Settings > Widget AI` can save provider config, model IDs, prompt overrides, and key replacement/clearing.
- Admin widget editor can load active provider models and generate/improve content through `/api/v1/admin/ai/*`.
