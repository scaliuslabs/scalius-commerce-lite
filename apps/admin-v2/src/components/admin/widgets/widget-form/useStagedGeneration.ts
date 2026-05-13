import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { parseHtmlIntoSections } from '@scalius/shared/html-section-parser';
import {
  createWidgetCompositionPlan,
  type WidgetCompositionPlan,
} from '@scalius/core/modules/ai';
import type { StructuredPromptResult } from '@scalius/core/modules/ai/prompt-helper-v2';
import { extractChatCompletionContent, readApiErrorMessage } from './ai-stream';
import {
  normalizeGeneratedWidgetContent,
  parseGeneratedWidgetContent,
  type GeneratedWidgetContent,
} from './widget-generation-content';
import { fetchWidgetAi } from './ai-request';

type PromptMessage = StructuredPromptResult['messages'][number];
type AiPromptType = 'widget' | 'landing-page' | 'collection';

type GenerationPlan = WidgetCompositionPlan;

export interface SectionContent {
  html: string;
  css: string;
  sectionIndex: number;
  description?: string;
  id: string;
  timestamp: number;
}

interface StagedGenerationState {
  isGenerating: boolean;
  currentStage: 'idle' | 'planning' | 'generating' | 'polishing' | 'complete' | 'error';
  plan: GenerationPlan | null;
  sections: SectionContent[];
  currentSectionIndex: number;
  error: string | null;
  retryCount: number;
}

type WidgetData = GeneratedWidgetContent;

function createAbortError(): Error {
  const error = new Error('Generation cancelled');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function sectionsFromWidgetData(content: WidgetData, plan: GenerationPlan): SectionContent[] {
  try {
    const parsedSections = parseHtmlIntoSections(content.html, content.css || '');
    if (parsedSections.length > 0) {
      return parsedSections.map((section, index) => ({
        html: section.html,
        css: section.css,
        sectionIndex: index,
        description: plan.sectionDescriptions[index] || section.description || `Section ${index + 1}`,
        id: section.id,
        timestamp: section.timestamp,
      }));
    }
  } catch (error: unknown) {
    if (import.meta.env.DEV) console.warn('Failed to parse generated widget sections.', error);
  }

  return [
    {
      html: content.html,
      css: content.css,
      sectionIndex: 0,
      description: plan.compositionBrief,
      id: `composition-${Date.now()}`,
      timestamp: Date.now(),
    },
  ];
}

export function useStagedGeneration() {
  const [state, setState] = useState<StagedGenerationState>({
    isGenerating: false,
    currentStage: 'idle',
    plan: null,
    sections: [],
    currentSectionIndex: 0,
    error: null,
    retryCount: 0,
  });

  const generateSinglePassComposition = useCallback(
    async (
      provider: string,
      model: string,
      messages: PromptMessage[],
      promptType: AiPromptType,
      plan: GenerationPlan,
      signal?: AbortSignal,
    ): Promise<WidgetData> => {
      const response = await fetchWidgetAi('/api/v1/admin/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          provider,
          model,
          promptType,
          messages,
          compositionMode: true,
          stream: false,
          operation: 'create',
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, `HTTP ${response.status}`));
      }

      const content = extractChatCompletionContent(await response.json());
      throwIfAborted(signal);
      return normalizeGeneratedWidgetContent(parseGeneratedWidgetContent(content));
    },
    [],
  );

  const startStagedGeneration = useCallback(
    async (
      provider: string,
      model: string,
      messages: PromptMessage[],
      promptType: AiPromptType,
      onSectionComplete?: (section: SectionContent, index: number, total: number, preview: WidgetData) => void,
      signal?: AbortSignal,
    ): Promise<WidgetData | null> => {
      throwIfAborted(signal);

      const plan = createWidgetCompositionPlan(promptType);
      setState({
        isGenerating: true,
        currentStage: 'planning',
        plan,
        sections: [],
        currentSectionIndex: 0,
        error: null,
        retryCount: 0,
      });

      try {
        toast.info('Preparing a cohesive composition blueprint...');
        throwIfAborted(signal);
        setState((prev) => ({ ...prev, currentStage: 'generating' }));

        toast.info('Generating one cohesive widget...');
        const finalWidget = await generateSinglePassComposition(provider, model, messages, promptType, plan, signal);
        const finalSections = sectionsFromWidgetData(finalWidget, plan);

        if (onSectionComplete && finalSections[0]) {
          onSectionComplete(finalSections[0], 0, finalSections.length, finalWidget);
        }

        setState((prev) => ({
          ...prev,
          currentStage: 'complete',
          isGenerating: false,
          currentSectionIndex: Math.max(0, finalSections.length - 1),
          sections: finalSections,
        }));
        toast.success('Widget generation complete!');

        return finalWidget;
      } catch (error: unknown) {
        if (isAbortError(error)) {
          setState({
            isGenerating: false,
            currentStage: 'idle',
            plan: null,
            sections: [],
            currentSectionIndex: 0,
            error: null,
            retryCount: 0,
          });
          return null;
        }

        if (import.meta.env.DEV) console.error('Composition generation error:', error);
        setState((prev) => ({
          ...prev,
          currentStage: 'error',
          error: error instanceof Error ? error.message : String(error),
          isGenerating: false,
        }));
        return null;
      }
    },
    [generateSinglePassComposition],
  );

  const reset = useCallback(() => {
    setState({
      isGenerating: false,
      currentStage: 'idle',
      plan: null,
      sections: [],
      currentSectionIndex: 0,
      error: null,
      retryCount: 0,
    });
  }, []);

  const updateSections = useCallback((updatedSections: SectionContent[]) => {
    setState((prev) => ({
      ...prev,
      sections: [...updatedSections],
    }));
  }, []);

  return {
    ...state,
    startStagedGeneration,
    reset,
    updateSections,
  };
}
