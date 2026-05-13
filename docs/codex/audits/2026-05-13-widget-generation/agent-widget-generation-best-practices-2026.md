# Agent Widget Generation Best Practices 2026

Date: 2026-05-13

Scope: bounded sidecar research for Scalius LLM-powered HTML/CSS/storefront widget generation. This document is research and implementation guidance only; no application code was changed.

## Sources Read

Current repo implementation:

- `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts`
- `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts`
- `apps/admin-v2/src/components/admin/widgets/widget-form/useAiImprover.ts`
- `apps/admin-v2/src/components/admin/widgets/widget-form/ai-stream.ts`
- `apps/api/src/routes/admin/ai.ts`
- `apps/api/src/routes/admin/ai-response-validation.ts`
- `packages/core/src/modules/ai/prompt-helper-v2.ts`
- `packages/core/src/modules/ai/default-prompts.ts`
- `packages/core/src/modules/ai/ai-config.ts`
- `packages/core/src/modules/ai/ai-settings.service.ts`
- `packages/core/src/modules/widgets/widgets.service.ts`
- `apps/storefront/src/lib/widget-content.ts`
- `apps/storefront/src/components/WidgetBlock.astro`

Existing local audits:

- `docs/codex/audits/2026-05-13-widget-generation/current-staged-generator-audit.md`
- `docs/codex/audits/2026-05-13-widget-generation/fast-widget-generation-architecture.md`
- `docs/codex/audits/2026-05-13-widget-generation/llm-ui-generation-best-practices-2026.md`
- `docs/codex/audits/2026-05-13-widget-generation/official-llm-ui-generation-research.md`
- `docs/codex/audits/2026-05-13-widget-generation/prompt-differentiation-audit.md`
- `docs/codex/audits/2026-05-13-widget-generation/widget-prompt-gap-audit.md`
- `docs/codex/audits/2026-05-13-widget-generation/widget-generation-speed-and-quality-v2.md`
- `docs/codex/widget-system-ux-research-2026-05-12.md`

Official/current references:

- [Vercel AI SDK: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [Vercel AI SDK: streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
- [Vercel AI SDK UI: Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)
- [OpenAI: Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Vercel: v0 Composite Model Family](https://vercel.com/blog/v0-composite-model-family)

## Current Repo State

The current implementation is already ahead of a raw prompt-to-HTML box:

- The admin create flow fetches prompt/context in parallel, builds structured prompt messages, then chooses simple generation or staged generation in `useAiGenerator.ts` (`handleAiRequest`, lines 266-351).
- The simple path now sends `stream: true` to `/api/v1/admin/ai/generate` and reads OpenAI-style SSE deltas with `readChatCompletionStream()` (`useAiGenerator.ts` lines 371-394; `ai-stream.ts` lines 42-90).
- The API route uses Vercel AI SDK v6 primitives: `generateText`, `streamText`, and `Output.object` (`apps/api/src/routes/admin/ai.ts` lines 1-13).
- Non-streaming generation and staged planning attempt SDK structured output when the provider/model supports it, then normalize text/tag fallbacks into the same tag payload (`ai.ts` lines 671-731 and 762-806).
- `promptType` is now present in `/generate` and `/generate-staged` request schemas, and the API appends a runtime destination contract for homepage, landing, or collection output (`ai.ts` lines 76-109 and 124-173).
- Prompt assembly has distinct goal contracts and layout blueprints for `widget`, `landing-page`, and `collection` (`prompt-helper-v2.ts` lines 141-187 and 712-734).
- Generated output is normalized/sanitized in the API, widget service, and storefront render path (`ai-response-validation.ts` lines 94-170; `widgets.service.ts` lines 104-115; `widget-content.ts` lines 78-95).
- Staged generation is currently merchant/admin-controlled and defaults off in runtime settings (`ai-settings.service.ts` lines 137-144; `ai-config.ts` lines 454-463).

The remaining problem is not that Scalius has no guardrails. The problem is that the durable contract is still mostly `{ html, css }`, while the product expectation is "commerce-aware, destination-specific, responsive widget composition."

## Current Bottlenecks

1. Browser-owned orchestration remains too powerful.
   The admin still assembles prompt messages and sends them to the API. The API validates shape and appends a runtime contract, but it does not yet own the full operation from intent/context IDs through catalog serialization, manifest creation, model call, validation, repair, and canonical artifact return.

2. Streaming sacrifices SDK structured output on the common simple path.
   `/generate` uses `streamText()` for `payload.stream` and only normalizes after raw text finishes (`ai.ts` lines 911-920). That improves perceived speed, but it means the streamed path does not get `Output.object({ schema })` validation during generation. This is acceptable only if partial deltas remain non-saveable and final acceptance waits for normalization.

3. The simple stream is still buffered in the editor.
   The API streams text, but the admin calls `readChatCompletionStream()` and sets generated content only after the stream completes (`ai-stream.ts` lines 42-90; `useAiGenerator.ts` lines 393-423). So the current simple path reduces timeout risk and supports cancellation, but it does not yet show an incremental validated draft.

4. Staged mode is still serial client fan-out.
   Staged generation does plan -> section 1..N -> final polish in the React hook (`useStagedGeneration.ts` lines 703-810). A four-section landing section can require six LLM calls before final acceptance, plus nested retries.

5. Staged plans are better, but still not executable enough.
   The plan now includes `compositionBrief`, `sharedDesignSystem`, `spacingStrategy`, and `sectionContinuity`, which is a real improvement. But these are free-text fields, not typed tokens, class prefixes, section archetypes, allowed refs, CTA policy, density, or boundary invariants.

6. Widget schemas validate safety more than commerce semantics.
   `widgetOutputSchema` only requires `html` and `css` (`ai-response-validation.ts` lines 9-15). There is no required manifest proving which products, images, URLs, prices, claims, or buy-now links were used.

7. Direct save/import paths are looser than generation paths.
   Generated output is normalized in the AI routes, but widget create/update still accept `htmlContent`, `cssContent`, and broad `aiContext` shapes before service-level serialization/sanitization. Paste/import validation is mostly structural before save. This is not an immediate XSS hole because persistence/rendering sanitizers exist, but it is a quality and payload-control gap.

8. Layout quality is not a deterministic gate.
   Sanitizers reject scripts, unsafe CSS, and bad protocols, but valid CSS can still create giant gaps, full-screen mini-pages, overflow, duplicate IDs, root margins, or global-feeling design resets.

## Why Staged Sections Cause Sameness, Gaps, And Slowness

Staged generation is tempting because it feels controlled, but the current model economics and prompt dynamics work against it.

Sameness:

- Each stage receives a similar global commerce contract, tag format, and destination text. The output space collapses toward "hero/product cards/trust/CTA."
- The final saved artifact is still just `{ html, css }`, so homepage, landing, and collection outputs are not forced to carry different required roles or rejected patterns.
- The finalizer is asked to merge slices into a polished ecommerce widget. Even with destination text present, polishing can smooth away sharper differences between a compact homepage module, a campaign landing section set, and a commerce-dense collection block.

Gaps:

- Section calls optimize for locally complete chunks. Each chunk can bring its own root padding, background, min-height, border radius, CTA close, and margin rhythm.
- The assembler then wraps section chunks into a `.widget-container` / `.widget-section` composition (`useStagedGeneration.ts` lines 375-409), which can compound section-level spacing.
- The CSS boundary guard can reduce wrapper gaps, but it cannot prove visual continuity or reject root-level dead zones.
- Storefront rendering scopes CSS under a widget wrapper (`WidgetBlock.astro` lines 15-17; `widget-content.ts` lines 87-92), which is good for containment but does not lint whether the scoped CSS creates layout gaps.

Slowness:

- The staged path is serial: plan call, N section calls, optional polish call (`useStagedGeneration.ts` lines 724-810).
- Each section call can retry up to `MAX_RETRIES = 3` (`useStagedGeneration.ts` lines 42-43 and 596-617), while the API also uses AI SDK retries.
- The merchant sees progress, but the saved artifact is delayed by all stages and the polish pass.

The practical conclusion: staged generation should exist, but not as the default mental model. In 2026, the better default is a fast, streamed, single-pass whole-composition generation with strict final validation and one targeted repair attempt.

## Recommended Architecture

### Default: Fast Streamed Single-Pass

Use this for ordinary homepage widgets, small landing sections, and collection inserts.

Flow:

1. Client sends intent, not model messages:
   `{ promptType, userPrompt, placement, selectedProductIds, selectedCategoryIds, selectedCollectionIds, selectedImageIds, profile }`.
2. API fetches trusted catalog/media/site context.
3. API builds a goal-profiled prompt and commerce manifest.
4. API streams model text for perceived progress.
5. Final output is normalized, sanitized, scoped/linted, manifest-checked, and accepted only after validation.
6. If validation fails, run one repair call with exact validator errors.

This keeps the model reasoning about the whole composition in one pass and avoids `1 + N + finalizer` latency.

### Balanced: Server-Owned Structured Sections

Use this when a landing section set is too large for a single output budget.

Flow:

1. Plan once with `Output.object({ schema: compositionPlanSchema })`.
2. Generate sections with server-side limited concurrency, not browser fan-out.
3. Prefer `streamText({ output: Output.array({ element: sectionSchema }) })` only when provider support is proven reliable; AI SDK docs say completed `elementStream` items are validated, while partial object streams are not.
4. Assemble deterministically from typed plan + typed sections.
5. Run finalizer only if deterministic validators or visual checks fail.

### Best Quality: Contract-Driven Staged

Keep staged mode for complex campaign pages and high-touch merchant workflows, but treat it as explicitly slower.

Required changes:

- Move staged orchestration to the API.
- Make plan/section/finalizer schemas typed.
- Enforce one retry budget per operation.
- Emit typed events: `plan.started`, `plan.completed`, `section.completed`, `validation.warning`, `repair.started`, `final.completed`.
- Return one canonical artifact, not an OpenAI-compatible response as the internal source of truth.

### Long-Term: Widget IR And Trusted Renderers

Official AI SDK generative UI guidance frames generated UI as model-selected tools/data rendered by trusted components. Scalius should move common commerce blocks toward typed widget IR:

- `hero`
- `category_rail`
- `product_grid`
- `comparison`
- `offer_banner`
- `trust_strip`
- `buying_guide`
- `cta`

The model produces block settings and context refs. Scalius renderers produce HTML/CSS. Raw HTML/CSS remains a power-user fallback, not the safest default.

## Prompt And Schema Strategy

The user-facing choices should map to typed generation profiles, not just different prose.

| User Choice | Internal Profile | Default Shape | Required Signals | Forbidden Patterns |
| --- | --- | --- | --- | --- |
| Homepage Widget | `homepage_widget` | 1-3 compact connected bands | store/category signal, broad discovery, featured product/category links, light trust or action close | full sales funnel, long proof/FAQ, oversized landing hero, dense comparison table |
| Landing Section | `landing_section_set` | 3-6 campaign bands when requested | specific offer/promise, benefit/proof, product/collection support, objection or urgency, final CTA | generic homepage discovery, plain product grid only, category directory, weak broad CTA |
| Collection Section | `collection_merchandising` | 1-3 commerce-dense bands | collection promise, product names/prices/discounts when supplied, product/buy links, comparison or buying cues | unrelated storytelling, hero-only output, invented reviews/claims/prices, generic trust-only section |

Recommended schema direction:

```ts
type WidgetGoalProfile = {
  promptType: "widget" | "landing-page" | "collection";
  internalProfile: "homepage_widget" | "landing_section_set" | "collection_merchandising";
  sectionRange: [number, number];
  density: "compact" | "standard" | "campaign" | "commerce-dense";
  requiredRoles: string[];
  forbiddenPatterns: string[];
  ctaPolicy: "broad-navigation" | "campaign-conversion" | "product-or-buy-now";
  catalogPolicy: "provided-facts-only";
};

type WidgetGenerationArtifact = {
  html: string;
  css: string;
  goal: WidgetGoalProfile;
  manifest: {
    productIds: string[];
    categoryIds: string[];
    collectionIds: string[];
    imageIds: string[];
    hrefs: string[];
    srcs: string[];
    claims: string[];
  };
  diagnostics: {
    warnings: string[];
    repairs: string[];
    model: string;
    provider: string;
    structuredMode: "sdk" | "text";
  };
};
```

For staged mode, add:

```ts
type StagedSectionArtifact = {
  index: number;
  sectionType: "opening" | "merchandising" | "proof" | "comparison" | "guide" | "trust" | "cta";
  html: string;
  css: string;
  usedRefs: string[];
  boundary: {
    top: "flush" | "soft-divider";
    bottom: "flush" | "soft-divider";
    hasOuterMargin: boolean;
    hasViewportMinHeight: boolean;
  };
};
```

Prompt rules:

- Put stable Scalius safety and schema rules first for cacheability.
- Put catalog/media/user request in clearly delimited untrusted blocks.
- Include short positive examples and anti-examples per goal profile.
- Lower temperature for planning/repair, moderate temperature for visual drafting.
- Treat stored prompt overrides as versioned settings; stale merchant overrides can mask improved defaults.

## Validation And Security Constraints

Keep the current no-script/sanitized/scoped boundary, but add deterministic gates before preview acceptance and before save.

Required hard rejects:

- `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, external stylesheets, tracking pixels.
- Inline event handlers and `javascript:`, `vbscript:`, `file:` URLs.
- Forms, hidden inputs, destructive actions, or arbitrary JS-dependent UI.
- CSS selectors targeting `html`, `body`, `:root`, broad `*`, global `button`, or storefront shell classes.
- Fixed-position overlays, viewport-wide absolute layers, or high `z-index` elements unless the widget type explicitly allows them.
- Unsafe remote `href`, `src`, `srcset`, and CSS `url()` values outside the generated manifest.
- Product names, prices, discounts, delivery promises, reviews, ratings, stock, or buy-now links that are not in trusted context.
- Oversized `htmlContent`, `cssContent`, and `aiContext` payloads; persisted AI context should be validated against `AiContextSchema`, not only serialized as arbitrary records.

Required layout gates:

- One root wrapper with class prefix.
- No root `margin-top` / `margin-bottom`.
- No `min-height: 100vh` unless the goal profile explicitly permits a hero-like landing section.
- No empty spacer nodes, giant fixed heights, or oversized `padding-block`.
- No duplicate IDs/classes across staged sections.
- Mobile width sanity: no horizontal overflow at common widths, text fits buttons/cards, images have stable aspect ratios.

Required observability:

- Record provider, model, profile, structured mode, retries, token usage, duration, parse failures, sanitizer mutations, URL rejections, repair count, and merchant accept/reject.
- Store final diagnostics with widget history so regressions can be traced to model/prompt/schema changes.

## Concrete Implementation Steps

1. Add a new server-owned `generate-widget-v2` route while keeping the current `/generate` and `/generate-staged` compatibility routes.
2. Define `WidgetGoalProfile`, `WidgetGenerationArtifact`, `WidgetManifest`, `WidgetDiagnostics`, and `StagedSectionArtifact` schemas in the API/shared layer.
3. Move prompt assembly and catalog/media serialization from the browser toward the API. The admin should submit intent and IDs, not arbitrary system/message arrays.
4. Make fast streamed single-pass the default: one model call, final normalization, one repair attempt if validators fail.
5. Keep staged mode as explicit `balanced` or `best_quality`, and move its plan/section/finalizer orchestration server-side.
6. Add layout/CSS linting beside `ai-response-validation.ts`: root margin/min-height/spacer checks, broad selector checks, duplicate ID/class checks, and goal-profile-specific required/forbidden checks.
7. Add commerce manifest validation for generated links, images, product facts, prices, claims, and buy-now URLs.
8. Replace OpenAI-compatible text streaming for the admin editor with typed generation events over time; keep text SSE as a compatibility projection.
9. Add eval fixtures before further prompt tuning: homepage discovery widget, landing campaign, collection merchandising, image-heavy request, no-context request, Bengali/English catalog, malicious catalog text, and mobile overflow checks.
10. Pilot widget IR for common blocks after the artifact schema and validators are stable; do not persist arbitrary v0 or model-generated project code directly as storefront widgets.

## Bottom Line

The fastest path to better output is not more staged calls. It is a stricter artifact contract: whole-composition generation by default, typed goal profiles, streamed progress, deterministic validation, one targeted repair loop, and a gradual move from arbitrary HTML/CSS toward trusted commerce block renderers.
