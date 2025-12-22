import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { parseJSONSafely, validateWidgetJSON } from '@/lib/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@/lib/tag-parser';

interface GenerationPlan {
  totalSections: number;
  sectionDescriptions: string[];
  estimatedTokens?: number;
}

interface SectionContent {
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

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * Step 1: Ask LLM to create a generation plan
   */
  const createPlan = useCallback(async (
    model: string,
    messages: any[]
  ): Promise<GenerationPlan | null> => {
    const planningPrompt = {
      role: "user",
      content: `Before generating the widget, create a plan. Analyze the request and respond with a JSON object containing:
{
  "totalSections": <number of self-contained HTML sections needed>,
  "sectionDescriptions": [<array of brief descriptions for each section>],
  "estimatedTokens": <estimated total tokens if you can estimate>
}

Guidelines:
- Each section should be a complete, standalone HTML div with inline CSS and inline JavaScript
- Sections will be rendered progressively, so plan accordingly
- Typical sections: hero/header, content blocks, CTA, footer
- For simple widgets: 1-2 sections. For complex: 3-6 sections max
- Keep each section under 1500 tokens if possible

Respond ONLY with the JSON object, no markdown formatting.`,
    };

    try {
      const response = await fetch("/api/openrouter/generate-staged", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [...messages, planningPrompt],
          stage: 'plan',
          useCache: true,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to create plan");
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content;

      if (!content) {
        throw new Error("No content in plan response");
      }

      const parsed = parseJSONSafely(content);
      if (!parsed.success) {
        throw new Error(parsed.error || "Failed to parse plan JSON");
      }

      const plan = parsed.data;

      // Validate plan structure
      if (!plan.totalSections || !Array.isArray(plan.sectionDescriptions)) {
        throw new Error("Invalid plan structure");
      }

      if (plan.totalSections !== plan.sectionDescriptions.length) {
        throw new Error("Plan section count mismatch");
      }

      return plan;
    } catch (error: any) {
      console.error("Error creating plan:", error);
      toast.error(`Planning failed: ${error.message}`);
      return null;
    }
  }, []);

  /**
   * Step 2: Generate a specific section with full conversation history
   */
  const generateSection = useCallback(async (
    model: string,
    messages: any[],
    sectionIndex: number,
    sectionDescription: string,
    totalSections: number,
    previousSections: SectionContent[],
    retryAttempt = 0
  ): Promise<SectionContent | null> => {
    // Build context from previous sections
    let previousContext = '';
    if (previousSections.length > 0) {
      previousContext = '\n\nPREVIOUS SECTIONS YOU GENERATED:\n' +
        previousSections.map((sec, idx) =>
          `Section ${idx + 1}:\n<htmljs>\n${sec.html}\n</htmljs>\n\n<css>\n${sec.css}\n</css>`
        ).join('\n\n') +
        '\n\nIMPORTANT: Maintain the SAME design language, colors, typography, and style as the previous sections.';
    }

    const sectionPrompt = {
      role: "user",
      content: `Generate section ${sectionIndex + 1} of ${totalSections}.

Section Description: ${sectionDescription}${previousContext}

Requirements:
- Use tag-based format with <htmljs> and <css> tags
- HTML must be a complete, self-contained <div> with inline JavaScript if needed
- CSS should be scoped to this section
- This section will be combined with others, so use unique IDs/classes
- CRITICAL: Match the visual style, colors, fonts, and design of previous sections for consistency

${sectionIndex > 0 ? 'Note: Continue the design system from previous sections.' : 'Note: This is the first section - establish a cohesive design system!'}

Respond with the section code in tag format.`,
    };

    try {
      const response = await fetch("/api/openrouter/generate-staged", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [...messages, sectionPrompt],
          stage: 'generate',
          sectionIndex,
          totalSections,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content;

      if (!content) {
        throw new Error("No content in response");
      }

      // Try tag-based parsing first, then fall back to JSON
      const tagResult = parseTagBasedResponse(content);

      let widgetData;

      if (tagResult.success && tagResult.data) {
        const validation = validateParsedWidget(tagResult.data);
        if (!validation.valid) {
          throw new Error(validation.error || "Invalid widget structure");
        }
        widgetData = tagResult.data;
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
        widgetData = parsed.data;
      }

      return {
        html: widgetData.html,
        css: widgetData.css || '',
        sectionIndex,
        description: sectionDescription,
        id: `section-${sectionIndex}-${Date.now()}`,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      console.error(`Error generating section ${sectionIndex}:`, error);

      // Retry logic with exponential backoff
      if (retryAttempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, retryAttempt);
        toast.info(`Retrying section ${sectionIndex + 1} in ${delay / 1000}s...`);
        await sleep(delay);
        return generateSection(model, messages, sectionIndex, sectionDescription, totalSections, previousSections, retryAttempt + 1);
      }

      toast.error(`Failed to generate section ${sectionIndex + 1}: ${error.message}`);
      return null;
    }
  }, []);

  /**
   * Main generation orchestrator
   */
  const startStagedGeneration = useCallback(async (
    model: string,
    messages: any[],
    onSectionComplete?: (section: SectionContent, index: number, total: number) => void
  ): Promise<{ html: string; css: string } | null> => {
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
      const plan = await createPlan(model, messages);

      if (!plan) {
        throw new Error("Failed to create generation plan");
      }

      setState(prev => ({ ...prev, plan, currentStage: 'generating' }));
      toast.success(`Plan created: ${plan.totalSections} sections`);

      // Phase 2: Generate each section with accumulated context
      const generatedSections: SectionContent[] = [];

      for (let i = 0; i < plan.totalSections; i++) {
        setState(prev => ({ ...prev, currentSectionIndex: i }));
        toast.info(`Generating section ${i + 1} of ${plan.totalSections}...`);

        // Pass all previously generated sections for consistency
        const section = await generateSection(
          model,
          messages,
          i,
          plan.sectionDescriptions[i],
          plan.totalSections,
          generatedSections  // Accumulating context from previous sections
        );

        if (!section) {
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
          await sleep(500);
        }
      }

      // Phase 3: Combine all sections with proper spacing
      const combinedHtml = `<div class="widget-container">\n${generatedSections.map((s, idx) => `  <div class="widget-section widget-section-${idx + 1}" data-section="${idx + 1}">\n    ${s.html.split('\n').map(line => '    ' + line).join('\n')}\n  </div>`).join('\n')}\n</div>`;

      const combinedCss = `
/* Widget Container Spacing */
.widget-container {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  width: 100%;
}

.widget-section {
  width: 100%;
}

/* Mobile Responsive Spacing */
@media (max-width: 768px) {
  .widget-container {
    gap: 1.5rem;
  }
}

@media (max-width: 480px) {
  .widget-container {
    gap: 1rem;
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
    } catch (error: any) {
      console.error("Staged generation error:", error);
      setState(prev => ({
        ...prev,
        currentStage: 'error',
        error: error.message,
        isGenerating: false,
      }));
      toast.error(`Generation failed: ${error.message}`);
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
    console.log('Updating sections:', updatedSections.length, 'sections');
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
