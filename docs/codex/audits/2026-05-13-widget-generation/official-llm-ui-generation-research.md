# Official LLM UI Generation Research

Date: 2026-05-13

Scope: official/primary-source research for improving Scalius staged HTML/CSS widget generation. This memo is research only; it does not propose source edits.

## Executive Summary

The current staged widget direction is broadly aligned with official guidance: use schemas for plans and widget payloads, keep generated UI behind validation, avoid arbitrary JavaScript, and treat model output as an artifact that must be parsed, sanitized, and tested before display or persistence.

The main refinements are:

1. Keep the staged generator server-owned: plan, validate, generate sections, validate each section, merge, sanitize, then return a canonical artifact.
2. Prefer AI SDK structured outputs (`Output.object` / `Output.array`) where the selected provider/model is known to support them reliably; keep a text/tag fallback for provider paths that fail or cannot stream structured output reliably.
3. Use streaming for progress and partial status, not for accepting incomplete widget content. Only completed, validated sections should enter preview state.
4. Treat v0 as an optional specialized external code-generation backend or inspiration source, not as the primary runtime contract for merchant widgets.
5. Move over time from raw `{ html, css }` toward a stricter widget IR and renderer registry for higher assurance.

## Official Findings

### Vercel AI SDK Structured Output

The current AI SDK v6 documentation says structured output is part of the `generateText` and `streamText` flow via an `output` property. It supports Zod, Valibot, and JSON Schema, and validates generated data against the requested shape. Source: [AI SDK Core: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data).

Important details for Scalius:

- `generateText({ output: Output.object({ schema }) })` is the right non-streaming path for validated plan and widget objects.
- `streamText({ output: Output.object({ schema }) })` exposes `partialOutputStream`, but the docs warn that partial outputs cannot be validated because incomplete data may not yet conform to the schema.
- `Output.array({ element })` can expose `elementStream`; each emitted array element is complete and validated. This is the most interesting official pattern for section-by-section staged generation.
- `Output.json()` only checks parseable JSON and does not validate structure or types. It should not be used as the primary widget contract.
- Structured output can be combined with tool calling, but it counts as a step in the AI SDK multi-step model, so any `stopWhen` limits need to account for that.
- For `streamText`, errors are part of the stream; use `onError` and do not assume thrown exceptions will catch all failures.

Recommendation: keep the existing `widgetOutputSchema` and `stagedPlanOutputSchema` shape, but consider adding a second schema for complete staged sections and using `Output.array({ element: stagedSectionSchema })` for providers where streaming structured arrays are reliable. Accept only completed `elementStream` items, never partial objects, into editor state.

### Vercel AI SDK Generative UI

The AI SDK UI generative UI guide frames "generated UI" as a tool-driven flow: the model chooses a tool, the tool returns data, and trusted React components render that data. Source: [AI SDK UI: Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces).

That is not identical to Scalius's current "model writes HTML/CSS" approach. The official pattern is safer because the model generates data or tool calls, while application-owned components render UI.

Recommendation: use the guide as evidence for the long-term widget IR direction. Instead of letting the model author final markup indefinitely, define trusted widget block types such as `hero`, `product_grid`, `offer_banner`, `trust_strip`, `faq`, `collection_feature`, and `cta`. The model can produce IR/settings, then Scalius renderers output scoped HTML/CSS. Raw HTML/CSS can remain a fallback or power-user path.

### Vercel AI SDK UI Streaming Protocols

The AI SDK stream protocol supports text streams, data streams, tool input/output parts, file parts, source parts, and custom `data-*` parts. Source: [AI SDK UI: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol).

Relevant details:

- Text streams only support basic text; data streams are the official path for richer events such as tool calls and custom structured updates.
- Custom data parts use `data-*` typed chunks, which maps well to progress events like `data-widget-plan`, `data-widget-section-start`, `data-widget-section-complete`, `data-widget-warning`, and `data-widget-final`.
- `createUIMessageStream` can merge streams and has finish/error callbacks. Source: [AI SDK UI: createUIMessageStream](https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream).

Recommendation: when the editor protocol is upgraded, avoid squeezing staged progress into OpenAI-style text chunks. Use a server-owned JSON/SSE event protocol or AI SDK UI-compatible data stream. Keep the current `choices[0].message.content` compatibility until the admin client is ready to consume canonical objects/events.

### AI SDK RSC `streamUI`

The AI SDK RSC `streamUI` reference explicitly says AI SDK RSC is experimental and recommends AI SDK UI for production. Source: [AI SDK RSC: streamUI](https://ai-sdk.dev/docs/reference/ai-sdk-rsc/stream-ui).

Recommendation: do not base Scalius widget generation on `@ai-sdk/rsc` or `streamUI`. The admin app is TanStack Start, and storefront widgets are persisted HTML/CSS/IR, so an RSC UI stream would be the wrong operational contract anyway.

### v0

The current v0 docs separate the Platform API from model-style generation. The Platform API is for chat/project/deployment workflows, requires a `V0_API_KEY`, and is accessed with `v0-sdk`. Sources: [v0 Platform API overview](https://v0.app/docs/api/platform/overview), [v0-sdk](https://v0.app/docs/api/platform/packages/v0-sdk).

v0 also documents an AI Tools adapter that lets an AI SDK agent call v0 Platform API tools for autonomous project workflows. Source: [v0 AI Tools adapter](https://v0.app/docs/api/platform/adapters/ai-tools).

Important fit notes:

- v0 is strong for full code/project generation, iterative chats, file workflows, and deployments.
- Scalius needs a narrow, deterministic runtime contract: safe storefront fragments, no arbitrary JS, strict catalog URL policy, and reusable widget placement.
- v0-generated code may be useful for offline inspiration, design exploration, or admin-only prototyping, but the output still needs the same sanitizer, URL allowlist, no-script policy, and section validation as any other model output.

Recommendation: treat v0 as optional provider research, not as a direct replacement for the staged widget pipeline. If integrated later, wrap it behind the same server operation and canonical widget schema. Do not persist v0 project/file outputs directly as storefront widgets.

### OpenAI Structured Outputs

OpenAI's structured outputs guide says Structured Outputs ensure schema adherence, while JSON mode only ensures valid JSON. OpenAI recommends Structured Outputs over JSON mode when possible. Source: [OpenAI: Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Relevant details:

- Structured output is appropriate when the model's response should match a schema for UI consumption.
- Function calling is appropriate when the model should call tools or connect to system data.
- OpenAI recommends clear, intuitive key names, titles/descriptions for important keys, and evals to determine the best structure.
- Edge cases still exist: refusals, max-token truncation, and incomplete responses must be handled.

Recommendation: the plan schema should stay strict, but it should become more semantically useful. Add fields like `sectionType`, `intent`, `contextRefs`, `visualRole`, `requiredAssets`, and `handoffNotes` rather than only free-text descriptions. For generated sections, prefer schema fields such as `html`, `css`, `usedProductIds`, `usedImageIds`, `links`, `warnings`, and `assumptions` so validators can enforce catalog and safety constraints.

### OpenAI Prompting

OpenAI's prompt engineering docs emphasize precise instructions, relevant context, clear message boundaries, few-shot examples, model/version evals, and pinning production model snapshots for consistent behavior. Source: [OpenAI: Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering).

Recommendation: keep stable global rules at the start of the prompt for caching, put task-specific merchant/catalog context in clearly delimited untrusted blocks, and add a small set of canonical input/output examples for the widget contract. Evaluate prompt changes against a fixed suite: homepage discovery widget, landing-page campaign section, collection merchandising block, product bundle, Bengali/English mixed catalog text, image-heavy widget, and malicious catalog text.

## Outdated or Risky Assumptions Found

- AI SDK v6 no longer uses the old `generateObject()` / `streamObject()` mental model in the official docs checked here; structured output is documented through `generateText` / `streamText` plus `Output.*`.
- `Output.json()` is not enough for widget contracts. It validates JSON syntax only, not schema shape.
- RSC `streamUI` should not be treated as a production-ready foundation; the official reference labels AI SDK RSC experimental and points production users to AI SDK UI.
- "Generative UI" in official AI SDK docs means trusted components rendering tool/data results. It is not an endorsement of persisting arbitrary model-authored HTML/CSS without a validation boundary.
- v0 is currently documented primarily as a Platform API for chats/projects/deployments and SDK workflows. It is not a drop-in structured widget generator unless wrapped behind Scalius's own safety contract.

## Implementation Recommendations for Staged HTML/CSS Widgets

### 1. Define a Canonical Server Operation

Target operation:

```ts
type GenerateWidgetRequest = {
  operation: "generate_widget";
  promptType: "homepage" | "landing_page" | "collection" | "shortcode";
  userPrompt: string;
  productIds: string[];
  categoryIds: string[];
  collectionIds: string[];
  imageIds: string[];
  placement?: unknown;
};
```

The client should submit intent and selected context IDs. The server should fetch and serialize safe catalog context, assemble the prompt, call the model, validate output, and return a canonical response. This prevents arbitrary client-supplied `system` or `assistant` messages from shaping production generation.

### 2. Upgrade the Plan Schema

Move from "section description strings" to typed plan sections:

```ts
type StagedSectionPlan = {
  index: number;
  sectionType: "hero" | "product_grid" | "offer" | "collection_feature" | "trust" | "faq" | "cta" | "custom";
  intent: string;
  visualRole: "lead" | "supporting" | "conversion" | "navigation" | "proof";
  contextRefs: string[];
  requiredAssets: string[];
  continuityNotes: string;
};
```

This gives each generation stage more than prose and lets validators check whether the final widget used only allowed product/media IDs and URLs.

### 3. Generate Completed Sections, Not Raw Streaming Text

For providers with reliable structured streaming, use `streamText` + `Output.array({ element: stagedSectionSchema })` and consume `elementStream`. Each element is complete and validated according to the AI SDK docs.

For providers where structured streaming is unreliable, keep the current sequential non-streaming section calls:

1. Generate one section.
2. Normalize tag or object output.
3. Validate/sanitize.
4. Store as a completed section.
5. Pass only compact previous-section context to the next call.

Either way, never use partial structured objects or incomplete text deltas as previewable widget content.

### 4. Return Canonical Artifacts

Final response shape should eventually become:

```ts
type WidgetGenerationResult = {
  success: true;
  data: {
    html: string;
    css: string;
    sections: Array<{
      index: number;
      plan: StagedSectionPlan;
      html: string;
      css: string;
      warnings: string[];
    }>;
    usedRefs: {
      products: string[];
      categories: string[];
      collections: string[];
      images: string[];
      urls: string[];
    };
    telemetry: {
      requestId: string;
      provider: string;
      model: string;
      structuredMode: "sdk" | "text";
      retries: number;
    };
  };
};
```

The existing OpenAI-style envelope can remain as a compatibility layer, but it should be a projection of this canonical result rather than the primary internal contract.

### 5. Build a Commerce Manifest and URL Validator

Before prompting, derive an allowlist:

- product IDs and canonical product URLs
- variant buy-now URLs
- collection/category URLs
- media IDs and CDN URLs
- site/storefront base URL

After generation, parse `href`, `src`, and `srcset`. Reject or rewrite anything outside the manifest, unsafe protocols, remote scripts, inline events, forms, and script tags. Keep sanitizer mutation counts in telemetry.

### 6. Add a Small Eval Harness

Official OpenAI guidance explicitly recommends evals for prompt/model changes. For Scalius, track at least:

- schema validity
- parse success
- sanitizer mutations
- unsafe URL attempts
- no-script/no-form compliance
- mobile CSS sanity
- section continuity
- catalog faithfulness
- Bengali/English mixed text handling
- latency and retry rate by provider/model

These evals are more useful than judging model output by visual impression alone.

### 7. Long-Term: Move to Widget IR

The safest target is not "better arbitrary HTML"; it is a renderer-owned IR:

```ts
type WidgetIR = {
  themeTokens: Record<string, string>;
  blocks: Array<{
    type: string;
    settings: Record<string, unknown>;
    bindings: Record<string, string>;
  }>;
};
```

This matches the official generative UI pattern more closely: the model chooses structured data/settings, while trusted Scalius renderers produce the final storefront markup.

## Suggested Priority Order

1. Preserve the current text/tag fallback, but make canonical object output the internal target.
2. Enrich the staged plan schema with typed section metadata.
3. Add per-section canonical validation and URL manifest checks before merge.
4. Add provider/model telemetry for structured-output failures and fallback reasons.
5. Introduce structured section streaming with `Output.array().elementStream` only after it is proven reliable for the enabled model/provider.
6. Design the first widget IR block registry for the most common ecommerce sections.

## Sources

- [Vercel AI SDK: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [Vercel AI SDK: Output reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/output)
- [Vercel AI SDK UI: Generative User Interfaces](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)
- [Vercel AI SDK UI: Object Generation](https://ai-sdk.dev/docs/ai-sdk-ui/object-generation)
- [Vercel AI SDK UI: Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [Vercel AI SDK UI: createUIMessageStream](https://ai-sdk.dev/docs/reference/ai-sdk-ui/create-ui-message-stream)
- [Vercel AI SDK RSC: streamUI](https://ai-sdk.dev/docs/reference/ai-sdk-rsc/stream-ui)
- [v0 Platform API overview](https://v0.app/docs/api/platform/overview)
- [v0-sdk](https://v0.app/docs/api/platform/packages/v0-sdk)
- [v0 AI Tools adapter](https://v0.app/docs/api/platform/adapters/ai-tools)
- [OpenAI: Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI: Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)
