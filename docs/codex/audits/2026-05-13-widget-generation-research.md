# Widget Generation Research Notes

Date: 2026-05-13

## Direction

The widget generator should stay server-owned: admin sends merchant intent and selected catalog/media IDs, the API assembles the prompt/context, the provider returns an artifact, and the API validates/sanitizes before admin preview or storefront rendering.

The durable path is not more client-side staging. It is a single authoritative generation pipeline:

1. Assemble destination-specific context for `widget`, `landing-page`, or `collection`.
2. Prefer one model call for normal creation.
3. Use structured output only when the provider path is known to be reliable.
4. Keep `<htmljs>` and `<css>` tags as the cross-provider fallback.
5. Sanitize HTML/CSS, validate commerce claims, and scope CSS at the API boundary.
6. Retry once with concrete format/validation errors.
7. Use deterministic no-context fallback only after model output cannot be made safe.

## Current Findings

- The old staged model has mostly become a single-call composition mode, but the UI/API names still imply multi-step section generation.
- Client-side blueprint prompt injection duplicated server contracts and made the flow harder to reason about.
- Instant no-context fallback skipped the model entirely, which made prompt types feel generic when no catalog facts were selected.
- Preview and storefront wrapped generated HTML in an extra inner `<div>`, so root-level selectors could target a different DOM shape than the generated artifact expected.
- Structured output can be excellent, but a failed schema attempt followed by text fallback and repair can multiply latency. Text/tag mode is the practical default for Cloudflare Workers AI and mixed providers.

## Destination Contracts

- Homepage widget: compact discovery/merchandising module, usually one or two connected bands, strong scanning, no full campaign funnel.
- Landing section: campaign-style conversion flow with offer, product support, proof/benefits, objection handling/trust, and final CTA.
- Collection section: commerce-dense selection support with product facts, comparison, buying-guide cues, and direct product/buy-now actions.

## Best Practices Applied

- Keep long/static contract and catalog context separate from dynamic merchant instructions for prompt caching.
- Use explicit XML-like tags for prompt sections and output extraction.
- Avoid previewing unvalidated partial HTML/CSS; stream status only until a complete sanitized artifact is ready.
- Treat catalog data and model output as untrusted.
- Keep generated widgets HTML/CSS only; no scripts, external stylesheets, forms, tracking pixels, or arbitrary execution.

## Sources

- Vercel AI SDK structured output: https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
- Vercel AI SDK `streamText`: https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
- Vercel AI SDK tool calling: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- Cloudflare Workers AI Kimi K2.6: https://developers.cloudflare.com/workers-ai/models/kimi-k2.6/
- Anthropic prompt XML guidance: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#structure-prompts-with-xml-tags
- Anthropic tool definition guidance: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- OpenAI structured outputs: https://platform.openai.com/docs/guides/structured-outputs
- OpenAI function/tool calling: https://platform.openai.com/docs/guides/function-calling/function-calling-with-structured-outputs
