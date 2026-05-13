import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  generateCompletePrompt,
  generateStructuredPrompt,
  type StructuredPromptResult,
} from '@scalius/core/modules/ai/prompt-helper-v2';
import { parseJSONSafely, validateWidgetJSON } from '@scalius/shared/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@scalius/shared/tag-parser';
import { ERROR_MESSAGES, shouldUseStagedGeneration } from '@scalius/core/modules/ai/ai-config';
import { useStagedGeneration } from './useStagedGeneration';
import { extractChatCompletionContent, readChatCompletionStream } from './ai-stream';
import { notifyAiContextWarnings, type AiContextBatchDetails } from './ai-context-warnings';
import { AI_CONTEXT_LIMITS, limitImagesForModel } from './ai-context-limits';
import type { useAiContext } from './useAiContext';
import type { ProductSearchResult, Category } from './types';
import type { Widget } from '@/types/api-responses';
import { getAiPrompts, getAiContextBatchDetails } from '@/lib/api.functions';

type PromptMessage = StructuredPromptResult['messages'][number];
type StructuredPromptParams = Parameters<typeof generateStructuredPrompt>[0];
type AiProductData = StructuredPromptParams['selectedProducts'][number];
type AiCategoryData = StructuredPromptParams['selectedCategories'][number];
type AiCollectionData = NonNullable<StructuredPromptParams['selectedCollections']>[number];
type GenerationRun = { id: number; signal: AbortSignal };

interface ModelInfo {
  id: string;
  name: string;
  provider?: string;
  supportsVision?: boolean;
  maxImages?: number;
  supportsAudio?: boolean;
  modality?: string;
}

interface WidgetAiSettings {
  activeProvider?: string;
  providers?: Record<string, { hasApiKey?: boolean; hasBinding?: boolean; defaultModel?: string }>;
  generation?: { stagedGenerationDefault?: boolean };
}

export type AiPlacementContext = {
  productIds: string[];
  categoryIds: string[];
  collectionIds: string[];
  anchorCollectionIds: string[];
  summary: string;
  suggestedPromptType: 'widget' | 'landing-page' | 'collection';
  hasActivePlacements: boolean;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function fetchWidgetAiSettings(): Promise<WidgetAiSettings> {
  const response = await fetch('/api/v1/admin/settings/widget-ai');
  const payload = (await response.json()) as {
    success?: boolean;
    data?: WidgetAiSettings;
    error?: { message?: string };
  };

  if (!response.ok || payload.success === false) {
    throw new Error(payload.error?.message || 'Failed to load widget AI settings.');
  }

  return payload.data ?? {};
}

export const useAiGenerator = (
  aiContext: ReturnType<typeof useAiContext>,
  widget: Widget | undefined | null,
  shouldLoadSettings = true,
  placementContext?: AiPlacementContext,
) => {
  const [promptType, setPromptType] = useState<'widget' | 'landing-page' | 'collection'>('widget');
  const [userPrompt, setUserPrompt] = useState('');
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(false);
  const [aiModels, setAiModels] = useState<ModelInfo[]>([]);
  const [activeProvider, setActiveProvider] = useState('openrouter');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [isApiKeySet, setIsApiKeySet] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [isAiSettingsLoading, setIsAiSettingsLoading] = useState(false);
  const [aiSettingsError, setAiSettingsError] = useState<string | null>(null);
  const [aiSettingsReloadToken, setAiSettingsReloadToken] = useState(0);
  const [generatedContent, setGeneratedContent] = useState<{
    html: string;
    css: string;
  } | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [rawOutput, setRawOutput] = useState<string | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [useStagedMode, setUseStagedMode] = useState(false);
  const generationRunIdRef = useRef(0);
  const generationAbortRef = useRef<AbortController | null>(null);

  // Deep composition hook (keeps the existing state shape used by section editing).
  const stagedGeneration = useStagedGeneration();

  const reloadAiSettings = useCallback(() => {
    setAiSettingsReloadToken((value) => value + 1);
  }, []);

  const startGenerationRun = (): GenerationRun => {
    generationAbortRef.current?.abort();
    const controller = new AbortController();
    generationAbortRef.current = controller;
    generationRunIdRef.current += 1;
    return { id: generationRunIdRef.current, signal: controller.signal };
  };

  const isActiveGenerationRun = (run: GenerationRun): boolean =>
    generationRunIdRef.current === run.id && !run.signal.aborted;

  const cancelGeneration = useCallback(
    (options?: { silent?: boolean }) => {
      if (generationAbortRef.current) {
        generationAbortRef.current.abort();
        generationAbortRef.current = null;
      }
      generationRunIdRef.current += 1;
      stagedGeneration.reset();
      setIsLoadingPrompt(false);
      setGeneratedContent(null);
      setGenerationError(null);
      setRawOutput(null);
      setIsPreviewOpen(false);
      if (!options?.silent) {
        toast.info('Generation cancelled.');
      }
    },
    [stagedGeneration],
  );

  const getModelLimitedImages = useCallback(
    (options?: { warn?: boolean }) => {
      const selectedModelInfo = aiModels.find((model) => model.id === selectedModel);
      const result = limitImagesForModel(aiContext.selectedImages, selectedModel, selectedModelInfo?.maxImages);
      if (options?.warn && result.truncated > 0) {
        toast.warning(
          `Using the first ${result.limit} selected images for this model. ${result.truncated} ${result.truncated === 1 ? 'image was' : 'images were'} skipped.`,
        );
      }
      return result.images;
    },
    [aiContext.selectedImages, aiModels, selectedModel],
  );

  const effectivePromptType = placementContext?.hasActivePlacements ? placementContext.suggestedPromptType : promptType;

  const getMergedProductIds = useCallback(
    () =>
      Array.from(
        new Set([
          ...aiContext.selectedProducts.map((p: ProductSearchResult) => p.id),
          ...(placementContext?.productIds ?? []),
        ]),
      ).slice(0, AI_CONTEXT_LIMITS.maxProducts),
    [aiContext.selectedProducts, placementContext?.productIds],
  );

  const getMergedCategoryIds = useCallback(
    () =>
      Array.from(
        new Set([...aiContext.selectedCategories.map((c: Category) => c.id), ...(placementContext?.categoryIds ?? [])]),
      ).slice(0, AI_CONTEXT_LIMITS.maxCategories),
    [aiContext.selectedCategories, placementContext?.categoryIds],
  );

  const getMergedCollectionIds = useCallback(
    () => Array.from(new Set(placementContext?.collectionIds ?? [])).slice(0, AI_CONTEXT_LIMITS.maxCollections),
    [placementContext?.collectionIds],
  );

  const getMergedAnchorCollectionIds = useCallback(
    () => Array.from(new Set(placementContext?.anchorCollectionIds ?? [])).slice(0, AI_CONTEXT_LIMITS.maxCollections),
    [placementContext?.anchorCollectionIds],
  );

  const getPlacementAwareInstructions = useCallback(
    (instructions: string) => {
      const prompt = instructions.trim();
      if (!placementContext?.summary) return prompt;
      return `${prompt}\n\nPlacement context: ${placementContext.summary}. Generate for this exact storefront placement and use only relevant calls to action.`;
    },
    [placementContext?.summary],
  );

  const getPlacementAwarePrompt = useCallback(() => {
    return getPlacementAwareInstructions(userPrompt);
  }, [getPlacementAwareInstructions, userPrompt]);

  useEffect(() => {
    if (!shouldLoadSettings) return;

    let cancelled = false;
    setIsAiSettingsLoading(true);
    setAiSettingsError(null);

    async function loadAiSettings() {
      const settings = await fetchWidgetAiSettings();
      if (cancelled) return;

      const provider = settings.activeProvider || 'openrouter';
      const providerSettings = settings.providers?.[provider];
      const configured = Boolean(providerSettings?.hasApiKey || providerSettings?.hasBinding);

      setActiveProvider(provider);
      setIsApiKeySet(configured);
      setUseStagedMode(settings.generation?.stagedGenerationDefault === true);

      const response = await fetch(`/api/v1/admin/ai/models?provider=${encodeURIComponent(provider)}`);
      const modelData = (await response.json()) as {
        success?: boolean;
        data?: { models?: ModelInfo[]; defaultModel?: string };
        models?: ModelInfo[];
        defaultModel?: string;
      };
      if (cancelled) return;

      const models = modelData.data?.models || modelData.models || [];
      const defaultModel =
        modelData.data?.defaultModel || modelData.defaultModel || providerSettings?.defaultModel || '';
      setAiModels(models);

      let widgetModel: string | null = null;
      try {
        widgetModel = widget?.aiContext
          ? (JSON.parse(widget.aiContext as string).preferredAiModel as string | undefined) || null
          : null;
      } catch {
        widgetModel = null;
      }

      if (widgetModel && models.some((m) => m.id === widgetModel)) {
        setSelectedModel(widgetModel);
      } else if (defaultModel) {
        setSelectedModel(defaultModel);
      } else {
        setSelectedModel('');
      }
    }

    loadAiSettings()
      .catch((error) => {
        if (cancelled) return;
        if (import.meta.env.DEV) console.error('Failed to load widget AI settings:', error);
        setIsApiKeySet(false);
        setAiModels([]);
        setSelectedModel('');
        setAiSettingsError(error instanceof Error ? error.message : 'Failed to load widget AI settings.');
      })
      .finally(() => {
        if (!cancelled) setIsAiSettingsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [widget, shouldLoadSettings, aiSettingsReloadToken]);

  const handleAiRequest = async () => {
    if (!userPrompt.trim()) {
      toast.error(ERROR_MESSAGES.promptEmpty);
      return;
    }

    if (!selectedModel) {
      toast.error(ERROR_MESSAGES.modelNotSelected);
      return;
    }

    const run = startGenerationRun();

    setIsLoadingPrompt(true);
    setGenerationError(null);
    setRawOutput(null);
    setGeneratedContent(null);
    setIsPreviewOpen(true);

    try {
      const promptPromise = getAiPrompts({
        data: { type: effectivePromptType },
      }) as Promise<string>;
      const contextPromise = getAiContextBatchDetails({
        data: {
          productIds: getMergedProductIds(),
          categoryIds: aiContext.allCategoriesSelected ? undefined : getMergedCategoryIds(),
          collectionIds: getMergedCollectionIds(),
          anchorCollectionIds: getMergedAnchorCollectionIds(),
          allCategories: aiContext.allCategoriesSelected,
        },
      }) as Promise<AiContextBatchDetails>;

      const [systemPrompt, contextData] = await Promise.all([promptPromise, contextPromise]);
      if (!isActiveGenerationRun(run)) return;
      if (!systemPrompt) throw new Error(ERROR_MESSAGES.systemPromptFailed);
      notifyAiContextWarnings(contextData);

      const currentModel = aiModels.find((m) => m.id === selectedModel);
      const isVisionModel = currentModel?.supportsVision || false;
      const selectedImages = getModelLimitedImages({ warn: true });

      const promptResult = await generateStructuredPrompt({
        systemPrompt,
        userPrompt: getPlacementAwarePrompt(),
        selectedImages,
        selectedProducts: (contextData.products || []) as AiProductData[],
        selectedCategories: (contextData.categories || []) as AiCategoryData[],
        selectedCollections: (contextData.collections || []) as AiCollectionData[],
        allCategoriesSelected: aiContext.allCategoriesSelected,
        modelId: selectedModel,
        supportsVision: isVisionModel,
        maxImagesOverride: currentModel?.maxImages,
        promptType: effectivePromptType,
      });
      if (!isActiveGenerationRun(run)) return;

      const useStaged = shouldUseStagedGeneration(promptResult.metadata.estimatedTokens * 4, useStagedMode);

      if (useStaged) {
        // STAGED GENERATION
        const result = await stagedGeneration.startStagedGeneration(
          activeProvider,
          selectedModel,
          promptResult.messages,
          effectivePromptType,
          (_section, _index, _total, preview) => {
            if (!isActiveGenerationRun(run)) return;
            setGeneratedContent(preview);
          },
          run.signal,
        );
        if (!isActiveGenerationRun(run)) return;

        if (result) {
          setGeneratedContent(result);
        } else {
          if (!isActiveGenerationRun(run)) return;
          toast.info('Deep composition could not finish; retrying as a standard widget.');
          stagedGeneration.reset();
          await handleSimpleGeneration(promptResult.messages, run);
        }
      } else {
        // SIMPLE GENERATION
        await handleSimpleGeneration(promptResult.messages, run);
      }
    } catch (error: unknown) {
      if (isAbortError(error) || run.signal.aborted) {
        return;
      }
      if (import.meta.env.DEV) console.error(`Error generating content:`, error);
      toast.error(ERROR_MESSAGES.generationFailed(error instanceof Error ? error.message : String(error)));
      setGenerationError(error instanceof Error ? error.message : String(error));
      setGeneratedContent(null);
      setIsPreviewOpen(false);
    } finally {
      if (generationRunIdRef.current === run.id) {
        setIsLoadingPrompt(false);
        if (generationAbortRef.current?.signal === run.signal) {
          generationAbortRef.current = null;
        }
      }
    }
  };

  const handleSimpleGeneration = async (messages: PromptMessage[], run: GenerationRun) => {
    const response = await fetch('/api/v1/admin/ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: run.signal,
      body: JSON.stringify({
        provider: activeProvider,
        messages: messages,
        model: selectedModel,
        stream: true,
        operation: 'create',
        promptType: effectivePromptType,
      }),
    });

    if (!isActiveGenerationRun(run)) return;

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || errorData.error?.message || 'Failed to generate content.');
    }

    const content = response.body ? await readChatCompletionStream(response) : extractChatCompletionContent(await response.json());
    if (!isActiveGenerationRun(run)) return;
    setRawOutput(content);

    // Try tag-based parsing first (primary), then fall back to JSON
    const tagResult = parseTagBasedResponse(content);

    if (tagResult.success && tagResult.data) {
      const validation = validateParsedWidget(tagResult.data);
      if (validation.valid) {
        setGeneratedContent(tagResult.data as { html: string; css: string });
      } else {
        if (import.meta.env.DEV) console.error('Invalid widget structure:', validation.error);
        throw new Error(`Invalid response: ${validation.error}`);
      }
    } else {
      // Fallback to JSON parsing
      const jsonParsed = parseJSONSafely(content);
      if (jsonParsed.success) {
        const validation = validateWidgetJSON(jsonParsed.data);
        if (validation.valid) {
          setGeneratedContent(jsonParsed.data as { html: string; css: string });
        } else {
          if (import.meta.env.DEV) console.error('Invalid widget structure:', validation.error);
          throw new Error(`Invalid response: ${validation.error}`);
        }
      } else {
        if (import.meta.env.DEV) console.error('Failed to parse response:', tagResult.error, content);
        throw new Error('Failed to parse AI response.');
      }
    }
  };

  const handleCopyPrompt = async () => {
    if (!userPrompt.trim()) {
      toast.error(`Please enter your request first`);
      return;
    }

    const toastId = toast.loading('Preparing standalone prompt...');
    try {
      const promptPromise = getAiPrompts({
        data: { type: effectivePromptType },
      }) as Promise<string>;
      const contextPromise = getAiContextBatchDetails({
        data: {
          productIds: getMergedProductIds(),
          categoryIds: aiContext.allCategoriesSelected ? undefined : getMergedCategoryIds(),
          collectionIds: getMergedCollectionIds(),
          anchorCollectionIds: getMergedAnchorCollectionIds(),
          allCategories: aiContext.allCategoriesSelected,
        },
      }) as Promise<AiContextBatchDetails>;
      const [systemPrompt, contextData] = await Promise.all([promptPromise, contextPromise]);
      if (!systemPrompt) throw new Error('Could not fetch system prompt.');
      notifyAiContextWarnings(contextData);
      const selectedImages = getModelLimitedImages({ warn: true });

      const combinedPrompt = await generateCompletePrompt({
        systemPrompt,
        userPrompt: getPlacementAwarePrompt(),
        selectedImages,
        selectedProducts: (contextData.products || []) as AiProductData[],
        selectedCategories: (contextData.categories || []) as AiCategoryData[],
        selectedCollections: (contextData.collections || []) as AiCollectionData[],
        allCategoriesSelected: aiContext.allCategoriesSelected,
        promptType: effectivePromptType,
      });

      // Add header and footer for standalone use
      const standalonePrompt = `# STANDALONE WIDGET GENERATOR PROMPT

**Instructions**: Copy this entire prompt and paste it into your preferred AI chatbot (ChatGPT, Claude, Gemini, etc.). After receiving the response, copy the \`<htmljs>\` and \`<css>\` sections and paste them back using the "Paste AI Response" button.

═══════════════════════════════════════════════════════════════

${combinedPrompt}

═══════════════════════════════════════════════════════════════

**IMPORTANT**: Your response must use this EXACT format:

<htmljs>
<!-- Your complete HTML code here. Do not include script tags. -->
</htmljs>

<css>
/* Your complete CSS code here */
</css>

Do NOT use markdown code blocks. Do NOT use JSON format. Use ONLY the <htmljs> and <css> tags shown above.
${selectedImages.length > 0 ? `\n\n**Note**: ${selectedImages.length} image URL(s) provided above. Use them in your HTML.` : ''}`;

      await navigator.clipboard.writeText(standalonePrompt);
      toast.success('Standalone prompt copied! Paste it into any AI chatbot.', {
        id: toastId,
      });
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error('Error preparing prompt for copy:', error);
      toast.error(`Failed to copy prompt: ${error instanceof Error ? error.message : String(error)}`, { id: toastId });
    }
  };

  // Compute generation progress for preview
  const generationProgress =
    stagedGeneration.isGenerating || stagedGeneration.plan
      ? (() => {
          const totalSections = stagedGeneration.plan?.totalSections ?? 1;

          if (stagedGeneration.currentStage === 'planning') {
            return {
              currentStage: 'Preparing composition blueprint...',
              totalSections,
              percentage: 10,
            };
          }

          if (stagedGeneration.currentStage === 'generating') {
            return {
              currentStage: 'Generating one cohesive widget...',
              totalSections,
              percentage: 70,
            };
          }

          if (stagedGeneration.currentStage === 'complete') {
            return {
              currentStage: 'Widget generation complete',
              totalSections,
              percentage: 100,
            };
          }

          return {
            currentStage: 'Finalizing composition...',
            currentSection: stagedGeneration.currentSectionIndex,
            totalSections,
            percentage: 90,
          };
        })()
      : undefined;

  return {
    promptType,
    effectivePromptType,
    isPromptTypePlacementDerived: Boolean(placementContext?.hasActivePlacements),
    setPromptType,
    userPrompt,
    setUserPrompt,
    isLoadingPrompt,
    handleAiRequest,
    handleCopyPrompt,
    activeProvider,
    aiModels,
    selectedModel,
    setSelectedModel,
    isApiKeySet,
    isAiSettingsLoading,
    aiSettingsError,
    reloadAiSettings,
    modelSearchQuery,
    setModelSearchQuery,
    isModelSelectorOpen,
    setIsModelSelectorOpen,
    generatedContent,
    setGeneratedContent,
    generationError,
    rawOutput,
    canAcceptGenerated: Boolean(generatedContent && !generationError && !isLoadingPrompt),
    isPreviewOpen,
    setIsPreviewOpen,
    cancelGeneration,
    useStagedMode,
    setUseStagedMode,
    stagedGeneration,
    generationProgress,
    getMergedProductIds,
    getMergedCategoryIds,
    getMergedCollectionIds,
    getMergedAnchorCollectionIds,
    getPlacementAwareInstructions,
  };
};
