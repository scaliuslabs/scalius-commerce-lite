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
import { generateStructuredPrompt } from '@scalius/core/modules/ai/prompt-helper-v2';
import { reconstructWidgetFromSections } from '@scalius/shared/html-section-parser';
import { parseJSONSafely, validateWidgetJSON } from '@scalius/shared/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@scalius/shared/tag-parser';
import { ERROR_MESSAGES, SUCCESS_MESSAGES } from '@scalius/core/modules/ai/ai-config';
import { getAiPrompts, getAiContextBatchDetails } from '@/lib/api.functions';
import { readApiErrorMessage, readChatCompletionStream } from './ai-stream';
import { notifyAiContextWarnings, type AiContextBatchDetails } from './ai-context-warnings';
import { limitImagesForModel } from './ai-context-limits';
import type { ImprovementHistoryEntry } from '@scalius/core/modules/ai/ai-context-schema';
import type { useAiContext } from './useAiContext';
import type { useAiGenerator } from './useAiGenerator';
import type { SectionContent } from './useStagedGeneration';

type StructuredPromptParams = Parameters<typeof generateStructuredPrompt>[0];
type AiProductData = StructuredPromptParams['selectedProducts'][number];
type AiCategoryData = StructuredPromptParams['selectedCategories'][number];
type AiCollectionData = NonNullable<StructuredPromptParams['selectedCollections']>[number];
type ImprovementRun = { id: number; signal: AbortSignal };

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

export function useAiImprover({ aiContext, aiGenerator }: UseAiImproverProps) {
  const [contentToImprove, setContentToImprove] = useState<{ html: string; css: string } | null>(null);
  const [isImproving, setIsImproving] = useState(false);
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
      setCurrentImprovementTarget(targetSection);

      try {
        // Fetch system prompt (returns plain text)
        const systemPrompt = (await getAiPrompts({ data: { type: aiGenerator.effectivePromptType } })) as string;
        if (!isActiveImprovementRun(run)) return false;
        if (!systemPrompt) throw new Error(ERROR_MESSAGES.systemPromptFailed);

        // Fetch context details
        const contextData = (await getAiContextBatchDetails({
          data: {
            productIds: aiGenerator.getMergedProductIds(),
            categoryIds: aiContext.allCategoriesSelected ? undefined : aiGenerator.getMergedCategoryIds(),
            collectionIds: aiGenerator.getMergedCollectionIds(),
            anchorCollectionIds: aiGenerator.getMergedAnchorCollectionIds(),
            allCategories: aiContext.allCategoriesSelected,
          },
        })) as AiContextBatchDetails;
        if (!isActiveImprovementRun(run)) return false;
        notifyAiContextWarnings(contextData);

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
          codeToImprove = { html: section.html, css: section.css };
          toast.info(`Improving Section ${targetSection + 1} of ${sections.length}`);
        }

        // Build improvement history context
        const historyContext =
          improvementHistory.length > 0
            ? `\n\nPREVIOUS IMPROVEMENTS:\n${improvementHistory
                .map(
                  (h, i) =>
                    `${i + 1}. ${h.section !== undefined ? `Section ${h.section + 1}` : 'Whole widget'}: "${h.prompt}"`,
                )
                .join(
                  '\n',
                )}\n\nIMPORTANT: Build upon these previous improvements. Do not revert any of the changes made in the history above.`
            : '';

        // Build other sections context (for awareness when improving specific section)
        let otherSectionsContext = '';
        if (targetSection !== undefined && sections.length > 1) {
          const otherSections = sections
            .map((s: SectionContent, idx: number) => {
              if (idx === targetSection) return null; // Skip the target section
              return `Section ${idx + 1}${s.description ? ` (${s.description})` : ''}:\n\`\`\`html\n${s.html}\n\`\`\`\n\`\`\`css\n${s.css || '/* No CSS */'}\n\`\`\``;
            })
            .filter(Boolean);

          if (otherSections.length > 0) {
            otherSectionsContext = `\n\nOTHER SECTIONS CONTEXT (for visual consistency and reference):\nYou are improving Section ${targetSection + 1} of ${sections.length}. Here are the other sections for context:\n\n${otherSections.join('\n\n')}\n\nIMPORTANT: Your improvement should maintain visual consistency with these sections. You can reference their styling and structure, but you should ONLY modify Section ${targetSection + 1}.`;
          }
        }

        // Generate structured prompt for improvement
        const currentModel = aiGenerator.aiModels.find((m: ModelInfo) => m.id === aiGenerator.selectedModel);
        const isVisionModel = currentModel?.supportsVision || false;
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

        const promptResult = await generateStructuredPrompt({
          systemPrompt,
          improvementPrompt:
            aiGenerator.getPlacementAwareInstructions(promptToUse) + historyContext + otherSectionsContext,
          existingHtml: codeToImprove.html,
          existingCss: codeToImprove.css,
          selectedImages: imageSelection.images,
          selectedProducts: (contextData.products || []) as AiProductData[],
          selectedCategories: (contextData.categories || []) as AiCategoryData[],
          selectedCollections: (contextData.collections || []) as AiCollectionData[],
          allCategoriesSelected: aiContext.allCategoriesSelected,
          modelId: aiGenerator.selectedModel,
          supportsVision: isVisionModel,
          maxImagesOverride: currentModel?.maxImages,
          promptType: aiGenerator.effectivePromptType,
          sectionIndex: targetSection,
          totalSections: sections.length,
        });
        if (!isActiveImprovementRun(run)) return false;

        // Call API with structured messages
        const response = await fetch('/api/v1/admin/ai/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: run.signal,
          body: JSON.stringify({
            provider: aiGenerator.activeProvider,
            messages: promptResult.messages,
            model: aiGenerator.selectedModel,
            stream: true,
            operation: 'improve',
          }),
        });
        if (!isActiveImprovementRun(run)) return false;

        if (!response.ok || !response.body) {
          throw new Error(await readApiErrorMessage(response, 'Failed to generate content.'));
        }

        const accumulatedJson = await readChatCompletionStream(response);
        if (!isActiveImprovementRun(run)) return false;
        setRawOutput(accumulatedJson);

        // Try tag-based parsing first, then fall back to JSON
        const tagResult = parseTagBasedResponse(accumulatedJson);

        let improvedContent;

        if (tagResult.success && tagResult.data) {
          const validation = validateParsedWidget(tagResult.data);
          if (!validation.valid) {
            if (import.meta.env.DEV) console.error('Tag-based validation failed:', validation.error);
            if (import.meta.env.DEV) console.error('Parsed data:', tagResult.data);
            throw new Error(`Invalid response: ${validation.error}. Check browser console for raw output.`);
          }
          improvedContent = tagResult.data as { html: string; css: string };
        } else {
          // Fallback to JSON parsing
          const parsed = parseJSONSafely(accumulatedJson);
          if (!parsed.success) {
            if (import.meta.env.DEV) console.error('All parsing strategies failed');
            if (import.meta.env.DEV) console.error('Tag error:', tagResult.error);
            if (import.meta.env.DEV) console.error('JSON error:', parsed.error);
            throw new Error(
              `Parsing failed: Neither tag-based nor JSON format detected. Check browser console for raw output.`,
            );
          }

          const validation = validateWidgetJSON(parsed.data);
          if (!validation.valid) {
            if (import.meta.env.DEV) console.error('JSON validation failed:', validation.error);
            if (import.meta.env.DEV) console.error('Parsed data:', parsed.data);
            throw new Error(`Invalid response: ${validation.error}. Check browser console for raw output.`);
          }
          improvedContent = parsed.data as { html: string; css: string };
        }

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
              timestamp: Date.now(),
            };

            setContentToImprove(
              reconstructWidgetFromSections(
                updatedSections.map((section, index) => ({
                  index,
                  html: section.html,
                  css: section.css,
                  description: section.description || `Section ${index + 1}`,
                  id: section.id,
                  timestamp: section.timestamp,
                })),
              ),
            );

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
    (content: { html: string; css: string }) => {
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
