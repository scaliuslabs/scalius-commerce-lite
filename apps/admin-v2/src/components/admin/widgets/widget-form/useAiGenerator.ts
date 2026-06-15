import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ERROR_MESSAGES } from '@scalius/core/modules/ai/ai-config';
import { useStagedGeneration } from './useStagedGeneration';
import {
  normalizeGeneratedWidgetContent,
  parseGeneratedWidgetContent,
  type GeneratedWidgetContent,
} from './widget-generation-content';
import { notifyAiContextWarnings, type AiContextBatchDetails } from './ai-context-warnings';
import { AI_CONTEXT_LIMITS, limitImagesForModel } from './ai-context-limits';
import type { useAiContext } from './useAiContext';
import type { ProductSearchResult, Category } from './types';
import type { Widget } from '@/types/api-responses';
import { getAiPrompts, getAiContextBatchDetails } from '@/lib/api-functions/ai';
import { runWidgetGeneration, type WidgetGenerationRunEvent } from './widget-generation-run-stream';

type GenerationRun = { id: number; controller: AbortController; signal: AbortSignal };
const SERVER_GENERATION_TIMEOUT_MS = 150_000;
const GENERATION_STEP_LABELS: Record<string, string> = {
  load_settings: 'Checking AI provider settings...',
  hydrate_context: 'Loading selected products and collections...',
  build_prompt: 'Building the storefront brief...',
  plan_artifact: 'Planning the widget sections...',
  generate_section: 'Building a section artifact...',
  assemble_artifact: 'Assembling the final widget...',
  generate: 'Generating the widget artifact...',
};
const GENERATION_STEP_PROGRESS: Record<string, number> = {
  load_settings: 18,
  hydrate_context: 34,
  build_prompt: 52,
  plan_artifact: 58,
  generate_section: 70,
  assemble_artifact: 88,
  generate: 68,
};

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

function isTimeoutError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'TimeoutError';
}

function withGenerationTimeout<T>(promise: Promise<T>, signal: AbortSignal, onTimeout?: (error: DOMException) => void): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Generation cancelled', 'AbortError'));
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      const error = new DOMException(
        'Widget generation timed out. Please try again with a smaller context or faster model.',
        'TimeoutError',
      );
      reject(error);
      onTimeout?.(error);
    }, SERVER_GENERATION_TIMEOUT_MS);

    const abort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException('Generation cancelled', 'AbortError'));
    };

    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function toastForGenerationEvent(event: WidgetGenerationRunEvent): void {
  if (event.type !== 'step.started' && event.type !== 'tool.started') return;
  const label = GENERATION_STEP_LABELS[event.type === 'tool.started' ? event.tool : event.step];
  if (label) toast.info(label);
}

function progressForGenerationEvent(event: WidgetGenerationRunEvent): { currentStage: string; percentage: number } | null {
  if (event.type === 'run.started') {
    return { currentStage: 'Starting the design agent...', percentage: 10 };
  }
  if (event.type === 'step.started' || event.type === 'tool.started') {
    const key = event.type === 'tool.started' ? event.tool : event.step;
    return {
      currentStage: GENERATION_STEP_LABELS[key] || 'Working on the widget...',
      percentage: GENERATION_STEP_PROGRESS[key] ?? 45,
    };
  }
  if (event.type === 'preview.patch') {
    return { currentStage: 'Rendering a live draft...', percentage: 78 };
  }
  if (event.type === 'artifact.validated') {
    return { currentStage: 'Validating the widget artifact...', percentage: 90 };
  }
  if (event.type === 'artifact') {
    return { currentStage: 'Preparing the final preview...', percentage: 95 };
  }
  if (event.type === 'run.completed') {
    return { currentStage: 'Widget ready.', percentage: 100 };
  }
  return null;
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
    js?: string;
  } | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [rawOutput, setRawOutput] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState<{
    html: string;
    css: string;
    js?: string;
  } | null>(null);
  const [generationProgress, setGenerationProgress] = useState<{
    currentStage: string;
    percentage: number;
  } | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const generationRunIdRef = useRef(0);
  const generationAbortRef = useRef<AbortController | null>(null);
  const lastRenderableDraftRef = useRef<GeneratedWidgetContent | null>(null);

  // Section metadata is kept for targeted improvements; generation itself is server-owned.
  const stagedGeneration = useStagedGeneration();

  const reloadAiSettings = useCallback(() => {
    setAiSettingsReloadToken((value) => value + 1);
  }, []);

  const startGenerationRun = (): GenerationRun => {
    generationAbortRef.current?.abort();
    const controller = new AbortController();
    generationAbortRef.current = controller;
    generationRunIdRef.current += 1;
    return { id: generationRunIdRef.current, controller, signal: controller.signal };
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
      setDraftContent(null);
      setGenerationProgress(null);
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

      const response = await fetch(`/api/v1/admin/ai/models?provider=${encodeURIComponent(provider)}`);
      const modelData = (await response.json()) as {
        success?: boolean;
        data?: { models?: ModelInfo[]; defaultModel?: string };
        models?: ModelInfo[];
        defaultModel?: string;
        error?: { message?: string };
      };
      if (!response.ok || modelData.success === false) {
        throw new Error(modelData.error?.message || 'Failed to load widget AI models.');
      }
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

      if (configured && models.length === 0) {
        throw new Error('The active AI provider returned no available models.');
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
    setGenerationProgress({ currentStage: 'Starting the design agent...', percentage: 10 });
    setDraftContent(null);
    setGeneratedContent(null);
    lastRenderableDraftRef.current = null;
    setIsPreviewOpen(true);

    try {
      const selectedImages = getModelLimitedImages({ warn: true });
      const result = await withGenerationTimeout(runWidgetGeneration({
        provider: activeProvider,
        model: selectedModel,
        promptType: effectivePromptType,
        operation: 'create',
        userPrompt: getPlacementAwarePrompt(),
        selectedImages,
        productIds: getMergedProductIds(),
        categoryIds: getMergedCategoryIds(),
        collectionIds: getMergedCollectionIds(),
        anchorCollectionIds: getMergedAnchorCollectionIds(),
        allCategoriesSelected: aiContext.allCategoriesSelected,
      }, {
        signal: run.signal,
        onEvent: (event) => {
          toastForGenerationEvent(event);
          const eventProgress = progressForGenerationEvent(event);
          if (eventProgress && isActiveGenerationRun(run)) {
            setGenerationProgress(eventProgress);
          }
          if (event.type === 'warning') {
            notifyAiContextWarnings({ warnings: event.warnings as AiContextBatchDetails['warnings'] } as AiContextBatchDetails);
          }
          if (event.type === 'preview.patch') {
            if (!isActiveGenerationRun(run)) return;
            const normalizedDraft = normalizeGeneratedWidgetContent(event);
            lastRenderableDraftRef.current = normalizedDraft;
            setDraftContent(normalizedDraft);
          }
        },
        onDraft: (raw) => {
          if (!isActiveGenerationRun(run)) return;
          setRawOutput(raw);
          try {
            const normalizedDraft = normalizeGeneratedWidgetContent(parseGeneratedWidgetContent(raw));
            lastRenderableDraftRef.current = normalizedDraft;
            setDraftContent(normalizedDraft);
          } catch {
            // Partial streams are expected to be unparsable until closing tags arrive.
          }
        },
      }), run.signal, (error) => run.controller.abort(error));
      if (!isActiveGenerationRun(run)) return;
      setRawOutput(result.raw);
      setGeneratedContent(normalizeGeneratedWidgetContent(parseGeneratedWidgetContent(result.raw)));
      lastRenderableDraftRef.current = null;
      setDraftContent(null);
      setGenerationProgress(null);
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        const message = error.message || 'Widget generation timed out.';
        toast.error(ERROR_MESSAGES.generationFailed(message));
        setGenerationError(message);
        setGeneratedContent(null);
        setDraftContent(null);
        setGenerationProgress(null);
        return;
      }
      if (isAbortError(error) || run.signal.aborted) {
        return;
      }
      if (lastRenderableDraftRef.current) {
        setGeneratedContent(lastRenderableDraftRef.current);
        setDraftContent(null);
        setGenerationError(null);
        setGenerationProgress(null);
        toast.warning('Using the last rendered widget draft after a late provider failure.');
        return;
      }
      if (import.meta.env.DEV) console.error(`Error generating content:`, error);
      toast.error(ERROR_MESSAGES.generationFailed(error instanceof Error ? error.message : String(error)));
      setGenerationError(error instanceof Error ? error.message : String(error));
      setGeneratedContent(null);
      setDraftContent(null);
      setGenerationProgress(null);
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

  const handleCopyPrompt = async () => {
    if (!userPrompt.trim()) {
      toast.error(`Please enter your request first`);
      return;
    }

    const toastId = toast.loading('Preparing standalone prompt...');
    try {
      const promptPromise = getAiPrompts({
        data: { type: effectivePromptType },
      });
      const contextPromise = getAiContextBatchDetails({
        data: {
          productIds: getMergedProductIds(),
          categoryIds: aiContext.allCategoriesSelected ? undefined : getMergedCategoryIds(),
          collectionIds: getMergedCollectionIds(),
          anchorCollectionIds: getMergedAnchorCollectionIds(),
          allCategories: aiContext.allCategoriesSelected,
        },
      });
      const promptHelperPromise = import('@scalius/core/modules/ai/prompt-helper-v2');
      const standalonePromptPromise = import('./standalone-prompt');
      const [promptHelper, standalonePromptHelper, systemPrompt, contextData] = await Promise.all([
        promptHelperPromise,
        standalonePromptPromise,
        promptPromise,
        contextPromise,
      ]);
      if (!systemPrompt) throw new Error('Could not fetch system prompt.');
      notifyAiContextWarnings(contextData);
      const selectedImages = getModelLimitedImages({ warn: true });

      const combinedPrompt = await promptHelper.generateCompletePrompt({
        systemPrompt,
        userPrompt: getPlacementAwarePrompt(),
        selectedImages,
        selectedProducts: contextData.products || [],
        selectedCategories: contextData.categories || [],
        selectedCollections: contextData.collections || [],
        allCategoriesSelected: aiContext.allCategoriesSelected,
        promptType: effectivePromptType,
      });

      const standalonePrompt = standalonePromptHelper.buildStandalonePrompt({
        combinedPrompt,
        imageCount: selectedImages.length,
      });

      await navigator.clipboard.writeText(standalonePrompt);
      toast.success('Standalone prompt copied! Paste it into any AI chatbot.', {
        id: toastId,
      });
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error('Error preparing prompt for copy:', error);
      toast.error(`Failed to copy prompt: ${error instanceof Error ? error.message : String(error)}`, { id: toastId });
    }
  };

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
    stagedGeneration,
    generationProgress: isLoadingPrompt
      ? {
          currentStage: generationProgress?.currentStage ?? (
            draftContent ? 'Rendering a live draft...' : 'Preparing storefront context...'
          ),
          totalSections: 1,
          percentage: generationProgress?.percentage ?? (draftContent ? 78 : 35),
        }
      : undefined,
    draftContent: isLoadingPrompt ? draftContent : null,
    getMergedProductIds,
    getMergedCategoryIds,
    getMergedCollectionIds,
    getMergedAnchorCollectionIds,
    getPlacementAwareInstructions,
  };
};
