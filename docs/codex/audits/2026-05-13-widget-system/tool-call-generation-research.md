# Tool-Call Generation Research for Scalius Widgets

Date: 2026-05-13

Scope: AI-assisted storefront widget generation in Scalius Commerce. This is a research/audit note only; it does not propose immediate code edits.

## Current Scalius Surface

The widget generation path is already split across the right boundaries:

- Admin UI orchestration: `apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx`, `apps/admin-v2/src/components/admin/widgets/widget-form/useAiGenerator.ts`, `useAiImprover.ts`, `useStagedGeneration.ts`, `FullScreenEditor.tsx`, and `AiAssistant.tsx`.
- API generation boundary: `apps/api/src/routes/admin/ai.ts`, with validation and normalization in `apps/api/src/routes/admin/ai-response-validation.ts`.
- Provider/runtime settings: `packages/core/src/modules/ai/ai-settings.service.ts`, `ai-config.ts`, `prompt-helper-v2.ts`, and admin settings UI in `apps/admin-v2/src/components/admin/settings/WidgetAiSettingsBuilder.tsx`.
- Widget persistence/rendering: `packages/core/src/modules/widgets/widgets.service.ts`, `packages/core/src/modules/widgets/widgets.validation.ts`, and storefront rendering in `apps/storefront/src/lib/widget-content.ts` plus `apps/storefront/src/lib/shortcodes.ts`.
- Shared safety utilities: `packages/shared/src/html-sanitize.ts`, `css-sanitize.ts`, `css-scope.ts`, `tag-parser.ts`, `json-repair.ts`, and `html-section-parser.ts`.

The current design already has important guardrails: model allowlists, provider credential validation, request size limits, KV-backed AI rate limiting, server-side response normalization, HTML/CSS sanitization, no-JavaScript prompt contracts, scoped storefront CSS, preview iframe sandboxing, widget history, and no-context commerce claim fallback logic.

## External Best-Practice Signals

- Vercel AI SDK 6 recommends structured generation through `generateText` / `streamText` with `Output.object()` instead of the older `generateObject` flow, and explicitly supports combining multi-step tool calling with a structured final output. Source: [Vercel AI SDK 6 announcement](https://vercel.com/blog/ai-sdk-6) and [AI SDK structured data docs](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data).
- AI SDK tool calls should use typed `tool()` definitions with Zod/JSON schemas, optional approval for sensitive tools, lifecycle observability, and `activeTools` to limit what the model can call. Source: [AI SDK tool calling docs](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling).
- AI Gateway/model routing works best when model IDs are request-scoped and provider routing/fallbacks are explicit where needed; Vercel documents plain `provider/model` strings, provider ordering, provider filters, request-scoped credentials, and model fallbacks. Source: [Vercel Models & Providers](https://vercel.com/docs/ai-gateway/models-and-providers) and [Provider Options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options).
- MCP is useful when an AI host must discover many external tools/resources, but naive loading of every tool harms latency, cost, and model performance. Progressive discovery and explicit schema definition are recommended once tool count grows. Source: [MCP client best practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices) and [AI SDK MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools).

## Recommendations

### 1. Make `Output.object()` the primary contract for widget artifacts

`apps/api/src/routes/admin/ai.ts` already attempts structured generation when `resolveWidgetAiModelCapabilities()` says the model supports it, then falls back to tagged text. Keep that direction and treat `apps/api/src/routes/admin/ai-response-validation.ts` as the canonical artifact contract.

Actionable next step:

- Define the future artifact schema around Scalius concepts, not raw code only: `{ html, css, metadata, safety, assetsUsed, commerceFactsUsed }`.
- Keep `<htmljs>/<css>` parsing as compatibility fallback for external chatbot copy/paste and providers with weak structured output.
- Add structured plan output for staged generation first, because `stagedPlanOutputSchema` already exists and is lower risk than changing full widget artifacts.

Why it fits Scalius:

- The admin currently parses AI output again in `useAiGenerator.ts` and `useAiImprover.ts`. A stronger API response shape can reduce duplicated browser-side parsing and make the server the authority for whether a generated widget is acceptable.

### 2. Keep provider routing simple, but standardize capability metadata

Scalius currently supports OpenRouter, OpenAI, Gemini, and Cloudflare Workers AI via `getLanguageModel()` in `apps/api/src/routes/admin/ai.ts`. Settings already include model allowlists and capability overrides in `WidgetAiSettingsBuilder.tsx`.

Actionable next step:

- Keep OpenRouter as the general multi-provider route for this Cloudflare-first app rather than introducing Vercel AI Gateway unless the deployment target or billing model changes.
- Continue storing per-provider `structuredOutput`, `visionInput`, and `maxImages`, but add observed generation outcomes later: parse failures, structured-output fallback rate, timeout rate, and validation failure category.
- Prefer explicit per-provider default models and allowlists over automatic open model catalogs for production widget generation.

Why it fits Scalius:

- `packages/core/src/modules/ai/ai-settings.service.ts` already constrains official base URLs, encrypts API keys, normalizes model lists, and caps allowed models. That is the right foundation for safe multi-provider routing.

### 3. Treat validation as a pipeline, not a parser

Scalius has good individual pieces: `tag-parser.ts`, `json-repair.ts`, `html-sanitize.ts`, `css-sanitize.ts`, `css-scope.ts`, and server checks in `ai-response-validation.ts`.

Actionable next step:

- Document and enforce this order as the canonical pipeline: parse -> schema validate -> sanitize HTML -> sanitize CSS -> reject scripts/unsafe claims -> normalize layout extremes -> preview -> persist -> scope CSS on storefront render.
- Keep both API-side sanitization and storefront-side sanitization. This is defense in depth, not duplication.
- Add validation categories to errors, such as `parse_failed`, `script_rejected`, `unsafe_url`, `css_invalid`, `commerce_claim_rejected`, and `layout_clamped`, so admin UX can suggest the right retry.

Why it fits Scalius:

- `apps/api/src/routes/admin/ai-response-validation.ts` already centralizes no-script and no-context commerce claim checks. `apps/storefront/src/lib/widget-content.ts` already re-normalizes, sanitizes, optimizes images, and scopes CSS before rendering.

### 4. Keep preview safe and intentionally less powerful than storefront

`FullScreenEditor.tsx` uses `srcDoc`, sanitizes HTML/CSS, and sets `sandbox="allow-same-origin"`. Since Scalius widgets are intended to be HTML/CSS only, preview should not support script execution.

Actionable next step:

- Keep JavaScript out of generated widgets and previews. If future interactive widgets are needed, model them as approved Scalius components/settings rather than arbitrary JS.
- Continue rendering generated content in a sandboxed iframe before accept. Treat preview acceptance as a human approval gate, not a security boundary.
- Consider adding preview diagnostics later: horizontal overflow, empty render, missing root wrapper, excessive height, external URL count, and image load failures.

Why it fits Scalius:

- The storefront already scopes rendered widget CSS with `getWidgetScopeClass()` and `scopeCss()`. Preview should approximate storefront constraints but remain stricter so unsafe or broken output is caught before persistence.

### 5. Use MCP-style tools only for stable, externalized capabilities

MCP would help if Scalius needs to expose reusable commerce capabilities to many AI hosts, such as product search, media lookup, widget history read, or safe theme-token lookup. It would overcomplicate the current in-app widget generator if used merely to call existing internal functions from the same API route.

Good MCP/tool candidates:

- Read-only product/category/collection search backed by the same context currently fetched through `getAiContextBatchDetails()`.
- Media library search with constrained signed/HTTPS URLs.
- Theme token/resource lookup so models can use approved colors, spacing, and typography.
- Widget history/resource retrieval for external AI coding tools, if merchants or developers edit widgets outside the admin UI.

Poor MCP/tool candidates:

- Direct arbitrary HTML/CSS write tools.
- Internal one-off wrappers around `generateStructuredPrompt()` or `sanitizeHtml()`.
- Tool servers loaded with every admin API capability.
- Anything requiring secrets or destructive writes without explicit user approval.

Practical rule:

- Use direct typed functions inside `apps/api/src/routes/admin/ai.ts` while the widget generator has a small, known tool surface. Introduce MCP only when the same capability must be safely discovered and reused by multiple AI clients or when tool count makes progressive discovery valuable.

## Suggested Implementation Sequence

1. Consolidate artifact validation into one API response shape, reusing `widgetOutputSchema` and keeping tag parsing as fallback.
2. Add validation/error categories and log them from `apps/api/src/routes/admin/ai.ts`.
3. Move admin parsing in `useAiGenerator.ts` and `useAiImprover.ts` toward trusting a normalized server artifact instead of reparsing raw model text.
4. Add preview diagnostics in `FullScreenEditor.tsx` without changing storefront rendering.
5. Only after those are stable, evaluate typed internal tools for catalog/media/theme lookup; defer MCP unless external AI hosts need the same capabilities.

## Bottom Line

The biggest win is not more agent machinery. It is a stricter server-owned widget artifact contract, predictable provider capability routing, richer validation diagnostics, and a preview that stays deliberately constrained. MCP can be useful later, but only as an integration boundary for stable, reusable commerce tools.
