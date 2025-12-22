
import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { generateCompletePrompt, generateStructuredPrompt } from '@/lib/prompt-helper-v2';
import { parseJSONSafely, validateWidgetJSON } from '@/lib/json-repair';
import { parseTagBasedResponse, validateParsedWidget } from '@/lib/tag-parser';
import { ERROR_MESSAGES, shouldUseStagedGeneration } from '@/lib/ai-config';
import { useStagedGeneration } from './useStagedGeneration';
import type { ProductSearchResult, Category } from './types';

interface ModelInfo {
  id: string;
  name: string;
  supportsVision?: boolean;
  supportsAudio?: boolean;
  modality?: string;
}

export const useAiGenerator = (aiContext: any, widget: any) => {
  const [promptType, setPromptType] = useState<
    "widget" | "landing-page" | "collection"
  >("widget");
  const [userPrompt, setUserPrompt] = useState("");
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(false);
  const [openRouterModels, setOpenRouterModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [isApiKeySet, setIsApiKeySet] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<{ html: string; css: string; } | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [useStagedMode, setUseStagedMode] = useState(true); // Toggle for staged generation (default: true)

  // Staged generation hook
  const stagedGeneration = useStagedGeneration();


  useEffect(() => {
    fetch("/api/settings/openrouter")
      .then(res => res.json())
      .then(data => {
        if (data.apiKey) {
          setIsApiKeySet(true);
          fetch("/api/openrouter/models")
            .then(res => res.json())
            .then(modelData => {
              const models = modelData.models || [];
              setOpenRouterModels(models);

              // Model preference priority:
              // 1. Widget's saved model (for existing widgets)
              // 2. Global last-used model from localStorage (for new widgets)
              const widgetModel = widget?.aiContext ? JSON.parse(widget.aiContext as string).preferredAiModel : null;
              const globalModel = localStorage.getItem('global_preferred_ai_model');

              if (widgetModel && models.some((m: any) => m.id === widgetModel)) {
                setSelectedModel(widgetModel);
              } else if (globalModel && models.some((m: any) => m.id === globalModel)) {
                setSelectedModel(globalModel);
              }
              // If still no model selected, user must choose
            });
        }
      });
  }, [widget]);

  const handleAiRequest = async () => {
    if (!userPrompt.trim()) {
      toast.error(ERROR_MESSAGES.promptEmpty);
      return;
    }

    if (!selectedModel) {
      toast.error(ERROR_MESSAGES.modelNotSelected);
      return;
    }

    setIsLoadingPrompt(true);
    setGeneratedContent({
      html: '<div class="flex items-center justify-center h-full"><div class="animate-spin rounded-full h-32 w-32 border-t-2 border-b-2 border-gray-900"></div></div>',
      css: ''
    });
    setIsPreviewOpen(true);

    try {
      // 1. Fetch system prompt
      const systemPromptRes = await fetch(`/api/system-prompt?type=${promptType}`);
      if (!systemPromptRes.ok) throw new Error(ERROR_MESSAGES.systemPromptFailed);
      const systemPrompt = await systemPromptRes.text();

      // 2. Fetch context details
      const contextRes = await fetch("/api/context/batch-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: aiContext.selectedProducts.map((p: ProductSearchResult) => p.id),
          categoryIds: aiContext.allCategoriesSelected
            ? undefined
            : aiContext.selectedCategories.map((c: Category) => c.id),
          allCategories: aiContext.allCategoriesSelected,
        }),
      });
      if (!contextRes.ok) throw new Error(ERROR_MESSAGES.contextFetchFailed);
      const contextData = await contextRes.json();

      // 3. Generate structured prompt with caching support
      const currentModel = openRouterModels.find(m => m.id === selectedModel);
      const isVisionModel = currentModel?.supportsVision || false;

      const promptResult = await generateStructuredPrompt({
        systemPrompt,
        userPrompt: userPrompt,
        selectedImages: aiContext.selectedImages,
        selectedProducts: contextData.products || [],
        selectedCategories: contextData.categories || [],
        allCategoriesSelected: aiContext.allCategoriesSelected,
        modelId: selectedModel,
        supportsVision: isVisionModel,
      });

      // 4. Decide: staged vs simple generation
      const useStaged = shouldUseStagedGeneration(
        promptResult.metadata.estimatedTokens * 4,
        useStagedMode
      );

      if (useStaged) {
        // STAGED GENERATION
        const result = await stagedGeneration.startStagedGeneration(
          selectedModel,
          promptResult.messages,
          (section) => {
            // Progressive rendering callback
            setGeneratedContent(prev => ({
              html: (prev?.html || '') + '\n\n' + section.html,
              css: (prev?.css || '') + '\n\n' + section.css,
            }));
          }
        );

        if (result) {
          setGeneratedContent(result);
        } else {
          throw new Error("Staged generation failed");
        }
      } else {
        // SIMPLE GENERATION
        await handleSimpleGeneration(promptResult.messages);
      }

    } catch (error: any) {
      console.error(`Error generating content:`, error);
      toast.error(ERROR_MESSAGES.generationFailed(error.message));
      setIsPreviewOpen(false);
    } finally {
      setIsLoadingPrompt(false);
    }
  };

  const handleSimpleGeneration = async (messages: any[]) => {
    try {
      const response = await fetch("/api/openrouter/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messages,
          model: selectedModel,
          stream: true,
        }),
      });

      if (!response.ok || !response.body) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to generate content.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedJson = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
            // Try tag-based parsing first (primary), then fall back to JSON
            const tagResult = parseTagBasedResponse(accumulatedJson);

            if (tagResult.success && tagResult.data) {
                const validation = validateParsedWidget(tagResult.data);
                if (validation.valid) {
                    setGeneratedContent(tagResult.data);
                } else {
                    console.error("Invalid widget structure:", validation.error);
                    toast.error(`Invalid response: ${validation.error}`);
                    setGeneratedContent({ html: '<p class="text-destructive">Invalid widget structure.</p>', css: '' });
                }
            } else {
                // Fallback to JSON parsing
                const jsonParsed = parseJSONSafely(accumulatedJson);
                if (jsonParsed.success) {
                    const validation = validateWidgetJSON(jsonParsed.data);
                    if (validation.valid) {
                        setGeneratedContent(jsonParsed.data);
                    } else {
                        console.error("Invalid widget structure:", validation.error);
                        toast.error(`Invalid response: ${validation.error}`);
                        setGeneratedContent({ html: '<p class="text-destructive">Invalid widget structure.</p>', css: '' });
                    }
                } else {
                    console.error("Failed to parse response:", tagResult.error, accumulatedJson);
                    toast.error("Failed to parse AI response.");
                    setGeneratedContent({ html: '<p class="text-destructive">Error parsing response.</p>', css: '' });
                }
            }
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        let lineEnd;
        while ((lineEnd = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);

            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                    break;
                }
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices[0].delta.content;
                    if (delta) {
                        accumulatedJson += delta;
                    }
                } catch (e) {
                    // Ignore JSON parse errors on partial data
                }
            }
        }
      }

    } catch (error: any) {
      console.error(`Error generating content:`, error);
      toast.error(`Generation failed: ${error.message}`);
      setIsPreviewOpen(false);
    } finally {
      setIsLoadingPrompt(false);
    }
  };

  const handleCopyPrompt = async () => {
    if (!userPrompt.trim()) {
      toast.error(`Please enter your request first`);
      return;
    }

    const toastId = toast.loading("Preparing standalone prompt...");
    try {
      const systemPromptRes = await fetch(`/api/system-prompt?type=${promptType}`);
      if (!systemPromptRes.ok) throw new Error("Could not fetch system prompt.");
      const systemPrompt = await systemPromptRes.text();

      const contextRes = await fetch("/api/context/batch-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productIds: aiContext.selectedProducts.map((p: ProductSearchResult) => p.id),
          categoryIds: aiContext.allCategoriesSelected
            ? undefined
            : aiContext.selectedCategories.map((c: Category) => c.id),
          allCategories: aiContext.allCategoriesSelected,
        }),
      });
      if (!contextRes.ok) throw new Error("Could not fetch context details.");
      const contextData = await contextRes.json();

      const combinedPrompt = await generateCompletePrompt({
        systemPrompt,
        userPrompt: userPrompt,
        selectedImages: aiContext.selectedImages,
        selectedProducts: contextData.products || [],
        selectedCategories: contextData.categories || [],
        allCategoriesSelected: aiContext.allCategoriesSelected,
      });

      // Add header and footer for standalone use
      const standalonePrompt = `# STANDALONE WIDGET GENERATOR PROMPT

**Instructions**: Copy this entire prompt and paste it into your preferred AI chatbot (ChatGPT, Claude, Gemini, etc.). After receiving the response, copy the \`<htmljs>\` and \`<css>\` sections and paste them back using the "Paste AI Response" button.

═══════════════════════════════════════════════════════════════

${combinedPrompt}

═══════════════════════════════════════════════════════════════

**IMPORTANT**: Your response must use this EXACT format:

<htmljs>
<!-- Your complete HTML code here, including inline JavaScript if needed -->
</htmljs>

<css>
/* Your complete CSS code here */
</css>

Do NOT use markdown code blocks. Do NOT use JSON format. Use ONLY the <htmljs> and <css> tags shown above.
${aiContext.selectedImages.length > 0 ? `\n\n**Note**: ${aiContext.selectedImages.length} image URL(s) provided above. Use them in your HTML.` : ''}`;

      await navigator.clipboard.writeText(standalonePrompt);
      toast.success("Standalone prompt copied! Paste it into any AI chatbot.", { id: toastId });

    } catch (error: any) {
      console.error("Error preparing prompt for copy:", error);
      toast.error(`Failed to copy prompt: ${error.message}`, { id: toastId });
    }
  };

  // Compute generation progress for preview
  const generationProgress = stagedGeneration.plan ? {
    currentStage: stagedGeneration.currentStage === 'planning' ? 'Planning widget structure...' : `Generating section ${stagedGeneration.currentSectionIndex + 1} of ${stagedGeneration.plan.totalSections}`,
    currentSection: stagedGeneration.currentSectionIndex,
    totalSections: stagedGeneration.plan.totalSections,
    percentage: Math.round(((stagedGeneration.currentSectionIndex + (stagedGeneration.currentStage === 'complete' ? 1 : 0)) / stagedGeneration.plan.totalSections) * 100)
  } : undefined;

  return {
    promptType,
    setPromptType,
    userPrompt,
    setUserPrompt,
    isLoadingPrompt,
    handleAiRequest,
    handleCopyPrompt,
    openRouterModels,
    selectedModel,
    setSelectedModel,
    isApiKeySet,
    modelSearchQuery,
    setModelSearchQuery,
    isModelSelectorOpen,
    setIsModelSelectorOpen,
    generatedContent,
    setGeneratedContent,
    isPreviewOpen,
    setIsPreviewOpen,
    useStagedMode,
    setUseStagedMode,
    stagedGeneration,
    generationProgress,
  };
};
