# Widget Generation Runtime Audit 2

Date: 2026-05-13  
Scope: current implementation only. This audit intentionally uses API/admin/storefront source files as the source of truth, not prior markdown notes.

## Current Status Note

This audit started as a runtime snapshot before the latest widget-generation fixes. The following findings have since been addressed in code:

- `/admin/ai/generate` and `/admin/ai/generate-staged` now accept a first-class `promptType`.
- The API appends destination-specific runtime contracts and uses destination-aware token budgets.
- Client staged generation passes the selected destination through planning, section generation, and finalization.
- The artificial staged section delay is now configuration-owned and currently set to `0`.
- No-context fallback widgets are now destination-aware and reject invented catalog/card details.
- No-context create flows with no selected image context now use an instant safe fallback instead of spending a full model call before falling back.

The remaining active concerns are the same architectural ones: staged mode is still a serial multi-call flow, the simple stream is still consumed only as final usable content by the admin UI, output validation still accepts generic `{ html, css }` rather than destination-specific semantics, and storefront rendering still treats all widget types as sanitized/scoped HTML/CSS.

## Executive Read

The widget generator is now safer than the older raw-prompt path, but speed and type differentiation are still constrained by the runtime shape:

- Fast generation is one streamed model call after prompt/context fetches, but it still does late server normalization and may run a hidden repair generation after the visible stream finishes.
- Staged generation is client-orchestrated and serial: plan call, N section calls, 500 ms sleeps, optional finalizer call, plus independent retries. A 4-section landing output normally means 6 AI calls before any save.
- Staged coherency backfires because every section is generated as a separate widget slice, with only truncated summaries of prior sections and a finalizer that is skipped for large drafts or ignored on failure.
- Homepage Widget, Landing Section, and Collection Section have different prompt text, but all are appended into the same broad composition/speed/HTML-CSS response contract. The stage prompts and API endpoint do not carry a first-class destination type, so the actual generation task often collapses to "one continuous ecommerce composition."
- Placement-derived prompt type can override the user's radio choice. Homepage widgets placed before/after a collection are treated as `collection`; product/category/page placements become `landing-page`.

## Exact Runtime Path

### Admin entry points

- `apps/admin-v2/src/components/admin/widgets/widget-form/AiAssistant.tsx`
  - Renders the Content goal radio labels: `Homepage Widget`, `Landing Section`, `Collection Section`.
  - The radio value is disabled when placement determines the prompt type.
  - Staged mode is a local switch described as slower multi-call mode.

- `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts`
  - `effectivePromptType` chooses `placementContext.suggestedPromptType` whenever active placements exist; otherwise it uses the user's selected `promptType`.
  - `handleAiRequest()` validates prompt/model, fetches prompt and context in parallel, builds structured messages, then chooses staged vs simple.
  - `handleSimpleGeneration()` posts to `/api/v1/admin/ai/generate` with `stream: true`.
  - `handleCopyPrompt()` follows the same prompt/context assembly path but flattens messages for external chat.

- `apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx`
  - `getPlacementAiContext()` maps active placements to prompt type:
    - collection intent if scope is `collection` or slot is `before_collection` / `after_collection`.
    - landing intent if scope is `page`, `product`, or `category`.
    - widget otherwise.
  - `onSubmit()` persists `promptType`, selected context, staged plan/sections, and improvement history in `aiContext`, but saved storefront rendering only uses `htmlContent` and `cssContent`.

### Prompt assembly

- `packages/core/src/modules/ai/default-prompts.ts`
  - `DEFAULT_AI_PROMPTS.widget`, `DEFAULT_AI_PROMPTS["landing-page"]`, and `DEFAULT_AI_PROMPTS.collection` are the dashboard-managed system prompt fallbacks.

- `packages/core/src/modules/ai/prompt-helper-v2.ts`
  - `GOAL_CONTRACTS` and `LAYOUT_BLUEPRINTS` append type-specific guidance.
  - `generateStructuredPrompt()` builds one user message containing:
    - selected system prompt.
    - destination contract.
    - layout blueprint.
    - shared `PROMPT_INSTRUCTIONS.composition`.
    - shared `PROMPT_INSTRUCTIONS.speed`.
    - shared `PROMPT_INSTRUCTIONS.json`.
    - product/category/collection/image context blocks.
    - user request or improvement request.
  - `PROMPT_CONTEXT_LIMITS` caps images per product, variants, attributes, collection products, and collection categories before they enter the prompt.
  - Prompt caching metadata is only applied for Anthropic/Claude model IDs through `cache_control`; most configured models receive repeated full prompt text on every call.

### API generation routes

- `apps/api/src/routes/admin/ai.ts`
  - `generateSchema` accepts provider, model, raw messages, raw prompt/images, stream flag, and operation.
  - `generateStagedSchema` accepts provider, model, messages, stage, sectionIndex, and totalSections. It does not accept or enforce `promptType`.
  - `/admin/ai/generate`:
    - rate-limits via KV.
    - loads widget AI runtime settings from DB and encrypted key storage.
    - resolves provider/model/capabilities.
    - streams with `streamText()` for simple generation.
    - appends a final OpenAI-compatible SSE message after `finalizeStreamedWidgetContent()` normalizes the completed raw text.
  - `/admin/ai/generate-staged`:
    - rate-limits and reloads runtime settings on every stage request.
    - uses `settings.generation.maxOutputTokens` for plan, section, and finalize stages.
    - calls `generateStagedPlan()` only for `stage: "plan"`; all other stages call `generateWidgetContent()`.

- `apps/api/src/routes/admin/ai-response-validation.ts`
  - `normalizeWidgetGenerationText()` accepts tag output first, JSON second, then sanitizes HTML/CSS.
  - `normalizeWidgetOutput()` converts structured `{ html, css }` object output back into tag format.
  - `normalizeStagedPlanText()` normalizes plan JSON into bounded fields.
  - `createNoContextFallbackWidget()` is generic "Store discovery"; it is not destination-aware.

- `apps/api/src/routes/admin/ai-message-normalization.ts`
  - `normalizeMessages()` converts admin message parts into AI SDK `ModelMessage`s.
  - `cache_control` is transformed into provider options for OpenRouter/Anthropic.
  - Image URL parts are turned into native `image` parts for user messages when present.

### Context route

- `apps/api/src/routes/admin/ai-context.ts`
  - `/admin/ai-context/batch-details` fetches selected products, categories, collections, and anchor collections.
  - Product context includes images, variants, attributes, category URL, product URL, buy-now URL, discounts, and final prices.
  - Collection context resolves collection products through `resolveCollectionProductsBatch()`.
  - Storefront URLs are resolved with `SettingsService.getStorefrontPath()` for product/category/collection/buy-now paths.

### Staged generation orchestrator

- `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts`
  - `createPlanningMessages()` flattens original messages into text, strips the simple tag output block, and asks for JSON plan only.
  - `createDeterministicPlan()` silently replaces a failed plan with a substring-based destination guess.
  - `generateSection()` posts original messages plus a section prompt to `/admin/ai/generate-staged`.
  - `compactPreviousSections()` sends at most 6,000 chars of prior-section summaries, with each section capped to about 900 chars HTML and 900 chars CSS.
  - `buildCombinedWidget()` wraps generated slices in `.widget-container > .widget-section`.
  - `finalizeComposition()` posts the combined draft to `/admin/ai/generate-staged` with `stage: "finalize"` unless the draft exceeds 36,000 chars.
  - `startStagedGeneration()` performs plan, serial section generation, 500 ms sleeps between sections, then optional polish.

### Persistence and storefront rendering

- `packages/core/src/modules/widgets/widgets.service.ts`
  - `createWidget()` and `updateWidget()` sanitize HTML/CSS before persistence.
  - `getActiveWidgetPlacements()` returns active widgets by placement scope.
  - `toPublicWidget()` sanitizes HTML/CSS again for public API responses.

- `apps/api/src/routes/widgets.ts`
  - Public widget endpoints return `{ success: true, data: { widget/widgets } }`.
  - Active homepage and scoped endpoints set `Cache-Control: no-store` at API response level.

- `apps/storefront/src/lib/api/widgets.ts`
  - Storefront wraps active widget fetches in `withEdgeCache()` with `CACHE_TTL.LONG`.

- `apps/storefront/src/lib/widget-content.ts`
  - `prepareWidgetContent()` strips tag/code wrappers, sanitizes HTML/CSS, optimizes image URLs, and scopes CSS with `scopeCss()`.

- `apps/storefront/src/components/WidgetBlock.astro` and `WidgetPlacementZone.astro`
  - Render sanitized/scoped widget CSS in a `<style>` tag and widget HTML via `set:html`.
  - Zone selection is purely placement-based; it does not use saved AI prompt type.

## Concrete Bottlenecks

1. Staged mode multiplies model calls.
   - Minimum staged request sequence is prompt fetch, context fetch, plan, each section, finalize.
   - A 4-section landing plan is normally 8 server requests total and 6 AI calls.
   - Each section may retry up to 3 times in the client orchestrator, while the API also allows provider retries.

2. Every staged AI call reloads runtime settings and credentials.
   - `runtimeSettings()` reads AI settings and decrypts stored API keys per `/generate-staged` request.
   - Plan, section 1, section 2, section 3, section 4, and finalize all repeat the same setup.

3. Staged mode resends the full prompt and selected context per section.
   - `generateSection()` sends `messages: [...messages, sectionPrompt]`.
   - The original `messages` include system prompt, shared contracts, catalog context, image context, native image parts, and user request.
   - Prior section context is additive, so later sections are larger than earlier sections.

4. Staged stages share the same high token budget.
   - `/generate-staged` uses `settings.generation.maxOutputTokens` for plan, generate, and finalize.
   - Default `maxOutputTokens` is 8,000, while fast single-pass default is 2,200.
   - Planning should not need an 8,000-token output budget.

5. There is an intentional 500 ms delay between sections.
   - `startStagedGeneration()` sleeps 500 ms between each generated section.
   - The config also defines `GENERATION_CONFIG.stagedGeneration.sectionDelayMs`, but the orchestrator uses a literal 500 ms.

6. Final polish is another full generation call and can disappear.
   - `finalizeComposition()` skips if the draft exceeds 36,000 chars.
   - If finalization fails, staged generation warns and returns the combined section fallback.
   - This means the most expensive staged path can still return unpolished stitched output.

7. Streaming simple generation has a hidden tail.
   - The API streams raw deltas first, then normalizes after the model finishes.
   - If normalization fails, `finalizeStreamedWidgetContent()` may call `generateWidgetContent()` again for repair before emitting the final replacement message.
   - The UI waits for the final replacement content from `readChatCompletionStream()`, so the visible stream does not equal usable-completion latency.

8. Context fetch is non-trivial even before the model call.
   - `/ai-context/batch-details` can query products, images, variants, attributes, categories, collections, and many storefront paths.
   - `allCategories` loads up to 24 categories and sets `categoriesTruncated` true by design.
   - Collection context calls `resolveCollectionProductsBatch()` and then resolves product/category/collection storefront URLs.

9. Structured output fallback can double-call non-streamed generation.
   - `generateWidgetContent()` tries AI SDK structured object output when model capabilities allow it.
   - If structured output fails, it falls back to text generation.
   - Staged plan/section/finalize are non-streaming, so they can pay this fallback cost.

## Why Staged Generation Backfires

1. It asks multiple independent generations to behave like one design system.
   - The plan describes a shared visual system, but each section is a separate model call.
   - Later calls only see truncated prior snippets; they do not receive the full rendered layout, exact computed CSS, or a stable design-token artifact.

2. The finalizer is optional in exactly the cases that need it most.
   - Large drafts skip polish at 36,000 chars.
   - Failed polish falls back to stitched sections.
   - The fallback wrapper prevents physical gaps with `gap: 0`, but it cannot fix mismatched art direction, duplicated CTA systems, inconsistent card radii, or conflicting class semantics.

3. Section prompts are generic and repetitive.
   - `generateSection()` tells every section to be a "progressive slice of ONE widget" and to reuse a shared design system.
   - It does not supply a machine-checkable style token set, component inventory, or destination-specific schema.
   - The model tends to satisfy the local section role with familiar ecommerce patterns, so sections drift toward hero, product cards, trust badges, CTA regardless of type.

4. The fallback plan can infer the wrong destination.
   - `createDeterministicPlan()` uses substring checks across the entire flattened prompt.
   - Because prompts include negative or comparative words like "landing", "campaign", "collection", and "homepage", the fallback can choose a destination for accidental text reasons rather than the selected UI value.

5. Planning loses native image parts.
   - `createPlanningMessages()` flattens messages into text-only context.
   - The plan therefore sees image URLs in text context at best, while section generation may receive native image parts.
   - The resulting plan can under-specify media layout, then each section improvises media treatment independently.

6. Progressive preview rewards local completion, not final coherency.
   - The UI previews stitched sections as they finish.
   - Each accepted section looks valid in isolation, but the final page-level rhythm depends on a later polish pass that may be skipped or fail.

## Why The Three Prompt Types Produce Similar Results

1. The strongest instructions are shared.
   - All prompt types receive the same `COMPOSITION CONTRACT`, `FAST GENERATION BUDGET`, and tag-only HTML/CSS response contract.
   - These shared instructions repeatedly say "one continuous composition", "avoid gaps", "use provided facts", and "do not overbuild."
   - The type-specific defaults become flavor text inside a larger common generation task.

2. Type-specific output is not enforced by schema.
   - The only widget output contract is `{ html, css }` or `<htmljs>/<css>`.
   - There is no type-aware schema requiring homepage discovery modules, landing funnel sections, or collection comparison/product-density ratios.
   - The validator checks safety and parseability, not semantic destination fit.

3. The API does not know prompt type.
   - `/admin/ai/generate` and `/admin/ai/generate-staged` receive messages, not a server-owned `{ promptType, operation, placement }` contract.
   - Staged route fields include `stage`, `sectionIndex`, and `totalSections`, but not `promptType`.
   - Once messages are assembled, the backend cannot apply type-specific budgets, validators, fallback widgets, or repair prompts.

4. Placement can override user intent.
   - A homepage `before_collection` or `after_collection` placement becomes `collection`.
   - Product/category/page placements become `landing-page`.
   - This is useful for relevance, but it makes the visible radio labels misleading and can make "Homepage Widget" outputs look like "Collection Section" outputs depending on placement state.

5. No-context generations intentionally converge.
   - When no product/category/collection context exists, `generateStructuredPrompt()` adds the same factuality gate.
   - If validation cannot repair a no-context response, the deterministic fallback is always generic store discovery, not type-specific.

6. Staged plans converge on the same common section archetypes.
   - Homepage: signal, discovery, trust/CTA.
   - Landing: offer, showcase, proof, final CTA.
   - Collection: intro, grid/comparison, trust/CTA.
   - These are legitimate commerce patterns, but without stronger constraints they all become hero plus cards plus trust plus CTA.

7. Storefront rendering erases type metadata.
   - Saved `aiContext.promptType` is not used by `WidgetBlock`, `WidgetPlacementZone`, or `prepareWidgetContent()`.
   - The storefront only sees sanitized HTML/CSS and placement, so any type difference must be fully embodied in generated markup.

## Recommendations Ranked By Speed And Impact

### 1. Make single-pass streaming the default path and reserve staged mode for explicit expert use

Impact: very high. Speed: very high.

- Keep `stagedGenerationDefault` off.
- Remove or ignore `autoEnableThreshold` until staged mode is redesigned; `shouldUseStagedGeneration()` already returns only the user toggle.
- In UI copy, position staged mode as "experimental long-form page builder" rather than "better quality."
- Fast path should be the baseline for Homepage Widget and Collection Section.

### 2. Add destination-aware fast templates before model generation

Impact: high. Speed: high.

- Convert `promptType` into a server-owned request field rather than only message text.
- For each type, provide a concise skeleton:
  - Homepage: 1-2 bands, discovery/offer/category links, max one product-card cluster.
  - Landing: 3-5 campaign bands, proof/objection/CTA progression.
  - Collection: compact intro plus product comparison/grid/buying guide, product facts dominate.
- Ask the model to fill a type-specific skeleton instead of inventing the structure from broad prose.

### 3. Move staged generation into one server operation with SSE progress

Impact: high. Speed: medium-high.

- Replace client fan-out with `/admin/ai/generate-widget` accepting `{ operation, promptType, prompt, contextIds, placement, staged }`.
- Resolve settings, credentials, model, prompt, and context once.
- Stream progress events for planning/sections/finalize.
- This removes repeated admin server function round trips, repeated runtime settings reads, and client-side orchestration failure states.

### 4. Cap staged token budgets by stage

Impact: high. Speed: high.

- Planning: 500-900 output tokens.
- Section generation: 1,200-2,000 output tokens per section.
- Finalizer: 2,000-3,500 output tokens, or skip finalizer for compact plans.
- Do not use global `maxOutputTokens` for every staged stage.

### 5. Replace LLM planning with deterministic destination plans for common cases

Impact: high. Speed: high.

- Use promptType plus selected context counts to choose section count.
- Call the model once for content, not once to decide the shape.
- Keep LLM planning only for explicit "long campaign" requests or when the merchant asks for many sections.

### 6. If staged remains, generate a locked design-token artifact first

Impact: medium-high. Speed: medium.

- Before section calls, create a compact non-visual contract: palette tokens, spacing scale, radius scale, button styles, card styles, image treatments, section backgrounds, CTA copy policy.
- Pass that artifact to every section and validate CSS against expected class/token names.
- This is better than sending prose like "reuse the shared visual system."

### 7. Make finalization deterministic where possible

Impact: medium-high. Speed: medium-high.

- Do not ask an LLM to merge sections just to remove gaps.
- Normalize wrappers, margin guards, root class naming, and CSS ordering in code.
- Reserve LLM finalization for semantic rewrite requests, not basic composition repair.

### 8. Add type-specific validators and fallbacks

Impact: medium-high. Speed: medium.

- Homepage validator: reject output that looks like a full landing page unless requested.
- Landing validator: require clear offer/promise, repeated CTA logic, and campaign progression.
- Collection validator: require supplied product/category facts when context exists; enforce product/fact density.
- Add type-specific no-context fallbacks instead of the single "Store discovery" widget.

### 9. Reduce context payload by destination

Impact: medium. Speed: high.

- Homepage: categories/collections first, fewer variants.
- Landing: selected campaign products/collection plus proof-oriented facts.
- Collection: product facts, prices, image, buy-now URLs; avoid unrelated broad category lists.
- Avoid sending all selected image URLs as native image parts on every staged section; keep media references text-only unless the merchant explicitly needs visual analysis.

### 10. Add generation telemetry before further tuning

Impact: medium. Speed: medium.

Record per request:

- promptType, placement-derived vs user-selected.
- provider/model/capabilities.
- simple vs staged.
- context counts and prompt char/token estimate.
- stage name, retry count, latency, usage.
- normalization path: structured, text, retry, fallback.
- finalizer skipped/failed/applied.

Without this, speed work is mostly anecdotal.

## Priority Fix Set

1. Backend contract: add a server-owned generation endpoint that accepts prompt type and context IDs instead of arbitrary assembled messages.
2. Fast differentiated generator: one streaming call with type-specific skeleton and max output budget.
3. Staged containment: deterministic plans, lower per-stage token budgets, server-side orchestration, no LLM finalizer for simple wrapper repair.
4. Type-aware validation: destination-specific semantic checks and fallback widgets.
5. Telemetry: measure actual latency/token/retry behavior by stage and prompt type.
