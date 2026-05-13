# AI Generation Architecture Research

Date: 2026-05-13

Scope: widget/page/collection AI generation in `apps/admin-v2/src/components/admin/widgets/widget-form`, `apps/api/src/routes/admin/ai.ts`, and `packages/core/src/modules/ai`.

Non-goal: no production code changes.

## Executive Summary

The current architecture is stronger than a plain "prompt to HTML" flow: prompts are assembled with bounded store context, generated output is normalized and sanitized server-side, structured output is used where the provider path is reliable, and Cloudflare/Kimi is deliberately kept on text/tag output because Workers AI JSON Mode is not streamable and may fail schema satisfaction.

The main weakness is orchestration shape. Single-shot generation now uses `stream: true`, but the UI still waits for the final normalized artifact before previewing it. Staged generation gives better visible progress, but it is browser-orchestrated and serial: plan, N section calls, then finalization. With API SDK retries plus client section retries, one merchant action can multiply into many provider calls and approach the current `20/minute` admin AI rate limit.

The best next architecture is a server-owned generation operation that emits progress events, owns the retry budget, validates/sanitizes every stage, and returns a canonical widget artifact. Keep streamed single-shot as the default path. Use staged generation only for explicitly large or merchant-selected compositions until the server orchestrator can safely parallelize or batch parts.

## Current Repo Shape

- Admin loads provider settings and models, gets prompt text and catalog context, builds messages with `generateStructuredPrompt()`, then chooses single-shot or staged by merchant toggle: `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts`.
- Prompt assembly serializes product/category/collection/image context into explicit untrusted data blocks, caps images/products/categories/collections, and adds destination-specific contracts: `packages/core/src/modules/ai/prompt-helper-v2.ts`.
- API generation uses Vercel AI SDK v6 with OpenRouter, OpenAI, Gemini, and Workers AI adapters: `apps/api/src/routes/admin/ai.ts`.
- `/generate` supports streaming and non-streaming. The streaming route uses `streamText()` and an OpenAI-compatible SSE envelope, then finalizes/repairs the full raw text at stream end.
- `/generate-staged` supports `plan`, `generate`, and `finalize`, but is non-streaming. Planning and widget output use `Output.object()` where capability detection allows it, otherwise tag/text output is parsed and repaired.
- Output validation uses strict Zod schemas for `{ html, css }` and staged plans, then normalizes tag or JSON output, sanitizes HTML/CSS, and rejects scripts: `apps/api/src/routes/admin/ai-response-validation.ts`.
- Capability gates intentionally infer Cloudflare as text output and no native image input by default: `packages/core/src/modules/ai/ai-config.ts`.

## Primary Source Notes

- Vercel AI SDK v6 standardizes structured output through `generateText()` or `streamText()` with `output: Output.object({ schema })`; schema output is still something apps must validate and handle on error. Source: [AI SDK structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data).
- `streamText()` is meant for interactive use cases and supports `maxRetries`, `abortSignal`, and timeout controls including `chunkMs`. Source: [AI SDK streamText](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text).
- AI SDK exposes `NoObjectGeneratedError` details such as raw text, response metadata, usage, finish reason, and cause. Source: [AI SDK NoObjectGeneratedError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-no-object-generated-error).
- v0 Platform API is a project/chat/code-generation API for creating and iterating web apps, not a narrow merchant runtime widget generator. Source: [v0 Platform overview](https://v0.app/docs/api/platform/overview) and [Create Chat](https://v0.app/docs/api/platform/reference/chats/create).
- Cloudflare Workers AI JSON Mode accepts OpenAI-compatible `response_format` schemas, but Cloudflare says it cannot guarantee schema satisfaction and JSON Mode currently does not support streaming. Source: [Cloudflare Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/).
- Cloudflare documents Kimi K2.6 as long-context, vision-capable, tool-calling-capable, and structured-output-capable. Source: [Cloudflare Kimi K2.6 model](https://developers.cloudflare.com/ai/models/@cf/moonshotai/kimi-k2.6/).
- Gemini structured output supports JSON Schema, streaming structured outputs, and only a subset of JSON Schema; Google still recommends app-level semantic validation. Source: [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output).
- OpenAI recommends strict JSON schema structured outputs and clear schema descriptions. Source: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs). Function calling is for connecting models to app-provided tools/data/actions. Source: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling).
- OpenRouter's model API exposes `architecture.input_modalities`, `context_length`, and `supported_parameters`, which is more useful than hard-coded capability guesses for OpenRouter models. Source: [OpenRouter models API](https://openrouter.ai/docs/api/api-reference/models/get-models).
- OpenRouter prompt caching and sticky routing can reduce repeated prompt cost, while its context-compression plugin removes/truncates the middle of prompts and is risky for exact product facts. Sources: [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching), [OpenRouter message transforms](https://openrouter.ai/docs/guides/features/message-transforms).
- Gemini context caching supports implicit and explicit caching for repeated context; cached content still counts against token limits and is a prompt prefix. Source: [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching).

## Architecture Comparisons

### Single-Shot vs Staged Generation

Single-shot is the right default for normal homepage widgets. It uses one provider request, one validation pass, one retry envelope, and one final artifact. It has lower wall-clock time and fewer rate-limit interactions.

Staged generation is useful when the user explicitly wants a campaign/landing flow or rich multi-section composition. The current implementation plans, generates sections serially, previews each completed section, then sends a finalizer request. That improves perceived progress, but adds many failure points and expands token usage because base context is resent with each section plus previous-section snippets.

Implementation recommendation: keep the UI toggle, but move staged orchestration into a server endpoint such as `POST /api/v1/admin/ai/generate-widget`. It should emit events:

```text
planning -> section.started -> section.completed -> validating -> finalizing -> completed
```

The server should return a final canonical artifact even if final polish fails, and should own retry/rate-limit accounting for the whole operation.

### Streaming vs Structured Output

Structured output is best for contracts: plan objects, final `{ html, css, warnings }`, source manifest, and future IR. AI SDK v6 supports `Output.object()` with both `generateText()` and `streamText()`, and OpenAI/Gemini/OpenRouter official docs all favor schema-bound outputs where supported.

Streaming is best for perceived latency. The current single-shot path streams SSE, but `handleSimpleGeneration()` awaits `readChatCompletionStream()` before parsing and setting `generatedContent`, so merchants still see a spinner until completion. Staged generation feels faster because it updates preview section by section, not because model compute is lower.

Implementation recommendation: split transport from contract:

- Stream progress and draft deltas for UI responsiveness.
- Validate only complete artifacts before enabling "Accept".
- For text/tag streaming, use the existing `StreamingTagParser` idea to show provisional preview after complete `<htmljs>` and `<css>` tags arrive.
- For structured streaming, consume partial object events only as progress; final schema validation remains mandatory.
- Keep Cloudflare/Kimi on text streaming by default because Cloudflare JSON Mode is non-streaming and may fail schema satisfaction.

### Prompt Contracts vs IR/Tool Plans

Prompt contracts are already doing useful work: destination-specific goals, composition rules, no invented commerce facts, tag-format response rules, and untrusted catalog data boundaries. They are still soft constraints. The sanitizer can reject scripts, but it cannot prove that a product URL, price, claim, or image was actually sourced from selected context.

IR/tool plans give a stricter boundary:

- `WidgetPlan`: sections, layout intent, selected product/media/category IDs, allowed behaviors.
- `WidgetIR`: typed blocks such as hero, productGrid, offerStrip, categoryRail, trustBand, FAQ, CTA.
- `WidgetManifest`: exact `href`, `src`, product IDs, category IDs, buy-now URLs, and claims used.
- Trusted renderer: turns IR into scoped HTML/CSS and allowlisted behavior hooks.

Implementation recommendation: do not jump straight from model-written HTML to arbitrary JS. First add a final artifact manifest and validate all product/media URLs against selected context. Then introduce IR for common blocks and reserve freeform HTML/CSS for fallback/prototyping.

### Retry Strategies

Current retry layers can stack:

- AI SDK call options use `maxRetries: 2`.
- `generateTextWithTransientRetry()` adds another retry for transient provider errors.
- Text/widget format repair can trigger another model call.
- Staged section generation retries each section up to `MAX_RETRIES = 3` with exponential backoff.
- Staged fallback can retry the whole request as single-shot.

This is reasonable defensive coding in isolation, but too expensive for a multi-call orchestration. It also makes merchant-visible latency hard to predict.

Implementation recommendation: define one per-operation retry budget. Suggested default:

- Plan: 1 transient retry, then deterministic plan fallback.
- Section: 1 transient retry plus 1 format-repair retry; no more than 2 provider calls per section.
- Finalizer: 1 transient retry; fallback to combined sections.
- Whole operation: never fall back from failed staged to single-shot without asking or using remaining retry budget.
- Log every retry with `requestId`, `stage`, `attempt`, `failureClass`, provider/model, latency, and usage.

### Context Compression

The repo already uses the safest context-compression strategy for commerce facts: deterministic caps, JSON serialization, sanitization, and previous-section summaries. That should remain the primary path.

Provider-side prompt caching is useful, but not a substitute for context budgeting. OpenRouter and Gemini both support caching patterns, but cache hits depend on stable prefixes, provider routing, model rules, and token thresholds. OpenRouter context compression is not appropriate for exact product facts because it removes/truncates the middle of prompts, which can silently drop product or URL evidence.

Implementation recommendation:

- Keep static instructions and stable catalog context at the beginning of messages to improve provider cache hits.
- Add a deterministic "commerce manifest" compact format before prose descriptions.
- Summarize previous sections into design tokens and used IDs instead of including large raw HTML/CSS.
- Treat any provider-side context-compression plugin as opt-in for non-factual drafts only.

### Perceived Latency

Single-shot has the best true latency but currently weak perceived latency because preview appears only after stream completion. Staged generation has worse true latency but better progress affordances because the UI displays planning, section progress, and partial preview.

Implementation recommendation:

- Make single-shot show meaningful progress: "building prompt", "model drafting", "validating", "preview ready".
- Render provisional streamed preview only after parseable safe chunks, and disable Accept until final API validation.
- For staged, stream server progress events instead of running orchestration in the browser.
- Add latency telemetry by stage: prompt/context fetch, provider TTFB, provider total, validation/repair, sanitizer, final payload.

## Provider Fit

| Provider path | Best use | Caveat |
| --- | --- | --- |
| Cloudflare Workers AI/Kimi | Default low-credential Cloudflare-native long-context text/tag generation | Keep text streaming by default; JSON Mode is not streaming and may fail schema satisfaction |
| OpenAI | Strict structured artifacts, vision input, strong tool/structured-output ecosystem | Direct API keys are required unless routed through another gateway |
| Gemini | Structured output with JSON Schema, streaming structured output, strong image input | Schema subset and app-level semantic validation still required |
| OpenRouter | Broad model catalog, capability metadata, routing/fallback/caching | Must read live `supported_parameters` and input modalities; provider routing/fallback can add latency |
| v0 | Internal design/prototyping, generating reference React/shadcn components or templates | Not recommended as the runtime merchant widget generator for this HTML/CSS-only Cloudflare worker flow |

## Recommended Target Architecture

1. Add a server-owned operation endpoint:

```text
POST /api/v1/admin/ai/generate-widget
body: {
  operation: "create" | "improve",
  promptType: "widget" | "landing-page" | "collection",
  userPrompt: string,
  placement: {...},
  contextIds: { productIds, categoryIds, collectionIds, imageIds },
  mode: "fast" | "staged" | "auto"
}
response: text/event-stream or JSON artifact
```

2. Return canonical artifacts:

```ts
type WidgetGenerationArtifact = {
  requestId: string;
  provider: string;
  model: string;
  mode: "fast" | "staged";
  artifact: {
    html: string;
    css: string;
    sections?: Array<{ id: string; title: string; html: string; css: string }>;
    warnings: string[];
    manifest: {
      productIds: string[];
      categoryIds: string[];
      collectionIds: string[];
      imageUrls: string[];
      hrefs: string[];
    };
  };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  timings: Record<string, number>;
}
```

3. Keep the OpenAI-compatible `choices[0].message.content` response only as a compatibility wrapper while the editor migrates to canonical artifacts.

4. Add manifest validation before persistence:

- Every product/category/collection/buy-now URL must exist in selected context or approved storefront routes.
- Every image URL must be selected media or selected product/category/collection media.
- Generated claims must either be generic or tied to known fields.

5. Move toward IR once the manifest exists:

```ts
type WidgetBlock =
  | { type: "hero"; title: string; body?: string; mediaId?: string; cta?: LinkRef }
  | { type: "productGrid"; productIds: string[]; cardStyle: "compact" | "editorial" }
  | { type: "offerStrip"; productIds?: string[]; message: string }
  | { type: "categoryRail"; categoryIds: string[] }
  | { type: "trustBand"; items: string[] }
  | { type: "cta"; label: string; href: LinkRef };
```

The model can draft `WidgetIR`, but the app owns rendering, scoping, behavior modules, and validation.

## Top Recommendations

1. Build a server-side `generate-widget` orchestrator with SSE progress and one retry budget per merchant action.
2. Keep single-shot streamed generation as default; reserve staged mode for explicit large compositions until orchestration is server-owned.
3. Replace the editor protocol's text envelope with canonical `{ html, css, warnings, manifest, sections }` artifacts, while keeping the old OpenAI-compatible wrapper temporarily.
4. Add deterministic manifest validation for generated `href`, `src`, product IDs, prices, and buy-now URLs before save.
5. Start the IR path with a small renderer registry for common ecommerce blocks; do not allow model-generated JavaScript.
