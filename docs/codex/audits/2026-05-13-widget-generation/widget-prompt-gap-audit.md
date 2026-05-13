# Widget Prompt + Gap Audit

Date: 2026-05-13
Scope: current widget generation paths for why `Homepage Widget`, `Landing Section`, and `Collection Section` can still converge visually, and why staged sections can still render with large gaps. This is a docs-only audit; no production code was changed.

## Executive Summary

The codebase now has real destination-specific prompt text, goal contracts, and layout blueprints. The remaining problems are downstream: the selected type is still mostly client-owned prose, staged generation can reclassify or genericize the destination, one-pass generation uses the same small output budget for all creation modes, and neither API validation nor storefront rendering enforces spacing quality.

Highest-impact root causes:

1. Staged deterministic fallback misclassifies homepage and collection prompts as landing prompts because it checks generic words like `landing` and `campaign` before honoring explicit contracts.
2. The API generation contract is destination-blind; `/generate` and `/generate-staged` accept already-rendered `messages` and never receive or validate `promptType`.
3. Active placements override the user's content-goal radio, so some apparent manual mode choices are ignored by design.
4. Single-pass create uses `fastGenerationMaxOutputTokens` for every mode, making landing and collection outputs compress toward compact generic widgets unless staged mode is manually enabled.
5. Staged finalization sends only a generic "production ecommerce widget" prompt plus draft code, not the original destination contract or selected context.
6. Gap prevention is instruction-only. The API validates safe HTML/CSS, but does not reject large root padding, margins, viewport min-heights, spacer blocks, or storefront wrapper padding.

## Verified Current Flow

Create flow:

1. `AiAssistant` exposes the content-goal radio in `apps/admin-v2/src/components/admin/widgets/widget-form/AiAssistant.tsx` lines 180-208.
2. `useAiGenerator()` computes `effectivePromptType` in `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts` line 153.
3. `handleAiRequest()` fetches `getAiPrompts({ type: effectivePromptType })`, fetches context, then calls `generateStructuredPrompt(..., promptType: effectivePromptType)` in `useAiGenerator.ts` lines 285-320.
4. Simple generation posts only `{ provider, messages, model, stream: true }` to `/api/v1/admin/ai/generate` in `useAiGenerator.ts` lines 370-380.
5. Staged generation posts planned/generated/finalized message arrays to `/api/v1/admin/ai/generate-staged` from `useStagedGeneration.ts` lines 439-449, 544-555, and 653-663.
6. The API routes use the provided message arrays directly in `apps/api/src/routes/admin/ai.ts` lines 686-688 and 750-752.

Prompt assembly:

- Defaults are distinct in `packages/core/src/modules/ai/default-prompts.ts` lines 5-72.
- Additional destination contracts and blueprints are appended in `packages/core/src/modules/ai/prompt-helper-v2.ts` lines 141-187.
- `generateStructuredPrompt()` appends the type-specific contract, then shared composition, speed, JSON, buy-now, catalog, and request blocks in `prompt-helper-v2.ts` lines 688-727.

Storefront rendering:

- `WidgetPlacementZone` passes `itemClass` straight to each `WidgetBlock` in `apps/storefront/src/components/WidgetPlacementZone.astro` lines 28-38.
- `WidgetBlock` wraps generated content in `widget-container cms-widget-frame {scopeClass}` and injects scoped CSS in `apps/storefront/src/components/WidgetBlock.astro` lines 15-17.
- CSS is sanitized and scoped in `apps/storefront/src/lib/widget-content.ts` lines 78-95.

## Root Causes

### P1: Staged deterministic fallback is biased to landing

Function: `createDeterministicPlan()` in `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts`.

The fallback reads the rendered prompt text and computes:

- `wantsLanding = hasLandingContract || promptText.includes('landing page designer') || promptText.includes('landing') || promptText.includes('campaign')` at lines 141-142.
- `wantsHomepage` and `wantsCollection` are evaluated after that at lines 143-151.
- `totalSections` and the section plan prefer landing whenever `wantsLanding` is true at lines 152-159.

Current homepage and collection prompts contain negative instructions using those same words:

- Homepage contract says "not a full campaign page" and "landing-page heroes" in `prompt-helper-v2.ts` lines 142-148.
- Collection contract says "not ... generic landing campaign" and "campaign storytelling" in `prompt-helper-v2.ts` lines 158-163.
- Default homepage prompt says "Do not generate a full landing page" in `default-prompts.ts` line 14.
- Default collection prompt says "Do not create unrelated campaign storytelling" in `default-prompts.ts` line 59.

Impact: when staged plan creation fails or returns invalid JSON, the deterministic fallback can turn all three modes into the landing plan. This is the clearest code-level explanation for similar-looking staged output.

### P1: The API cannot enforce the selected destination

Functions/routes: `generateSchema`, `generateStagedSchema`, `/generate`, `/generate-staged` in `apps/api/src/routes/admin/ai.ts`.

Neither request schema has `promptType`; they only accept `messages`/`prompt`, provider/model, operation, and staged fields at lines 72-103. The route handlers then call `normalizeMessages(payload.messages)` directly at lines 686-688 and 750-752.

Impact: the server cannot tell whether the message array was built for `widget`, `landing-page`, or `collection`, cannot choose token budgets by destination, cannot require destination-specific plan shapes, and cannot guard finalization/retries against drifting into generic widget output.

### P1: Placement-derived prompt type can hide manual choices

Functions/components: `getPlacementAiContext()` in `apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx`, `useAiGenerator()`, and `AiAssistant`.

`getPlacementAiContext()` maps active placements to a suggested type:

- collection scope or `before_collection`/`after_collection` slot -> `collection`
- page/product/category scope -> `landing-page`
- otherwise -> `widget`

This logic is in `WidgetForm.tsx` lines 179-225. `useAiGenerator()` then makes the placement suggestion authoritative whenever any active placement exists at line 153. The radio UI is disabled when this happens in `AiAssistant.tsx` lines 182-208.

Impact: if a merchant tests the three labels while an active placement exists, their selected radio value may not be the type used for generation. The UI explains this, but it is easy to mistake placement-derived output for prompt-type output. It also means homepage widgets anchored before/after a homepage collection are treated as collection sections.

### P1: One-pass create compresses every destination through the same fast budget

Functions: `DEFAULT_WIDGET_AI_CONFIG`, `shouldUseStagedGeneration()`, and `/generate`.

Defaults set `fastGenerationMaxOutputTokens: 2200`, `maxOutputTokens: 8000`, and `stagedGenerationDefault: false` in `packages/core/src/modules/ai/ai-settings.service.ts` lines 137-143. Simple create uses the fast budget for every non-improvement operation in `apps/api/src/routes/admin/ai.ts` lines 698-701. Staged mode is only used when the toggle is enabled because `shouldUseStagedGeneration()` returns `userEnabled` and ignores prompt length in `packages/core/src/modules/ai/ai-config.ts` lines 455-463; the caller passes the estimate at `useAiGenerator.ts` line 323, but the helper discards it.

Impact: a landing section set and a collection merchandising block both have to fit the same compact output envelope as a homepage module unless staged mode is manually enabled. The model will naturally converge on short hero/product/trust/CTA shapes.

### P1: Staged finalization is destination-neutral

Function: `finalizeComposition()` in `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts`.

The finalizer prompt starts with "You are the final composition editor for a production ecommerce widget" and receives only `describePlan(plan)` plus the drafted staged sections at lines 631-650. It posts `messages: [finalizerPrompt]` to `/generate-staged` at lines 653-663.

Impact: finalization can wash away type-specific semantics because it does not receive the original `GOAL_CONTRACTS[promptType]`, `LAYOUT_BLUEPRINTS[promptType]`, selected catalog context, or merchant request as first-class state. If the plan already drifted, the finalizer reinforces the drift.

### P2: Stored prompt overrides can preserve old/similar prompts indefinitely

Functions/UI: `getWidgetAiPrompts()` and `WidgetAiSettingsBuilder`.

`getWidgetAiPrompts()` returns the stored settings-table prompt if present, otherwise the current fallback in `packages/core/src/modules/ai/ai-settings.service.ts` lines 448-456. Saving prompts writes whatever is in the settings UI back into the same keys at lines 587-596. The settings UI exposes reset buttons at `apps/admin-v2/src/components/admin/settings/WidgetAiSettingsBuilder.tsx` lines 765-793, but there is no versioning or stale-default detection.

Impact: if the local database already saved older generic prompts, edits to `DEFAULT_AI_PROMPTS` will not affect runtime generation until the prompts are reset or rewritten in settings. This can make current code look ineffective even though defaults differ.

### P2: Shared prompt weight still dilutes mode differences

Function: `generateStructuredPrompt()` in `packages/core/src/modules/ai/prompt-helper-v2.ts`.

The type-specific pieces are appended at lines 689-691, then every mode receives the same composition, speed, JSON, buy-now, catalog, image, and request structure at lines 692-727. The shared `FAST GENERATION BUDGET` also says homepage is 1-2 bands, landing uses more narrative only when asked, and collection should stay concise in `packages/core/src/modules/ai/ai-config.ts` lines 168-173.

Impact: this is not wrong for safety, but it pushes all modes toward "compact, polished, safe commerce block." Without downstream enforcement, the strongest common denominator wins.

### P2: Gap prevention is not validated

Functions: `generateWidgetContent()`, `normalizeWidgetGenerationText()`, `assertGeneratedWidgetIsSafe()`.

`normalizeWidgetGenerationText()` parses tag/JSON output, sanitizes it, and rejects scripts in `apps/api/src/routes/admin/ai-response-validation.ts` lines 88-152. It does not reject:

- root `margin-top`/`margin-bottom`;
- oversized `padding-block`;
- `min-height: 100vh` or large fixed heights;
- empty spacer elements;
- section roots that behave like full-screen independent pages;
- CSS that creates visible separation through background/radius resets.

Impact: the generator can obey the syntactic contract and still produce large visual gaps.

### P2: Staged gap guards are weak and sometimes ineffective after scoping

Functions: `buildCombinedWidget()`, `applyCompositionBoundaryGuard()`, storefront `scopeCss()`.

The fallback combiner wraps sections and sets `.widget-container { gap: 0; margin: 0; }`, `.widget-section { margin: 0; }`, and first/last child margin resets in `useStagedGeneration.ts` lines 362-390. The finalizer appends a similar boundary guard at lines 46-60 and 670-671.

The guard only targets `.widget-container`. In storefront, generated CSS is scoped under the outer widget scope class in `apps/storefront/src/lib/widget-content.ts` lines 87-92, while the outer wrapper itself is `<div class="widget-container cms-widget-frame {scopeClass}">` in `WidgetBlock.astro` line 15. A scoped selector like `.sw-id .widget-container` targets a descendant `.widget-container`, not the outer wrapper. If the finalizer changes the generated root to a non-`.widget-container` class, the appended guard is dead CSS in storefront.

Impact: the guard helps fallback staged markup that keeps an inner `.widget-container`, but it does not reliably normalize the actual rendered root.

### P2: Storefront placement wrappers add their own spacing

Components/pages: `WidgetPlacementZone`, homepage, collection, category, product, and CMS pages.

`WidgetPlacementZone` passes `itemClass` to the wrapper around each widget in `WidgetPlacementZone.astro` lines 28-38. Some placements intentionally add spacing:

- Homepage before/after collection: `mb-2` and `mt-2` in `apps/storefront/src/pages/index.astro` lines 77-99.
- Collection page before/after/bottom: `py-3` wrappers in `apps/storefront/src/pages/collections/[id].astro` lines 157-194.
- Category page before/after/bottom: `py-3` wrappers in `apps/storefront/src/pages/categories/[slug].astro` lines 269-275 and 482-496.
- Product page before/after/bottom: `py-2` wrappers in `apps/storefront/src/pages/products/[slug].astro` lines 240-270.
- CMS page normal layout: `mb-8` and `mt-8` wrappers in `apps/storefront/src/pages/[slug].astro` lines 193-210.

Impact: even a zero-gap generated widget can appear to have large gaps when combined with page wrapper padding/margins and generated internal padding. This is especially visible for staged sections that already include self-contained vertical rhythm.

### P3: Improvement UI can display one prompt type while generation uses another

Components/hooks: `FullScreenEditor`, `WidgetForm`, `useAiImprover`.

`WidgetForm` passes `promptType={aiGenerator.promptType}` and `setPromptType={aiGenerator.setPromptType}` to `FullScreenEditor` at lines 1009-1011. But `useAiImprover()` fetches prompts with `aiGenerator.effectivePromptType` at `apps/admin-v2/src/components/admin/widgets/widget-form/useAiImprover.ts` line 114 and passes `promptType: aiGenerator.effectivePromptType` to `generateStructuredPrompt()` at lines 200-205.

Impact: with active placements, the improvement panel can show/change the raw radio state while the actual generation still uses the placement-derived type. This is less likely to affect first generation, but it contributes to confusion when comparing output types.

## Prioritized Fixes

### 1. Make destination first-class in the API contract

Add `promptType: z.enum(["widget", "landing-page", "collection"])` to `/generate` and `/generate-staged`, and move prompt assembly toward a server-owned request shape. At minimum, the API should log and validate `promptType`, choose budgets by destination, and pass it into staged planning/finalization/retry helpers.

Files/functions:

- `apps/api/src/routes/admin/ai.ts` `generateSchema`, `generateStagedSchema`, route handlers
- `packages/core/src/modules/ai/prompt-helper-v2.ts` `generateStructuredPrompt()`
- `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts` `handleAiRequest()`
- `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts` staged request bodies

### 2. Fix staged deterministic type detection immediately

Change `createDeterministicPlan()` to prioritize explicit contracts:

1. if `hasHomepageContract`, use homepage;
2. else if `hasLandingContract`, use landing;
3. else if `hasCollectionContract`, use collection;
4. only then consider merchant request heuristics.

Do not treat negative words like "avoid landing" or "not campaign" as positive landing intent.

File/function: `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts` `createDeterministicPlan()`.

### 3. Pass destination contract into every staged stage

Planning, section generation, retries, and finalization should all receive an explicit destination contract, not just prose embedded in the original message.

The finalizer should preserve:

- homepage: compact discovery/module rhythm;
- landing: campaign promise/proof/conversion flow;
- collection: product-dense comparison/merchandising flow.

Files/functions:

- `useStagedGeneration.ts` `createPlanningMessages()`, `generateSection()`, `finalizeComposition()`
- `apps/api/src/routes/admin/ai.ts` `addStagedPlanRetryInstruction()`
- `packages/core/src/modules/ai/prompt-helper-v2.ts` `GOAL_CONTRACTS`, `LAYOUT_BLUEPRINTS`

### 4. Scale generation budget and staging policy by destination

Landing section sets should either default to staged generation or receive a larger one-pass budget. Collection sections with product grids should also have a larger or product-count-aware budget. The dead `autoEnableThreshold` should either be removed or honored.

Files/functions:

- `packages/core/src/modules/ai/ai-settings.service.ts` `DEFAULT_WIDGET_AI_CONFIG`
- `packages/core/src/modules/ai/ai-config.ts` `shouldUseStagedGeneration()`
- `apps/api/src/routes/admin/ai.ts` generation `maxOutputTokens`
- `useAiGenerator.ts` call site around `shouldUseStagedGeneration()`

### 5. Add deterministic gap linting before Accept/Save

Introduce a shared widget layout lint for generated artifacts. It should warn or reject known gap creators:

- root margins;
- `min-height: 100vh`, `height: 100vh`, and very large fixed heights;
- oversized top/bottom padding;
- empty spacer-only nodes;
- wrapper CSS that sets nonzero `.widget-container` gaps;
- finalizer roots that do not match the boundary guard selector.

Files/functions:

- `apps/api/src/routes/admin/ai-response-validation.ts`
- `packages/shared/src/html-section-parser.ts`
- `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts`
- `apps/storefront/src/lib/widget-content.ts`

### 6. Normalize placement wrapper spacing by slot

For storefront-rendered widgets, decide whether spacing belongs to the page slot or to generated content. If the goal is "zero gap", remove or reduce `itemClass` padding/margins for slots that are intended to visually attach to page content, especially collection/category `before_content`, `after_content`, and CMS `mb-8`/`mt-8`.

Files:

- `apps/storefront/src/pages/collections/[id].astro`
- `apps/storefront/src/pages/categories/[slug].astro`
- `apps/storefront/src/pages/products/[slug].astro`
- `apps/storefront/src/pages/[slug].astro`
- `apps/storefront/src/components/WidgetPlacementZone.astro`

### 7. Add prompt/settings freshness diagnostics

Expose whether each runtime prompt is default or customized, and add a "Reset all prompts to current defaults" action. Optionally store default prompt version hashes so old generic saved prompts are visible.

Files/functions:

- `packages/core/src/modules/ai/ai-settings.service.ts` `getWidgetAiPrompts()`, `maskWidgetAiAdminSettings()`
- `apps/admin-v2/src/components/admin/settings/WidgetAiSettingsBuilder.tsx`

## Verification Targets After Fixes

- Unit: staged fallback returns homepage for a homepage prompt containing "do not generate a landing page".
- Unit: staged fallback returns collection for a collection prompt containing "avoid landing campaign".
- Unit: API rejects or warns on generated root `margin-top`, large `padding-block`, and `min-height: 100vh`.
- UI: with no placement, switching the three content goals changes `promptType` and produces different prompt headers.
- UI: with active placement, the disabled radio clearly shows "derived from placement" and the improvement panel shows the effective type, not stale raw type.
- Browser/storefront: generated widgets render in homepage, collection, category, product, and CMS slots without unintended double spacing from both wrapper `itemClass` and internal generated padding.
