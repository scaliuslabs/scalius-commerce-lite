# Current Staged Generator Audit

Date: 2026-05-13

Scope: `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts`, `useAiGenerator.ts`, `apps/api/src/routes/admin/ai.ts`, `ai-response-validation.ts`, and `packages/core/src/modules/ai/*`.

## Executive Summary

The current staged generator is vulnerable to disconnected sections because it decomposes a single composition into independently generated widgets, then joins them with a wrapper and a flex `gap`. The system asks for cohesion in prose, but it does not establish a machine-checkable composition contract, shared design tokens, shared section boundary rules, or a final reconciliation pass. The API validates each section as syntactically safe widget HTML/CSS, not as one continuous composition.

The robust fix is not another spacing instruction. The generator needs a staged contract that treats the full widget as the artifact: plan with shared art direction and layout tokens, generate section bodies against that contract, validate/normalize section boundaries, and assemble through one composition-aware server or shared module that can reject or repair structural gaps before the browser sees the result.

## Findings

### 1. Staged mode generates standalone widgets, then stitches them afterward

`useStagedGeneration.ts` requests each section separately with "HTML must be a complete, self-contained `<div>`" and "CSS should be scoped to this section" (`apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts:314-318`). That makes each call optimize for local completeness, not inter-section continuity. The final assembly wraps each returned section in another `.widget-section` and adds a container `gap` (`useStagedGeneration.ts:487-520`).

This is the core source of disconnected sections/gaps:

- each section can bring its own root padding, min-height, background, border radius, or margin reset;
- the assembler then adds another structural wrapper and explicit `gap`;
- CSS from later sections can still leak globally if class names collide, because "unique IDs/classes" is only a prompt instruction (`useStagedGeneration.ts:318`);
- no pass normalizes root margins, min-height, section padding, background transitions, or boundary continuity before combining.

The current `SECTION_GAP_CSS` is a monkey-patch symptom control (`useStagedGeneration.ts:39`, `useStagedGeneration.ts:491-520`). It can reduce dead air in some cases but cannot fix self-contained sections that render like separate mini-pages.

### 2. The plan is too weak to carry a design system across stages

The planning response schema only contains `totalSections`, `sectionDescriptions`, and `estimatedTokens` (`apps/api/src/routes/admin/ai-response-validation.ts:29-53`). The client-side fallback plan has the same shape (`useStagedGeneration.ts:108-152`).

The planning prompt asks for shared visual system prose (`useStagedGeneration.ts:93-103`), but the returned data has no fields for:

- composition type or target density;
- shared color tokens;
- typography scale;
- spacing scale;
- section boundary rules;
- root wrapper constraints;
- CTA/link treatment;
- image treatment;
- allowed catalog assets by section;
- canonical class prefix.

Because those values are not returned in structured form, later section prompts can only receive a text outline (`useStagedGeneration.ts:302-312`). The model has to reinvent styling choices on every section call.

### 3. Previous-section context is lossy and biased toward markup, not design decisions

`compactPreviousSections()` sends only the first 900 characters of each previous section's HTML and CSS, up to a 6000-character total (`useStagedGeneration.ts:38`, `useStagedGeneration.ts:154-179`). This loses exactly the information that matters most for visual continuity when sections are non-trivial: token definitions, media queries, root spacing, final boundary styles, and component variants.

It also sends concrete previous code, which encourages copying or accidental class reuse, while still not extracting a stable design contract. The instruction says "Maintain the same design language" (`useStagedGeneration.ts:178`), but there is no canonical source of truth for that design language.

### 4. The API validates per-section widget shape, not staged composition shape

For `stage: "generate"`, `/generate-staged` calls the same `generateWidgetContent()` used for complete widgets (`apps/api/src/routes/admin/ai.ts:717-720`). That function normalizes one widget output via `normalizeWidgetGenerationText()` or structured `{ html, css }` (`ai.ts:459-494`).

`normalizeWidgetGenerationText()` only proves that the response can be parsed, sanitized, and contains no scripts (`apps/api/src/routes/admin/ai-response-validation.ts:134-149`). `assertGeneratedWidgetIsSafe()` checks parsed widget structure, JSON validation, and script tags (`ai-response-validation.ts:76-101`). None of this checks the staged-specific contract:

- exactly one section root;
- no outer vertical margins;
- no viewport-height/min-height dead zones;
- no spacer-only elements;
- no full-page header/footer assumptions;
- no global selectors outside the section namespace;
- no duplicate IDs/classes across sections;
- no hard reset on `body`, `html`, `*`, `:root`, or shared widget wrappers;
- no section-level background/radius changes that create card-like islands unless planned.

The result is "valid widget code" that can still be visually disconnected.

### 5. The client reparses already-normalized API output and owns assembly logic

The API returns OpenAI-compatible JSON inside the standard success envelope (`apps/api/src/routes/admin/ai.ts:722-730`). The client extracts content and reparses tags/JSON (`useStagedGeneration.ts:350-375`). This duplicates parsing and keeps composition assembly in the React hook (`useStagedGeneration.ts:487-520`) instead of in shared/server-side logic.

That weakens the contract because the API has no visibility into the final artifact. It validates section N in isolation, returns a string, and the browser glues all sections together. The server cannot reject cross-section class collisions or boundary problems because it never receives the accumulated sections as a structured composition.

### 6. Progressive preview shows a different structure than final output

During staged generation, `useAiGenerator.ts` progressively appends raw section HTML/CSS directly to `generatedContent` (`apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts:333-346`). After completion, it replaces that with the wrapper-based combined output from `startStagedGeneration()` (`useAiGenerator.ts:351-353`; `useStagedGeneration.ts:487-529`).

This means spacing and connectedness during generation can differ from the final accepted widget. It also makes partial generation look deceptively acceptable or unacceptable depending on whether the wrapper gap, `.widget-section`, and final CSS have been applied.

### 7. Staged mode is enabled by default and used purely by a toggle

`stagedGenerationDefault` is true in default settings (`packages/core/src/modules/ai/ai-settings.service.ts:136-142`), and `shouldUseStagedGeneration()` returns the user toggle directly (`packages/core/src/modules/ai/ai-config.ts:447-455`). The prompt token estimate is passed in (`useAiGenerator.ts:327-331`) but ignored.

That makes the weaker staged path the default even for prompts that would be better generated as one coherent artifact. Until staged generation has a stronger contract, defaulting to it increases the chance of disconnected output.

### 8. The shared prompt already asks for cohesion, but staged generation works around it

The core prompt contract explicitly says generated output should be part of an existing storefront, sections should share one visual system, and root wrappers should avoid large external margins/min-height (`packages/core/src/modules/ai/ai-config.ts:146-152`). The default prompts reinforce the same expectations for widget, landing page, and collection generation (`packages/core/src/modules/ai/default-prompts.ts:16-25`, `default-prompts.ts:39-48`, `default-prompts.ts:61-70`).

Simple generation benefits from those instructions because the model produces the full artifact in one pass. Staged generation strips/replaces output instructions during planning (`useStagedGeneration.ts:67-106`) and then asks each section to be self-contained (`useStagedGeneration.ts:314-318`). The staged path therefore loses the main advantage of the full prompt: one model pass can reason about the whole composition.

## Contract Gaps

The implementation currently has three separate contracts, none strong enough:

1. Prompt contract: prose instructions in `PROMPT_INSTRUCTIONS.composition` and section prompts.
2. API contract: parseable/safe `{ html, css }` or tag format.
3. UI contract: React hook concatenates sections into `.widget-container`.

What is missing is a staged composition contract. A robust contract should be structured, persisted through all stages, and validated at the same boundary that normalizes AI output.

Recommended staged plan shape:

```ts
type StagedCompositionPlan = {
  totalSections: number;
  sectionDescriptions: string[];
  composition: {
    intent: "homepage-widget" | "landing-page" | "collection-section";
    density: "compact" | "standard" | "campaign";
    classPrefix: string;
    visualSystem: {
      colors: Record<string, string>;
      typography: {
        headingScale: string;
        bodyScale: string;
      };
      spacing: {
        sectionPadding: string;
        boundaryGap: string;
        cardGap: string;
      };
      radius: string;
      buttonStyle: string;
      imageTreatment: string;
    };
    boundaryRules: {
      rootMargin: "0";
      allowMinHeight: boolean;
      maxInterSectionGapPx: number;
      transitionStyle: string;
    };
  };
};
```

Recommended section output shape:

```ts
type StagedSectionOutput = {
  sectionIndex: number;
  html: string;
  css: string;
  usedTokens: string[];
  boundary: {
    top: "flush" | "soft";
    bottom: "flush" | "soft";
    hasOuterMargin: boolean;
    hasViewportMinHeight: boolean;
  };
};
```

The important shift is that the plan owns design decisions, not each section. Sections should implement against the plan.

## Robust Fixes

### 1. Move staged orchestration/assembly behind an API or shared module

Keep the UI as a caller, not the owner of composition assembly. Add a server/shared staged generation service that:

- creates a structured `StagedCompositionPlan`;
- generates sections with the plan as structured context;
- validates every section against staged-specific constraints;
- assembles the final widget;
- returns one normalized `{ html, css, plan, sections, diagnostics }` payload.

This can live server-side in `apps/api/src/routes/admin/ai.ts` initially, with reusable validation helpers in `ai-response-validation.ts` or a new shared module. The key is that the same layer that normalizes AI output also sees the final composition.

### 2. Strengthen `stagedPlanOutputSchema`

Extend `stagedPlanOutputSchema` beyond descriptions (`apps/api/src/routes/admin/ai-response-validation.ts:29-53`). Add the structured `composition` fields above. Use `Output.object()` when supported (`apps/api/src/routes/admin/ai.ts:511-536`) and text normalization fallback for unsupported providers.

Avoid treating missing plan fields as harmless. The current text normalizer invents generic section names and estimated token counts (`ai-response-validation.ts:164-205`). For the new composition fields, fallback should be deterministic and explicit, not silently permissive.

### 3. Add staged section validation distinct from complete widget validation

Do not overload `widgetOutputSchema` for section generation. Add `stagedSectionOutputSchema` and a `normalizeStagedSectionOutput()` that checks:

- HTML has one root element;
- root selector uses the plan `classPrefix`;
- CSS selectors are scoped to the root/class prefix;
- no `body`, `html`, `:root`, `*`, `.widget-container`, or broad reset selectors;
- root styles do not include external margins;
- `min-height: 100vh`, large fixed heights, empty spacer divs, and large top/bottom margins are rejected or normalized;
- IDs/classes are unique across accumulated sections.

This is not a substitute for visual review, but it turns the biggest known gap causes into enforceable contracts.

### 4. Generate shared CSS once, then section CSS as deltas

The plan should produce shared CSS variables and base component styles once. Section prompts should reference those tokens and return only section-scoped additions.

Instead of each section inventing color/radius/spacing, final CSS should look conceptually like:

```css
.scw-abc123 {
  --scw-bg: ...;
  --scw-surface: ...;
  --scw-accent: ...;
  --scw-section-y: ...;
}

.scw-abc123__section {
  margin: 0;
  padding-block: var(--scw-section-y);
}

/* section deltas */
```

This is more robust than repeatedly telling the model to "match previous sections."

### 5. Replace final `gap` assembly with boundary-aware assembly

The final wrapper currently uses `gap: clamp(0.75rem, 1.8vw, 1.35rem)` (`useStagedGeneration.ts:491-520`). A composition-aware assembler should derive boundary behavior from the plan and section metadata:

- flush campaign bands may use `gap: 0`;
- compact homepage widgets may use a small tokenized boundary gap;
- collection sections may use no outer gap and rely on internal rhythm;
- section backgrounds should either continue or transition intentionally.

The assembler should not add arbitrary wrapper spacing after sections have already padded themselves.

### 6. Make progressive preview use the same assembler as final output

In `useAiGenerator.ts`, the progressive callback currently appends raw section output (`apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts:339-345`). Replace this with the same partial assembly function used for the final artifact. If only one section has completed, render a one-section composed widget. If two have completed, render the two-section composed widget with the final wrapper and shared CSS.

That keeps preview behavior faithful and avoids acceptance decisions based on a different DOM/CSS structure.

### 7. Revisit staged default and routing decision

Until the staged contract is strengthened, consider making staged generation opt-in or threshold-driven again. `shouldUseStagedGeneration()` receives an estimated length but ignores it (`packages/core/src/modules/ai/ai-config.ts:453-455`). A safer decision rule would use staged mode only when:

- merchant setting is enabled;
- estimated prompt/output size exceeds a threshold;
- model output limit is likely insufficient for one pass;
- prompt type benefits from multiple bands, such as landing pages.

For compact homepage and collection widgets, a single full-artifact generation is often more coherent.

## Recommended Implementation Sequence

1. Add failing regression fixtures before changing behavior.
   - Cover generated sections with root margins, `min-height: 100vh`, duplicate class prefixes, global resets, and wrapper-induced gaps.
   - Add tests around `ai-response-validation.ts` first because that is the best enforcement point.

2. Introduce structured staged contracts.
   - Extend `stagedPlanOutputSchema` with `composition`.
   - Add `stagedSectionOutputSchema`.
   - Add deterministic fallback defaults for composition fields.

3. Add section normalization/validation.
   - Implement `normalizeStagedSectionOutput()` beside `normalizeWidgetGenerationText()`.
   - Reject or sanitize known gap creators: external margins, viewport min-heights, spacer-only nodes, and global selectors.

4. Generate and carry a stable class prefix/design token plan.
   - Planning stage returns the prefix and visual system.
   - Section prompts include the plan as structured JSON and require the root class/prefix.
   - Previous sections should be summarized as token/role/boundary metadata, not truncated HTML/CSS.

5. Centralize composition assembly.
   - Move the wrapper generation out of `useStagedGeneration.ts`.
   - Create a shared/server assembly function that uses plan boundary rules and emits final `{ html, css }`.
   - Use that function for progressive preview and final output.

6. Update `/generate-staged` contract.
   - Either add explicit stages (`plan`, `section`, `assemble`) or add a single endpoint that orchestrates all staged work.
   - Return typed payloads instead of OpenAI-compatible text for staged internals. Keep OpenAI-compatible shape only for provider-facing compatibility if still needed.

7. Adjust staged-mode selection.
   - Use prompt type, estimated tokens, and model output limits rather than only the toggle.
   - Consider defaulting compact widgets to simple generation until staged validation is proven.

8. Add end-to-end visual checks.
   - Run generated fixture widgets through the admin preview/storefront renderer.
   - Assert no large vertical dead zones by measuring section bounding boxes in a browser test.

## Concrete Files To Change Later

No source code was changed by this audit. The likely future edit points are:

- `apps/api/src/routes/admin/ai-response-validation.ts`: new staged plan/section schemas and validation.
- `apps/api/src/routes/admin/ai.ts`: staged orchestration and typed staged responses.
- `packages/core/src/modules/ai/ai-config.ts`: staged decision rule and composition prompt constants.
- `packages/core/src/modules/ai/prompt-helper-v2.ts`: shared composition contract injection.
- `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts`: reduce to caller/progress state, remove local assembly.
- `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts`: use composed partial previews rather than raw append.

