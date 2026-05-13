# LLM UI Generation Best Practices 2026

Date: 2026-05-13

Scope: research and product/architecture guidance for Scalius AI-generated ecommerce widgets, page sections, landing sections, and merchant-configurable storefront blocks. This is a research document only. It does not include production code changes.

## Executive Summary

Current official guidance from Vercel AI SDK, Vercel AI Gateway, v0, OpenAI, Gemini, Cloudflare Workers AI, OWASP, MDN, and DOMPurify converges on one practical rule: never treat generated UI as trusted frontend code. Treat the model as a planner and drafter behind typed contracts, provider capability checks, validation, sanitization, repair loops, telemetry, and a final trusted rendering boundary.

For Scalius, the best target is a server-owned generation operation that produces a canonical widget artifact:

```ts
type WidgetGenerationArtifact = {
  html: string;
  css: string;
  plan: WidgetPlan;
  sections: WidgetSectionArtifact[];
  manifest: WidgetManifest;
  diagnostics: WidgetDiagnostics;
  telemetry: WidgetGenerationTelemetry;
};
```

The merchant should experience the flow as fast and configurable: choose a goal, selected products/categories/media, brand/tone options, and quality/speed profile; then see progress events and validated previews. The system should experience the flow as strict and boring: schemas, allowlists, scoped CSS, no scripts, deterministic assembly, bounded retries, and explicit diagnostics.

Recommended direction:

1. Use Vercel AI SDK v6 structured outputs for plans, final widget artifacts, manifests, and diagnostics where provider support is reliable. Use text/tag fallback only after normalizing into the same schema.
2. Use streaming for progress and completed section events, not as an acceptance boundary for incomplete HTML/CSS.
3. Add repair loops that receive exact validator failures and are allowed to change only the failing scope.
4. Add a manifest that proves generated product IDs, category IDs, image IDs, URLs, claims, and CTA targets came from trusted Scalius context.
5. Move over time from raw `{ html, css }` toward a widget IR rendered by trusted Scalius components for common ecommerce blocks.
6. Keep normal widgets HTML/CSS only. Treat arbitrary JavaScript as a separate sandboxed interactive-widget product surface, not a default widget feature.

## Primary Source Findings

### Vercel AI SDK v6: Structured Output Is The Contract Layer

The AI SDK v6 docs describe structured data generation through the `output` property on `generateText` and `streamText`, using `Output.object`, `Output.array`, `Output.choice`, or JSON output strategies with Zod, Valibot, or JSON Schema. The docs explicitly frame schemas as something apps still need to validate because model outputs can be incomplete or wrong. Source: [AI SDK Core: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data).

Scalius implications:

- Use `Output.object({ schema })` for the plan, final artifact, repair result, and diagnostics.
- Use `Output.array({ element })` only when each emitted element is a complete section artifact that can be accepted or rejected independently.
- Treat partial structured streams as progress only. Do not save or preview incomplete partial objects as final content.
- Give schemas clear names/descriptions and semantically meaningful fields, not just `html` and `css`.

AI SDK v6 also documents streaming errors as part of the stream and `streamText` options such as `maxRetries`, `abortSignal`, and total/step/chunk timeouts. Source: [AI SDK Core: streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text).

Scalius implications:

- Set operation-level timeout budgets, not just provider defaults.
- Detect stalled streams with chunk timeouts.
- Avoid stacking AI SDK retries, custom transient retries, section retries, repair retries, and whole-operation retries without a shared budget.

The AI SDK error reference exposes details for `NoObjectGeneratedError`, including raw text, response metadata, usage, finish reason, and cause. Source: [AI SDK Errors: NoObjectGeneratedError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-no-object-generated-error).

Scalius implications:

- Store structured-output failures as diagnostics: `finishReason`, schema path, parse error, provider/model, and repair attempt count.
- A failed object generation should become either a bounded repair attempt or a visible merchant/admin diagnostic, not a silent fallback to weak output.

### Vercel AI SDK UI: Stream Status And Data Parts, Not Raw Widget Truth

AI SDK UI supports type-safe custom streamed data using `createUIMessageStream`, `createUIMessageStreamResponse`, and related helpers. The docs position data streams as the mechanism for status, references, and structured updates alongside model output. Source: [AI SDK UI: Streaming Custom Data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data).

The stream protocol supports custom `data-*` parts for structured events, error parts, file parts, source parts, and tool input/output parts. Source: [AI SDK UI: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol).

Scalius implications:

- Stream progress as first-class events: `data-widget-plan`, `data-widget-section-start`, `data-widget-section-complete`, `data-widget-validation`, `data-widget-repair`, `data-widget-final`, `data-widget-error`.
- Only emit `section-complete` after the section passes normalization, sanitizer, CSS scoping, URL validation, and manifest checks.
- Keep "Accept" disabled until the final canonical artifact passes validation.

`createUIMessageStream` is designed for readable UI message streams with merging, error handling, and finish callbacks. Source: [AI SDK UI: createUIMessageStream](https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream).

Scalius implications:

- A future admin client can consume a typed event stream instead of OpenAI-compatible text deltas.
- Compatibility with the current OpenAI-style SSE route can remain, but the durable contract should be typed events plus a final artifact.

### Vercel AI SDK Generative UI: Tools/Data Rendered By Trusted Components

The AI SDK generative UI guide frames generated UI as a tool-driven flow: the model chooses a tool, the tool returns data, and application-owned React components render that data. Source: [AI SDK UI: Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces).

Scalius implications:

- Official "generative UI" guidance is closer to "model selects data/components" than "model persists arbitrary HTML/CSS."
- This supports a long-term widget IR direction: the model generates typed block configuration, while trusted Scalius renderers output final markup.
- Raw HTML/CSS can remain useful for prototyping and rare custom layouts, but common ecommerce widgets should converge on trusted renderers.

AI SDK RSC `streamUI` is explicitly marked experimental, with the docs recommending AI SDK UI for production. Source: [AI SDK RSC: streamUI](https://ai-sdk.dev/docs/reference/ai-sdk-rsc/stream-ui).

Scalius implications:

- Do not base persisted storefront widget generation on `@ai-sdk/rsc` or `streamUI`.
- Scalius storefront output must survive persistence, caching, SSR, and Cloudflare Worker execution; a React Server Components stream is the wrong runtime contract.

### Vercel AI Gateway: Route By Capability And Observe Every Request

Vercel AI Gateway provider options support provider filtering, provider ordering, automatic caching, per-provider timeouts, model fallbacks, and request-scoped BYOK. Source: [Vercel AI Gateway Provider Options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options).

AI Gateway capabilities include request traces, token counts, latency metrics, spend tracking, usage/billing, and zero-data-retention controls. Source: [Vercel AI Gateway Capabilities](https://vercel.com/docs/ai-gateway/capabilities).

The AI Gateway docs also note that string model IDs use AI Gateway as the default provider in AI SDK contexts. Source: [Vercel AI Gateway Models and Providers](https://vercel.com/docs/ai-gateway/models-and-providers).

Scalius implications:

- Failover should be capability-aware, not random. A planner needs structured output and reasoning; a section drafter needs frontend/code quality; a repair model needs strict schema adherence; a finalizer needs low-temperature coherence.
- Merchant-facing profiles should map to internal provider chains:
  - `fast`: lower latency, fewer stages, one repair attempt.
  - `balanced`: structured plan, sequential sections when needed, finalizer.
  - `best_quality`: stronger finalizer, more visual QA, wider repair budget.
  - `strict_privacy`: only providers/routes that satisfy configured privacy policy.
- Telemetry should record model, provider, routing/fallback path, timings, token usage, retries, validation failures, and final acceptance.

### v0: Strong For Project/Code Workflows, Not A Runtime Widget Contract

The v0 Platform API is documented around chats, projects, code generation, file workflows, deployments, and autonomous project workflows. Source: [v0 Platform API Overview](https://v0.app/docs/api/platform/overview).

v0 also provides AI SDK tool integration via `@v0-sdk/ai-tools` for agents that use v0 project capabilities. Source: [v0 AI Tools Adapter](https://v0.app/docs/api/platform/adapters/ai-tools).

Scalius implications:

- v0 is useful inspiration for generate-preview-iterate workflows and potentially for offline prototyping.
- v0 should not bypass Scalius's widget contract, catalog URL policy, sanitizer, or no-script policy.
- If v0 is ever integrated, wrap it as a backend provider behind the same `WidgetGenerationArtifact` schema and validators.

### OpenAI: Structured Outputs, Prompt Contracts, And Edge Cases

OpenAI states that Structured Outputs are preferable to JSON mode when possible because JSON mode only ensures valid JSON, while Structured Outputs enforce schema adherence. Source: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

OpenAI also distinguishes function calling from response formatting: use function calling when connecting the model to tools, data, or system actions; use structured response formats when shaping the model response for application consumption. Source: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling).

OpenAI's structured output guide calls out practical edge cases such as refusals, max-output-token truncation, and content filtering causing incomplete outputs. It also recommends clear key names, field descriptions, and evals. Source: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Scalius implications:

- Do not equate parseable JSON with valid widget output.
- Treat refusals, truncation, content-filter stoppage, and `finishReason: length` as explicit failure classes.
- Use tools/function calling for trusted catalog/media lookups or action planning; use structured output for artifact generation.
- Use evals and fixture prompts for widget quality, not only manual inspection.

OpenAI prompt engineering guidance emphasizes instruction hierarchy, clear logical boundaries, examples, relevant context, and prompt caching by putting stable reused content early. It also recommends precise frontend guidance: typography, colors, spacing/layout, interaction states, accessibility, and consistency. Source: [OpenAI Prompt Engineering](https://developers.openai.com/api/docs/guides/prompt-engineering).

Scalius implications:

- Put stable Scalius rules and schema contract first for cacheability.
- Put merchant prompt and catalog data in clearly delimited untrusted blocks.
- Include compact examples of good section artifacts and invalid anti-examples.
- Explicitly specify destination, density, allowed assets, links, locale, responsive behavior, accessibility, and continuity rules.

### Gemini And Cloudflare: Structured Output Support Is Provider-Specific

Gemini structured output docs support JSON Schema, SDK helpers such as Zod/Pydantic, and streaming structured outputs, while noting support for a subset of JSON Schema. Source: [Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output).

Cloudflare Workers AI JSON Mode accepts JSON Schema-like response formatting but states that Workers AI cannot guarantee schema satisfaction and that JSON Mode currently does not support streaming. Source: [Cloudflare Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/json-mode/).

Scalius implications:

- Provider capability detection must be live/configurable. "Supports JSON" is not enough; Scalius needs to know whether structured output, streaming structured output, image input, tool calling, and strict schema behavior are usable for the chosen model/provider.
- Cloudflare Workers AI/Kimi can be a good Cloudflare-native default for text/tag generation, but the pipeline should continue to validate and repair server-side.
- Gemini can be strong for structured and multimodal flows, but validators still own semantic correctness.

### Browser Security: Generated HTML/CSS Is Untrusted Input

OWASP's XSS guidance distinguishes contexts such as HTML body, safe attributes, URL attributes, CSS values, JavaScript variables, and DOM sinks. It recommends safe URL validation/allowlisting for `href`/`src`, strict structural validation for CSS values, and HTML sanitization for untrusted HTML. Source: [OWASP Cross Site Scripting Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html).

MDN's CSP docs describe `style-src` behavior and note that disallowing inline styles and scripts is a major CSP security win; nonce or hash sources can allow specific inline blocks when necessary. Source: [MDN Content-Security-Policy style-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src) and [MDN CSP Guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP).

DOMPurify's project documentation describes sanitizing HTML/SVG/MathML, secure defaults, server-side use with up-to-date `jsdom`, and the foot-gun that modifying sanitized markup afterward can void sanitization. Source: [DOMPurify README](https://github.com/cure53/DOMPurify).

Scalius implications:

- Generated HTML/CSS must be sanitized and scoped before preview and before save.
- Do not allow `<script>`, inline event handlers, `javascript:` URLs, untrusted external URLs, broad CSS selectors, or global CSS resets.
- Prefer one generated `<style>` block controlled by Scalius, or persisted CSS that is injected through a trusted renderer with CSP strategy.
- If server-side DOMPurify is used, keep `jsdom` current and avoid post-sanitization mutation that reintroduces unsafe content.

## Target Generation Architecture

### 1. Server-Owned Operation

The API should own the complete operation: context fetch, prompt assembly, model calls, validation, repair, finalization, telemetry, and saveable artifact. The admin client should send intent and trusted IDs, not raw system prompts.

Recommended request shape:

```ts
type GenerateWidgetRequest = {
  goal:
    | "homepage_widget"
    | "landing_section"
    | "collection_section"
    | "product_section"
    | "page_section";
  userPrompt: string;
  placement?: {
    scope: "homepage" | "page" | "product" | "category" | "collection";
    position: "top" | "middle" | "bottom" | "sidebar" | "inline";
  };
  selected: {
    productIds: string[];
    categoryIds: string[];
    collectionIds: string[];
    imageIds: string[];
  };
  merchantControls: {
    profile: "fast" | "balanced" | "best_quality" | "strict_privacy";
    density: "compact" | "standard" | "campaign";
    tone?: "premium" | "friendly" | "urgent" | "minimal" | "editorial";
    locale?: string;
    brandTokens?: {
      colorMode?: "brand" | "neutral" | "seasonal";
      radius?: "none" | "small" | "medium";
      typography?: "system" | "serif-accent" | "condensed";
    };
  };
};
```

Recommended operation events:

```ts
type WidgetGenerationEvent =
  | { type: "plan.started"; requestId: string }
  | { type: "plan.completed"; plan: WidgetPlanSummary }
  | { type: "section.started"; index: number; sectionType: string }
  | { type: "section.completed"; index: number; artifact: WidgetSectionArtifact }
  | { type: "validation.warning"; stage: string; warnings: string[] }
  | { type: "repair.started"; stage: string; attempt: number; errors: string[] }
  | { type: "repair.completed"; stage: string; attempt: number }
  | { type: "final.completed"; artifact: WidgetGenerationArtifact }
  | { type: "operation.failed"; diagnostics: WidgetDiagnostics };
```

### 2. Plan First, But Plan For The Whole Composition

The planner should return a typed design and merchandising plan, not a list of vague section descriptions.

Recommended plan shape:

```ts
type WidgetPlan = {
  goal: GenerateWidgetRequest["goal"];
  compositionBrief: string;
  pageRole: "discovery" | "conversion" | "comparison" | "campaign" | "retention";
  density: "compact" | "standard" | "campaign";
  locale: string;
  classPrefix: string;
  designSystem: {
    colorTokens: {
      background: string;
      surface: string;
      text: string;
      mutedText: string;
      accent: string;
      border: string;
    };
    typography: {
      headingStyle: string;
      bodyStyle: string;
      priceStyle: string;
    };
    spacing: {
      outerPadding: string;
      bandGap: "0";
      gridGap: string;
    };
    components: {
      cardTreatment: string;
      imageTreatment: string;
      buttonTreatment: string;
    };
  };
  constraints: {
    noJavascript: true;
    noExternalAssetsExceptAllowlist: true;
    rootMarginsAllowed: false;
    maxSectionCount: number;
    maxInternalBandPaddingPx: number;
    allowedBlockTypes: WidgetBlockType[];
  };
  sections: Array<{
    index: number;
    type: WidgetBlockType;
    role: "lead" | "browse" | "proof" | "comparison" | "conversion" | "support";
    requiredRefs: {
      products: string[];
      categories: string[];
      collections: string[];
      images: string[];
    };
    continuityNote: string;
    merchantConfigurableFields: string[];
  }>;
};
```

Why this matters:

- Coherence comes from shared design tokens and continuity notes.
- Reliability comes from explicit allowed block types, counts, and required refs.
- Merchant configurability comes from fields the UI can expose after generation.
- Fast repair comes from knowing exactly which section and constraint failed.

### 3. Generate Completed Sections, Not Mini Pages

Each section should be a slice of the plan. It should not contain an independent page wrapper, its own global design system, or large root spacing.

Recommended section artifact:

```ts
type WidgetSectionArtifact = {
  index: number;
  type: WidgetBlockType;
  html: string;
  css: string;
  manifest: {
    productIds: string[];
    categoryIds: string[];
    collectionIds: string[];
    imageIds: string[];
    hrefs: string[];
    srcs: string[];
    claims: Array<{ text: string; sourceRef: string | null }>;
  };
  boundary: {
    top: "flush" | "intentional_transition";
    bottom: "flush" | "intentional_transition";
    hasOuterMargin: false;
    hasViewportMinHeight: false;
  };
  merchantFields: Array<{
    key: string;
    label: string;
    type: "text" | "color" | "image" | "product_ref" | "category_ref" | "url" | "boolean";
    value: unknown;
  }>;
  warnings: string[];
};
```

Reject or repair sections with:

- `<script>`, event handler attributes, `javascript:` URLs, forms with external actions, iframes, object/embed tags.
- `body`, `html`, `:root`, `*`, broad resets, unscoped IDs/classes, duplicate IDs.
- `position: fixed`, excessive `z-index`, `min-height: 100vh`, large fixed heights, spacer-only elements, root `margin-top`/`margin-bottom`.
- External images or links outside the Scalius allowlist.
- Product/category/image references not present in the server-provided trusted context.
- Claims such as discounts, shipping promises, stock state, warranties, or delivery dates not present in trusted context.

### 4. Canonical Assembly And Finalization

Progressive preview should use the same assembler as the final artifact. The assembler should:

1. Wrap sections with a Scalius-owned root element and generated class prefix.
2. Concatenate accepted sections in plan order.
3. Scope CSS to the root prefix.
4. Deduplicate CSS tokens and repeated declarations.
5. Run HTML sanitizer and CSS validator.
6. Validate manifest refs and links.
7. Emit preview only after the current accepted state is safe.

The finalizer is not a second unrestricted generator. It is an editor with a narrow job:

- Merge duplicated CSS.
- Normalize spacing and transitions.
- Preserve section order and required refs.
- Remove discontinuities between bands.
- Improve responsive behavior without changing merchant facts.
- Return a change summary and warnings.

Finalizer output should use the same schema as the final artifact, not free text.

### 5. Repair Loops

Repair should be deterministic where possible and model-assisted only where necessary.

Recommended repair hierarchy:

1. Deterministic repairs:
   - Strip banned tags/attributes.
   - Prefix classes.
   - Remove root margins and banned selectors.
   - Normalize URLs through known Scalius helpers.
   - Remove duplicate IDs.
2. Model repair:
   - Receive exact validator errors and the failing artifact.
   - Preserve all valid fields and all trusted refs.
   - Return the same schema.
   - Change only the failing section or final artifact field.
3. Human-visible failure:
   - If repair fails after the operation budget, show precise diagnostics and do not silently save weak content.

Suggested retry budget:

```ts
type RetryBudget = {
  plan: { transientProviderRetries: 1; formatRepairRetries: 1 };
  section: { transientProviderRetries: 1; formatRepairRetries: 1 };
  finalizer: { transientProviderRetries: 1; formatRepairRetries: 1 };
  totalProviderCalls: number; // profile-specific cap
};
```

Profiles:

| Profile | Best For | Suggested Cap |
| --- | --- | --- |
| `fast` | Small homepage widgets, quick variants | 2-3 provider calls |
| `balanced` | Most merchant generation | 4-7 provider calls |
| `best_quality` | Landing/campaign sections | 8-12 provider calls |
| `strict_privacy` | Sensitive catalog or regulated merchants | provider-policy dependent |

Avoid whole-operation fallback from staged to single-shot unless it fits inside the same budget and the UI clearly reports the fallback.

## Prompt Contract

The prompt contract should be stable, explicit, and separated from untrusted merchant/catalog data.

### Recommended Message Layout

1. Developer/system instructions:
   - Role: ecommerce UI planner/drafter for Scalius storefront widgets.
   - Output contract: exact schema, no prose outside structured output.
   - Safety: no scripts, no event handlers, no unsupported links/assets, no invented commerce facts.
   - Layout rules: scoped classes, no global selectors, no root margins, responsive behavior, accessibility.
   - Merchant configurability: identify editable fields.
2. Schema and examples:
   - One compact valid example.
   - One compact invalid anti-example with explanation in developer-only text.
3. Trusted store context:
   - Products, categories, collections, images, prices, URLs, badges, inventory/availability claims.
   - Use IDs and canonical URLs; keep prose short.
4. Untrusted merchant prompt:
   - Delimited as user intent, not instructions that override the contract.
5. Stage-specific task:
   - Planner, section drafter, finalizer, or repair.

### Contract Rules To Make Explicit

- Generate for the specified destination only.
- Use only provided refs; never invent product names, prices, URLs, reviews, badges, or discounts.
- All class names must start with the provided prefix.
- Root section margins must be zero.
- No JavaScript, no forms, no third-party embeds.
- Images must use provided Scalius media URLs/IDs.
- CTAs must link only to provided product/category/collection/page URLs.
- Text must be merchant-editable when it is campaign copy.
- Product facts must be source-backed and listed in `manifest.claims`.
- The final artifact must be coherent as one widget, not a collage of independent mini pages.

### Prompt Caching

Per OpenAI prompt guidance, stable repeated prompt content should appear early to maximize prompt caching benefits. For Scalius:

- Keep global rules, schema definitions, and examples stable at the beginning.
- Place merchant prompt and per-request catalog context later.
- Avoid provider-side context-compression plugins for exact commerce facts unless explicitly marked non-factual/draft-only.

## Validation Checklist

Validation should run at plan, section, assembled preview, finalizer, and save time.

### Structural Validation

- Zod/schema parse succeeds.
- Required fields are present.
- No additional unexpected top-level fields when strict mode is available.
- Section count and block types match plan/profile limits.
- Every `manifest` ref maps to trusted context.
- All hrefs/srcs are canonical or allowlisted.

### HTML Validation

- No banned tags.
- No inline event handlers.
- No `javascript:`, `data:` URLs except explicitly allowed image data if ever needed for preview-only.
- No duplicate IDs.
- No empty wrapper trees or spacer-only blocks.
- Accessible names for buttons/links/images where appropriate.
- Headings follow a reasonable order for an embedded section.

### CSS Validation

- All selectors are scoped to generated root prefix.
- No `body`, `html`, `:root`, universal reset, or global element styling outside root scope.
- No external `@import`.
- No fixed overlays or intrusive positioning.
- No root margins.
- Responsive constraints exist for grids, media, cards, and buttons.
- No one-note visual palette if merchant did not request it.
- Text has wrapping rules for long product names and Bengali/English mixed content.

### Commerce Validation

- Prices and sale language match trusted product data.
- Inventory, delivery, warranty, payment, and discount claims have source refs.
- CTAs use real product/category/collection/page URLs.
- Product images match the product/image context or are clearly decorative approved media.
- Generated copy does not imply unavailable payment/shipping providers.

### Performance Validation

- CSS size within profile budget.
- HTML size within profile budget.
- No huge base64 assets in persisted artifacts.
- Images use optimized Scalius/R2/CDN paths.
- No layout patterns likely to cause large CLS in storefront.
- Preview and final render use the same wrapper/assembler.

## Merchant Configuration Model

Generated widgets should not be frozen blobs. The model should identify merchant-editable fields, and the UI should expose controls without requiring another model call for every small change.

Recommended field classes:

- Copy: headline, eyebrow, subcopy, CTA label.
- Merchandising refs: featured product IDs, category IDs, collection IDs.
- Media refs: hero image, card image, background image where allowed.
- Style tokens: accent color, background treatment, radius, density, card treatment.
- Behavior toggles: show prices, show badges, show CTA, show trust strip.
- Locale/tone: language, urgency, formality, campaign tone.

Recommended rule: merchant edits should modify an IR/config layer where possible, then re-render trusted HTML/CSS. Regenerate only when changing composition, not when editing a headline or accent color.

## IR Direction

Raw HTML/CSS is flexible but hard to prove safe and coherent. The long-term high-assurance model is a widget IR:

```ts
type WidgetIR = {
  root: {
    classPrefix: string;
    theme: WidgetThemeTokens;
    density: "compact" | "standard" | "campaign";
  };
  blocks: Array<
    | HeroBlock
    | ProductGridBlock
    | CategoryRailBlock
    | OfferStripBlock
    | TrustBandBlock
    | ComparisonBlock
    | FAQBlock
    | CTABlock
  >;
  manifest: WidgetManifest;
};
```

Benefits:

- Faster generation: the model configures known blocks instead of writing all markup.
- Higher reliability: renderers enforce scope, accessibility, responsive layout, and URL policies.
- Better merchant editing: block fields map naturally to controls.
- Easier caching: IR diffs are small and deterministic.
- Better repair: invalid block config is easier to fix than arbitrary markup.

Migration path:

1. Add manifest and stricter validators to current `{ html, css }`.
2. Add typed section plans and merchant fields.
3. Introduce IR for common blocks while preserving raw HTML/CSS fallback.
4. Make the default path IR -> trusted renderer.
5. Reserve raw HTML/CSS for advanced/admin-only experiments with stricter review.

## Inline JavaScript Policy

Default policy: no inline JavaScript in normal storefront widgets.

Reasons:

- It expands the XSS surface for merchant/customer pages.
- It weakens CSP unless hashes/nonces and strict controls are added.
- It makes cached storefront fragments harder to reason about.
- It creates hidden dependencies on DOM structure and global state.
- It makes AI repair much riskier because behavior and markup become coupled.

If interactive generated widgets are needed later, make them a separate capability:

- Explicit merchant/admin opt-in.
- Sandboxed preview runtime.
- No direct access to secrets, cookies, local storage, or unrestricted network.
- Approved behavior primitives only: tabs, accordion, carousel, countdown, filter chips.
- AST/static validation plus runtime CSP.
- Trusted renderer preferred over arbitrary generated JS.

## Evals And QA

A production widget generator needs repeatable evals, not only visual taste checks.

Fixture suite:

- Homepage discovery widget with products/categories/images.
- Campaign landing section with offer copy and trust proof.
- Collection merchandising section with comparison/buying guide.
- Product bundle widget with mixed availability.
- Bengali/English mixed catalog names and long product titles.
- Image-heavy widget with multiple aspect ratios.
- Malicious merchant prompt asking for scripts/global CSS/external links.
- Malicious catalog text containing HTML/JS-like strings.
- Missing/empty media context.
- Provider truncation or invalid structured output.

Automated checks:

- Schema parse and strict fields.
- Sanitizer diff: what was removed and why.
- CSS selector scope.
- Manifest refs and URL allowlist.
- Accessibility smoke test.
- Screenshot diff at mobile/tablet/desktop for overflow and blank space.
- Latency and token budget by stage.

Human review rubric:

- Does it look like one coherent widget?
- Does it fit ecommerce scanning behavior?
- Are product/category/media choices intentional?
- Can a merchant edit the important parts?
- Are there awkward gaps, repeated CTAs, visual jumps, or mismatched tones?
- Are claims source-backed?

## Practical Recommendations For Scalius

### Near-Term

1. Keep the current HTML/CSS generation path, but make the final artifact include `manifest`, `diagnostics`, and `merchantFields`.
2. Add a shared operation-level retry budget.
3. Add provider capability flags for structured output, structured streaming, image input, tool support, max output, and privacy profile.
4. Stream typed progress events and completed validated sections.
5. Add section-level and final artifact validators for scoped CSS, root spacing, links, refs, and commerce claims.
6. Add a finalizer that edits the whole composition under the original plan.

### Mid-Term

1. Move staged orchestration from the browser into a server-owned endpoint.
2. Add test fixtures and evals for widget generation.
3. Add merchant-editable field extraction and a UI editor for those fields.
4. Add IR for the most common blocks: hero, product grid, category rail, trust band, FAQ, CTA.
5. Use trusted renderers for IR blocks and allow raw HTML/CSS only as fallback.

### Long-Term

1. Make IR the default generation target.
2. Use model-generated HTML/CSS mainly for novel layouts that are then converted into IR or held for manual review.
3. Add visual QA with screenshot checks before saving high-impact landing/page sections.
4. Offer profile-based provider routing and observability in admin settings.
5. Add an optional sandboxed interactive-widget product surface with strict behavior primitives.

## Source Index

- [AI SDK Core: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [AI SDK Core: streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
- [AI SDK Errors: NoObjectGeneratedError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-no-object-generated-error)
- [AI SDK UI: Streaming Custom Data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data)
- [AI SDK UI: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [AI SDK UI: createUIMessageStream](https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream)
- [AI SDK UI: Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)
- [AI SDK RSC: streamUI](https://ai-sdk.dev/docs/reference/ai-sdk-rsc/stream-ui)
- [Vercel AI Gateway Provider Options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)
- [Vercel AI Gateway Capabilities](https://vercel.com/docs/ai-gateway/capabilities)
- [Vercel AI Gateway Models and Providers](https://vercel.com/docs/ai-gateway/models-and-providers)
- [v0 Platform API Overview](https://v0.app/docs/api/platform/overview)
- [v0 AI Tools Adapter](https://v0.app/docs/api/platform/adapters/ai-tools)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Prompt Engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)
- [Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Cloudflare Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/json-mode/)
- [OWASP Cross Site Scripting Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [MDN CSP Guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [MDN Content-Security-Policy style-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src)
- [DOMPurify README](https://github.com/cure53/DOMPurify)
