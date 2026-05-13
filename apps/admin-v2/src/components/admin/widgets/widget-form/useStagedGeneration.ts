import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { parseHtmlIntoSections } from '@scalius/shared/html-section-parser';
import { parseJSONSafely, validateWidgetJSON } from '@scalius/shared/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@scalius/shared/tag-parser';
import type { StructuredPromptResult } from '@scalius/core/modules/ai/prompt-helper-v2';
import { extractChatCompletionContent, readApiErrorMessage } from './ai-stream';

type PromptMessage = StructuredPromptResult['messages'][number];
type AiPromptType = 'widget' | 'landing-page' | 'collection';

interface GenerationPlan {
  totalSections: number;
  sectionDescriptions: string[];
  compositionBrief: string;
  sharedDesignSystem: string;
  spacingStrategy: string;
  sectionContinuity: string[];
  estimatedTokens?: number;
}

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
.widget-container,
[data-scalius-widget-root="true"] {
  gap: 0;
  margin: 0;
}

.widget-container > .widget-section:first-child > *:first-child,
[data-scalius-widget-root="true"] > :first-child {
  margin-top: 0;
}

.widget-container > .widget-section:last-child > *:last-child,
[data-scalius-widget-root="true"] > :last-child {
  margin-bottom: 0;
}`;

const DESTINATION_STAGE_CONTRACTS: Record<AiPromptType, string> = {
  widget:
    'Homepage Widget: compact homepage merchandising inserted into an existing homepage. Prioritize discovery, featured products/categories, trust, and one light action close. Do not build a full landing page.',
  'landing-page':
    'Landing Section: campaign-style conversion flow inside the storefront shell. Move from offer/promise to proof, product support, objection handling, urgency/trust, and final CTA.',
  collection:
    'Collection Section: commerce-dense collection merchandising. Product comparison, prices, links, variant cues, buying-guide support, and direct selection matter more than broad storytelling.',
};

const DESTINATION_BLUEPRINTS: Record<
  AiPromptType,
  {
    totalSections: number;
    compositionBrief: string;
    sections: string[];
    designSystem: string;
    spacing: string;
  }
> = {
  widget: {
    totalSections: 2,
    compositionBrief:
      'One fast homepage merchandising module that opens with a clear store/category signal and closes with compact discovery/action support.',
    sections: [
      'Compact opening band with the strongest merchandising signal, one primary CTA, and restrained visual weight',
      'Discovery/support band for selected products, categories, collections, trust cues, or a final action without landing-page length',
    ],
    designSystem:
      'Reusable homepage rhythm: medium density, strong hierarchy, compact cards, consistent CTA style, and lightweight visual transitions.',
    spacing:
      'Keep the root compact; bands share background tokens or tight dividers and use internal padding instead of external margins.',
  },
  'landing-page': {
    totalSections: 5,
    compositionBrief:
      'One continuous campaign section set that sells a specific offer, audience promise, product line, or collection inside the existing storefront shell.',
    sections: [
      'Campaign hero/offer with a specific promise and primary CTA',
      'Product or collection showcase that makes the offer concrete',
      'Benefits, proof, or use-case explanation that supports the choice without invented claims',
      'Objection handling, urgency, trust, or comparison content tied to provided facts',
      'Final conversion CTA that closes the campaign stronger than the opening',
    ],
    designSystem:
      'Campaign art direction: stronger narrative hierarchy, repeated but restrained CTA language, cohesive product/media treatment, and a clear conversion progression.',
    spacing:
      'Make sections read as one page story with connected backgrounds/dividers; no disconnected cards, spacer bands, or full-viewport gaps.',
  },
  collection: {
    totalSections: 3,
    compositionBrief:
      'One practical collection merchandising flow that introduces the collection, helps shoppers compare products, and ends with a tight trust/action strip.',
    sections: [
      'Collection intro with the shopper promise and compact navigation/filter-like cues',
      'Product grid, comparison, buying guide, or shop-by-need layout using provided product facts prominently',
      'Tight trust/action strip that supports selection without broad campaign storytelling',
    ],
    designSystem:
      'Commerce-first system: dense scan layout, prominent price/link hierarchy, stable product cards, restrained copy, and practical comparison affordances.',
    spacing:
      'Keep vertical rhythm tight for collection browsing; product content should dominate and adjacent blocks should connect without whitespace gaps.',
  },
};

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

function createDeterministicPlan(promptType: AiPromptType): GenerationPlan {
  const blueprint = DESTINATION_BLUEPRINTS[promptType];
  return {
    totalSections: blueprint.totalSections,
    sectionDescriptions: blueprint.sections,
    compositionBrief: blueprint.compositionBrief,
    sharedDesignSystem: blueprint.designSystem,
    spacingStrategy: blueprint.spacing,
    sectionContinuity: blueprint.sections.map((section, index) =>
      index === 0
        ? `${section}; establish the shared design system and hand off naturally to the next band.`
        : `${section}; continue the prior band's palette, typography, spacing rhythm, and CTA treatment without outer gaps.`,
    ),
  };
}

function describePlan(plan: GenerationPlan): string {
  return [
    `Complete composition: ${plan.compositionBrief}`,
    `Shared design system: ${plan.sharedDesignSystem}`,
    `Spacing strategy: ${plan.spacingStrategy}`,
    'Expected flow:',
    ...plan.sectionDescriptions.map(
      (description, index) => `${index + 1}. ${description} Continuity: ${plan.sectionContinuity[index]}`,
    ),
  ].join('\n');
}

function createSinglePassMessages(
  messages: PromptMessage[],
  promptType: AiPromptType,
  plan: GenerationPlan,
): PromptMessage[] {
  return [
    ...messages,
    {
      role: 'user',
      content: `Generate the final widget in ONE model response using the destination blueprint below. Do not output a plan.

Destination:
${DESTINATION_STAGE_CONTRACTS[promptType]}

Blueprint:
${describePlan(plan)}

Single-pass generation rules:
- Think through the full composition internally, then return one complete <htmljs> and <css> artifact.
- Use exactly one root wrapper with data-scalius-widget-root="true" and destination-specific classes.
- If the output has multiple visual bands, they must be children of the same root and must look like one connected composition, not separate widgets.
- Do not create client-side JavaScript, script tags, markdown, external CSS, tracking pixels, hidden forms, unrelated page headers, or footers.
- Keep generated CSS compact, scoped, and purposeful. Avoid repeated card systems, giant min-heights, viewport-height filler, spacer divs, oversized margins, and dead vertical gaps.
- Use only provided catalog facts, URLs, product images, prices, discounts, stock, delivery/trust claims, and category/collection names. If a fact is not provided, keep copy generic and non-factual.
- Homepage widgets should remain compact; landing sections should be campaign-like; collection sections should be product-comparison led.

Return only:
<htmljs>
...
</htmljs>

<css>
...
</css>`,
    },
  ];
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
  const html = widget.html.includes('data-scalius-widget-root=')
    ? widget.html
    : `<div class="widget-container" data-scalius-widget-root="true">\n${widget.html}\n</div>`;
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
          messages: createSinglePassMessages(messages, promptType, plan),
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

      const plan = createDeterministicPlan(promptType);
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
