# AI

Configuration and prompt helpers for AI-powered content generation (widgets, landing pages, collections) via OpenRouter.

## Exports

- `SYSTEM_PROMPT_URLS` / `SYSTEM_PROMPT_FALLBACKS` — remote and fallback system prompts per content type
- `GENERATION_CONFIG` — temperature, timeout, retry, and context limit settings
- `PROMPT_INSTRUCTIONS` — structured prompt templates for JSON output, buy-now links, improvements
- `getProviderFromModel()` — extract provider name from model ID
- `getRetryDelay()` — exponential backoff calculation
- `UI_CONFIG` — preview device widths, model selector, toast durations

## Dependencies

- None (pure configuration, no DB access)

## API Routes

- `POST /api/v1/admin/ai/generate` — generate widget/page content via LLM
