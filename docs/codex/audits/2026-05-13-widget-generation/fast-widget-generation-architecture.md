# Fast Widget Generation Architecture Audit

Date: 2026-05-13
Scope: `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts`, `useStagedGeneration.ts`, `apps/api/src/routes/admin/ai.ts`, and `packages/core/src/modules/ai/*.ts`.

## Executive Summary

Widget generation feels slow because the current default path is a serial multi-call pipeline:

1. fetch prompt;
2. fetch product/category/collection context;
3. build browser-side prompt context, including image dimension probes;
4. ask the model for a staged plan;
5. generate section 1;
6. generate section 2;
7. generate section N;
8. wait 500 ms between sections;
9. run a finalizer call;
10. parse/validate in the browser.

For a four-section landing widget, that is normally six LLM calls before the merchant gets a finished artifact. With Kimi K2.6 or any high-quality model, this can become minutes, not seconds. Retries make the worst case much worse: the API uses `maxRetries: 2`, the section hook has its own retry loop, and each planning/generation timeout can be 90-120 seconds.

The faster default architecture should be:

**Default: streamed single-pass composition.** Generate the whole widget in one model call using a destination-specific composition profile, stream progress to the preview, validate once at the end, and only run a repair/finalizer when deterministic checks fail.

**Optional Balanced mode: plan once, generate sections in parallel with a shared immutable plan, assemble deterministically, finalizer only on validation/visual failures.**

**Optional Best Quality mode: current staged idea, but server-owned, contract-driven, and explicitly slower.**

The user-facing "Homepage Widget / Landing Section / Collection Section" selection should not merely swap one text prompt. It should select a concrete generation profile: default layout archetypes, density, section count bounds, required/forbidden patterns, CTA rules, catalog usage rules, and final validation expectations.

## Current Architecture

### Admin Orchestration

`useAiGenerator.ts` owns the front-door flow:

- loads the prompt type and AI settings;
- fetches the system prompt with `getAiPrompts`;
- fetches catalog/media context with `getAiContextBatchDetails`;
- calls `generateStructuredPrompt`;
- decides between staged and simple generation;
- parses the final OpenAI-compatible response in the browser.

The key switch is in `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts:325-353`. It calls `shouldUseStagedGeneration(promptResult.metadata.estimatedTokens * 4, useStagedMode)`, then either calls `startStagedGeneration()` or `/api/v1/admin/ai/generate`.

`shouldUseStagedGeneration()` currently ignores prompt length and returns only the user/admin toggle (`packages/core/src/modules/ai/ai-config.ts:447-455`). The default setting is `stagedGenerationDefault: true` (`packages/core/src/modules/ai/ai-settings.service.ts:136-142`). So the heavier staged path is effectively the default.

### Staged Flow

`useStagedGeneration.ts` currently performs:

- plan call: `createPlan()` -> `/api/v1/admin/ai/generate-staged` with `stage: "plan"` (`useStagedGeneration.ts:420-487`);
- serial section calls: `for (let i = 0; i < plan.totalSections; i++)` (`useStagedGeneration.ts:699-739`);
- 500 ms delay between sections (`useStagedGeneration.ts:735-738`);
- finalizer call: `finalizeComposition()` -> `/api/v1/admin/ai/generate-staged` with `stage: "finalize"` (`useStagedGeneration.ts:602-665`).

This is coherent from a quality-control standpoint, but it is not fast. It is `1 + sections + 1` LLM calls, serially.

### API Route

`apps/api/src/routes/admin/ai.ts` exposes:

- `/generate`, which supports non-streamed or streamed widget generation (`ai.ts:621-663`);
- `/generate-staged`, which supports `plan`, `generate`, and `finalize` (`ai.ts:665-731`).

The API already has useful pieces:

- Vercel AI SDK v6 `generateText`, `streamText`, and `Output.object`;
- provider abstraction for OpenRouter, OpenAI, Gemini, and Cloudflare Workers AI;
- structured-output attempt with text fallback;
- timeouts and retries;
- model capability resolution.

The admin simple path does not use streaming. It posts `stream: false` (`useAiGenerator.ts:373-383`), even though the API can stream.

### Prompt/Profile Layer

The default prompts are meaningfully different:

- Homepage widget prompt: compact, reusable homepage rhythm (`packages/core/src/modules/ai/default-prompts.ts:6-27`);
- Landing page prompt: full campaign funnel (`default-prompts.ts:29-49`);
- Collection prompt: product comparison/merchandising (`default-prompts.ts:51-71`).

But after the prompt is chosen, the rest of the pipeline applies mostly the same mechanics:

- same global composition contract (`ai-config.ts:146-152`);
- same output format (`ai-config.ts:154-170`);
- same staged plan shape (`useStagedGeneration.ts:109-118`);
- same section generation prompt;
- same finalizer prompt, which calls everything a "production ecommerce widget" (`useStagedGeneration.ts:624-643`).

That is why the three modes can still look too similar. The prompts differ, but there is no strongly typed "goal profile" controlling layout structure, density, section count, content hierarchy, and rejection criteria.

## Why It Is Slow

### 1. Default mode multiplies model calls

If the plan chooses 4 sections, current time is approximately:

```text
prompt fetch + context fetch + browser prompt assembly
+ plan call
+ section 1 call
+ 500 ms delay
+ section 2 call
+ 500 ms delay
+ section 3 call
+ 500 ms delay
+ section 4 call
+ finalizer call
```

If each LLM call takes 15-30 seconds, that is 90-180 seconds before retries.

### 2. Browser-side image probing can add pre-generation latency

`generateStructuredPrompt()` collects all selected/product/category/collection image URLs, caps them, then calls `processImagesWithDimensions()` (`packages/core/src/modules/ai/prompt-helper-v2.ts:547-599`). In a browser context this uses `new Image()` with a 5-second timeout per image. It is parallel, but a slow CDN image can still delay prompt assembly before the first LLM request begins.

Fast mode should not block generation on image dimension probing. Prefer known dimensions from media records; otherwise pass URLs without dimensions.

### 3. Finalizer is always attempted after staged generation

The finalizer improves cohesion, but it is a full extra LLM call (`useStagedGeneration.ts:741-760`). For the default UX, it should be conditional:

- run when static validators detect gap-prone CSS, unscoped selectors, duplicate wrappers, missing required catalog refs, or large output;
- run in "Best quality" mode;
- skip in "Fast" mode unless needed.

### 4. Retries are stacked

The API uses `maxRetries: 2` for generation (`apps/api/src/routes/admin/ai.ts:638-652`, `ai.ts:695-715`). The staged section hook also retries each section up to `MAX_RETRIES = 3` with exponential backoff (`useStagedGeneration.ts:41-42`, `useStagedGeneration.ts:570-584`). This can turn a single flaky section into many calls.

Fast mode needs one retry boundary per operation, not nested retries at every layer.

### 5. Streaming exists but the admin does not use it for the normal simple path

`/generate` can use `streamText()` and return `text/event-stream` (`apps/api/src/routes/admin/ai.ts:654-659`). But `handleSimpleGeneration()` sends `stream: false` (`useAiGenerator.ts:378-383`). Streaming will not reduce model compute time, but it makes the interface feel much faster and gives the merchant immediate progress.

## Why Prompt Types Look Similar

The default prompts are differentiated, so the problem is not "no prompt difference." The problem is that prompt type is not a full generation contract.

Current prompt type selection changes:

- broad role: homepage designer, landing page designer, collection page designer;
- purpose text;
- some design expectations.

It does not currently enforce:

- exact section count range by mode;
- density defaults;
- allowed archetypes by mode;
- required content hierarchy;
- visual treatment boundaries;
- different CTA strategy;
- validation rules per mode;
- model-visible examples of what "not this mode" means.

The staged plan tries to add destination guidance (`useStagedGeneration.ts:120-124`), but it still asks for the same generic fields for all modes. The finalizer then smooths everything into one generic ecommerce widget. That can erase useful differences.

Recommended goal profiles:

| User Choice | Internal Goal | Default Shape | Density | Should Avoid |
| --- | --- | --- | --- | --- |
| Homepage Widget | `homepage_widget` | 1-3 compact bands: opening signal, featured product/category strip, trust/CTA | compact/standard | full sales funnel, FAQ-heavy page, hero-scale whitespace |
| Landing Section | `landing_section_set` | 3-6 campaign bands: hero/offer, showcase, proof, objections, urgency, final CTA | campaign | generic product grid only, homepage-like category browsing |
| Collection Section | `collection_merchandising` | 1-3 practical bands: collection intro, product grid/comparison, buying guide/trust | dense/commerce | unrelated campaign storytelling, oversized hero unless asked |

The model should receive this as structured profile data, not just prose.

## Architecture Options Compared

### Option A: Single-Pass Composition

Flow:

1. API receives goal, prompt, selected context IDs, model/profile.
2. API builds a compact goal-specific prompt.
3. One `generateText()` or `streamText()` call produces the full `<htmljs>/<css>` widget.
4. API validates/sanitizes/normalizes.
5. If validation fails, run one narrow repair retry.

Pros:

- fastest real completion;
- best whole-composition coherence because the model sees the final artifact in one pass;
- lowest rate-limit pressure;
- simpler UI state;
- easiest to reason about failures.

Cons:

- no true accepted-section progress;
- long landing pages can hit output limits;
- weaker for very large catalogs unless context is compressed well.

Recommendation:

- Make this the default mode.
- Use streaming for perceived speed.
- Add a static repair pass only when validation fails.

### Option B: Parallel Section Generation

Flow:

1. Plan once with structured `GoalProfile + CompositionPlan`.
2. Generate all sections in parallel or limited concurrency using the same immutable plan.
3. Validate sections.
4. Deterministically assemble.
5. Finalizer only if validators or visual checks fail.

Pros:

- much faster than serial staged generation for 3+ sections;
- retains some progress;
- plan can make sections consistent without relying on previous-section context.

Cons:

- sections cannot naturally react to previous accepted output unless plan is very strong;
- more rate-limit pressure;
- higher risk of style drift if the plan is vague;
- partial failures need a clean retry/fallback strategy.

Recommendation:

- Use as "Balanced" mode for larger landing pages.
- Default concurrency should be 2, not unlimited.
- Only use after adding a structured plan with design tokens, class prefix, and section archetypes.

### Option C: Streaming Single-Pass

Flow:

1. Same as single-pass composition.
2. API streams text deltas through the existing `streamText()` path.
3. UI shows progress/live draft.
4. Final accepted artifact appears only after complete parse/validation.

Pros:

- fastest perceived UX;
- one model call;
- easiest to make robust.

Cons:

- partial deltas are not safely parseable as final HTML/CSS;
- preview should show "drafting" or a sandboxed text/code preview until tags are complete;
- final parse may still fail.

Recommendation:

- Use as the default user experience.
- Do not allow partial streamed HTML to become saveable content.
- Optionally render partial preview only after both tags can be parsed into a safe interim artifact.

### Option D: Current Serial Staged Planning

Flow:

1. Plan.
2. Generate sections one by one.
3. Include previous section summaries in later section prompts.
4. Finalize.

Pros:

- easy mental model;
- visible section progress;
- can produce long widgets beyond one output limit.

Cons:

- slowest option;
- many calls per widget;
- previous-section snippets are lossy (`useStagedGeneration.ts:191-216`);
- each section can become a mini-widget;
- finalizer adds another slow call;
- failure in a late section wastes earlier time.

Recommendation:

- Do not use as default.
- Keep only as "Best quality / long composition" mode after moving orchestration server-side and strengthening validation.

### Option E: Always Finalize

Pros:

- can improve visual cohesion;
- can fix duplicate wrappers and accidental gaps.

Cons:

- adds one full LLM call every time;
- can alter product references or remove details unless validators catch it;
- makes fast mode not fast.

Recommendation:

- Finalizer should be `onValidationIssues` by default.
- Use `always` only in Best Quality mode.

## Recommended Default Architecture

### 1. Add Generation Modes

Replace the single `stagedGenerationDefault` mental model with explicit modes:

```ts
type WidgetGenerationMode = "fast" | "balanced" | "best_quality" | "auto";
```

Default: `fast`.

Suggested behavior:

- `fast`: streamed single-pass, one repair retry if invalid, no finalizer unless validation fails.
- `balanced`: plan once, parallel sections with concurrency 2, deterministic assembly, finalizer on validation/visual issues.
- `best_quality`: staged/parallel hybrid with finalizer always enabled and richer diagnostics.
- `auto`: choose fast unless estimated output is too large, landing-page target needs 4+ sections, or model output limit is too low.

Admin labels:

- "Fast draft": fastest, best for most homepage and collection widgets.
- "Balanced composition": better for longer landing sections.
- "Best quality": slower, deeper section planning and polish.

### 2. Make Streamed Single-Pass The Default UI Flow

Change the default generation path to `/api/v1/admin/ai/generate` with `stream: true`.

UI behavior:

- show "Drafting complete widget..." immediately;
- show streamed text/code progress or a safe progressive preview only after parseable tags appear;
- keep "Accept" disabled until final validation passes;
- if streamed output fails parsing, run one automatic non-streamed repair retry using the full raw text and exact validation error.

This makes generation feel fast without accepting unsafe partial output.

### 3. Move Orchestration Toward The API

Longer-term, the admin should not own the generation pipeline. It should send:

```ts
type GenerateWidgetRequest = {
  goal: "homepage_widget" | "landing_section_set" | "collection_merchandising";
  mode: "fast" | "balanced" | "best_quality" | "auto";
  prompt: string;
  context: {
    productIds: string[];
    categoryIds: string[];
    collectionIds: string[];
    imageIds: string[];
    allCategories?: boolean;
    placement?: {
      scope: "homepage" | "page" | "product" | "category";
      position: "top" | "middle" | "bottom";
      pageSlug?: string;
    };
  };
  provider?: string;
  model?: string;
};
```

The API should fetch trusted catalog/media context, assemble prompts, run generation, validate, and return:

```ts
type GenerateWidgetResponse = {
  html: string;
  css: string;
  goal: string;
  mode: string;
  diagnostics: string[];
  plan?: CompositionPlan;
  sections?: StagedSection[];
  telemetry: {
    durationMs: number;
    modelCalls: number;
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    repaired: boolean;
    finalized: boolean;
  };
};
```

Benefits:

- one authoritative validation boundary;
- no browser-side assembly drift;
- easier telemetry;
- easier retries/fallbacks;
- less risk that stale frontend code saves weak artifacts.

### 4. Introduce Goal Profiles

Create a structured profile beside the editable prompt text:

```ts
type GoalProfile = {
  goal: "homepage_widget" | "landing_section_set" | "collection_merchandising";
  merchantLabel: string;
  defaultDensity: "compact" | "standard" | "campaign" | "dense";
  sectionCount: { fast: [number, number]; balanced: [number, number]; bestQuality: [number, number] };
  preferredArchetypes: string[];
  requiredSignals: string[];
  forbiddenPatterns: string[];
  ctaStrategy: string;
  catalogUsage: string;
};
```

Example differences:

- Homepage Widget: "compact, useful inside a homepage, not a full funnel; prefer featured products/categories and trust strip."
- Landing Section: "campaign narrative, proof and objection handling, stronger CTA, can be taller."
- Collection Section: "dense product comparison, prices, variant/stock cues, category/product links, restrained storytelling."

Expose profile editing in admin as advanced settings, but ship strong defaults.

### 5. Reduce Preflight Context Cost

Fast mode should:

- skip browser image dimension probes unless dimensions are already known;
- cap selected products lower by default, then summarize extra items;
- include only primary product images unless the merchant explicitly selected images;
- avoid sending all categories when a specific placement/category/product context exists;
- cache context details per selection hash for the current editor session.

The current context limits allow 20 products, 50 categories, 12 collections, and 10 images (`packages/core/src/modules/ai/ai-config.ts:132-139`). Those are reasonable maximums, but fast mode needs smaller practical defaults.

### 6. Make Parallel Sections A Secondary Mode

Balanced mode should not depend on previous-section snippets. It should generate a rich plan first:

```ts
type CompositionPlan = {
  goal: string;
  classPrefix: string;
  density: string;
  visualTokens: {
    colors: Record<string, string>;
    typeScale: string;
    spacingScale: string;
    radius: string;
    buttonStyle: string;
    imageTreatment: string;
  };
  sections: Array<{
    index: number;
    archetype: "hero" | "product_grid" | "comparison" | "proof" | "faq" | "trust" | "cta";
    role: string;
    requiredRefs: string[];
    boundaryTop: "flush" | "designed_transition";
    boundaryBottom: "flush" | "designed_transition";
  }>;
};
```

Then each section can be generated independently from the plan, making parallelism safe enough:

```ts
const sections = await runWithConcurrency(plan.sections, 2, generateSectionFromPlan);
```

Do not use unlimited `Promise.all` against the AI API. It can hit the current `20/minute` admin AI rate limit (`apps/api/src/routes/admin/ai.ts`) and create noisy failures.

### 7. Finalizer Policy

Use this policy:

```ts
type FinalizerPolicy = "never" | "on_validation_issues" | "always";
```

Defaults:

- Fast: `on_validation_issues`;
- Balanced: `on_validation_issues`;
- Best quality: `always`.

Static validators should trigger finalizer/repair when they find:

- root `margin-top` or `margin-bottom`;
- large spacer blocks;
- `min-height: 100vh` or hero-scale sections in homepage/collection profiles;
- broad selectors (`body`, `html`, `:root`, `*`);
- unscoped classes;
- duplicate IDs;
- missing selected product/image refs;
- external images outside allowed/optimized hosts;
- output too large for storefront performance.

## Failure Modes And Handling

### Streamed single-pass returns malformed tags

Handling:

- keep preview visible but mark draft invalid;
- run one repair retry with exact parser error;
- if repair fails, show a concise error and preserve raw output for debugging/copy.

Do not save partial streamed output.

### Single-pass output is too large or incomplete

Handling:

- detect missing closing tags or output token exhaustion;
- auto-retry in Balanced mode with a plan and parallel sections;
- tell the user the system switched to "Balanced" because the requested output was too large for one pass.

### Model ignores goal profile

Handling:

- validators check goal-specific constraints;
- for collection mode, reject outputs without product grid/comparison when products are supplied;
- for homepage mode, flag full landing-page funnels;
- for landing mode, flag too-short one-card banners unless merchant asked for a small section.

### Parallel section fails

Handling:

- retry the failed section once;
- if one section still fails, generate a smaller fallback section from the plan;
- if required references are missing after fallback, fail the operation rather than saving a broken widget.

### Finalizer changes catalog facts

Handling:

- diff product names, prices, URLs, image URLs, and buy-now links before/after;
- reject if the finalizer invents/removes critical facts without permission;
- repair with "preserve these exact refs" prompt.

### Rate limit pressure

Handling:

- mode-aware call budget:
  - Fast: 1-2 calls;
  - Balanced: 2-5 calls with concurrency 2;
  - Best quality: 4-8 calls;
- show estimated call count before generation;
- avoid nested retries.

### Provider capability mismatch

Handling:

- if structured output is unsupported, use tag format but normalize into the same internal result type;
- if vision input is unsupported, pass image URLs as text facts;
- record provider/model/capability downgrade in telemetry.

## API And UI Settings Recommendations

### Settings Schema

Add generation settings:

```ts
generation: {
  modeDefault: "fast" | "balanced" | "best_quality" | "auto";
  streamPreviewDefault: boolean;
  finalizerPolicy: "never" | "on_validation_issues" | "always";
  parallelSectionConcurrency: number;
  fastModeMaxProducts: number;
  fastModeMaxImages: number;
  autoBalancedThresholdChars: number;
}
```

Keep existing provider/model settings, but add model profiles later:

```ts
modelProfiles: {
  planner?: { provider: string; model: string };
  generator?: { provider: string; model: string };
  finalizer?: { provider: string; model: string };
  repair?: { provider: string; model: string };
}
```

This lets merchants use fast cheaper models for drafting and stronger models only when finalization is actually needed.

### UI

The widget studio should show:

- goal selector with clear behavioral descriptions:
  - Homepage Widget: compact homepage merchandising;
  - Landing Section: campaign/funnel section set;
  - Collection Section: product comparison and collection merchandising;
- mode selector:
  - Fast;
  - Balanced;
  - Best quality;
- an estimated call count/time hint:
  - Fast: 1 model call;
  - Balanced: 1 plan + parallel sections;
  - Best quality: plan + sections + polish;
- finalizer policy as an advanced setting;
- "streaming preview" toggle enabled by default.

The current "Staged generation" toggle is too implementation-shaped. Merchants care about speed/quality, not whether the implementation is staged.

## Concrete Repo Recommendations

### Immediate No-Code Decision

Do not keep staged generation as the default. The current default contradicts the "must be very fast" requirement.

### First Implementation Slice

1. Change default generation mode to Fast.
2. Set `stagedGenerationDefault` to false or migrate it into `modeDefault: "fast"`.
3. Make simple generation use `/generate` with `stream: true`.
4. Keep final validation before enabling Accept.
5. Run one repair retry on parser/validator failure.
6. Skip browser image dimension probing in fast mode unless dimensions are already available.

Expected result: most widget generations become one LLM call instead of 4-8 calls.

### Second Implementation Slice

1. Add goal profiles for homepage/landing/collection.
2. Inject profile JSON into prompt construction.
3. Add goal-specific validators.
4. Update admin copy so users understand the differences.

Expected result: the three goal choices produce visibly and structurally different outputs.

### Third Implementation Slice

1. Build server-side `/api/v1/admin/ai/generate-widget` orchestration.
2. Move context fetching and prompt assembly to API/core.
3. Return canonical `{ html, css, diagnostics, telemetry }`.
4. Store generation timing/model-call telemetry in widget history or a generation log.

Expected result: cleaner architecture and easier production debugging.

### Fourth Implementation Slice

1. Add Balanced mode with plan + parallel sections.
2. Add `parallelSectionConcurrency`, default 2.
3. Add finalizer-on-validation policy.
4. Add section/result validators before deterministic assembly.

Expected result: long landing sections become faster than serial staged generation without losing composition control.

## Bottom Line

The current staged system solved one problem, long generation with visible progress, by creating a bigger default problem: too many serial model calls. The fastest robust default is not "better staged generation." It is a streamed single-pass composition with strong goal profiles, compact context, validation, and conditional repair.

Staged/sectioned generation should remain available, but it should be an explicit quality mode or automatic fallback for outputs that are genuinely too large for one pass. The merchant should experience the system as fast by default, deeper when requested, and clearly different for homepage, landing, and collection generation.

## Primary Source Notes

- Vercel AI SDK v6 documents structured output through `generateText` and `streamText` with the `output` property, so the long-term path should keep using SDK-level schemas/validation rather than prompt-only JSON policing: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
- The AI SDK Output reference notes that partial structured streams are deep-partial while final objects are validated, which fits a streaming preview plus final-accept validation model: https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-object
- v0's public platform API exposes chat/session, code parsing, project, deployment, and version concepts rather than a one-off prompt box. The relevant lesson for Scalius is to treat generations as tracked sessions with context, versions, repair/iteration, and deployable artifacts: https://v0.dev/docs/v0-platform-api
- Cloudflare's current Kimi K2.6 model page describes `@cf/moonshotai/kimi-k2.6` as supporting long context, vision inputs, and structured outputs. That makes it a good default for rich widget context, but not a reason to multiply serial calls by default: https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/
