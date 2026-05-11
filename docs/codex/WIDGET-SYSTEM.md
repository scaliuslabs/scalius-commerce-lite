# Widget System Operating Notes

## Purpose

The widget system is Scalius Commerce's merchant-facing storefront composition layer. It is not just an HTML paste box. It should let merchants build and iterate on high-quality homepage sections, collection merchandising blocks, campaign sections, landing-page content, product bundles, trust/urgency panels, and reusable shortcode content without needing to know HTML, CSS, prompt engineering, or storefront internals.

## Product Standard

- Merchants must be able to create rich widgets from real store context: selected products, product images, media library images, categories, buy-now URLs, prices, discounts, availability signals, and brand/settings context.
- A generated homepage widget must default to a visible homepage placement unless the merchant explicitly chooses standalone shortcode usage.
- Landing-page and collection-oriented generation must be clearly represented as storefront sections until there is a full page-builder save flow.
- Failed, partial, loading, or parse-error output must never be acceptable as widget content.
- Every generated widget must be HTML/CSS only. No JavaScript, script tags, inline event handlers, remote scripts, forms, or unsafe URL protocols.
- CSS must be scoped or safe to scope before storefront rendering so one widget cannot break the page around it.
- Preview must be useful before publishing: desktop/tablet/mobile, code view, raw output for recovery, and clear generation status.

## AI Provider Reality

- Default model: Cloudflare Workers AI `@cf/moonshotai/kimi-k2.6`.
- Cloudflare documents Kimi K2.6 as a long-context model with vision inputs and structured outputs: https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/
- Cloudflare REST API usage requires Account ID plus API token: https://developers.cloudflare.com/workers-ai/get-started/rest-api/
- Production generation should prefer the Workers AI binding because it avoids storing a provider token in D1. REST credentials are fallback/model-catalog credentials.
- The current `workers-ai-provider` path should treat Cloudflare/Kimi as text-only until selected image URLs are converted server-side into provider-compatible image bytes with strict size and MIME limits.
- AI SDK v6 supports structured output through `generateText`/`streamText` with the `output` option: https://v6.ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
- The current API route uses AI SDK structured object output where it is reliable for the provider/model, then falls back to text parsing. Cloudflare/Kimi is intentionally text/tag based for now because local binding tests showed AI SDK structured output can add a 504 + fallback delay.

## Reliability Requirements

- Bound all generated plans to `GENERATION_CONFIG.stagedGeneration.minSections/maxSections`.
- Bound context inputs to `GENERATION_CONFIG.context.maxImages/maxProducts/maxCategories`.
- Deduplicate and cap image URLs before dimension probing or multimodal payload construction.
- Preserve merchant-selected product order in prompt context.
- Separate loading/progress UI from generated content state.
- Keep raw model output separate from parsed widget content.
- Parse/validate at the API boundary, returning canonical `{ html, css, sections, warnings }` when the editor protocol is upgraded.
- Use dashboard-configured prompts from the settings table; do not fetch prompts from third-party URLs.

## Current Hardening Direction

1. Make the existing widget editor safe and predictable.
2. Make rich product/image context selection compact and unambiguous.
3. Make Cloudflare binding/API-token mode understandable for admins.
4. Add a real page-builder AI save flow for landing pages instead of overloading widget save semantics.
5. Finish moving output repair and validation server-side by upgrading the editor protocol from OpenAI-style text envelopes to canonical widget objects.
6. Add browser smoke suites for widget creation, editing, staged generation, preview devices, placement, shortcode use, homepage rendering, and landing-page rendering.
