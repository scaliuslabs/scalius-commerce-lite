# AI

AI-powered widget/page/collection generation via OpenRouter. Provides centralized configuration, structured prompt building with provider-aware caching, multimodal vision support, and Zod-validated context persistence.

## Architecture

```
Admin Dashboard (React)                 API Worker (Hono)              Core Package
-----------------------                 ----------------               ------------
AiAssistant.tsx                         openrouter.ts                  ai-config.ts
  useAiGenerator.ts ──fetch──────────> /api/openrouter/generate       prompt-helper-v2.ts
  useAiImprover.ts  ──fetch──────────> /api/openrouter/generate       ai-context-schema.ts
  useStagedGeneration.ts ──fetch─────> /api/openrouter/generate-staged
  useAiContext.ts   ──fetch──────────> /api/v1/admin/ai-context/batch-details
                    ──fetch──────────> /api/v1/admin/ai-prompts
                    ──fetch──────────> /api/v1/admin/settings/openrouter
```

The admin widget form calls API routes which proxy requests to OpenRouter. The core package is consumed at build time by both the admin (prompt building) and the API (config constants).

## End-to-End Flow

### Simple Generation
1. Admin UI calls `GET /api/v1/admin/settings/openrouter` to check if an API key is configured
2. If configured, `GET /api/openrouter/models` fetches the full model list from OpenRouter
3. User selects a model, picks context (products, categories, images), writes a prompt
4. `GET /api/v1/admin/ai-prompts?type=widget` fetches the system prompt from an external URL (`text.wrygo.com`)
5. `POST /api/v1/admin/ai-context/batch-details` fetches full product/category data with URLs, prices, variants, buy-now links
6. `generateStructuredPrompt()` from `prompt-helper-v2.ts` assembles a structured messages array with cache_control breakpoints (Anthropic only), image content objects (vision models), and context sections
7. `POST /api/openrouter/generate` proxies the request to OpenRouter with streaming enabled
8. Admin UI streams SSE chunks, accumulates the response, parses it via tag-based parser (`<htmljs>`/`<css>` tags) with JSON fallback
9. Generated HTML/CSS is shown in a live preview

### Staged Generation
1. Steps 1-6 are the same
2. `POST /api/openrouter/generate-staged` with `stage=plan` asks the LLM to create a JSON plan: section count + descriptions
3. For each section, `POST /api/openrouter/generate-staged` with `stage=generate` generates one section at a time, accumulating context from prior sections for visual consistency
4. Sections are rendered progressively in the preview as they complete
5. All sections are combined into a `.widget-container` with `.widget-section` divs and merged CSS
6. Retry logic: up to 3 retries per section with exponential backoff (1s, 2s, 4s)

### Improvement Flow
1. `useAiImprover` takes existing HTML/CSS and an improvement prompt
2. It includes improvement history context and (for section-specific improvements) other-section context for visual consistency
3. Same streaming/parsing pipeline as generation
4. Section-specific improvements merge back into the full widget by replacing only the target section

### Copy Prompt (External AI)
1. `handleCopyPrompt` in `useAiGenerator` assembles a standalone prompt string via `generateCompletePrompt()` (legacy string-based function)
2. Adds instructions header/footer explaining the expected `<htmljs>`/`<css>` response format
3. Copies to clipboard for pasting into ChatGPT, Claude, Gemini, etc.

## Files

### Core Package (`packages/core/src/modules/ai/`)

- **`ai-config.ts`** -- All centralized configuration constants:
  - `SYSTEM_PROMPT_URLS` / `SYSTEM_PROMPT_FALLBACKS` -- External prompt URLs and fallback text for widget, landing-page, collection types
  - `OPENROUTER_BASE_URL`, `OPENROUTER_HEADERS` -- API endpoint and request headers
  - `MODEL_CAPABILITIES` -- Per-provider thresholds for caching (minTokens, maxBreakpoints, TTL), max images
  - `GENERATION_CONFIG` -- Temperature (planning: 0.3, generation: 0.7, improvement: 0.6), timeouts (30s-120s), retry config (3 attempts, exponential backoff), context limits (max 10 images, 20 products, 50 categories, 50K chars)
  - `PROMPT_INSTRUCTIONS` -- Response format instructions (tag-based `<htmljs>`/`<css>`), buy-now URL usage, improvement instructions, section-specific instructions
  - `UI_CONFIG` -- Preview device widths, model selector settings, context manager pagination
  - `ERROR_MESSAGES` / `SUCCESS_MESSAGES` -- All user-facing strings
  - Helper functions: `getProviderFromModel()`, `getMinCacheTokens()`, `getMaxCacheBreakpoints()`, `getCacheTTL()`, `getMaxImages()`, `getRetryDelay()`, `isRetryableStatus()`, `isPromptTooLarge()`, `shouldUseStagedGeneration()`, `getTimeout()`

- **`prompt-helper-v2.ts`** -- Structured prompt construction:
  - `generateStructuredPrompt()` -- Main function. Returns `{ messages, metadata }`. Builds a structured messages array with cache_control breakpoints for Anthropic models only (other providers use automatic caching). Handles multimodal image content for vision-capable models. Separates static (cacheable) and dynamic (per-request) content.
  - `generateCompletePrompt()` -- Legacy wrapper that flattens structured messages to a single string for clipboard/external-AI use
  - `processImagesWithDimensions()` -- Fetches image dimensions via `Image()` API, calculates aspect ratios
  - `prepareImagesForMultimodal()` -- Converts image files to OpenRouter vision content objects
  - Image dimension fetching uses `new Image()` (runs in browser context in admin), with 5s timeout and graceful fallback for failed loads

- **`ai-context-schema.ts`** -- Zod schemas for persisting AI context in the widget's `aiContext` DB column:
  - `AiContextSchema` -- Main schema: promptType, preferredAiModel, useStagedMode, savedImages, savedProducts, savedCategories, allCategoriesSelected, stagedPlan, stagedSections, improvementHistory, timestamps
  - `parseAiContext()` -- Parses JSON from DB with double-stringified legacy data handling and graceful recovery
  - `serializeAiContext()` -- Validates and stringifies for DB storage
  - `mergeAiContext()` -- Merges partial updates with existing context

### Admin Hooks (`apps/admin/src/components/admin/widgets/widget-form/`)

- **`useAiGenerator.ts`** -- Main generation orchestrator hook:
  - On mount: checks API key status, fetches model list, restores model preference (widget aiContext > localStorage global)
  - `handleAiRequest()`: Orchestrates system prompt fetch, context fetch, prompt building, and delegates to staged or simple generation
  - `handleSimpleGeneration()`: Streams response via SSE, parses with tag-based parser (primary) then JSON fallback
  - `handleCopyPrompt()`: Builds standalone prompt and copies to clipboard
  - Model preference is saved to `localStorage` as `global_preferred_ai_model` and persisted in widget's aiContext

- **`useAiImprover.ts`** -- Improvement workflow:
  - `improve()`: Handles whole-widget and section-specific improvements
  - Section-specific: extracts target section, includes other-section context for consistency, merges result back
  - Tracks improvement history (prompt, section index, timestamp, model used)
  - Same streaming/parsing pipeline as generator

- **`useStagedGeneration.ts`** -- Multi-section generation state machine:
  - States: idle -> planning -> generating -> complete | error
  - `createPlan()`: Asks LLM for JSON plan with section count and descriptions
  - `generateSection()`: Generates one section, passing all previous sections as context
  - Progressive rendering via callback on each section completion
  - 500ms delay between sections to avoid rate limits
  - Up to 3 retries per section with exponential backoff

- **`useAiContext.ts`** -- Context selection manager:
  - Manages selected images, products, categories, and allCategoriesSelected toggle
  - Product search with debounced query (300ms), paginated latest products (10 per page)
  - Fetches all categories on mount (limit: 200)

- **`AiAssistant.tsx`** -- React UI component:
  - Collapsible card with 3-step workflow: content type selection, context manager, prompt textarea
  - Model selector with vision/audio capability indicators
  - Staged generation toggle and progress bar with section descriptions
  - Copy Prompt and Generate buttons

### API Routes (`apps/api/src/routes/admin/`)

- **`openrouter.ts`** -- OpenRouter proxy routes:
  - `GET /models` -- Lists all OpenRouter models with processed capability flags (supportsVision, supportsAudio, supportsImageGeneration, input/output modalities)
  - `POST /generate` -- Proxies chat completion requests. Reads `openrouter_api_key` from settings table. Supports streaming (returns raw SSE body) and non-streaming (returns JSON). Logs cache hit rates for Anthropic models. 120s timeout with AbortController.
  - `POST /generate-staged` -- Same proxy but always non-streaming. Uses `response_format: { type: "json_object" }` for planning stage. Lower timeout for planning (30s) vs generation (120s). Returns stage/section metadata alongside response.

- **`ai-context.ts`** -- Context enrichment:
  - `POST /batch-details` -- Fetches full product details (with images, variants, attributes, category, URLs, buy-now URLs, final prices after discounts) and category details. Resolves storefront URLs via `SettingsService.getStorefrontPath()`.

- **`ai-prompts.ts`** -- System prompt fetcher:
  - `GET /` -- Fetches system prompt text from external URLs (`text.wrygo.com`). Returns plain text with 5-minute cache header.

- **`settings/integrations.ts`** -- OpenRouter settings CRUD:
  - `GET /openrouter` -- Returns masked API key status
  - `POST /openrouter` -- Saves API key to `settings` table (key: `openrouter_api_key`, category: `integrations`)

## Provider-Specific Caching

Cache control breakpoints are applied conditionally based on the LLM provider:
- **Anthropic (Claude)**: Manual `cache_control: { type: "ephemeral" }` breakpoints on static content. Minimum 1024 tokens required. Up to 4 breakpoints. 5-minute TTL.
- **OpenAI, Google, DeepSeek, Grok, etc.**: Automatic caching by the provider. No cache_control applied (adding it would break their caching).

## Response Parsing

Two parsing strategies in priority order:
1. **Tag-based** (primary): Extracts content from `<htmljs>...</htmljs>` and `<css>...</css>` tags
2. **JSON** (fallback): Parses `{ "html": "...", "css": "..." }` with JSON repair

Both use shared utilities from `@scalius/shared` (`parseTagBasedResponse`, `parseJSONSafely`, `validateParsedWidget`, `validateWidgetJSON`).

## Dependencies

- `zod` (context schema validation)
- `@scalius/shared/json-repair`, `@scalius/shared/tag-parser` (response parsing, consumed in admin hooks)
- No direct DB access from this module (DB access is in the API routes)
