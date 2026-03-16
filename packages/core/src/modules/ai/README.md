# AI

Configuration and prompt helpers for AI content generation via OpenRouter.

## Files

- `ai-config.ts` -- `SYSTEM_PROMPT_URLS`, `SYSTEM_PROMPT_FALLBACKS`, `GENERATION_CONFIG`, `PROMPT_INSTRUCTIONS`, `UI_CONFIG`, `ERROR_MESSAGES`, `SUCCESS_MESSAGES`, `getProviderFromModel()`, `getRetryDelay()`, model capability helpers
- `prompt-helper-v2.ts` -- prompt construction utilities
- `ai-context-schema.ts` -- Zod schemas for AI context data

## Dependencies

- None (pure configuration, no DB access)
