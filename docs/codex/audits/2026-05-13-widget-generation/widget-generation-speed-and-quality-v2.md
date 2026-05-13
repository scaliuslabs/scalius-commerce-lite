# Widget Generation Speed And Quality V2

Date: 2026-05-13

Scope: current best practices for Scalius AI widget generation using Vercel AI SDK v6, structured output, streaming, prompt contracts, and commercial UI generators such as v0. This is a research/audit note only.

## Executive Takeaway

Scalius is already pointed in the right direction: the API uses AI SDK v6 `generateText`, `streamText`, and `Output.object`; widget output is normalized into `{ html, css }`; and storefront rendering keeps a no-script/sanitized HTML/CSS boundary.

The main speed and quality gap is orchestration. The fastest high-quality default should be one streamed, server-owned, goal-profiled widget generation call, with structured validation at the end and one repair call only when checks fail. Current staged generation should remain available as an explicit "best quality / large section set" mode, but it should not be the default path for ordinary widgets because it multiplies serial model calls.

## Sources Checked

- [Vercel AI SDK v6: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [Vercel AI SDK v6: Output reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/output)
- [Vercel AI SDK v6: streamText reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
- [Vercel AI SDK UI: Streaming Custom Data](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data)
- [Vercel AI SDK UI: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [Vercel AI SDK UI: Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)
- [Vercel AI SDK Core: Prompt Engineering](https://ai-sdk.dev/docs/ai-sdk-core/prompt-engineering)
- [OpenAI: Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [v0 Model API](https://v0.app/docs/api/model)
- [v0 Platform API overview](https://v0.app/docs/api/platform/overview)
- [v0-sdk](https://v0.app/docs/api/platform/packages/v0-sdk)
- [v0 AI Tools adapter](https://v0.app/docs/api/platform/adapters/ai-tools)
- [v0 Text Prompting](https://v0.app/docs/text-prompting)
- [v0 Design systems](https://v0.app/docs/design-systems)
- [v0 Design mode](https://v0.app/docs/design-mode)
- [Vercel blog: How to prompt v0](https://vercel.com/blog/how-to-prompt-v0)

## Current Scalius Fit

Current implementation patterns:

- `apps/api/src/routes/admin/ai.ts` uses `generateText`, `streamText`, and `Output.object`.
- `apps/api/src/routes/admin/ai-response-validation.ts` defines `widgetOutputSchema` and `stagedPlanOutputSchema`, then normalizes tag or JSON text into the same widget format.
- `packages/core/src/modules/ai/prompt-helper-v2.ts` builds structured messages, separates static context from dynamic merchant requests, and treats catalog data as untrusted.
- `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts` calls `/api/v1/admin/ai/generate` with `stream: false` for the simple path.
- `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts` performs plan, serial section calls, a delay between sections, then a finalizer call.

What this means:

- Quality foundations are good: schemas, sanitizer, no JavaScript, scoped CSS instructions, catalog URL reuse, and staged finalization.
- Speed is weaker than it needs to be: the normal simple path does not use the streaming API that already exists, while staged generation can require `1 + sections + finalizer` LLM calls before acceptance.
- The browser owns too much of the generation contract. It sends assembled messages, and staged generation orchestration lives in React. A safer, faster contract is server-owned: client submits intent and context IDs; API fetches context, builds prompt, runs model, validates, and returns canonical widget artifacts/events.

## Best Practices That Apply

### 1. Structured Output Should Be The Contract, Not Prompt Policing

AI SDK v6 documents structured output through `generateText` and `streamText` using `Output.object`, `Output.array`, `Output.choice`, or `Output.json`. `Output.object` validates the complete object against the schema. `Output.json` only checks parseable JSON and does not enforce structure or types.

OpenAI's structured output guidance reaches the same conclusion: prefer schema-constrained structured outputs over JSON mode when possible, use clear key names/descriptions, and build evals around the schema.

Scalius application:

- Keep `widgetOutputSchema` and `stagedPlanOutputSchema`.
- Add a stricter section schema for staged mode: `index`, `sectionType`, `intent`, `html`, `css`, `usedRefs`, `warnings`.
- Keep tag output as fallback, but normalize it into the same schema before it enters preview, history, or persistence.
- Avoid `Output.json()` for widgets. Use `Output.object()` for one widget or `Output.array()` for validated section streams.

### 2. Stream For Perceived Speed, But Only Accept Validated Artifacts

AI SDK's streaming docs make the UX case clearly: users should see progress before a long generation completes. For richer events, AI SDK UI data streams are a better fit than plain text chunks because they can carry typed progress parts.

The important caveat from the Output reference: partial object streams are deep partials and cannot be fully validated while incomplete. In contrast, `Output.array({ element })` can emit complete, validated elements through `elementStream`.

Scalius application:

- Use the existing `/generate` streaming support for the default simple path.
- Treat streamed text as preview/progress only until final normalization succeeds.
- For a future staged streaming path, prefer `Output.array({ element: stagedSectionSchema })` where provider support is reliable, because each emitted element is complete and validated.
- Replace OpenAI-compatible text stream emulation with a Scalius or AI SDK UI data stream over time: `plan`, `section-start`, `section-complete`, `warning`, `final`, `repair`.

### 3. Prompt Contracts Need To Be Typed Goal Profiles

AI SDK prompt guidance emphasizes meaningful names, lower temperature for object/tool generation, simpler schemas, descriptions on important fields, and provider warnings/debugging. v0 guidance says better prompts specify product surface, context of use, and constraints/taste. v0 text prompting similarly recommends specificity, UI/UX preferences, technical details, and breaking complex work into increments.

Scalius already has distinct prompts for widget, landing page, and collection. The next step is to make those choices executable contracts, not just prose.

Recommended goal profile fields:

```ts
type WidgetGoalProfile = {
  promptType: "widget" | "landing-page" | "collection";
  defaultSectionRange: [number, number];
  density: "compact" | "standard" | "campaign" | "commerce-dense";
  requiredRoles: Array<"opening" | "merchandising" | "proof" | "comparison" | "cta">;
  forbiddenPatterns: string[];
  ctaPolicy: "broad-homepage" | "campaign-conversion" | "product-or-buy-now";
  catalogPolicy: "provided-facts-only";
};
```

This applies directly to Scalius widgets:

- Homepage widget: compact 1-3 bands, broad discovery, avoid full campaign funnels.
- Landing section: 3-6 campaign bands, offer/proof/urgency/final CTA, avoid generic product-grid-only output.
- Collection section: 1-3 commerce-dense bands, product names/prices/links/buy-now URLs, avoid unrelated storytelling.

### 4. Generative UI Is Safer As Data Plus Trusted Renderers

AI SDK's generative UI guide frames generated UI as tool results rendered by trusted React components. That is safer than persisting arbitrary model-written markup.

Scalius still needs HTML/CSS widgets for the current storefront, so raw markup can remain. But the long-term direction should be a widget IR:

- `hero`
- `product_grid`
- `offer_banner`
- `trust_strip`
- `comparison`
- `collection_feature`
- `cta`

The model generates IR and settings; Scalius-owned renderers produce scoped HTML/CSS. This would reduce malformed markup, improve visual consistency, and make safety checks easier.

### 5. v0 Is Useful Inspiration Or An Optional Backend, Not A Drop-In Runtime

v0's Model API is framework-aware, OpenAI-compatible, supports streaming, text/image input, and large output windows. Its Platform API and `v0-sdk` cover chats, projects, versions, files, and deployments. v0 also supports design systems through registries and design-mode iteration with diffable versions.

Scalius fit:

- Good fit for offline prototyping, admin-only inspiration, prompt benchmarking, or a premium "draft with v0" experiment.
- Possible fit as a provider behind the same Scalius widget contract, using `@ai-sdk/vercel` or the OpenAI-compatible endpoint.
- Poor fit as a direct persistence path. v0 outputs project/code artifacts, while Scalius needs sanitized storefront fragments with no scripts, allowed URLs, placement metadata, and history snapshots.

If v0 is piloted, every response must still pass the Scalius schema, sanitizer, URL checks, no-script policy, CSS scoping checks, and preview rendering checks.

## Concrete Recommendations

### P0: Make Fast Streamed Single-Pass The Default

Default flow:

1. Client sends `{ promptType, userPrompt, selectedIds, placement, model }`.
2. API fetches catalog/media context and builds the goal-profile prompt.
3. API calls `streamText` with `Output.object({ schema: widgetOutputSchema })` where reliable, or text/tag fallback where not.
4. UI shows streamed draft/progress.
5. API normalizes, validates, sanitizes, and returns final `{ html, css, usedRefs, warnings, usage }`.
6. Run one repair call only if validation fails.

Expected result: ordinary widgets complete in one model call instead of several serial calls.

### P0: Move The Generation Contract To The API

Stop accepting arbitrary client-supplied `system` and `assistant` messages for production widget generation once the replacement route exists. The API should own:

- prompt assembly;
- catalog serialization;
- untrusted data boundaries;
- provider options and cache controls;
- structured output mode;
- repair policy;
- telemetry.

The admin should own UX state, not model contract construction.

### P0: Add Typed Goal Profiles And Evals

Add a compact eval suite before changing prompts:

- homepage discovery widget;
- landing campaign section set;
- collection merchandising section;
- image-heavy widget;
- Bengali/English catalog text;
- malicious catalog text;
- long product list with irrelevant items.

Score each output for parse success, no scripts, URL correctness, mode distinction, responsive structure, visual density, catalog factuality, and generation time.

### P1: Keep Staged Generation As Explicit Best Quality Mode

Current staged generation is valuable, but expensive. Keep it as opt-in for large landing pages or difficult composition requests.

Improve staged mode by:

- planning with `Output.object`;
- generating validated sections with `Output.array` or a server-side loop;
- removing fixed inter-section sleeps unless rate-limit feedback requires them;
- making the finalizer conditional on validators or "Best quality" mode;
- enforcing one retry boundary per stage instead of nested retries.

### P1: Use Data Streams For Progress Events

The current OpenAI-compatible stream is useful for compatibility. For the admin editor, typed events will be clearer:

```ts
type WidgetStreamEvent =
  | { type: "plan"; plan: WidgetPlan }
  | { type: "draft-delta"; text: string }
  | { type: "section-complete"; section: StagedSection }
  | { type: "warning"; message: string }
  | { type: "final"; widget: WidgetOutput };
```

Only `section-complete` and `final` should be eligible for persisted preview state.

### P1: Add Static Quality Gates Before Repair Calls

Before spending another LLM call, run deterministic checks:

- missing `<htmljs>`/`<css>` or failed schema parse;
- script tags, event handlers, unsafe URLs;
- unscoped selectors such as `body`, `html`, `*`, global `button`;
- external margins/gaps on root wrappers;
- invented product names, prices, discounts, URLs, or buy-now links;
- empty/mobile-breaking CSS;
- output length above configured limits.

Repair prompts should include the exact failing checks and ask for only a corrected `{ html, css }`.

### P2: Pilot v0 Behind The Same Contract

Pilot options:

- Use v0 Model API as an experimental provider for high-quality UI drafts.
- Use v0 Platform API for internal design exploration or building reusable block patterns.
- Build a small Scalius design registry or prompt package with store tokens, spacing rules, and ecommerce block examples.

Do not persist raw v0 project files directly as storefront widgets.

## Not Recommended

- Do not rely on JSON mode or `Output.json()` for production widgets.
- Do not accept partial streamed object data as final widget state.
- Do not make v0 the direct source of persisted storefront HTML/CSS without Scalius validation.
- Do not keep serial staged generation as the default for normal widgets.
- Do not add JavaScript to widget output to compensate for generation quality issues.

## Recommended Next Sequence

1. Add a new server-owned `generate-widget-v2` route while keeping existing routes.
2. Implement fast streamed single-pass generation first.
3. Add typed goal profiles and eval fixtures.
4. Move staged orchestration from React into the API as an opt-in mode.
5. Add typed stream events for admin progress.
6. Pilot v0 as a non-default provider only after the schema, sanitizer, and eval gates are in place.
