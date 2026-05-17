# Widget System Operating Notes

## Purpose

The widget system is Scalius Commerce's merchant-facing storefront composition layer. It is not just an HTML paste box. It should let merchants build and iterate on high-quality homepage sections, collection merchandising blocks, campaign sections, landing-page content, product bundles, trust/urgency panels, and reusable shortcode content without needing to know HTML, CSS, prompt engineering, or storefront internals.

## Product Standard

- Merchants must be able to create rich widgets from real store context: selected products, product images, media library images, categories, buy-now URLs, prices, discounts, availability signals, and brand/settings context.
- A generated homepage widget must default to a visible homepage placement unless the merchant explicitly chooses standalone shortcode usage.
- Landing-page and collection-oriented generation must be clearly represented as storefront sections until there is a full page-builder save flow.
- Failed, partial, loading, or parse-error output must never be acceptable as widget content.
- Generated widgets are canonical artifacts with `html`, `css`, and optional scoped `js`. JavaScript is allowed only for local widget interaction/effects and must run through the platform wrapper with access to `widget.root`, `widget.query()`, and `widget.queryAll()`. No remote scripts, inline event handlers, forms, unsafe URL protocols, storage, navigation, network calls, or global storefront mutation.
- CSS must be scoped or safe to scope before storefront rendering so one widget cannot break the page around it.
- Preview must be useful before publishing: desktop/tablet/mobile, code view, raw output for recovery, and clear generation status.

## Non-Negotiable Rewrite Requirements

- Do not preserve old widget behavior for backward compatibility if it damages the new experience.
- Do not show fake generated content or placeholder widgets when generation starts. The UI may show honest progress/status, but the preview canvas stays empty until the Agent has a real parsed preview or final artifact.
- Progress must be truthful. Step labels come from actual Agent events: settings, context hydration, prompt assembly, generation stream, validation, artifact persistence. Never imply the model is done before validation succeeds.
- The artifact protocol is object-first: `{ html, css, js?, sections?, warnings?, metadata? }`. Tagged text is only a model transport/parser fallback, not the product contract.
- Server validation owns canonicalization. The client should not be the place where broken provider output becomes accepted content.
- Every tool/context input must be labeled in the prompt so the model knows exactly what it is seeing and why: products, drink category, selected media, product images, collection/placement intent, and merchant instruction.
- The core production smoke test is real context: select drink products + drink category, prompt `generate a homepage collection section for our drinks products.`, verify a visually polished section, apply/save it, and verify storefront render.
- Durable Object SQLite is the runtime memory/timeline for generation sessions. Runs should be resumable/inspectable enough to debug bad generations without guessing from a toast.

## AI Provider Reality

- Default model: Cloudflare Workers AI `@cf/moonshotai/kimi-k2.6`.
- Cloudflare documents Kimi K2.6 as a long-context model with vision inputs and structured outputs: https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/
- Cloudflare REST API usage requires Account ID plus API token: https://developers.cloudflare.com/workers-ai/get-started/rest-api/
- Production generation should prefer the Workers AI binding because it avoids storing a provider token in D1. REST credentials are only for direct provider access/model catalog operations.
- The current `workers-ai-provider` path should treat Cloudflare/Kimi as text-only until selected image URLs are converted server-side into provider-compatible image bytes with strict size and MIME limits.
- AI SDK v6 supports structured output through `generateText`/`streamText` with the `output` option: https://v6.ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
- The Agent runtime uses a tagged HTML/CSS/JS artifact stream for Cloudflare/Kimi because local binding tests showed AI SDK structured output can add a 504 + repair delay.

## Agent Runtime Direction

- New generation runs are routed through `WidgetDesignAgent`. There is no stateless generation fallback.
- The Agent uses the SQLite-backed Durable Object storage backend (`new_sqlite_classes`), which is compatible with Workers Free and Paid plans.
- Admin still calls `/api/v1/admin/widget-generation-runs`; the endpoint enforces existing admin auth/rate limits, then forwards the run to a named Agent session. Missing Durable Object binding is a deployment error.
- Agent state tracks the active run, phase, operation, provider/model, artifact status, and error. Non-token events are persisted in the Agent SQLite database so a future UI can resume or inspect a generation timeline.
- Stream protocol remains SSE and emits progress, accepted-section preview patches, final revision preview patches, validated artifact metadata, final artifact, and failure events.
- Create-generation is an artifact workspace harness, not one giant completion. The Agent plans the destination, generates bounded section artifacts, validates each artifact before it becomes workspace state, streams accepted previews, passes the exact previous HTML/CSS/JS and preview observations into later steps, and runs a final revision pass that may modify earlier artifact code before canonical assembly.
- The harness should follow coding-agent discipline: plan, write a bounded artifact, observe/validate, persist to the SQLite event ledger, revise when the observation shows problems, and only then continue. The model should never be asked to guess what it previously wrote from memory.

## Context Labeling Contract

- Every image sent to text or vision context must be labeled before prompt assembly.
- Image records include `sourceType`, `sourceLabel`, `sourceId`, and optional `role`.
- Valid source types currently include selected media, product image, category image, collection featured product image, and collection product image.
- Models must treat selected media as merchant-provided visual/reference media unless a role says otherwise; product and collection images must only be used for their labeled product/collection.
- Catalog/context blocks remain untrusted data blocks. The model may use facts inside them but must not follow instructions embedded in merchant data.

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

## Placement Architecture

Widgets are reusable content blocks. Placement is a separate concern and now has a dedicated `widget_placements` table. The old `widgets.displayTarget`, `widgets.placementRule`, `widgets.referenceCollectionId`, and `widgets.sortOrder` columns remain only as a projection for response compatibility and sorting fallbacks.

Canonical placement fields:

- `scope`: currently `homepage` or `page`
- `scopeId`: required for non-homepage scopes
- `slot`: top/bottom/content/collection anchor slot
- `anchorType` + `anchorId`: used when a placement is anchored to a collection or content region
- `sortOrder` + `isActive`: placement-specific ordering and status

Current implementation notes:

- Admin create/edit hydrates and saves canonical `placements[]`.
- A widget with zero placements is shortcode/manual use only.
- Homepage rendering reads canonical homepage placements and renders zones by `slot`/`anchorId`.
- CMS page rendering reads canonical page-scoped placements through `/storefront/pages/slug/{slug}` and renders `top`, `before_content`, `after_content`, and `bottom` zones around the page body.
- Shortcodes remain an escape hatch for exact inline placement, not the primary page-builder model.
- Widget mutations invalidate both homepage and page render caches because one reusable widget can appear on either surface.
- Product, category, and collection scoped placements are not accepted by admin/API validation until the admin chooser, storefront fetch path, cache invalidation, and page render zones exist end to end.
