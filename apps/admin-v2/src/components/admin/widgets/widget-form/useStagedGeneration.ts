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
  currentStage: 'idle' | 'planning' | 'generating' | 'complete' | 'error';
  plan: GenerationPlan | null;
  sections: SectionContent[];
  currentSectionIndex: number;
  error: string | null;
  retryCount: number;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const PREVIOUS_SECTION_CONTEXT_LIMIT = 6000;
const SECTION_GAP_CSS = "clamp(0.75rem, 1.8vw, 1.35rem)";

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
      if (typeof message.content === "string") return message.content;
      return message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
    })
    .join("\n");
}

function removeWidgetOutputInstructions(text: string): string {
  const outputStart = text.indexOf("RESPONSE FORMAT - USE SIMPLE TAGS:");
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
      role: "user",
      content: `${planningContext}

Before generating the widget, create a concise implementation plan. Respond with ONLY a JSON object in this shape:
{
  "totalSections": <number of self-contained HTML sections needed>,
  "sectionDescriptions": [<brief description for each section>],
  "estimatedTokens": <optional estimated total tokens>
}

Guidelines:
- Choose section count by destination:
  - Homepage widget: usually 2-4 cohesive bands such as offer/category signal, featured products or categories, trust/urgency, and CTA.
  - Landing section set: usually 4-6 campaign bands such as hero/offer, product or collection showcase, proof, objection handling, urgency, and final CTA.
  - Collection section: usually 2-4 practical merchandising bands such as collection intro, product grid/comparison, buying guide, and CTA/trust strip.
- Plan the output as ONE continuous composition. Section descriptions must state each section's role in that flow, not isolated ideas.
- Each section must be a complete, standalone HTML div with CSS-only interactions.
- Every section must share one visual system: color tokens, typography, image treatment, button style, radius scale, and spacing rhythm.
- Avoid huge vertical gaps. Root section wrappers should not rely on large top/bottom margins or spacer blocks.
- Do not include HTML, CSS, markdown, comments, or explanations in this planning response.
- The sectionDescriptions array length must equal totalSections.`,
    },
  ];
}

function createDeterministicPlan(messages: PromptMessage[]): GenerationPlan {
  const promptText = textFromMessages(messages).toLowerCase();
  const wantsCollection =
    promptText.includes("collection page designer") ||
    promptText.includes("collection section") ||
    promptText.includes("collection") ||
    promptText.includes("products") ||
    promptText.includes("product grid");
  const wantsLanding =
    promptText.includes("landing page designer") ||
    promptText.includes("landing") ||
    promptText.includes("campaign");
  const wantsHomepage =
    promptText.includes("homepage widget designer") ||
    promptText.includes("homepage");
  const totalSections = wantsLanding ? 4 : wantsHomepage || wantsCollection ? 3 : 2;
  const sectionDescriptions = wantsLanding
    ? [
        "Campaign hero/offer that establishes the shared visual system",
        "Product or collection showcase that continues the hero rhythm",
        "Proof, benefits, or objection handling using the same design language",
        "Final conversion CTA with tight spacing from the prior section",
      ]
    : wantsHomepage
      ? [
          "Homepage offer/category signal that establishes the visual system",
          "Featured product or collection discovery band",
          "Trust, urgency, or CTA band that closes the homepage widget",
        ]
    : wantsCollection
    ? [
        "Collection intro with the core merchandising promise",
        "Product or category comparison using the provided storefront context",
        "Trust, urgency, and call-to-action strip connected to the product grid",
      ]
      : [
          "Primary promotional section",
          "Supporting call-to-action section",
        ];

  return {
    totalSections,
    sectionDescriptions: sectionDescriptions.slice(0, totalSections),
  };
}

function compactPreviousSections(previousSections: SectionContent[]): string {
  if (previousSections.length === 0) return "";

  const newestFirst = [...previousSections].reverse();
  const snippets: string[] = [];
  let usedChars = 0;

  for (const section of newestFirst) {
    const snippet = `Section ${section.sectionIndex + 1}${section.description ? ` (${section.description})` : ""}:
HTML summary:
${section.html.slice(0, 900)}

CSS summary:
${section.css.slice(0, 900) || "No CSS"}`;
    if (usedChars + snippet.length > PREVIOUS_SECTION_CONTEXT_LIMIT) break;
    snippets.unshift(snippet);
    usedChars += snippet.length;
  }

  if (snippets.length === 0) return "";

  return `\n\nPREVIOUS SECTIONS CONTEXT:
${snippets.join("\n\n")}

IMPORTANT: Maintain the same design language, color rhythm, spacing, typography, and CTA style. Do not copy previous sections verbatim.`;
}

function describePlan(planDescriptions: string[]): string {
  return planDescriptions
    .map((description, index) => `${index + 1}. ${description}`)
    .join("\n");
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
        "abort",
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
  const createPlan = useCallback(async (
    provider: string,
    model: string,
    messages: PromptMessage[],
    signal?: AbortSignal,
  ): Promise<GenerationPlan | null> => {
    try {
      throwIfAborted(signal);
      const response = await fetch("/api/v1/admin/ai/generate-staged", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        throw new Error(
          await readApiErrorMessage(response, "Failed to create plan"),
        );
      }

      const content = extractChatCompletionContent(await response.json());

      const parsed = parseJSONSafely(content);
      if (!parsed.success) {
        throw new Error(parsed.error || "Failed to parse plan JSON");
      }

      const plan = parsed.data as GenerationPlan;

      // Validate plan structure
      if (!plan.totalSections || !Array.isArray(plan.sectionDescriptions)) {
        throw new Error("Invalid plan structure");
      }

      if (plan.totalSections !== plan.sectionDescriptions.length) {
        throw new Error("Plan section count mismatch");
      }

      if (
        plan.totalSections < GENERATION_CONFIG.stagedGeneration.minSections ||
        plan.totalSections > GENERATION_CONFIG.stagedGeneration.maxSections
      ) {
        throw new Error(
          `Plan requested ${plan.totalSections} sections. Use ${GENERATION_CONFIG.stagedGeneration.minSections}-${GENERATION_CONFIG.stagedGeneration.maxSections} sections.`,
        );
      }

      plan.sectionDescriptions = plan.sectionDescriptions.map((description, index) =>
        String(description || `Section ${index + 1}`).slice(0, 160),
      );

      return plan;
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      if (import.meta.env.DEV) console.error("Error creating staged generation plan:", error);
      return null;
    }
  }, []);

  /**
   * Step 2: Generate a specific section with full conversation history
   */
  const generateSection = useCallback(async (
    provider: string,
    model: string,
    messages: PromptMessage[],
    sectionIndex: number,
    sectionDescription: string,
    allSectionDescriptions: string[],
    totalSections: number,
    previousSections: SectionContent[],
    retryAttempt = 0,
    signal?: AbortSignal,
  ): Promise<SectionContent | null> => {
    throwIfAborted(signal);

    const previousContext = compactPreviousSections(previousSections);
    const planOutline = describePlan(allSectionDescriptions);

    const sectionPrompt = {
      role: "user",
      content: `Generate section ${sectionIndex + 1} of ${totalSections}.

Overall flow so far:
${planOutline}

Current Section Role: ${sectionDescription}${previousContext}

Requirements:
- Use tag-based format with <htmljs> and <css> tags
- HTML must be a complete, self-contained <div> with no JavaScript or script tags
- CSS should be scoped to this section
- This section will be combined with others, so use unique IDs/classes
- CRITICAL: Match the visual style, colors, fonts, and design of previous sections for consistency
- CRITICAL: This section sits directly next to the other generated sections. Do not add large margin-top, margin-bottom, min-height, empty spacer divs, or unrelated visual resets.
- Use internal padding for section content. Root section wrappers should usually use margin: 0 and box-sizing: border-box.
- Keep CTAs, card treatments, image crops, and typography aligned with the overall flow.

${sectionIndex > 0 ? 'Note: Continue the design system from previous sections.' : 'Note: This is the first section - establish a cohesive design system!'}

Respond with the section code in tag format.`,
    };

    try {
      const response = await fetch("/api/v1/admin/ai/generate-staged", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          provider,
          model,
          messages: [...messages, sectionPrompt],
          stage: 'generate',
          sectionIndex,
          totalSections,
        }),
      });

      if (!response.ok) {
        throw new Error(
          await readApiErrorMessage(response, `HTTP ${response.status}`),
        );
      }

      const content = extractChatCompletionContent(await response.json());

      // Try tag-based parsing first, then fall back to JSON
      const tagResult = parseTagBasedResponse(content);

      let widgetData;

      if (tagResult.success && tagResult.data) {
        const validation = validateParsedWidget(tagResult.data);
        if (!validation.valid) {
          throw new Error(validation.error || "Invalid widget structure");
        }
        widgetData = tagResult.data as { html: string; css: string };
      } else {
        // Fallback to JSON parsing
        const parsed = parseJSONSafely(content);
        if (!parsed.success) {
          throw new Error(parsed.error || "Failed to parse response");
        }

        const validation = validateWidgetJSON(parsed.data);
        if (!validation.valid) {
          throw new Error(validation.error || "Invalid widget structure");
        }
        widgetData = parsed.data as { html: string; css: string };
      }

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
          sectionDescription,
          allSectionDescriptions,
          totalSections,
          previousSections,
          retryAttempt + 1,
          signal,
        );
      }

      toast.error(`Failed to generate section ${sectionIndex + 1}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }, []);

  /**
   * Main generation orchestrator
   */
  const startStagedGeneration = useCallback(async (
    provider: string,
    model: string,
    messages: PromptMessage[],
    onSectionComplete?: (section: SectionContent, index: number, total: number) => void,
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
      toast.info("Planning widget structure...");
      const plan = await createPlan(provider, model, messages, signal)
        ?? createDeterministicPlan(messages);

      setState(prev => ({ ...prev, plan, currentStage: 'generating' }));

      // Phase 2: Generate each section with accumulated context
      const generatedSections: SectionContent[] = [];

      for (let i = 0; i < plan.totalSections; i++) {
        throwIfAborted(signal);
        setState(prev => ({ ...prev, currentSectionIndex: i }));
        toast.info(`Generating section ${i + 1} of ${plan.totalSections}...`);

        // Pass all previously generated sections for consistency
        const section = await generateSection(
          provider,
          model,
          messages,
          i,
          plan.sectionDescriptions[i],
          plan.sectionDescriptions,
          plan.totalSections,
          generatedSections,  // Accumulating context from previous sections
          0,
          signal,
        );

        if (!section) {
          throwIfAborted(signal);
          throw new Error(`Failed to generate section ${i + 1}`);
        }

        generatedSections.push(section);
        // Update sections with new array reference to trigger re-renders
        setState(prev => ({ ...prev, sections: [...generatedSections] }));

        // Callback for progressive rendering
        if (onSectionComplete) {
          onSectionComplete(section, i, plan.totalSections);
        }

        toast.success(`Section ${i + 1}/${plan.totalSections} complete`);

        // Small delay between sections to avoid rate limits
        if (i < plan.totalSections - 1) {
          await sleep(500, signal);
        }
      }

      // Phase 3: Combine all sections with modest spacing. Generated sections
      // own their internal padding; the wrapper should not create dead zones.
      const combinedHtml = `<div class="widget-container">\n${generatedSections.map((s, idx) => `  <div class="widget-section widget-section-${idx + 1}" data-section="${idx + 1}">\n    ${s.html.split('\n').map(line => '    ' + line).join('\n')}\n  </div>`).join('\n')}\n</div>`;

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

/* Mobile Responsive Spacing */
@media (max-width: 768px) {
  .widget-container {
    gap: 1rem;
  }
}

@media (max-width: 480px) {
  .widget-container {
    gap: 0.75rem;
  }
}

/* Section-specific styles */
${generatedSections.map((s, idx) => s.css ? `/* Section ${idx + 1} styles */\n${s.css}` : '').filter(Boolean).join('\n\n')}
`;

      setState(prev => ({ ...prev, currentStage: 'complete', isGenerating: false }));
      toast.success("Widget generation complete!");

      return {
        html: combinedHtml,
        css: combinedCss,
      };
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

      if (import.meta.env.DEV) console.error("Staged generation error:", error);
      setState(prev => ({
        ...prev,
        currentStage: 'error',
        error: (error instanceof Error ? error.message : String(error)),
        isGenerating: false,
      }));
      return null;
    }
  }, [createPlan, generateSection]);

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
    setState(prev => ({
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
