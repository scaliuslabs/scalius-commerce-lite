/**
 * useAiImprover Hook - Manages widget improvement workflow
 *
 * This hook encapsulates all improvement logic including:
 * - Section-specific improvements
 * - Streaming API calls
 * - History tracking
 * - Section merging for staged widgets
 */

import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { generateStructuredPrompt } from '@/lib/prompt-helper-v2';
import { parseJSONSafely, validateWidgetJSON } from '@/lib/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@/lib/tag-parser';
import { ERROR_MESSAGES, SUCCESS_MESSAGES } from '@/lib/ai-config';
import type { ImprovementHistoryEntry } from '@/lib/ai-context-schema';


interface UseAiImproverProps {
  aiContext: any;
  aiGenerator: any;
}

export function useAiImprover({ aiContext, aiGenerator }: UseAiImproverProps) {
  const [contentToImprove, setContentToImprove] = useState<{ html: string; css: string } | null>(null);
  const [isImproving, setIsImproving] = useState(false);
  const [improvementHistory, setImprovementHistory] = useState<ImprovementHistoryEntry[]>([]);
  const [currentImprovementTarget, setCurrentImprovementTarget] = useState<number | undefined>(undefined);
  const [rawOutput, setRawOutput] = useState<string>(''); // Capture raw LLM output for debugging

  /**
   * Main improvement function
   */
  const improve = useCallback(async (prompt: string, targetSection?: number) => {
    const promptToUse = prompt.trim();

    if (!promptToUse || !contentToImprove) {
      toast.error('Please enter your improvement instructions.');
      return false;
    }

    setIsImproving(true);
    setCurrentImprovementTarget(targetSection);

    try {
      // Fetch system prompt
      const systemPromptRes = await fetch(`/api/system-prompt?type=${aiGenerator.promptType}`);
      if (!systemPromptRes.ok) throw new Error(ERROR_MESSAGES.systemPromptFailed);
      const systemPrompt = await systemPromptRes.text();

      // Fetch context details
      const contextRes = await fetch('/api/context/batch-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds: aiContext.selectedProducts.map((p: any) => p.id),
          categoryIds: aiContext.allCategoriesSelected
            ? undefined
            : aiContext.selectedCategories.map((c: any) => c.id),
          allCategories: aiContext.allCategoriesSelected,
        }),
      });
      if (!contextRes.ok) throw new Error(ERROR_MESSAGES.contextFetchFailed);
      const contextData = await contextRes.json();

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
      const historyContext = improvementHistory.length > 0
        ? `\n\nPREVIOUS IMPROVEMENTS:\n${improvementHistory.map((h, i) =>
            `${i + 1}. ${h.section !== undefined ? `Section ${h.section + 1}` : 'Whole widget'}: "${h.prompt}"`
          ).join('\n')}\n\nIMPORTANT: Build upon these previous improvements. Do not revert any of the changes made in the history above.`
        : '';

      // Build other sections context (for awareness when improving specific section)
      let otherSectionsContext = '';
      if (targetSection !== undefined && sections.length > 1) {
        const otherSections = sections
          .map((s: any, idx: number) => {
            if (idx === targetSection) return null; // Skip the target section
            return `Section ${idx + 1}${s.description ? ` (${s.description})` : ''}:\n\`\`\`html\n${s.html}\n\`\`\`\n\`\`\`css\n${s.css || '/* No CSS */'}\n\`\`\``;
          })
          .filter(Boolean);

        if (otherSections.length > 0) {
          otherSectionsContext = `\n\nOTHER SECTIONS CONTEXT (for visual consistency and reference):\nYou are improving Section ${targetSection + 1} of ${sections.length}. Here are the other sections for context:\n\n${otherSections.join('\n\n')}\n\nIMPORTANT: Your improvement should maintain visual consistency with these sections. You can reference their styling and structure, but you should ONLY modify Section ${targetSection + 1}.`;
        }
      }

      // Generate structured prompt for improvement
      const currentModel = aiGenerator.openRouterModels.find((m: any) => m.id === aiGenerator.selectedModel);
      const isVisionModel = currentModel?.supportsVision || false;

      const promptResult = await generateStructuredPrompt({
        systemPrompt,
        improvementPrompt: promptToUse + historyContext + otherSectionsContext,
        existingHtml: codeToImprove.html,
        existingCss: codeToImprove.css,
        selectedImages: aiContext.selectedImages,
        selectedProducts: contextData.products || [],
        selectedCategories: contextData.categories || [],
        allCategoriesSelected: aiContext.allCategoriesSelected,
        modelId: aiGenerator.selectedModel,
        supportsVision: isVisionModel,
        sectionIndex: targetSection,
        totalSections: sections.length,
      });

      // Call API with structured messages
      const response = await fetch('/api/openrouter/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: promptResult.messages,
          model: aiGenerator.selectedModel,
          stream: true,
        }),
      });

      if (!response.ok || !response.body) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to generate content.');
      }

      // Stream and parse response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedJson = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Save raw output for debugging
          setRawOutput(accumulatedJson);
          console.log('=== RAW IMPROVEMENT OUTPUT ===');
          console.log(accumulatedJson);
          console.log('=== END RAW OUTPUT ===');

          // Try tag-based parsing first, then fall back to JSON
          const tagResult = parseTagBasedResponse(accumulatedJson);

          let improvedContent;

          if (tagResult.success && tagResult.data) {
            const validation = validateParsedWidget(tagResult.data);
            if (!validation.valid) {
              console.error('Tag-based validation failed:', validation.error);
              console.error('Parsed data:', tagResult.data);
              throw new Error(`Invalid response: ${validation.error}. Check browser console for raw output.`);
            }
            improvedContent = tagResult.data;
          } else {
            // Fallback to JSON parsing
            const parsed = parseJSONSafely(accumulatedJson);
            if (!parsed.success) {
              console.error('All parsing strategies failed');
              console.error('Tag error:', tagResult.error);
              console.error('JSON error:', parsed.error);
              throw new Error(`Parsing failed: Neither tag-based nor JSON format detected. Check browser console for raw output.`);
            }

            const validation = validateWidgetJSON(parsed.data);
            if (!validation.valid) {
              console.error('JSON validation failed:', validation.error);
              console.error('Parsed data:', parsed.data);
              throw new Error(`Invalid response: ${validation.error}. Check browser console for raw output.`);
            }
            improvedContent = parsed.data;
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

              // Reconstruct full widget using consistent section reconstruction logic
              const combinedHtml = `<div class="widget-container">\n${updatedSections
                .map((s: any, idx: number) => {
                  const sectionHtml = s.html.split('\n').map((line: string) => '    ' + line).join('\n');
                  return `  <div class="widget-section widget-section-${idx + 1}" data-section="${idx + 1}">\n${sectionHtml}\n  </div>`;
                }).join('\n')}\n</div>`;

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
  .widget-container { gap: 1.5rem; }
}

@media (max-width: 480px) {
  .widget-container { gap: 1rem; }
}

/* Section-specific styles */
${updatedSections.map((s, idx) => s.css ? `/* Section ${idx + 1} styles */\n${s.css}` : '').filter(Boolean).join('\n\n')}
`;

              setContentToImprove({ html: combinedHtml, css: combinedCss });

              // Update the staged generation state immutably
              aiGenerator.stagedGeneration.updateSections(updatedSections);

              // Add to improvement history
              setImprovementHistory(prev => [...prev, {
                section: targetSection,
                prompt: promptToUse,
                timestamp: Date.now(),
                modelUsed: aiGenerator.selectedModel,
              }]);

              toast.success(SUCCESS_MESSAGES.sectionImproved(targetSection, sections.length));
            } catch (mergeError: any) {
              console.error('Failed to merge section:', mergeError);
              toast.error(ERROR_MESSAGES.sectionMergeFailed);
              // Fallback: just show the improved section
              setContentToImprove(improvedContent);
            }
          } else {
            // Whole widget improvement
            setContentToImprove(improvedContent);

            // Add to improvement history
            setImprovementHistory(prev => [...prev, {
              prompt: promptToUse,
              timestamp: Date.now(),
              modelUsed: aiGenerator.selectedModel,
            }]);

            toast.success(SUCCESS_MESSAGES.improved);
          }
          break;
        }

        // Stream parsing logic
        buffer += decoder.decode(value, { stream: true });
        let lineEnd;
        while ((lineEnd = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);

          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') break;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices[0].delta.content;
              if (delta) accumulatedJson += delta;
            } catch (e) {
              // Ignore partial JSON errors
            }
          }
        }
      }

      return true;
    } catch (error: any) {
      console.error('Error improving content:', error);
      toast.error(ERROR_MESSAGES.generationFailed(error.message));
      return false;
    } finally {
      setIsImproving(false);
      setCurrentImprovementTarget(undefined);
    }
  }, [contentToImprove, aiContext, aiGenerator, improvementHistory]);

  /**
   * Initialize improvement session with content
   */
  const startImprovement = useCallback((content: { html: string; css: string }) => {
    setContentToImprove(content);
    setImprovementHistory([]);
  }, []);

  /**
   * Reset improvement state
   */
  const reset = useCallback(() => {
    setContentToImprove(null);
    setImprovementHistory([]);
    setIsImproving(false);
    setCurrentImprovementTarget(undefined);
    setRawOutput('');
  }, []);

  /**
   * Load improvement history (e.g., from saved aiContext)
   */
  const loadHistory = useCallback((history: ImprovementHistoryEntry[]) => {
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
    loadHistory,
    setContentToImprove,
  };
}
