# Prompt Differentiation Audit

Date: 2026-05-13
Scope: why `Homepage Widget`, `Landing Section`, and `Collection Section` can produce similar-looking widgets, plus concrete prompt/schema changes to make each mode visually and structurally distinct.

## Executive Summary

The three content goals do fetch different default system prompts, but the generation pipeline weakens those differences after the first prompt block.

The biggest causes are:

1. The actual assembled prompt has one type-specific intro followed by a large shared composition contract, shared output format, shared catalog context, and shared staged-generation instructions.
2. Staged generation introduces a generic planner/finalizer around every goal. The planner only gives loose destination examples, and the finalizer calls everything a generic "production ecommerce widget."
3. The system has no explicit machine-readable `destinationSpec` or required/forbidden pattern contract. The selected goal is only implied by prose in the chosen system prompt.
4. The retry prompt for staged plans hardcodes a homepage example, which can bias failed landing/collection plan retries toward homepage-like outputs.
5. The UI label says `Landing Section`, while settings/default prompt language says `landing page`/`complete landing page section set`; that ambiguity encourages landing outputs to look like multi-band homepage blocks instead of a focused campaign module.

The fix should not be another patchy sentence. The model needs a small, explicit destination contract injected into prompt assembly and staged planning/finalization. That contract should define information architecture, layout archetypes, density, CTA behavior, and anti-patterns for each destination.

## Verified Flow

- The content goal radio sets `promptType` in `AiAssistant.tsx`.
- If a widget has active placements, `effectivePromptType` ignores the radio value and uses placement-derived intent in `useAiGenerator.ts`.
- `useAiGenerator.ts` fetches `/api/v1/admin/ai-prompts?type={effectivePromptType}` and passes the returned prompt into `generateStructuredPrompt()`.
- `prompt-helper-v2.ts` prepends that system prompt, then appends the same global `COMPOSITION CONTRACT`, response format, buy-now link rules, catalog context, and user prompt for every type.
- If staged mode is enabled, `useStagedGeneration.ts` replaces direct generation with plan -> section 1..N -> final polish.
- The staged planner/finalizer are generic; they do not receive a typed destination schema other than prose already present in the prompt text.

Key files:

- `/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/ai/default-prompts.ts`
- `/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/ai/prompt-helper-v2.ts`
- `/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/ai/ai-config.ts`
- `/Users/arob/Desktop/open/scalius-commerce-lite/packages/core/src/modules/ai/ai-settings.service.ts`
- `/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts`
- `/Users/arob/Desktop/open/scalius-commerce-lite/apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts`
- `/Users/arob/Desktop/open/scalius-commerce-lite/apps/api/src/routes/admin/ai.ts`

## Current Differentiation That Exists

The defaults are not identical:

- `widget` says homepage widget, store understanding, featured collections, product/category discovery, trust/urgency, final CTA.
- `landing-page` says campaign page, offer/product line/audience promise, funnel structure, proof, objection handling, urgency, final CTA.
- `collection` says collection merchandising, product comparison, prices, discounts, availability cues, variant cues, product cards, buying guide.

The tests currently verify that these default prompts contain mode-specific substrings in `default-prompts.test.ts`.

This is good, but it is shallow. It proves the defaults contain distinct words. It does not prove the final assembled prompts or staged plans produce distinct page architecture.

## Why Outputs Still Look Similar

### 1. The shared prompt weight is too high

In `prompt-helper-v2.ts`, every mode becomes:

1. selected default prompt
2. same `COMPOSITION CONTRACT`
3. same tag response format
4. same buy-now link rules
5. same product/category/collection/image context
6. same merchant request

The global contract repeats "one continuous composition", "shared design tokens", "avoid gaps", "not standalone website", and "use catalog facts." Those are valid safeguards, but they are generic enough to make homepage, landing, and collection converge into the same polished commerce-section shape.

Recommendation: keep the global safety contract, but add a typed `DESTINATION CONTRACT` immediately after the selected system prompt and before the global composition contract.

### 2. The selected goal is implicit prose, not structured generation state

`generateStructuredPrompt()` receives `systemPrompt`, but not `promptType`. Once the default prompt is in the message, downstream code must infer the destination from text.

That becomes fragile in staged generation:

- The planner sees a long prompt and has to infer mode from prose.
- The deterministic fallback searches for terms like `collection`, `products`, and `homepage`.
- The finalizer gets a generic editor role and a plan, not a first-class destination type.

Recommendation: pass `promptType` through prompt assembly and staged-generation APIs as explicit metadata. Use it to inject destination-specific contract text and validate the plan shape.

### 3. Staged planner examples overlap too much

The current staged planning guidance says:

- Homepage: offer/category signal, featured products/categories, trust/urgency, CTA.
- Landing: hero/offer, product/collection showcase, proof, objection handling, urgency, final CTA.
- Collection: collection intro, product grid/comparison, buying guide, CTA/trust strip.

Those all contain some version of hero/offer, product showcase, trust/urgency, CTA. A model will naturally converge to similar layouts unless the prompt explicitly defines different architecture and anti-patterns.

Recommendation: make the planner return a `destinationArchitecture` object with required and forbidden patterns.

### 4. Staged plan retry is homepage-biased

`addStagedPlanRetryInstruction()` uses this example:

```json
{
  "compositionBrief": "One continuous homepage merchandising widget",
  "sectionDescriptions": ["Hero", "Product showcase", "CTA"]
}
```

That retry happens after a validation failure, exactly when the model is already unstable. For landing or collection generation, this pushes the repair attempt toward homepage structure.

Recommendation: retry instructions must either include the current `promptType` or avoid destination-specific examples entirely. Better: generate the retry example from a destination spec.

### 5. Finalizer is destination-neutral

The finalizer prompt says "production ecommerce widget" and asks it to merge staged slices. It preserves continuity, but not destination semantics.

That can wash out distinctions:

- A landing page can be shortened into a generic widget.
- A collection page can be made more "polished" with hero/trust/CTA patterns.
- A homepage widget can become a campaign section set.

Recommendation: finalizer must receive and enforce the same destination contract as the planner/generator.

### 6. UI wording is inconsistent

The create UI says:

- `Homepage Widget`
- `Landing Section`
- `Collection Section`

Settings says:

- `Homepage Widget`
- `Landing Page`
- `Collection Page`

Default prompt says landing should create a "complete ... landing page section set." This means the merchant thinks they selected one section, but the model hears "complete landing page section set." That can create similar multi-band outputs across all three modes.

Recommendation: rename the mode consistently or split modes:

- `Homepage Module`
- `Landing Page Section Set`
- `Collection Merchandising Block`

Or keep the existing labels but inject unambiguous internal contracts.

### 7. Placement override can hide the user's choice

If active placements exist, `effectivePromptType` is placement-derived:

- collection placement or before/after collection slot -> `collection`
- page/product/category placement -> `landing-page`
- otherwise -> `widget`

The radio is disabled and shows the derived value, which is reasonable. But the placement summary sent to the model is only an ID-based string such as `page top target page_x`. It does not say what that page is about, what page role it plays, or what slot-specific layout should do.

Recommendation: enrich placement context with semantic target labels/slugs and slot obligations:

- top of page: opener, but not duplicate site header
- bottom of page: closing CTA/trust/help section
- product page: product-supporting module, not broad campaign page
- category page: category merchandising/filter-support module

## Recommended Prompt Architecture

Add a destination contract object near `default-prompts.ts` or `ai-config.ts`:

```ts
export const DESTINATION_CONTRACTS = {
  widget: {
    label: "Homepage module",
    purpose: "Help shoppers orient, discover categories/products, and take one broad next action inside an existing homepage.",
    structure: ["store/category signal", "featured discovery", "trust/offer/CTA"],
    density: "compact to medium; reusable homepage band or small connected band set",
    primaryLayouts: ["editorial category strip", "featured product rail", "offer + discovery split", "trust strip"],
    requiredSignals: ["store/category clarity", "broad navigation CTA", "homepage-safe copy"],
    forbiddenPatterns: ["full campaign funnel", "long objection handling", "dense product comparison table", "checkout-focused single-offer pressure"]
  },
  "landing-page": {
    label: "Campaign landing section set",
    purpose: "Move one audience/offer/product-line from promise to proof to conversion inside the storefront shell.",
    structure: ["specific offer hero", "benefits/proof", "selected product/collection offer", "objection handling", "urgency/final CTA"],
    density: "medium to immersive; stronger narrative and conversion pressure than homepage",
    primaryLayouts: ["offer hero", "benefit grid", "proof band", "comparison/objection cards", "final CTA band"],
    requiredSignals: ["specific promise", "reason to act now", "conversion CTA repeated with restraint"],
    forbiddenPatterns: ["generic store discovery", "category directory", "plain product listing", "homepage-style broad browse CTA"]
  },
  collection: {
    label: "Collection merchandising block",
    purpose: "Help shoppers compare products in a collection/category and move to product detail or buy-now.",
    structure: ["collection promise", "product grid/comparison", "buying guide/filter cues", "compact trust/action strip"],
    density: "compact, scan-first, product-information-forward",
    primaryLayouts: ["product card grid", "comparison row", "buying-guide sidebar", "availability/price badges"],
    requiredSignals: ["product names", "prices", "discounts when supplied", "availability/variant cues", "product/buy links"],
    forbiddenPatterns: ["oversized hero-only design", "campaign storytelling without product cards", "generic trust-only section", "invented reviews or claims"]
  }
} as const;
```

Then inject a rendered version:

```text
DESTINATION CONTRACT: Collection merchandising block
Purpose: Help shoppers compare products in a collection/category and move to product detail or buy-now.
Expected structure: collection promise -> product grid/comparison -> buying guide/filter cues -> compact trust/action strip.
Density: compact, scan-first, product-information-forward.
Use layout archetypes: product card grid, comparison row, buying-guide sidebar, availability/price badges.
Must include when context exists: product names, prices, discounts, availability/variant cues, product and buy-now links.
Avoid: oversized hero-only design, campaign storytelling without product cards, generic trust-only section, invented reviews or claims.
```

## Concrete Default Prompt Changes

### Homepage Widget

Replace the broad "surface timely offers..." style with a stronger contract:

```text
You are designing a HOMEPAGE MODULE, not a landing page and not a collection listing.

The output should feel like a reusable homepage band or compact connected band set. Its job is broad orientation and discovery: show what the store/selection is about, help shoppers browse categories or featured products, and provide one clear next action.

Homepage modules should usually use one of these patterns:
- store/category signal + featured product rail
- offer banner + category tiles
- new arrivals / featured collection module
- trust strip connected to a discovery CTA

Do not produce a full funnel, long objection handling, dense comparison table, or single-offer landing page unless the merchant explicitly asks.
```

### Landing Section

Make it explicitly campaign/funnel-driven:

```text
You are designing a LANDING PAGE SECTION SET inside the storefront shell.

The output should be campaign-specific and conversion-oriented. It should sell one offer, audience promise, product line, or collection. It should not behave like a generic homepage discovery block.

Landing sections should usually progress through:
1. specific offer/promise hero
2. benefit or outcome proof
3. selected product/collection offer
4. objection handling, comparison, guarantee, or trust
5. urgency/final CTA

Use repeated but restrained CTAs. Do not create broad category browsing, generic store intro, or a plain product grid unless the merchant requests it.
```

### Collection Section

Make it product-information-first:

```text
You are designing a COLLECTION MERCHANDISING BLOCK for a category/collection/product-listing context.

The output should help shoppers compare and choose. Product information is the hero: names, images, prices, discounts, availability cues, variants, category context, product links, and buy-now links when supplied.

Collection sections should usually use:
- compact collection intro
- product card grid or comparison layout
- buying guide/filter cue strip
- compact trust or action footer

Do not create a campaign landing funnel, oversized hero-only design, generic homepage discovery section, or invented reviews/claims.
```

## Recommended Staged Plan Schema Changes

Current plan shape:

```ts
{
  totalSections,
  compositionBrief,
  sharedDesignSystem,
  spacingStrategy,
  sectionDescriptions,
  sectionContinuity,
  estimatedTokens
}
```

Recommended additions:

```ts
{
  destinationType: "widget" | "landing-page" | "collection",
  destinationLabel: string,
  informationArchitecture: string[],
  requiredElements: string[],
  forbiddenElements: string[],
  conversionStrategy: string,
  density: "compact" | "medium" | "immersive",
  layoutArchetype: string,
  sectionDescriptions: string[],
  sectionContinuity: string[]
}
```

Validation rules:

- `destinationType` must equal the selected/effective prompt type.
- `informationArchitecture.length` should match or explain `sectionDescriptions`.
- Collection plans should require at least one product-information section when products/collections exist.
- Landing plans should require a campaign promise and proof/objection/CTA sections.
- Homepage plans should reject long funnel language unless the merchant prompt explicitly asks for a landing page.

## Recommended Staged Planner Text

Replace the generic destination bullets with:

```text
You are planning a {DESTINATION_LABEL}. Use this exact destination contract:
{RENDERED_DESTINATION_CONTRACT}

Return ONLY JSON with:
- destinationType: "{promptType}"
- layoutArchetype: one specific archetype from the destination contract
- informationArchitecture: the shopper journey for this destination
- requiredElements: concrete elements this output must include from context
- forbiddenElements: concrete elements this output must avoid
- sectionDescriptions: progressive slices of the same composition
- sectionContinuity: how each slice connects without becoming a separate widget

Do not choose the same architecture you would choose for another destination type.
```

## Recommended Section Generation Text

Add destination enforcement before current section requirements:

```text
Destination type: {promptType}
Destination contract:
{RENDERED_DESTINATION_CONTRACT}

Current section role inside this destination: {sectionDescription}
This section must satisfy these destination-specific requirements:
{requiredElements}

Do not include these destination anti-patterns:
{forbiddenElements}
```

## Recommended Finalizer Text

Replace "production ecommerce widget" with:

```text
You are the final composition editor for a {DESTINATION_LABEL}.

Your job is to polish the drafted staged slices into one final {DESTINATION_LABEL} while preserving the destination architecture below:
{informationArchitecture}

Do not convert this into a generic ecommerce widget. Keep the output recognizably different from:
- homepage module
- landing page section set
- collection merchandising block
whichever are not the selected destination.
```

## Recommended Retry Fix

Replace the hardcoded homepage retry example with a destination-neutral shape or a dynamic one.

Better dynamic retry:

```text
Return ONLY valid JSON for destinationType "{promptType}".
Use the destination contract below:
{RENDERED_DESTINATION_CONTRACT}

Shape:
{
  "destinationType": "{promptType}",
  "layoutArchetype": "...",
  "informationArchitecture": ["..."],
  "requiredElements": ["..."],
  "forbiddenElements": ["..."],
  "totalSections": 3,
  "compositionBrief": "...",
  "sharedDesignSystem": "...",
  "spacingStrategy": "...",
  "sectionDescriptions": ["..."],
  "sectionContinuity": ["..."]
}
```

## Speed-Related Finding

The current staged path is inherently slow:

```text
plan call -> section 1 call -> section 2 call -> ... -> section N call -> finalizer call
```

With a 4-section landing output, that is 6 model calls. Each section can retry up to 3 times with exponential waits, and there is a 500 ms delay between sections. This is why generation feels painfully slow even when each individual model call is healthy.

Recommendation:

- Default to single-pass generation for normal widgets.
- Keep staged generation as an explicit "large page set" mode.
- Add a fast path that asks for one complete widget using the destination contract and only uses staged mode when:
  - merchant selects "large multi-section page",
  - prompt/context exceeds a real token threshold,
  - or first single-pass response fails validation/size constraints.
- For progressive UX without multiple LLM calls, stream the single-pass response and render when `<htmljs>` and `<css>` are complete, or use server-side skeleton/progress states.

Current settings already show the right direction: `stagedGenerationDefault` is false in `DEFAULT_WIDGET_AI_CONFIG`, and the settings UI explains staged generation is slower and useful for unusually large section sets.

## Test Coverage Gaps

Add tests that prove mode differentiation at the assembled-prompt level, not just default substrings:

1. `generateStructuredPrompt` with `promptType: "widget"` contains homepage contract and forbids landing/collection anti-patterns.
2. `generateStructuredPrompt` with `promptType: "landing-page"` contains campaign/funnel contract and forbids generic homepage/category-directory output.
3. `generateStructuredPrompt` with `promptType: "collection"` contains product-card/comparison requirements and forbids oversized hero-only/campaign-only output.
4. Staged plan retry instruction should not contain `"homepage"` unless `promptType === "widget"`.
5. Finalizer prompt should contain the selected destination label and required/forbidden elements.
6. Placement-derived prompt type should be tested for homepage/page/product/category/collection placements, including label/summary generation.

## Priority Implementation Plan

1. Add `DESTINATION_CONTRACTS` and render helper in core AI module.
2. Pass `promptType` into `generateStructuredPrompt()` and staged generation calls.
3. Inject rendered destination contract after the selected system prompt.
4. Extend staged plan schema with `destinationType`, `layoutArchetype`, `informationArchitecture`, `requiredElements`, and `forbiddenElements`.
5. Replace staged retry/finalizer text with destination-aware versions.
6. Simplify default prompts so they point to the destination contract instead of duplicating generic safety language.
7. Add assembled-prompt and staged-plan tests.
8. Keep staged generation default off and make the UI copy clear: fast single-pass is normal; staged is for large page sets.

## Bottom Line

The three modes look similar because they are only differentiated by prose at the beginning of a much larger shared prompt pipeline. The system needs a first-class destination contract that survives prompt assembly, staged planning, section generation, finalization, retries, saved context, and tests.

The best long-term fix is not "make the three default prompts longer." It is to make destination type a structured contract throughout the generation pipeline.
