/**
 * Shared AI generation defaults.
 *
 * Runtime provider settings and prompt overrides live in the dashboard-managed
 * settings table. This file only keeps non-secret defaults and UI constants.
 */

import { AI_PROMPT_TYPES, DEFAULT_AI_PROMPTS } from "./default-prompts";

export const SYSTEM_PROMPT_FALLBACKS = DEFAULT_AI_PROMPTS;

// Cache TTL for system prompts (5 minutes)
export const SYSTEM_PROMPT_CACHE_TTL = 300;

// ============================================================================
// MODEL & PROVIDER CONFIGURATION
// ============================================================================

export const AI_PROVIDER_IDS = ["openrouter", "openai", "gemini", "cloudflare"] as const;

// Model capability thresholds
export const MODEL_CAPABILITIES = {
  minTokensForCache: {
    anthropic: 1024,
    openai: 1024,
    google: 4096,
    default: 1024,
  },
  maxCacheBreakpoints: {
    anthropic: 4,
    openai: 1,
    google: 1,
    default: 1,
  },
  cacheTTLMinutes: {
    anthropic: 5,
    openai: 60,
    google: 5,
    default: 5,
  },
  maxImages: {
    anthropic: 20,
    openai: 10,
    google: 16,
    default: 10,
  },
} as const;

// ============================================================================
// GENERATION CONFIGURATION
// ============================================================================

export const GENERATION_CONFIG = {
  // Temperature settings
  temperature: {
    planning: 0.3,      // Low temp for consistent planning
    generation: 0.7,    // Medium temp for creative content
    improvement: 0.6,   // Slightly lower for improvements
  },

  // Staged generation thresholds
  stagedGeneration: {
    autoEnableThreshold: 500,  // Auto-enable staged mode if prompt > 500 chars
    maxSections: 10,            // Maximum sections per widget
    minSections: 1,             // Minimum sections
    sectionDelayMs: 500,        // Delay between section generation
  },

  // Timeouts
  timeouts: {
    default: 60000,      // 60 seconds
    planning: 30000,     // 30 seconds for planning
    generation: 120000,  // 2 minutes for generation
    improvement: 90000,  // 90 seconds for improvements
  },

  // Retry configuration
  retry: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    exponentialBase: 2,  // 1s, 2s, 4s
    retryableStatuses: [408, 429, 500, 502, 503, 504],
  },

  // Context limits
  context: {
    maxImages: 10,
    maxProducts: 20,
    maxCategories: 50,
    maxPromptChars: 50000,
  },
} as const;

// ============================================================================
// PROMPT ASSEMBLY CONFIGURATION
// ============================================================================

export const PROMPT_INSTRUCTIONS = {
  json: `RESPONSE FORMAT - USE SIMPLE TAGS:

<htmljs>
<!-- Your HTML code here. Do not include script tags. -->
</htmljs>

<css>
/* Your CSS code here */
</css>

IMPORTANT RULES:
- Use the simple tag format shown above
- Do NOT wrap in markdown code blocks (\`\`\`html or \`\`\`json)
- Do NOT use JSON format
- Do NOT include JavaScript or <script> tags. Widget previews and storefront rendering are HTML/CSS only.
- Make sure to close all tags properly
- For multi-section widgets, use <part1>, <part2>, etc. with nested tags`,

  buyNow: `IMPORTANT: "BUY NOW" (DIRECT CHECKOUT) LINKS
When creating purchase links, use the pre-generated "buyNowUrl" fields provided in the product context:
- Each product has a "buyNowUrl" for general purchase
- Each variant has its own "buyNowUrl" for variant-specific purchase
Simply use these URLs directly in your buttons or links.`,

  improvement: `IMPORTANT: This is an IMPROVEMENT request for existing code.
- Maintain the overall structure and style unless specifically asked to change it
- Only modify what the user requested
- Ensure the improved code is still valid HTML/CSS
- Use the same tag format: <htmljs>...</htmljs> and <css>...</css>`,

  sectionSpecific: (sectionIndex: number, totalSections: number) => `CRITICAL: SECTION-SPECIFIC IMPROVEMENT
You are improving ONLY Section ${sectionIndex + 1} of ${totalSections} total sections.
- Return ONLY the improved HTML and CSS for this specific section using tags
- Do NOT include other sections
- Do NOT include container wrappers
- Maintain compatibility with other sections
- Format: <htmljs>section content</htmljs><css>section styles</css>`,
} as const;

// ============================================================================
// UI CONFIGURATION
// ============================================================================

export const UI_CONFIG = {
  // Preview device widths
  previewDevices: {
    desktop: '100%',
    tablet: '768px',
    mobile: '375px',
  },

  // Model selector
  modelSelector: {
    searchDebounceMs: 300,
    maxVisibleModels: 100,
    showCapabilityIcons: true,
  },

  // Context manager
  contextManager: {
    productPageSize: 10,
    categoryLimit: 200,
    imageProcessingTimeout: 5000,
  },

  // Toast durations (milliseconds)
  toastDuration: {
    success: 3000,
    error: 5000,
    info: 4000,
    loading: 0,  // No auto-dismiss
  },

  // Progress indicators
  progress: {
    updateIntervalMs: 100,
    smoothingFactor: 0.8,  // For smooth progress animations
  },
} as const;

// ============================================================================
// ERROR MESSAGES
// ============================================================================

export const ERROR_MESSAGES = {
  // API errors
  apiKeyMissing: "The selected AI provider is not configured. Add the provider credentials in General Settings > Widget AI.",
  modelNotSelected: "Please select an AI model before generating.",
  promptEmpty: "Please enter your prompt first.",
  systemPromptFailed: "Failed to fetch system prompt. Please try again or contact support.",
  contextFetchFailed: "Failed to fetch product/category details. Please check your selections.",

  // Generation errors
  generationFailed: (reason: string) => `Generation failed: ${reason}`,
  timeoutError: "Request timed out. The model took too long to respond. Please try again.",
  networkError: "Network error. Please check your connection and try again.",
  rateLimitError: "Rate limit exceeded. Please wait a moment and try again.",

  // Parsing errors
  jsonParseFailed: "Failed to parse AI response. The response was not valid JSON.",
  jsonRepairFailed: "Could not repair malformed JSON response. Please try generating again.",
  validationFailed: (error: string) => `Response validation failed: ${error}`,

  // Model capability errors
  visionNotSupported: "This model does not support image inputs. Please select a vision-capable model or remove images.",
  imagesIgnored: "Selected model cannot process images. Image URLs will be included as text only.",

  // Section errors
  sectionNotFound: (index: number) => `Section ${index + 1} not found. Please regenerate the widget.`,
  sectionMergeFailed: "Failed to merge improved section. Please try improving the entire widget instead.",
  invalidSectionIndex: "Invalid section selection. Please try again.",

  // State errors
  invalidState: "Invalid application state. Please refresh the page.",
  concurrentRequest: "Another generation is in progress. Please wait for it to complete.",

  // History errors
  historyFetchFailed: "Failed to load version history.",
  restoreFailed: "Failed to restore version. Please try again.",
} as const;

// ============================================================================
// SUCCESS MESSAGES
// ============================================================================

export const SUCCESS_MESSAGES = {
  generated: "Content generated successfully!",
  improved: "Content improved successfully!",
  sectionImproved: (index: number, total: number) => `Section ${index + 1} of ${total} improved and merged!`,
  contextLoaded: "Loaded saved AI context for this widget.",
  promptCopied: "Prompt copied to clipboard!",
  codeCopied: "Code copied to clipboard!",
  versionRestored: "Version restored successfully! The page will now reload.",
  versionDeleted: "Version deleted successfully!",
  settingsSaved: "Settings saved successfully.",
} as const;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get provider name from model ID
 * Examples: "anthropic/claude-3" -> "anthropic", "openai/gpt-4" -> "openai"
 */
export function getProviderFromModel(modelId: string): string {
  const parts = modelId.split('/');
  return (parts.length > 1 ? parts[0] : undefined) ?? 'default';
}

/**
 * Get minimum tokens required for caching for a specific model
 */
export function getMinCacheTokens(modelId: string): number {
  const provider = getProviderFromModel(modelId);
  return MODEL_CAPABILITIES.minTokensForCache[provider as keyof typeof MODEL_CAPABILITIES.minTokensForCache]
    || MODEL_CAPABILITIES.minTokensForCache.default;
}

/**
 * Get maximum cache breakpoints for a specific model
 */
export function getMaxCacheBreakpoints(modelId: string): number {
  const provider = getProviderFromModel(modelId);
  return MODEL_CAPABILITIES.maxCacheBreakpoints[provider as keyof typeof MODEL_CAPABILITIES.maxCacheBreakpoints]
    || MODEL_CAPABILITIES.maxCacheBreakpoints.default;
}

/**
 * Get cache TTL in minutes for a specific model
 */
export function getCacheTTL(modelId: string): number {
  const provider = getProviderFromModel(modelId);
  return MODEL_CAPABILITIES.cacheTTLMinutes[provider as keyof typeof MODEL_CAPABILITIES.cacheTTLMinutes]
    || MODEL_CAPABILITIES.cacheTTLMinutes.default;
}

/**
 * Get maximum images supported for a specific model
 */
export function getMaxImages(modelId: string): number {
  const provider = getProviderFromModel(modelId);
  return MODEL_CAPABILITIES.maxImages[provider as keyof typeof MODEL_CAPABILITIES.maxImages]
    || MODEL_CAPABILITIES.maxImages.default;
}

/**
 * Calculate delay for retry attempt with exponential backoff
 */
export function getRetryDelay(attempt: number): number {
  const { baseDelayMs, exponentialBase } = GENERATION_CONFIG.retry;
  return baseDelayMs * Math.pow(exponentialBase, attempt - 1);
}

/**
 * Check if status code is retryable
 */
export function isRetryableStatus(status: number): boolean {
  return (GENERATION_CONFIG.retry.retryableStatuses as readonly number[]).includes(status);
}

/**
 * Validate prompt length
 */
export function isPromptTooLarge(prompt: string): boolean {
  return prompt.length > GENERATION_CONFIG.context.maxPromptChars;
}

/**
 * Should use staged generation?
 *
 * Keep this decision merchant-controlled. Large prompts can benefit from
 * staged generation, but silently overriding an off toggle makes the editor
 * feel unpredictable and can save partial content when a later section fails.
 */
export function shouldUseStagedGeneration(_promptLength: number, userEnabled: boolean): boolean {
  return userEnabled;
}

/**
 * Get appropriate timeout for operation type
 */
export function getTimeout(operation: 'planning' | 'generation' | 'improvement' | 'default'): number {
  return GENERATION_CONFIG.timeouts[operation];
}

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type PromptType = (typeof AI_PROMPT_TYPES)[number];
export type WidgetAiProvider = (typeof AI_PROVIDER_IDS)[number];
export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'default';
export type OperationType = 'planning' | 'generation' | 'improvement' | 'default';
