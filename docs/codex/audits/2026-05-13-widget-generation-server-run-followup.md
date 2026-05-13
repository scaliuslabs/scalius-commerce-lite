# Widget Generation Server Run Follow-Up

Date: 2026-05-13

## Why This Pass Exists

The widget generator still had multiple code paths for the same job:

- create generation used the new server-owned `/admin/widget-generation-runs` stream;
- improvement still assembled prompts in the browser and called `/admin/ai/generate`;
- paste/manual AI response handling used looser parser validation;
- the deep composition toggle was not actually sent to the server run;
- stream timeout ownership was split between the fetch wrapper and outer React state.

That made generated widgets behave differently depending on how they entered the form, and it allowed valid-looking AI outputs such as `{ htmljs, cssContent }` to lose CSS on the client.

## Decision

Keep `/admin/widget-generation-runs` as the single widget orchestration boundary and make it MCP-shaped internally instead of adding a separate MCP server process right now.

This API worker already owns the right tools: provider settings, prompt loading, commerce context hydration, model selection, rate limits, response normalization, and validation. A separate remote MCP server would add deployment and auth complexity before fixing the product problem. The durable next step is a local typed tool registry inside the API worker, with streamed `tool.started` / `tool.completed` events, then optional AI SDK tool-calling on top once provider support is reliable.

## Changes In This Pass

- Create requests now send `deepComposition` so the server only injects the heavier composition blueprint when the merchant selected it.
- Improvement requests now use `/admin/widget-generation-runs` instead of rebuilding prompt/context in the browser.
- Improvement context, section context, and history are sent as typed request fields and assembled server-side.
- Client parsing now preserves JSON aliases (`htmljs`, `htmlContent`, `cssContent`) instead of dropping supported fields.
- Pasted AI content uses the same generated-widget normalization path and rejects HTML-only output.
- Generation timeout now aborts the active stream controller instead of only rejecting React state.
- History restore sanitizes restored content before it becomes the active widget again.
- Storefront shortcode error placeholders escape IDs/slugs before interpolation.

## Still Worth Doing

- Extract `apps/api/src/routes/admin/widget-generation-tools.ts` as an explicit typed tool registry.
- Emit `tool.started`, `tool.completed`, and `artifact.validated` events from the run endpoint.
- Add a server-side heartbeat during long model calls.
- Add authenticated production UI tests that create, improve, accept, save, place, and render a widget end to end.
