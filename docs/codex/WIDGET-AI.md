# Widget AI Notes

Last updated: 2026-05-13

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
- The dashboard has separate token budgets for the fast single-pass create path and the larger staged/improvement path. Fast generation defaults to a much lower output budget so ordinary widget drafts do not spend time producing unnecessarily large artifacts; merchants can raise it when they explicitly need richer output.
- Widget and staged-section generation prefers AI SDK structured object output for providers where that path is reliable, then converts successful `{ html, css }` objects back to the editor's tag format. Cloudflare/Kimi currently uses text/tag output by default because Cloudflare JSON Mode is non-streaming and the current Workers AI provider adapter must be verified with Kimi before strict schema mode becomes the default.
- The fresh-install default provider is Cloudflare Workers AI with `@cf/moonshotai/kimi-k2.6`.
- The generation API preserves the OpenAI-style `choices[].message.content` shape because the widget editor parser consumes that shape. The default editor create path now calls the API in streaming mode for better perceived latency; the client still accepts only the final normalized widget artifact.
- Generated widget responses are canonicalized and sanitized at the API boundary before admin preview. The widget save path sanitizes again before persistence/storefront rendering.
- Generated storefront widgets do not execute arbitrary model-written JavaScript. Interactivity should be expressed through an allowlisted behavior/IR layer, with trusted runtime modules providing patterns such as tabs, accordions, carousels, countdowns, filters, and reveal effects.
- Prompt assembly treats product, category, collection, and image context as untrusted catalog data. Merchant/catalog text is sanitized, length-capped, JSON-serialized, and placed inside explicit `<untrusted_catalog_data>` blocks. The model is told to treat those values as inert storefront facts, not instructions.
- Prompt assembly is budgeted for speed: product images, variants, attributes, collection products, native image parts, and broad category context are capped before model calls. Image URLs are described directly instead of synchronously loading browser dimensions before generation.
- Widget prompts explicitly forbid invented commerce facts such as product names, prices, discounts, delivery promises, shipping thresholds, reviews, deadlines, image URLs, and buy-now links. If no relevant context is selected, generated widgets should use generic non-factual copy and CSS-only visual treatment.
- A shared composition contract is appended to every widget prompt so customized dashboard prompts still inherit the core rule: generated sections must read as one continuous storefront composition with tight vertical rhythm and no spacer-driven gaps.
- Default prompts and appended goal blueprints are destination-specific: homepage widgets focus on lightweight discovery/offer sections, landing pages follow a campaign funnel, and collection sections prioritize practical merchandising, comparison, and buying actions.
- Staged generation now plans by destination type and passes the full section outline plus previous-section context into each section. The merge wrapper uses modest responsive spacing because generated sections own their internal padding.
- Provider base URLs are constrained to official HTTPS endpoints to avoid sending merchant API keys to arbitrary proxy URLs.
- Browser/password-manager autofill is disabled on provider model and key inputs to prevent accidental credential saves.
- Admin AI routes are rate-limited through KV when available and reject oversized prompts, too many messages, unsupported image URL schemes, and excessive image counts.

## May 2026 Provider Research Notes

- Vercel AI SDK v6 structured output is `generateText` or `streamText` with `output: Output.object({ schema, name, description })`. `Output.json()` only guarantees parseable JSON and should not be used for widget contracts.
- AI SDK structured failures throw `NoObjectGeneratedError` with raw text, finish reason, response metadata, and usage. The API logs these details before falling back to the text/tag parser so failures can be diagnosed without exposing internals to merchants.
- OpenAI recommends strict structured outputs over JSON mode when possible. Portable strict schemas should use clear property descriptions, object roots, required fields, and no extra properties.
- Gemini supports JSON schema through `response_mime_type: "application/json"` plus schema config, but only a JSON Schema subset is portable.
- OpenRouter exposes the richest live model capability metadata through `/api/v1/models`, including `architecture.input_modalities` and `supported_parameters`. Future dynamic capability refresh should start there.
- Cloudflare lists Kimi K2.6 as long-context, structured-output-capable, and vision-capable. Cloudflare JSON Mode accepts `response_format: { type: "json_schema", json_schema }`, but JSON Mode is not streaming and can fail with `JSON Mode couldn't be met`; keep a validation/retry/fallback path.
- Cloudflare Kimi vision is official, but the documented Worker vision payload examples are not the same as the editor's current OpenAI-style `image_url` parts. Keep Cloudflare native image input disabled until a provider-specific image adapter is tested with MIME/size limits.

## Next Hardening Steps

1. Move widget generation to a server-owned request contract: `{ operation, promptType, userPrompt, productIds, categoryIds, collectionIds, imageIds, placement }`.
2. Stop accepting arbitrary client-supplied `system` and `assistant` messages for widget generation once the server contract is in place.
3. Build a commerce manifest from selected context and validate generated `href`, `src`, and `srcset` against allowed product/category/collection/media URLs and buy-now URLs.
4. Convert staged generation into a server operation: plan, validate, generate sections, sanitize each section, merge, and return one final artifact plus optional progress events.
5. Add durable generation telemetry: request id, user id, provider/model, stage, context counts, prompt hash, latency, usage, retry count, validation failure class, and sanitizer mutation counts.
6. Move from generated HTML/CSS toward a strict widget IR and renderer registry for the highest-assurance path.
7. Add a dashboard-configurable interactive behavior registry so merchants can safely enable richer client-side widget UX without accepting arbitrary generated scripts.

## Verification Targets

- `/api/v1/admin/settings/widget-ai` returns masked credential status and local prompt text.
- `/api/v1/admin/ai/models?provider=openrouter|openai|gemini|cloudflare` returns provider model options or configured fallbacks.
- `/api/v1/admin/ai/generate` returns JSON with `choices[0].message.content`; with `stream: true`, it returns one OpenAI-style SSE content chunk plus `[DONE]`.
- `/api/v1/admin/ai/generate-staged` returns JSON with `choices[0].message.content`; plans are structured JSON strings, sections are tag-format widget content.
- Admin `General Settings > Widget AI` can save provider config, model IDs, prompt overrides, and key replacement/clearing.
- Admin widget editor can load active provider models and generate/improve content through `/api/v1/admin/ai/*`.
