# Server-Owned Widget Generation Refactor

Date: 2026-05-13

## Why This Exists

The widget create flow had become split-brain:

- The normal path assembled prompts in the React hook, did not send the composition contract, and accepted empty CSS.
- The "Deep composition" path sent a stronger contract and used a different parser/normalizer.
- Preview could show CSS embedded in `<style>` tags, but save could strip those tags before storefront rendering.

That is why a merchant could see a plain browser-default widget preview and why the non-deep path could feel like it loaded forever.

## Shipped Stabilization

- Commit `feeed3de`: `fix(widgets): enforce styled generation artifacts`
- Generated widgets now require usable CSS at the API boundary.
- The normal create path sends `compositionMode: true`.
- Both normal and composition create paths use the same parser/runtime-wrapper stripper/boundary guard.
- Widget persistence extracts `<style>` tags into `cssContent` before sanitizing HTML, so preview and storefront rendering agree.
- History preview no longer inserts an extra wrapper that breaks direct-child scoped CSS.
- Client create requests have a visible timeout instead of an endless loading state.

## Shipped Simplification

- Commit `3b8dd5c7`: `refactor(widgets): move create generation orchestration server-side`
- The React create flow now sends intent and selected context IDs to `generateWidgetFromIntent`.
- The server function loads the configured prompt and catalog context, assembles the structured prompt, calls `/admin/ai/generate`, and returns the model artifact.
- The browser no longer builds create-generation LLM messages. It only controls merchant state, preview, cancel/timeout, and accept.

## Current Boundary

This is not yet the final MCP/tool-run architecture. It is the first durable simplification:

- Browser: user intent, selected IDs/images, preview state.
- Admin server function: prompt/context assembly and generation request orchestration.
- API worker: provider/model validation, rate limit, AI SDK call, output normalization, fallback/repair, sanitizer.
- Storefront/shared: scoped rendering and final HTML/CSS sanitization.

## Next Architecture Slice

The next step should move the orchestration from an admin server function into a first-class API route:

`POST /api/v1/admin/ai/widget-runs`

Suggested request:

```json
{
  "operation": "create",
  "promptType": "widget",
  "userPrompt": "Create a compact drinks collection section",
  "context": {
    "productIds": [],
    "categoryIds": [],
    "collectionIds": [],
    "anchorCollectionIds": [],
    "imageIds": [],
    "allCategories": false
  },
  "options": {
    "provider": "cloudflare",
    "model": "@cf/moonshotai/kimi-k2.6"
  }
}
```

Suggested progress events:

1. `loading_context`
2. `planning`
3. `generating`
4. `validating`
5. `repairing`
6. `ready`
7. `failed`

## MCP/Tool-Call Direction

Implement the tool registry in-process first, then expose the same tools through MCP only when the internal contract is stable.

Core tools:

- `loadCatalogContext`
- `loadMediaContext`
- `getDestinationContract`
- `createCompositionPlan`
- `validateWidgetArtifact`
- `repairWidgetArtifact`

Tools must be narrow, Zod-validated, and server-owned. The model can request context and validation, but it must never choose arbitrary SQL, arbitrary URLs, or persistence actions.

## Verification Notes

Production after `3b8dd5c7`:

- `https://api.scalius.com/api/v1/health` returned `status: ok`.
- `https://dashboard.scalius.com/admin/widgets/new` returned HTTP 200 and redirects unauthenticated browser sessions to login as expected.
- `https://storefront.scalius.com/testing-page` returned HTTP 200.
- Playwright browser smoke found one widget root, widget CSS present, no horizontal overflow.
- Playwright also surfaced a storefront React hydration console error (`Minified React error #418`). This appears outside the widget generation patch and should become a separate storefront hydration investigation.

