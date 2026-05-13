# Post-Deploy Staged Widget Generation Audit

Audited commit: `c8ce2ccd` (`Fix staged widget composition generation`)
Date: 2026-05-13
Scope: staged widget generation after the composition-plan and finalizer changes. This audit is docs-only and is based on the current implementation, not stale comments.

## Executive Summary

The recent implementation is directionally correct: staged generation now asks for a composition plan, combines progressive previews with `gap: 0`, adds a final composition pass, and validates/sanitizes API output before returning it. The remaining risks are mostly lifecycle and verification problems, not one-line CSS issues.

The highest-priority next fixes should be:

1. Keep saved `aiContext.stagedSections` synchronized with the final polished widget, not the pre-finalizer draft.
2. Add a deliberate repair/migration path for already-saved widgets that contain old staged wrapper gaps.
3. Resolve the staged plan schema/prompt mismatch around `estimatedTokens`.
4. Add deterministic post-generation checks for gap/style regressions and catalog preservation.
5. Reduce staged generation request/retry pressure so one rich widget does not trip admin AI rate limits.

## Findings

### P1: Finalized widget content and saved staged metadata can diverge

`useStagedGeneration.startStagedGeneration()` generates draft sections, builds a fallback widget, then optionally replaces the returned artifact with `polishedWidget` from `finalizeComposition()` ([useStagedGeneration.ts:697](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L697)-[728](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L728)). However, the hook state still keeps `sections` as the original generated slices ([useStagedGeneration.ts:680](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L680)-[683](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L683)).

On save, `WidgetForm` persists `stagedPlan` and `stagedSections` from hook state ([WidgetForm.tsx:759](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L759)-[784](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L784)), while the actual saved `htmlContent/cssContent` may be the finalizer's rewritten one-root widget. Reopening the widget reloads those old sections into the editor ([WidgetForm.tsx:423](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L423)-[456](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L456)), and the section list for improvement comes from stale staged sections ([WidgetForm.tsx:811](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L811)-[829](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L829)).

Why this matters: a merchant may save the polished widget, later edit "Section 2", and actually improve a pre-polish section that no longer matches the storefront artifact. That can reintroduce gaps or overwrite the finalizer's cohesion.

Recommended fix: after finalization succeeds, parse the final artifact into the current section model or mark `stagedSections` as finalized-derived. Also update `replaceWidgetContent()` so accepted finalizer output refreshes sections even when `stagedGeneration.sections.length > 0` ([WidgetForm.tsx:860](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L860)-[874](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L874)).

### P1: Existing saved widgets with old gap CSS are not repaired

The new combiner uses `gap: 0` ([useStagedGeneration.ts:314](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L314)-[344](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L344)), and storefront sanitizes/scopes widget CSS on render ([widget-content.ts:78](../../../../apps/storefront/src/lib/widget-content.ts#L78)-[94](../../../../apps/storefront/src/lib/widget-content.ts#L94)). But render-time preparation intentionally preserves valid CSS; it does not rewrite old `.widget-container { gap: ... }` rules.

That means widgets generated before this fix can keep visible white gaps forever unless edited/regenerated or explicitly repaired. This matches the production symptom: code changes fix future generation, but existing widget artifacts remain data debt.

Related risk: the shared `reconstructWidgetFromSections()` helper still bakes in legacy gaps of `2rem`, `1.5rem`, and `1rem` ([html-section-parser.ts:295](../../../../packages/shared/src/html-section-parser.ts#L295)-[331](../../../../packages/shared/src/html-section-parser.ts#L331)). It appears unused today, but if reused for section reconstruction it will reintroduce the exact behavior the staged combiner just fixed.

Recommended fix: add an explicit admin repair action or migration-style script that snapshots affected widget history, rewrites only generated staged wrapper gaps, saves, and purges storefront cache. Also update or delete the unused legacy reconstruction helper before anyone wires it back in.

### P1: Staged plan schema says `estimatedTokens` is required while prompts/types call it optional

The planning prompt describes `"estimatedTokens"` as optional ([useStagedGeneration.ts:93](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L93)-[102](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L102)), and the client `GenerationPlan` type also marks it optional ([useStagedGeneration.ts:11](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L11)-[19](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L19)). But the API structured-output schema requires it ([ai-response-validation.ts:17](../../../../apps/api/src/routes/admin/ai-response-validation.ts#L17)-[61](../../../../apps/api/src/routes/admin/ai-response-validation.ts#L61)).

Text-mode normalization repairs missing `estimatedTokens` ([ai-response-validation.ts:224](../../../../apps/api/src/routes/admin/ai-response-validation.ts#L224)-[245](../../../../apps/api/src/routes/admin/ai-response-validation.ts#L245)), but SDK structured output can fail validation and fall back to text if the model follows the "optional" instruction ([ai.ts:502](../../../../apps/api/src/routes/admin/ai.ts#L502)-[543](../../../../apps/api/src/routes/admin/ai.ts#L543)). This is not catastrophic, but it adds latency and failure surface to the most fragile stage.

Recommended fix: either make `estimatedTokens` optional in `stagedPlanOutputSchema` and normalize afterward, or make it required everywhere in the prompt and client type.

### P1/P2: One staged generation run can consume too many rate-limited API calls

The admin AI route enforces `20` requests per minute per user/IP ([ai.ts:48](../../../../apps/api/src/routes/admin/ai.ts#L48)-[53](../../../../apps/api/src/routes/admin/ai.ts#L53), [ai.ts:182](../../../../apps/api/src/routes/admin/ai.ts#L182)-[198](../../../../apps/api/src/routes/admin/ai.ts#L198)). A staged run now performs plan + N sections + finalizer ([useStagedGeneration.ts:648](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L648)-[728](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L728)). With up to `10` sections ([ai-config.ts:108](../../../../packages/core/src/modules/ai/ai-config.ts#L108)-[114](../../../../packages/core/src/modules/ai/ai-config.ts#L114)), client section retries ([useStagedGeneration.ts:522](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L522)-[547](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L547)), and server retries ([ai.ts:686](../../../../apps/api/src/routes/admin/ai.ts#L686)-[707](../../../../apps/api/src/routes/admin/ai.ts#L707)), one merchant action can approach or exceed the quota.

Recommended fix: treat a full staged run as one logical generation job for rate limiting, or use a higher weighted quota for authenticated admins. At minimum, avoid client retries on `429` and show a clear "wait X seconds" recovery path instead of falling back to single generation blindly.

### P2: Finalizer output is safe, but not quality-verified or catalog-preservation verified

The API sanitizes generated HTML/CSS and rejects scripts ([ai-response-validation.ts:83](../../../../apps/api/src/routes/admin/ai-response-validation.ts#L83)-[148](../../../../apps/api/src/routes/admin/ai-response-validation.ts#L148)). The finalizer prompt asks the model to preserve product facts and remove gaps ([useStagedGeneration.ts:580](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L580)-[620](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L620)). But no deterministic check confirms that:

- Product URLs/images/prices present in drafts survived finalization.
- Root wrappers have no external margins/gaps.
- The final CSS does not contain legacy `.widget-container` gap rules.
- The result renders without large vertical whitespace in preview/storefront.

Existing tests cover response parsing, sanitization, and plan normalization ([ai-response-validation.test.ts:53](../../../../apps/api/src/routes/admin/ai-response-validation.test.ts#L53)-[132](../../../../apps/api/src/routes/admin/ai-response-validation.test.ts#L132)), but not staged orchestration or rendered layout quality.

Recommended fix: add a small post-generation quality gate before enabling "Accept": static lint for gap/margin/min-height anti-patterns, preservation checks against drafted catalog URLs, and a Playwright/iframe smoke for desktop and mobile bounding boxes.

### P2: Full-screen progress UI does not represent planning/polishing accurately

`AiAssistant` shows a polishing label and `95%` ([AiAssistant.tsx:255](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/AiAssistant.tsx#L255)-[283](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/AiAssistant.tsx#L283)), but only after a plan exists. The full-screen editor uses `aiGenerator.generationProgress` ([WidgetForm.tsx:1052](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L1052)-[1104](../../../../apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx#L1104)), and that derived object does not handle `polishing`; it always says `Generating section X of Y` unless the stage is `planning` ([useAiGenerator.ts:495](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts#L495)-[510](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts#L510)).

Recommended fix: expose `currentStage` directly from staged generation into `generationProgress`, include a planless planning state, and compute percentages as planning `5%`, section progress `10-90%`, polishing `95%`, complete `100%`.

### P2: Planning relies on fragile prompt string surgery

`createPlanningMessages()` flattens all messages into one user message and removes output-format instructions by searching for exact string markers ([useStagedGeneration.ts:62](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L62)-[118](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts#L118)). This works with the current default prompt format, but it is brittle if dashboard-managed prompts change the marker text. It also drops native image parts from multimodal messages; only text survives.

Recommended fix: build planning messages from structured prompt components instead of editing rendered prompt text. If that is too large a refactor, isolate the formatter/remover into a tested utility with fixtures for widget, landing, collection, vision, and custom prompt overrides.

### P2/P3: Inline JavaScript is intentionally forbidden, but the product decision needs to be explicit

The current stack rejects scripts in prompts and validation ([ai-config.ts:154](../../../../packages/core/src/modules/ai/ai-config.ts#L154)-[170](../../../../packages/core/src/modules/ai/ai-config.ts#L170), [ai-response-validation.ts:101](../../../../apps/api/src/routes/admin/ai-response-validation.ts#L101)-[103](../../../../apps/api/src/routes/admin/ai-response-validation.ts#L103)), and preview iframes run with `sandbox=""` ([FullScreenEditor.tsx:372](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/FullScreenEditor.tsx#L372)-[397](../../../../apps/admin-v2/src/components/admin/widgets/widget-form/FullScreenEditor.tsx#L397)). This is safe and consistent with storefront insertion, but it conflicts with the idea of allowing inline JS for richer generated UI.

Recommended fix: keep the no-JS path as the default production-safe widget tier. If merchants need interactions, add a separate declarative interaction model or sandboxed component runtime with explicit capabilities, not arbitrary inline scripts inside storefront pages.

### P3: Tests do not cover the new client orchestration

The API validator tests are useful, but there are no tests for:

- `buildCombinedWidget()` preserving `gap: 0`.
- `finalizeComposition()` fallback when draft is too large or provider fails.
- `startStagedGeneration()` returning polished content while state remains coherent.
- `useAiGenerator()` fallback from staged to single generation without leaking partial preview state.
- Progress labels for planning/generating/polishing.

Recommended fix: extract pure helpers where needed and add focused Vitest coverage. For the hook orchestration, use mocked `fetch` with a plan, two section responses, finalizer success/failure, and abort cases.

## Next Fix Order

1. Fix staged metadata finalization: after finalizer success, update state and saved `aiContext` to match the actual saved artifact.
2. Add a safe production repair path for old generated widgets with legacy `.widget-container` gaps, including history snapshots and cache purge.
3. Resolve `estimatedTokens` required/optional mismatch.
4. Add deterministic generation quality gates for gap CSS, root margins, and catalog URL preservation.
5. Make progress state truthful in the full-screen preview.
6. Reduce staged run rate-limit pressure and avoid retrying into `429`.
7. Add unit tests for combiner/finalizer/fallback/progress behavior.

## Verification Recommended After Fixes

- Unit: `pnpm vitest run apps/api/src/routes/admin/ai-response-validation.test.ts` plus new staged helper tests.
- Type: `pnpm --filter @scalius/admin-v2 typecheck && pnpm --filter @scalius/api typecheck`.
- Browser: create a 3-4 section homepage widget, accept, save as active page placement, purge storefront cache, verify rendered sections have no unintended vertical gaps on desktop and mobile.
- Data lifecycle: reopen the saved widget and confirm the section editor targets the final saved artifact, not pre-finalizer drafts.
