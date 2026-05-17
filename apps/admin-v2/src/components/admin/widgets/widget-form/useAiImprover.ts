/**
 * useAiImprover Hook - Manages widget improvement workflow
 *
 * This hook encapsulates all improvement logic including:
 * - Section-specific improvements
 * - Streaming API calls
 * - History tracking
 * - Section merging for staged widgets
 */

import { useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { reconstructWidgetFromSections } from '@scalius/shared/html-section-parser';
import { ERROR_MESSAGES, SUCCESS_MESSAGES } from '@scalius/core/modules/ai/ai-config';
import { notifyAiContextWarnings, type AiContextBatchDetails } from './ai-context-warnings';
import { limitImagesForModel } from './ai-context-limits';
import { normalizeGeneratedWidgetContent, parseGeneratedWidgetContent } from './widget-generation-content';
import { runWidgetGeneration, type WidgetGenerationRunEvent } from './widget-generation-run-stream';
import type { ImprovementHistoryEntry } from '@scalius/core/modules/ai/ai-context-schema';
import type { useAiContext } from './useAiContext';
import type { useAiGenerator } from './useAiGenerator';
import type { SectionContent } from './useStagedGeneration';

type ImprovementRun = { id: number; signal: AbortSignal };
type ImprovementProgress = { currentStage: string; percentage: number };

interface ModelInfo {
  id: string;
  name: string;
  supportsVision?: boolean;
  maxImages?: number;
  supportsAudio?: boolean;
  modality?: string;
}

interface UseAiImproverProps {
  aiContext: ReturnType<typeof useAiContext>;
  aiGenerator: ReturnType<typeof useAiGenerator>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function progressForImprovementEvent(event: WidgetGenerationRunEvent): ImprovementProgress | null {
  if (event.type === 'run.started') return { currentStage: 'Starting the design agent...', percentage: 10 };
  if (event.type === 'tool.started' || event.type === 'step.started') {
    const key = event.type === 'tool.started' ? event.tool : event.step;
    if (key === 'load_settings') return { currentStage: 'Checking AI provider settings...', percentage: 20 };
    if (key === 'hydrate_context') return { currentStage: 'Loading selected products and categories...', percentage: 35 };
    if (key === 'build_prompt') return { currentStage: 'Preparing the improvement brief...', percentage: 50 };
    if (key === 'generate') return { currentStage: 'Reworking the artifact...', percentage: 68 };
    return { currentStage: 'Improving the widget...', percentage: 55 };
  }
  if (event.type === 'preview.patch') return { currentStage: 'Rendering the improved draft...', percentage: 82 };
  if (event.type === 'artifact.validated') return { currentStage: 'Validating the improved artifact...', percentage: 92 };
  if (event.type === 'artifact') return { currentStage: 'Preparing the improved preview...', percentage: 96 };
  if (event.type === 'run.completed') return { currentStage: 'Improvement ready.', percentage: 100 };
  return null;
}

export function useAiImprover({ aiContext, aiGenerator }: UseAiImproverProps) {
  const [contentToImprove, setContentToImprove] = useState<{ html: string; css: string; js?: string } | null>(null);
  const [isImproving, setIsImproving] = useState(false);
  const [improvementProgress, setImprovementProgress] = useState<ImprovementProgress | null>(null);
  const [improvementHistory, setImprovementHistory] = useState<ImprovementHistoryEntry[]>([]);
  const [currentImprovementTarget, setCurrentImprovementTarget] = useState<number | undefined>(undefined);
  const [rawOutput, setRawOutput] = useState<string>(''); // Capture raw LLM output for debugging
  const improvementRunIdRef = useRef(0);
  const improvementAbortRef = useRef<AbortController | null>(null);
  const improvementBaselineRef = useRef<ImprovementHistoryEntry[]>([]);

  const startImprovementRun = (): ImprovementRun => {
    improvementAbortRef.current?.abort();
    const controller = new AbortController();
    improvementAbortRef.current = controller;
    improvementRunIdRef.current += 1;
    return { id: improvementRunIdRef.current, signal: controller.signal };
  };

  const isActiveImprovementRun = (run: ImprovementRun): boolean =>
    improvementRunIdRef.current === run.id && !run.signal.aborted;

  const cancel = useCallback((options?: { silent?: boolean }) => {
    if (improvementAbortRef.current) {
      improvementAbortRef.current.abort();
      improvementAbortRef.current = null;
    }
    improvementRunIdRef.current += 1;
    setIsImproving(false);
    setImprovementProgress(null);
    setCurrentImprovementTarget(undefined);
    if (!options?.silent) {
      toast.info('Improvement cancelled.');
    }
  }, []);

  /**
   * Main improvement function
   */
  const improve = useCallback(
    async (prompt: string, targetSection?: number) => {
      const promptToUse = prompt.trim();

      if (!promptToUse || !contentToImprove) {
        toast.error('Please enter your improvement instructions.');
        return false;
      }

      if (!aiGenerator.isApiKeySet) {
        toast.error(ERROR_MESSAGES.apiKeyMissing);
        return false;
      }

      if (!aiGenerator.selectedModel) {
        toast.error(ERROR_MESSAGES.modelNotSelected);
        return false;
      }

      const run = startImprovementRun();

      setIsImproving(true);
      setImprovementProgress({ currentStage: 'Starting the design agent...', percentage: 10 });
      setCurrentImprovementTarget(targetSection);

      try {
        // Get latest sections from stagedGeneration state
        const sections = aiGenerator.stagedGeneration.sections;

        // Determine what to improve
        let codeToImprove = contentToImprove;

        if (targetSection !== undefined && sections.length > 0) {
          // Validate section index
          if (targetSection < 0 || targetSection >= sections.length) {
            throw new Error(ERROR_MESSAGES.invalidSectionIndex);
          }

          const section = sections[targetSection];
          codeToImprove = { html: section.html, css: section.css, js: section.js };
          toast.info(`Improving Section ${targetSection + 1} of ${sections.length}`);
        }

        const currentModel = aiGenerator.aiModels.find((m: ModelInfo) => m.id === aiGenerator.selectedModel);
        const imageSelection = limitImagesForModel(
          aiContext.selectedImages,
          aiGenerator.selectedModel,
          currentModel?.maxImages,
        );
        if (imageSelection.truncated > 0) {
          toast.warning(
            `Using the first ${imageSelection.limit} selected images for this model. ${imageSelection.truncated} ${imageSelection.truncated === 1 ? 'image was' : 'images were'} skipped.`,
          );
        }

        const result = await runWidgetGeneration({
          provider: aiGenerator.activeProvider,
          model: aiGenerator.selectedModel,
          promptType: aiGenerator.effectivePromptType,
          operation: 'improve',
          userPrompt: aiGenerator.getPlacementAwareInstructions(promptToUse),
          existingHtml: codeToImprove.html,
          existingCss: codeToImprove.css,
          existingJs: codeToImprove.js,
          targetSection,
          sections: sections.map((section: SectionContent) => ({
            html: section.html,
            css: section.css,
            js: section.js,
            description: section.description,
          })),
          improvementHistory,
          selectedImages: imageSelection.images,
          productIds: aiGenerator.getMergedProductIds(),
          categoryIds: aiContext.allCategoriesSelected ? undefined : aiGenerator.getMergedCategoryIds(),
          collectionIds: aiGenerator.getMergedCollectionIds(),
          anchorCollectionIds: aiGenerator.getMergedAnchorCollectionIds(),
          allCategoriesSelected: aiContext.allCategoriesSelected,
        }, {
          signal: run.signal,
          onEvent: (event) => {
            if (!isActiveImprovementRun(run)) return;
            const progress = progressForImprovementEvent(event);
            if (progress) setImprovementProgress(progress);
            if (event.type === 'preview.patch') {
              setContentToImprove({
                html: event.html,
                css: event.css,
                js: event.js,
              });
            }
            if (event.type === 'warning') {
              notifyAiContextWarnings({ warnings: event.warnings as AiContextBatchDetails['warnings'] } as AiContextBatchDetails);
            }
          },
          onDraft: setRawOutput,
        });
        if (!isActiveImprovementRun(run)) return false;
        setRawOutput(result.raw);
        const improvedContent = normalizeGeneratedWidgetContent(parseGeneratedWidgetContent(result.raw));

        // Section-specific improvement: merge back into full widget
        if (targetSection !== undefined && sections.length > 0) {
          try {
            // Update the specific section in the sections array
            const updatedSections = [...sections];
            const oldSection = updatedSections[targetSection];
            updatedSections[targetSection] = {
              ...oldSection,
              html: improvedContent.html,
              css: improvedContent.css,
              js: improvedContent.js,
              timestamp: Date.now(),
            };

            setContentToImprove({
              ...reconstructWidgetFromSections(
                updatedSections.map((section, index) => ({
                  index,
                  html: section.html,
                  css: section.css,
                  description: section.description || `Section ${index + 1}`,
                  id: section.id,
                  timestamp: section.timestamp,
                })),
              ),
              js: updatedSections.map((section) => section.js).filter(Boolean).join('\n\n'),
            });

            // Update the staged generation state immutably
            aiGenerator.stagedGeneration.updateSections(updatedSections);

            // Add to improvement history
            setImprovementHistory((prev) => [
              ...prev,
              {
                section: targetSection,
                prompt: promptToUse,
                timestamp: Date.now(),
                modelUsed: aiGenerator.selectedModel,
              },
            ]);

            toast.success(SUCCESS_MESSAGES.sectionImproved(targetSection, sections.length));
          } catch (mergeError: unknown) {
            if (import.meta.env.DEV) console.error('Failed to merge section:', mergeError);
            toast.error(ERROR_MESSAGES.sectionMergeFailed);
            // Fallback: just show the improved section
            setContentToImprove(improvedContent);
          }
        } else {
          // Whole widget improvement
          setContentToImprove(improvedContent);

          // Add to improvement history
          setImprovementHistory((prev) => [
            ...prev,
            {
              prompt: promptToUse,
              timestamp: Date.now(),
              modelUsed: aiGenerator.selectedModel,
            },
          ]);

          toast.success(SUCCESS_MESSAGES.improved);
        }

        return true;
      } catch (error: unknown) {
        if (isAbortError(error) || run.signal.aborted) {
          return false;
        }
        if (import.meta.env.DEV) console.error('Error improving content:', error);
        toast.error(ERROR_MESSAGES.generationFailed(error instanceof Error ? error.message : String(error)));
        return false;
      } finally {
        if (improvementRunIdRef.current === run.id) {
          setIsImproving(false);
          setImprovementProgress(null);
          setCurrentImprovementTarget(undefined);
          if (improvementAbortRef.current?.signal === run.signal) {
            improvementAbortRef.current = null;
          }
        }
      }
    },
    [contentToImprove, aiContext, aiGenerator, improvementHistory],
  );

  /**
   * Initialize improvement session with content
   */
  const startImprovement = useCallback(
    (content: { html: string; css: string; js?: string }) => {
      setContentToImprove(content);
      improvementBaselineRef.current = improvementHistory;
    },
    [improvementHistory],
  );

  const discardImprovement = useCallback(() => {
    cancel({ silent: true });
    setContentToImprove(null);
    setImprovementHistory(improvementBaselineRef.current);
    setRawOutput('');
  }, [cancel]);

  const clearCurrentImprovement = useCallback(() => {
    cancel({ silent: true });
    setContentToImprove(null);
    setRawOutput('');
  }, [cancel]);

  /**
   * Reset improvement state
   */
  const reset = useCallback(() => {
    cancel({ silent: true });
    setContentToImprove(null);
    setImprovementHistory([]);
    improvementBaselineRef.current = [];
    setRawOutput('');
  }, [cancel]);

  /**
   * Load improvement history (e.g., from saved aiContext)
   */
  const loadHistory = useCallback((history: ImprovementHistoryEntry[]) => {
    improvementBaselineRef.current = history;
    setImprovementHistory(history);
  }, []);

  return {
    // State
    contentToImprove,
    isImproving,
    improvementProgress,
    improvementHistory,
    currentImprovementTarget,
    rawOutput,

    // Actions
    improve,
    startImprovement,
    reset,
    cancel,
    loadHistory,
    discardImprovement,
    clearCurrentImprovement,
    setContentToImprove,
  };
}
