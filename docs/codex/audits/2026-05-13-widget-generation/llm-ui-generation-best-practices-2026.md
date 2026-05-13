# LLM UI Generation Best Practices 2026

Date: 2026-05-13  
Scope: Scalius AI widget generation for ecommerce homepage widgets, landing sections, collection sections, and future interactive storefront blocks. This is research and implementation guidance only; no source changes are included here.

## Executive Summary

The strongest public patterns from Vercel AI SDK, v0, OpenAI, Cloudflare, and browser security guidance converge on one principle: do not treat the model as a free-form frontend engineer whose raw output is trusted. Treat the model as a planning and drafting engine behind typed contracts, validation, repair loops, observability, and a final trusted rendering boundary.

For Scalius, the immediate direction should be:

1. Keep staged generation, but make the complete widget the only canonical artifact. Sections are progress checkpoints, not independent widgets.
2. Use structured output for plan, section, finalizer, and diagnostics whenever the provider/model supports it. Tag/text fallback is acceptable only when it is normalized into the same schema.
3. Add a finalizer/repair pass that sees the whole composition and has a narrow job: remove discontinuities, normalize spacing, preserve product/media references, and return one canonical widget.
4. Do not allow arbitrary inline JavaScript in normal storefront widgets. If interactive JS is ever allowed, make it a separate "interactive widget" capability with sandboxed preview/runtime, CSP, AST validation, strict APIs, and no direct secret/network/storage access.
5. Long term, move from raw `{ html, css }` toward a widget IR: trusted Scalius renderers for hero, product grid, collection strip, trust bar, FAQ, tabs, carousel, CTA, etc. The model should choose and configure blocks more often than it writes markup.

## What Leading Systems Do

### Vercel AI SDK: Typed Outputs And Event Streams

AI SDK v6 documents structured data through `generateText`/`streamText` plus `Output.object`, `Output.array`, `Output.choice`, and `Output.json`. `Output.object({ schema })` validates the generated object against a schema, and `Output.array({ element })` can stream completed validated elements through `elementStream`. The important caveat is that partial streamed objects cannot be validated while incomplete. Source: [AI SDK structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) and [Output reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-object).

Scalius translation:

- Plan generation should be `Output.object` where available.
- Section streaming should prefer `Output.array({ element: stagedSectionSchema })` only if each emitted section is complete and validated.
- Partial text deltas should never become accepted widget content.
- If a model/provider cannot reliably produce native structured output, the API can still accept tag/text output, but only after converting it into the same schema and validators.

AI SDK UI also recommends custom streamed data parts for status and structured events. Source: [Streaming custom data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data) and [Stream protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol).

Scalius translation:

- Progress should be events like `plan.created`, `section.started`, `section.accepted`, `repair.failed`, `final.completed`.
- The browser preview should update only when a section is accepted by the validator.
- The final saveable artifact should be a canonical `{ html, css, plan, sections, diagnostics }` payload.

### Vercel Generative UI And v0: Data/Tools First, Code Behind Boundaries

AI SDK "generative UI" is framed as tool calls returning data, then trusted React components rendering that data. It is not a recommendation to persist arbitrary model-authored HTML/JS directly into production pages. Source: [AI SDK Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces).

v0 is a more general AI development platform. Its public API revolves around chats, projects, generated versions, and deployments rather than narrow ecommerce widget fragments. Sources: [v0 overview](https://v0.dev/docs), [v0 Platform API](https://v0.dev/docs/api/platform/overview), and [v0 AI Tools adapter](https://v0.dev/docs/api/platform/adapters/ai-tools).

Scalius translation:

- v0 is useful as inspiration for iterative generate-preview-repair workflows and high-quality UI drafting.
- It should not bypass Scalius validation, catalog URL rules, image optimization, or storefront sandbox rules.
- The production-grade version of Scalius widgets should trend toward trusted renderers fed by model-produced data/IR.

### OpenAI: Structured Outputs Beat JSON Mode, And Context Must Be Explicit

OpenAI states that Structured Outputs ensure schema adherence, while JSON mode only ensures parseable JSON. It recommends Structured Outputs where possible, and notes function calling is better when connecting models to tools/data/actions. Source: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

OpenAI prompting guidance also emphasizes relevant context and clear task-specific instructions. Source: [OpenAI prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering).

Scalius translation:

- The prompt must not merely say "make a homepage widget." It should declare destination, page role, catalog context, available assets, density, allowed links, required product/category IDs, image optimization rules, and design continuity requirements.
- The plan schema should carry those decisions into every section prompt.
- The finalizer should receive the same plan and section outputs, plus deterministic diagnostics, rather than a vague "improve this."

### Provider Failover: Capability-Aware, Not Random

AI SDK supports central provider management through `createProviderRegistry`, where models are addressed by `providerId:modelId`. Source: [createProviderRegistry](https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry).

AI Gateway adds routing options such as provider order, allowed providers, fallback models, usage tags, and zero-data-retention constraints. Source: [AI Gateway provider options](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway).

Scalius translation:

- Provider failover should be profile-based:
  - `planner`: strong structured output, good reasoning, lower temperature.
  - `section`: good frontend/code generation, adequate context, moderate temperature.
  - `finalizer`: strongest visual/code coherence, low temperature.
  - `repair`: strict schema/code correction, very low temperature.
- Failover must preserve the operation contract. Do not fail from a structured-output-capable model to a text-only model without switching to the text normalization path and recording that downgrade.
- A single staged generation should log every provider/model used. If a failover changes model family mid-widget, the finalizer must reconcile the full design system.
- Admin settings should expose provider profiles and fallback chains in plain merchant language: "Fast", "Balanced", "Best quality", "Strict privacy", not raw implementation trivia only.

## Recommended Scalius Generation Architecture

### 1. Canonical Operation Shape

The API should own the generation operation. The admin should send intent and selected context IDs; the API should fetch trusted catalog/media records and build the model context.

Recommended request shape:

```ts
type GenerateWidgetRequest = {
  goal: "homepage_widget" | "landing_section" | "collection_section" | "page_section";
  prompt: string;
  selected: {
    productIds: string[];
    categoryIds: string[];
    imageIds: string[];
    pageId?: string;
    placement?: {
      scope: "homepage" | "page" | "product" | "category";
      position: "top" | "middle" | "bottom";
    };
  };
  generationProfile: "fast" | "balanced" | "best_quality";
};
```

Recommended response shape:

```ts
type WidgetGenerationResult = {
  html: string;
  css: string;
  plan: StagedCompositionPlan;
  sections: StagedSectionResult[];
  diagnostics: WidgetDiagnostics;
  telemetry: {
    providers: Array<{ stage: string; provider: string; model: string }>;
    usage?: unknown;
    durationMs: number;
  };
};
```

### 2. Plan For The Whole Composition

The staged plan should not be a list of section descriptions only. It should define one visual and merchandising system that all sections inherit.

Recommended plan fields:

```ts
type StagedCompositionPlan = {
  goal: "homepage_widget" | "landing_section" | "collection_section";
  totalSections: number;
  compositionBrief: string;
  pageRole: string;
  density: "compact" | "standard" | "campaign";
  designSystem: {
    classPrefix: string;
    colorTokens: Record<string, string>;
    typography: string;
    spacingScale: string;
    cardTreatment: string;
    imageTreatment: string;
    buttonTreatment: string;
  };
  boundaryRules: {
    outerGap: "0";
    rootMarginsAllowed: false;
    maxInternalBandPaddingPx: number;
    allowedTransitions: string[];
  };
  sections: Array<{
    index: number;
    type: "hero" | "product_grid" | "collection_intro" | "comparison" | "trust" | "faq" | "cta" | "custom";
    role: "lead" | "merchandising" | "proof" | "conversion";
    contextRefs: string[];
    continuityNote: string;
  }>;
};
```

Homepage widgets should usually be compact and scannable: category/product signal, featured products or collection discovery, trust/urgency, CTA. Landing sections can be more campaign-like: hero/offer, product proof, objection handling, urgency, final CTA. Collection sections should emphasize browsing and comparison: intro, product grid, buying guide, trust/CTA.

### 3. Section Generation Should Produce Slices, Not Mini Pages

Each section prompt should receive the full plan, the selected catalog/media context, and a compact summary of accepted prior sections. It should not be asked to make a "complete self-contained widget"; that phrase encourages root wrappers, independent backgrounds, and extra spacing.

Recommended section output:

```ts
type StagedSectionResult = {
  index: number;
  html: string;
  css: string;
  usedRefs: {
    products: string[];
    categories: string[];
    images: string[];
    urls: string[];
  };
  boundary: {
    top: "flush" | "intentional_transition";
    bottom: "flush" | "intentional_transition";
    hasOuterMargin: false;
    hasViewportMinHeight: false;
  };
  warnings: string[];
};
```

Validators should reject or repair:

- `margin-top`/`margin-bottom` on section roots.
- `min-height: 100vh`, large fixed heights, spacer-only divs, and decorative blank bands.
- broad selectors like `body`, `html`, `:root`, `*`, `.widget-container`, or unscoped resets.
- duplicate IDs and unprefixed classes.
- external image URLs that do not go through the platform's allowed/optimized media path.
- products/categories/images not selected or not present in the API-provided context.

### 4. Progressive Preview Must Use The Canonical Assembler

Progressive generation should feel fast, but preview correctness matters more than showing raw text early.

Recommended flow:

1. Create plan.
2. Generate section N.
3. Validate and sanitize section N.
4. Assemble accepted sections with the same wrapper and CSS rules the final widget will use.
5. Render that assembled preview.
6. After all sections, run finalizer.
7. Validate final output.
8. Save only the final canonical artifact.

This preserves the original purpose of staged generation: the merchant sees progress, but the model and preview still understand the sections as one composition.

### 5. Finalizer And Repair Passes

A finalizer is not a second generator. It is an editor constrained by the plan and accepted sections.

Finalizer responsibilities:

- Merge duplicated CSS.
- Normalize design tokens.
- Remove accidental gaps between bands.
- Preserve all selected product/media references unless diagnostics explicitly allow removal.
- Keep the same composition order.
- Return a concise change summary and warnings.

Repair pass responsibilities:

- Receive exact validator errors.
- Change only what failed.
- Be limited to one or two attempts per stage.
- If repair still fails, show the admin actionable diagnostics instead of silently saving a weak artifact.

## Inline JavaScript Policy

### Default Position: No Inline JS In Normal Widgets

Normal storefront widgets should remain HTML/CSS only. Arbitrary inline JS creates security, performance, cache, and maintenance risks:

- CSP guidance treats broad inline script allowance as risky and recommends nonce/hash mechanisms instead of `unsafe-inline`. Source: [MDN script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src).
- Inline event handlers are script execution too, so `onclick`, `onload`, `javascript:` URLs, and similar attributes should stay banned.
- Merchant-generated code runs on the storefront origin unless isolated; that means cookies, local storage, cart data, forms, and analytics can be affected.

### Preferred Interactivity Model: Trusted Runtime, Model-Generated Config

For common ecommerce interactions, do not let the model write JS. Let it choose from trusted behaviors:

```ts
type WidgetBehavior =
  | { kind: "carousel"; target: string; autoplay: boolean; intervalMs: number }
  | { kind: "tabs"; target: string }
  | { kind: "accordion"; target: string }
  | { kind: "countdown"; target: string; endsAt: string }
  | { kind: "quick_add"; productIds: string[] };
```

Scalius-owned JavaScript implements these behaviors once. The model only outputs config that validators can check.

### If Custom JS Is Ever Allowed

Custom JS should be a separate "interactive widget" capability with explicit admin opt-in and stricter isolation. Minimum requirements:

1. Separate artifact type: `html`, `css`, `behavior` or `js`, never mixed into normal widgets.
2. Preview in a sandboxed iframe. MDN documents iframe sandbox as restrictions on nested content; only add tokens deliberately. Source: [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/sandbox).
3. Production runtime isolation:
   - safest: iframe on an isolated origin with no `allow-same-origin`;
   - communicate with storefront through typed `postMessage` only;
   - no access to storefront DOM outside the iframe;
   - no cookies/localStorage/sessionStorage;
   - no arbitrary network unless allowlisted.
4. CSP:
   - no `unsafe-inline`;
   - no `unsafe-eval`;
   - scripts must be static trusted runtime files or nonce/hash-approved bundles;
   - event-handler attributes remain disallowed.
5. Static validation:
   - parse JS with an AST, not regex;
   - reject `eval`, `Function`, dynamic `import`, `document.cookie`, storage APIs, broad DOM mutation outside the root, timers without cleanup, and network APIs unless explicitly allowed;
   - enforce bundle size and execution budget.
6. Dynamic validation:
   - run generated JS in a browser sandbox before save;
   - capture console errors, network attempts, long tasks, layout shifts, and DOM mutations;
   - fail closed.
7. Server-side code execution or build-time checks can use Cloudflare isolation:
   - Dynamic Workers can run AI-generated code with `globalOutbound: null` or intercepted egress. Source: [Cloudflare Dynamic Workers egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/).
   - Sandbox SDK can run untrusted code in isolated containers. Source: [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/).

Important distinction: Cloudflare sandboxing protects server-side validation/execution. It does not automatically make arbitrary browser JS safe on the storefront. Browser runtime isolation still needs iframe/CSP/postMessage boundaries.

## Safety And Quality Gates

Before save:

- Schema validation for plan, sections, final artifact, diagnostics.
- HTML sanitization and CSS sanitization.
- scoped CSS selector validation.
- asset URL allowlist and image optimization checks.
- selected product/category/image reference checks.
- no-script/no-event-handler policy.
- size budgets for HTML, CSS, and images.
- deterministic assembly with `outerGap: 0`.

Before publish or after deploy:

- Playwright visual smoke on desktop and mobile.
- screenshot diff or heuristic checks for large blank vertical gaps.
- console/page-error checks.
- storefront render check on real placement route.
- image optimization URL check for product and widget images.
- cache purge verification for changed widget/page placement.

Operationally:

- Persist every generation attempt with prompt, plan, provider/model, usage, validation errors, final output hash, and admin user ID.
- Make generation history visible from the widget editor.
- Provide admin-facing diagnostics that explain why a generation was repaired or rejected.

## Practical Roadmap For This Codebase

### Now

- Keep HTML/CSS-only default.
- Keep staged generation, but treat section outputs as validated slices of one widget.
- Strengthen plan and section schemas with destination-specific page roles, design tokens, boundary rules, context references, and diagnostics.
- Keep finalizer pass mandatory for staged output.
- Ensure progressive preview uses the same canonical assembler as final output.

### Next

- Move staged orchestration toward the API/shared service so the server validates the whole composition, not just individual strings.
- Add provider profiles and capability-aware fallback chains.
- Add screenshot-based visual gap tests and image optimization checks to the widget verification suite.
- Add an admin diagnostics panel: provider/model used, plan, repairs, warnings, asset coverage, and validation status.

### Later

- Introduce widget IR and trusted renderers for common ecommerce blocks.
- Add trusted behavior config for common interactivity.
- Consider custom JS only after the isolated interactive-widget model exists and passes CSP, iframe, AST, and browser-sandbox validation.

## Bottom Line

Staged generation did not fail as an idea; it failed when each stage became a separate visual artifact. The fix is to make the plan, validator, assembler, preview, and finalizer all share one truth: this is one ecommerce composition with progressive checkpoints. Keep the model creative inside typed boundaries, keep JavaScript trusted by default, and let the platform own rendering, safety, and verification.
