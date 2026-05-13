import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { parseJSONSafely, validateWidgetJSON } from '@scalius/shared/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@scalius/shared/tag-parser';
import type { StructuredPromptResult } from '@scalius/core/modules/ai/prompt-helper-v2';
import { GENERATION_CONFIG } from '@scalius/core/modules/ai/ai-config';
import { extractChatCompletionContent, readApiErrorMessage } from './ai-stream';

type PromptMessage = StructuredPromptResult['messages'][number];

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

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const PREVIOUS_SECTION_CONTEXT_LIMIT = 6000;
const FINALIZATION_DRAFT_LIMIT = 36_000;
const SECTION_GAP_CSS = '0';

type WidgetData = { html: string; css: string };

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

function textFromMessages(messages: PromptMessage[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === 'string') return message.content;
      return message.content
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    })
    .join('\n');
}

function removeWidgetOutputInstructions(text: string): string {
  const outputStart = text.indexOf('RESPONSE FORMAT - USE SIMPLE TAGS:');
  if (outputStart < 0) return text;

  const nextInstructionStart = text.indexOf('IMPORTANT: "BUY NOW"', outputStart);
  if (nextInstructionStart < 0) {
    return text.slice(0, outputStart).trim();
  }

  return `${text.slice(0, outputStart)}${text.slice(nextInstructionStart)}`.trim();
}

function createPlanningMessages(messages: PromptMessage[]): PromptMessage[] {
  const planningContext = removeWidgetOutputInstructions(textFromMessages(messages));
  return [
    {
      role: 'user',
      content: `${planningContext}

	Before generating the widget, create a concise implementation plan. Respond with ONLY a JSON object in this shape:
	{
	  "totalSections": <number of progressive sections needed>,
	  "compositionBrief": "<one sentence describing the complete widget as a single composition>",
	  "sharedDesignSystem": "<specific reusable art direction: colors, typography, cards, buttons, image treatment>",
	  "spacingStrategy": "<how sections connect without blank gaps; assume final wrapper gap is 0>",
	  "sectionDescriptions": [<brief role for each section in the single composition>],
	  "sectionContinuity": [<how each section connects to the previous/next section>],
	  "estimatedTokens": <optional estimated total tokens>
	}

	Guidelines:
- Choose section count by destination:
  - Homepage widget: usually 2-4 cohesive bands such as offer/category signal, featured products or categories, trust/urgency, and CTA.
  - Landing section set: usually 4-6 campaign bands such as hero/offer, product or collection showcase, proof, objection handling, urgency, and final CTA.
  - Collection section: usually 2-4 practical merchandising bands such as collection intro, product grid/comparison, buying guide, and CTA/trust strip.
	- Plan the output as ONE continuous composition. Section descriptions must state each section's role in that flow, not isolated ideas.
	- Each generated section is only a progressive slice of the same widget, not an independent widget.
	- Every section must share one visual system: color tokens, typography, image treatment, button style, radius scale, and spacing rhythm.
	- The final composition wrapper uses gap: 0. The spacingStrategy and sectionContinuity fields must explain how visual continuity is achieved through internal padding, shared backgrounds, overlap, dividers, or shape transitions.
	- Avoid huge vertical gaps. Root section wrappers should not rely on large top/bottom margins or spacer blocks.
	- Do not include HTML, CSS, markdown, comments, or explanations in this planning response.
	- The sectionDescriptions and sectionContinuity array lengths must equal totalSections.`,
    },
  ];
}

function createDeterministicPlan(messages: PromptMessage[]): GenerationPlan {
  const promptText = textFromMessages(messages).toLowerCase();
  const wantsCollection =
    promptText.includes('collection page designer') ||
    promptText.includes('collection section') ||
    promptText.includes('collection') ||
    promptText.includes('products') ||
    promptText.includes('product grid');
  const wantsLanding =
    promptText.includes('landing page designer') || promptText.includes('landing') || promptText.includes('campaign');
  const wantsHomepage = promptText.includes('homepage widget designer') || promptText.includes('homepage');
  const totalSections = wantsLanding ? 4 : wantsHomepage || wantsCollection ? 3 : 2;
  const sectionDescriptions = wantsLanding
    ? [
        'Campaign hero/offer that establishes the shared visual system',
        'Product or collection showcase that continues the hero rhythm',
        'Proof, benefits, or objection handling using the same design language',
        'Final conversion CTA with tight spacing from the prior section',
      ]
    : wantsHomepage
      ? [
          'Homepage offer/category signal that establishes the visual system',
          'Featured product or collection discovery band',
          'Trust, urgency, or CTA band that closes the homepage widget',
        ]
      : wantsCollection
        ? [
            'Collection intro with the core merchandising promise',
            'Product or category comparison using the provided storefront context',
            'Trust, urgency, and call-to-action strip connected to the product grid',
          ]
        : ['Primary promotional section', 'Supporting call-to-action section'];

  return {
    totalSections,
    sectionDescriptions: sectionDescriptions.slice(0, totalSections),
    compositionBrief: wantsLanding
      ? 'One continuous campaign section set that moves from offer to proof to conversion inside the storefront shell.'
      : wantsCollection
        ? 'One continuous collection merchandising widget that introduces products, helps comparison, and closes with trust or action.'
        : 'One continuous homepage merchandising widget that opens with a clear signal, supports discovery, and closes with action.',
    sharedDesignSystem:
      'Use one palette, type scale, image treatment, card radius, button language, and responsive spacing rhythm across every generated section.',
    spacingStrategy:
      'The final wrapper uses gap: 0; connect adjacent sections with shared backgrounds, intentional dividers, or internal padding rather than external margins.',
    sectionContinuity: sectionDescriptions
      .slice(0, totalSections)
      .map((description, index) =>
        index === 0
          ? `${description}; establish the shared visual system and leave a natural handoff to the next section.`
          : `${description}; continue the prior section's visual language without outer spacing or unrelated resets.`,
      ),
  };
}

function compactPreviousSections(previousSections: SectionContent[]): string {
  if (previousSections.length === 0) return '';

  const newestFirst = [...previousSections].reverse();
  const snippets: string[] = [];
  let usedChars = 0;

  for (const section of newestFirst) {
    const snippet = `Section ${section.sectionIndex + 1}${section.description ? ` (${section.description})` : ''}:
HTML summary:
${section.html.slice(0, 900)}

CSS summary:
${section.css.slice(0, 900) || 'No CSS'}`;
    if (usedChars + snippet.length > PREVIOUS_SECTION_CONTEXT_LIMIT) break;
    snippets.unshift(snippet);
    usedChars += snippet.length;
  }

  if (snippets.length === 0) return '';

  return `\n\nPREVIOUS SECTIONS CONTEXT:
${snippets.join('\n\n')}

	IMPORTANT: Maintain the same design language, color rhythm, spacing, typography, and CTA style. Do not copy previous sections verbatim.`;
}

function normalizePlan(plan: GenerationPlan): GenerationPlan {
  const totalSections = Math.min(
    GENERATION_CONFIG.stagedGeneration.maxSections,
    Math.max(
      GENERATION_CONFIG.stagedGeneration.minSections,
      Math.round(Number(plan.totalSections) || GENERATION_CONFIG.stagedGeneration.minSections),
    ),
  );
  const sectionDescriptions = Array.isArray(plan.sectionDescriptions)
    ? plan.sectionDescriptions
        .slice(0, totalSections)
        .map((description, index) => String(description || `Section ${index + 1}`).slice(0, 160))
    : [];

  while (sectionDescriptions.length < totalSections) {
    sectionDescriptions.push(`Section ${sectionDescriptions.length + 1}`);
  }

  const sectionContinuity = Array.isArray(plan.sectionContinuity)
    ? plan.sectionContinuity
        .slice(0, totalSections)
        .map((instruction, index) =>
          String(
            instruction ||
              (index === 0
                ? 'Establish the shared visual system and hand off naturally to the next section.'
                : 'Continue the shared visual system from the previous section without external spacing.'),
          ).slice(0, 200),
        )
    : [];

  while (sectionContinuity.length < totalSections) {
    sectionContinuity.push(
      sectionContinuity.length === 0
        ? 'Establish the shared visual system and hand off naturally to the next section.'
        : 'Continue the shared visual system from the previous section without external spacing.',
    );
  }

  return {
    totalSections,
    sectionDescriptions,
    compositionBrief: String(
      plan.compositionBrief ||
        'One continuous storefront widget composition with a clear opening, supporting merchandising, and conversion close.',
    ).slice(0, 500),
    sharedDesignSystem: String(
      plan.sharedDesignSystem ||
        'Reuse one color palette, type scale, image treatment, card style, button language, and responsive spacing rhythm across every section.',
    ).slice(0, 500),
    spacingStrategy: String(
      plan.spacingStrategy ||
        'The final wrapper places sections with zero external gap; each section uses internal padding and intentional dividers or shared backgrounds to connect.',
    ).slice(0, 360),
    sectionContinuity,
    estimatedTokens: plan.estimatedTokens,
  };
}

function describePlan(plan: GenerationPlan): string {
  return [
    `Complete composition: ${plan.compositionBrief}`,
    `Shared design system: ${plan.sharedDesignSystem}`,
    `Spacing strategy: ${plan.spacingStrategy}`,
    'Section flow:',
    ...plan.sectionDescriptions.map(
      (description, index) => `${index + 1}. ${description} Continuity: ${plan.sectionContinuity[index]}`,
    ),
  ].join('\n');
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

function indentHtml(html: string): string {
  return html
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n');
}

function buildCombinedWidget(generatedSections: SectionContent[]): WidgetData {
  const combinedHtml = `<div class="widget-container">\n${generatedSections.map((s, idx) => `  <div class="widget-section widget-section-${idx + 1}" data-section="${idx + 1}">\n${indentHtml(s.html)}\n  </div>`).join('\n')}\n</div>`;

  const combinedCss = `
	/* Widget Container Composition */
	.widget-container {
	  display: flex;
	  flex-direction: column;
	  gap: ${SECTION_GAP_CSS};
	  width: 100%;
	  margin: 0;
	}

	.widget-section {
	  width: 100%;
	  margin: 0;
	}

	.widget-section > :first-child {
	  margin-top: 0;
	}

	.widget-section > :last-child {
	  margin-bottom: 0;
	}

	/* Section-specific styles */
	${generatedSections
    .map((s, idx) => (s.css ? `/* Section ${idx + 1} styles */\n${s.css}` : ''))
    .filter(Boolean)
    .join('\n\n')}
	`;

  return { html: combinedHtml, css: combinedCss };
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

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }

      const timeout = window.setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timeout);
          reject(createAbortError());
        },
        { once: true },
      );
    });

  /**
   * Step 1: Ask LLM to create a generation plan
   */
  const createPlan = useCallback(
    async (
      provider: string,
      model: string,
      messages: PromptMessage[],
      signal?: AbortSignal,
    ): Promise<GenerationPlan | null> => {
      try {
        throwIfAborted(signal);
        const response = await fetch('/api/v1/admin/ai/generate-staged', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            provider,
            model,
            messages: createPlanningMessages(messages),
            stage: 'plan',
            useCache: true,
          }),
        });

        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response, 'Failed to create plan'));
        }

        const content = extractChatCompletionContent(await response.json());

        const parsed = parseJSONSafely(content);
        if (!parsed.success) {
          throw new Error(parsed.error || 'Failed to parse plan JSON');
        }

        const plan = normalizePlan(parsed.data as GenerationPlan);

        // Validate plan structure
        if (!plan.totalSections || !Array.isArray(plan.sectionDescriptions) || !Array.isArray(plan.sectionContinuity)) {
          throw new Error('Invalid plan structure');
        }

        if (
          plan.totalSections !== plan.sectionDescriptions.length ||
          plan.totalSections !== plan.sectionContinuity.length
        ) {
          throw new Error('Plan section count mismatch');
        }

        if (
          plan.totalSections < GENERATION_CONFIG.stagedGeneration.minSections ||
          plan.totalSections > GENERATION_CONFIG.stagedGeneration.maxSections
        ) {
          throw new Error(
            `Plan requested ${plan.totalSections} sections. Use ${GENERATION_CONFIG.stagedGeneration.minSections}-${GENERATION_CONFIG.stagedGeneration.maxSections} sections.`,
          );
        }

        return plan;
      } catch (error: unknown) {
        if (isAbortError(error)) throw error;
        if (import.meta.env.DEV) console.error('Error creating staged generation plan:', error);
        return null;
      }
    },
    [],
  );

  /**
   * Step 2: Generate a specific section with full conversation history
   */
  const generateSection = useCallback(
    async (
      provider: string,
      model: string,
      messages: PromptMessage[],
      sectionIndex: number,
      plan: GenerationPlan,
      previousSections: SectionContent[],
      retryAttempt = 0,
      signal?: AbortSignal,
    ): Promise<SectionContent | null> => {
      throwIfAborted(signal);

      const previousContext = compactPreviousSections(previousSections);
      const planOutline = describePlan(plan);
      const sectionDescription = plan.sectionDescriptions[sectionIndex] || `Section ${sectionIndex + 1}`;
      const sectionContinuity =
        plan.sectionContinuity[sectionIndex] || 'Continue the shared composition without external spacing.';

      const sectionPrompt = {
        role: 'user',
        content: `Generate section ${sectionIndex + 1} of ${plan.totalSections} as a progressive slice of ONE widget, not a separate widget.

Composition contract:
${planOutline}

Current section role: ${sectionDescription}
Continuity requirement: ${sectionContinuity}${previousContext}

Requirements:
- Use tag-based format with <htmljs> and <css> tags
- HTML must be a complete, self-contained <div> with no JavaScript or script tags
- CSS should be scoped to this section's unique classes, but must reuse the shared design system above
- This section will be combined with others in a wrapper with gap: 0, so use unique IDs/classes and no assumptions about outside spacing
- CRITICAL: This is part of one continuous composition. Do not create a detached card, isolated full page, unrelated palette, or new typography system.
- CRITICAL: Do not add margin-top, margin-bottom, min-height, empty spacer divs, decorative blank bands, or CSS resets that create visible separation between sections.
- Use internal padding for section content. Root section wrappers must use margin: 0, box-sizing: border-box, and either share the adjacent background or include an intentional divider/transition.
- Keep CTAs, card treatments, image crops, and typography aligned with the overall flow.

${sectionIndex > 0 ? 'Note: Continue the design system from previous sections and make the top edge visually connect to the prior bottom edge.' : 'Note: This is the first section - establish the cohesive design system and avoid ending with disconnected whitespace.'}

Respond with the section code in tag format.`,
      };

      try {
        const response = await fetch('/api/v1/admin/ai/generate-staged', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            provider,
            model,
            messages: [...messages, sectionPrompt],
            stage: 'generate',
            sectionIndex,
            totalSections: plan.totalSections,
          }),
        });

        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response, `HTTP ${response.status}`));
        }

        const content = extractChatCompletionContent(await response.json());
        const widgetData = parseWidgetData(content);

        return {
          html: widgetData.html,
          css: widgetData.css || '',
          sectionIndex,
          description: sectionDescription,
          id: `section-${sectionIndex}-${Date.now()}`,
          timestamp: Date.now(),
        };
      } catch (error: unknown) {
        if (isAbortError(error)) throw error;
        if (import.meta.env.DEV) console.error(`Error generating section ${sectionIndex}:`, error);

        // Retry logic with exponential backoff
        if (retryAttempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * Math.pow(2, retryAttempt);
          toast.info(`Retrying section ${sectionIndex + 1} in ${delay / 1000}s...`);
          await sleep(delay, signal);
          return generateSection(
            provider,
            model,
            messages,
            sectionIndex,
            plan,
            previousSections,
            retryAttempt + 1,
            signal,
          );
        }

        toast.error(
          `Failed to generate section ${sectionIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    },
    [],
  );

  /**
   * Step 3: Recompose the progressive sections into one final widget.
   *
   * Staged generation is for progress and model focus; the saved artifact should
   * still read like one deliberate storefront composition.
   */
  const finalizeComposition = useCallback(
    async (
      provider: string,
      model: string,
      plan: GenerationPlan,
      generatedSections: SectionContent[],
      fallback: WidgetData,
      signal?: AbortSignal,
    ): Promise<WidgetData | null> => {
      throwIfAborted(signal);

      const draft = `<htmljs>\n${fallback.html}\n</htmljs>\n\n<css>\n${fallback.css}\n</css>`;
      if (draft.length > FINALIZATION_DRAFT_LIMIT) {
        if (import.meta.env.DEV) {
          console.info('Skipping staged widget finalization; draft is too large.', {
            draftLength: draft.length,
            limit: FINALIZATION_DRAFT_LIMIT,
          });
        }
        return null;
      }

      const finalizerPrompt: PromptMessage = {
        role: 'user',
        content: `You are the final composition editor for a production ecommerce widget.

Your job is to transform the drafted staged sections below into ONE continuous, polished widget.

Composition contract:
${describePlan(plan)}

Drafted staged sections:
${draft}

Finalization rules:
- Return only <htmljs> and <css> tags.
- Preserve all real product names, URLs, image URLs, prices, categories, and claims already present in the draft. Do not invent new catalog facts.
- Merge the staged slices into one cohesive composition with one root wrapper.
- Remove accidental external gaps, spacer blocks, duplicated wrappers, and section-level margins that make bands look disconnected.
- The final root wrapper should use gap: 0 unless an intentional divider is visually designed in CSS.
- Keep CSS scoped to generated classes and do not include JavaScript, script tags, external stylesheets, tracking pixels, hidden forms, markdown, or explanations.
- Keep the result responsive, accessible, and safe for insertion inside an existing storefront page.`,
      };

      const response = await fetch('/api/v1/admin/ai/generate-staged', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          provider,
          model,
          messages: [finalizerPrompt],
          stage: 'finalize',
          totalSections: generatedSections.length,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, 'Failed to polish composition'));
      }

      const content = extractChatCompletionContent(await response.json());
      return parseWidgetData(content);
    },
    [],
  );

  /**
   * Main generation orchestrator
   */
  const startStagedGeneration = useCallback(
    async (
      provider: string,
      model: string,
      messages: PromptMessage[],
      onSectionComplete?: (section: SectionContent, index: number, total: number, preview: WidgetData) => void,
      signal?: AbortSignal,
    ): Promise<{ html: string; css: string } | null> => {
      throwIfAborted(signal);

      setState({
        isGenerating: true,
        currentStage: 'planning',
        plan: null,
        sections: [],
        currentSectionIndex: 0,
        error: null,
        retryCount: 0,
      });

      try {
        // Phase 1: Create plan
        toast.info('Planning widget structure...');
        const plan = (await createPlan(provider, model, messages, signal)) ?? createDeterministicPlan(messages);

        setState((prev) => ({ ...prev, plan, currentStage: 'generating' }));

        // Phase 2: Generate each section with accumulated context
        const generatedSections: SectionContent[] = [];

        for (let i = 0; i < plan.totalSections; i++) {
          throwIfAborted(signal);
          setState((prev) => ({ ...prev, currentSectionIndex: i }));
          toast.info(`Generating section ${i + 1} of ${plan.totalSections}...`);

          // Pass all previously generated sections for consistency
          const section = await generateSection(
            provider,
            model,
            messages,
            i,
            plan,
            generatedSections, // Accumulating context from previous sections
            0,
            signal,
          );

          if (!section) {
            throwIfAborted(signal);
            throw new Error(`Failed to generate section ${i + 1}`);
          }

          generatedSections.push(section);
          // Update sections with new array reference to trigger re-renders
          setState((prev) => ({ ...prev, sections: [...generatedSections] }));

          // Callback for progressive rendering
          if (onSectionComplete) {
            onSectionComplete(section, i, plan.totalSections, buildCombinedWidget(generatedSections));
          }

          toast.success(`Section ${i + 1}/${plan.totalSections} complete`);

          // Small delay between sections to avoid rate limits
          if (i < plan.totalSections - 1) {
            await sleep(500, signal);
          }
        }

        const fallbackWidget = buildCombinedWidget(generatedSections);
        let finalWidget = fallbackWidget;

        try {
          throwIfAborted(signal);
          setState((prev) => ({ ...prev, currentStage: 'polishing' }));
          toast.info('Polishing sections into one composition...');
          const polishedWidget = await finalizeComposition(
            provider,
            model,
            plan,
            generatedSections,
            fallbackWidget,
            signal,
          );
          if (polishedWidget) {
            finalWidget = polishedWidget;
          }
        } catch (error: unknown) {
          if (isAbortError(error)) throw error;
          if (import.meta.env.DEV) console.warn('Staged composition polish failed; using combined sections.', error);
          toast.warning('Composition polish could not finish; using the generated sections.');
        }

        setState((prev) => ({
          ...prev,
          currentStage: 'complete',
          isGenerating: false,
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

        if (import.meta.env.DEV) console.error('Staged generation error:', error);
        setState((prev) => ({
          ...prev,
          currentStage: 'error',
          error: error instanceof Error ? error.message : String(error),
          isGenerating: false,
        }));
        return null;
      }
    },
    [createPlan, finalizeComposition, generateSection],
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
      sections: [...updatedSections], // Create new array to ensure reference changes
    }));
  }, []);

  return {
    ...state,
    startStagedGeneration,
    reset,
    updateSections,
  };
}
