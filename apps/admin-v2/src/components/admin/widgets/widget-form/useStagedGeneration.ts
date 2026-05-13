import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { parseHtmlIntoSections } from '@scalius/shared/html-section-parser';
import { stripWidgetRuntimeMarkup } from '@scalius/shared/widget-rendering';
import { parseJSONSafely, validateWidgetJSON } from '@scalius/shared/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@scalius/shared/tag-parser';
import {
  createWidgetCompositionPlan,
  type WidgetCompositionPlan,
} from '@scalius/core/modules/ai';
import type { StructuredPromptResult } from '@scalius/core/modules/ai/prompt-helper-v2';
import { extractChatCompletionContent, readApiErrorMessage } from './ai-stream';

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

type WidgetData = { html: string; css: string };

const COMPOSITION_BOUNDARY_GUARD_CSS = `

/* Scalius composition boundary guard */
[data-scalius-widget-root="true"] {
  gap: 0;
  margin: 0;
}

[data-scalius-widget-root="true"] > :first-child {
  margin-top: 0;
}

[data-scalius-widget-root="true"] > :last-child {
  margin-bottom: 0;
}`;

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

function parseWidgetData(content: string): WidgetData {
  const tagResult = parseTagBasedResponse(content);

  if (tagResult.success && tagResult.data) {
    const validation = validateParsedWidget(tagResult.data);
    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid widget structure');
    }
    return {
      html: tagResult.data.html,
      css: tagResult.data.css || '',
    };
  }

  const parsed = parseJSONSafely(content);
  if (!parsed.success) {
    throw new Error(parsed.error || 'Failed to parse response');
  }

  const validation = validateWidgetJSON(parsed.data);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid widget structure');
  }

  const widgetData = parsed.data as { html: string; css?: string };
  return {
    html: widgetData.html,
    css: widgetData.css || '',
  };
}

function applyCompositionBoundaryGuard(widget: WidgetData): WidgetData {
  const html = stripWidgetRuntimeMarkup(widget.html);
  return { html, css: `${widget.css || ''}${COMPOSITION_BOUNDARY_GUARD_CSS}` };
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
      const response = await fetch('/api/v1/admin/ai/generate', {
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
      return applyCompositionBoundaryGuard(parseWidgetData(content));
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
