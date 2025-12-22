/**
 * WidgetForm (Refactored) - Clean, maintainable widget creation/editing form
 *
 * Major improvements:
 * - Uses Zod schema for type-safe aiContext
 * - Extracted improvement logic to useAiImprover hook
 * - Unified FullScreenEditor (replaces two modal components)
 * - Persistent improvement history in aiContext
 * - HTML parsing for non-staged widgets
 * - No localStorage usage
 * - Cleaner, more maintainable code
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { WidgetPlacementRule, type Widget, type Collection } from '@/db/schema';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { ArrowLeft, Clock } from 'lucide-react';
import { parseAiContext, serializeAiContext, type AiContext } from '@/lib/ai-context-schema';
import { parseHtmlIntoSections } from '@/lib/html-section-parser';
import { useAiContext } from './widget-form/useAiContext';
import { useAiGenerator } from './widget-form/useAiGenerator';
import { useAiImprover } from './widget-form/useAiImprover';
import { AiAssistant } from './widget-form/AiAssistant';
import { WidgetDetails } from './widget-form/WidgetDetails';
import { WidgetPlacement } from './widget-form/WidgetPlacement';
import { FullScreenEditor, type EditorMode } from './widget-form/FullScreenEditor';
import { WidgetHistoryModal } from './widget-form/WidgetHistoryModal';
import { WidgetPasteModal } from './widget-form/WidgetPasteModal';

const widgetFormSchema = z.object({
  name: z.string().min(3, 'Widget name must be at least 3 characters long.'),
  htmlContent: z.string().min(1, 'HTML content cannot be empty.'),
  cssContent: z.string().optional(),
  isActive: z.boolean().default(true),
  displayTarget: z.enum(['homepage']).default('homepage'),
  placementRule: z.enum([
    WidgetPlacementRule.BEFORE_COLLECTION,
    WidgetPlacementRule.AFTER_COLLECTION,
    WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
    WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE,
    WidgetPlacementRule.STANDALONE,
  ]),
  referenceCollectionId: z.string().optional().nullable(),
  sortOrder: z.coerce.number().int().default(0),
}).refine(
  (data) => {
    if (
      (data.placementRule === WidgetPlacementRule.BEFORE_COLLECTION ||
        data.placementRule === WidgetPlacementRule.AFTER_COLLECTION) &&
      !data.referenceCollectionId
    ) {
      return false;
    }
    return true;
  },
  {
    message: 'A collection must be selected for "Before Collection" or "After Collection" placement.',
    path: ['referenceCollectionId'],
  }
);

export type WidgetFormValues = z.infer<typeof widgetFormSchema>;

interface WidgetFormProps {
  widget?: Widget | null;
  isCreateMode: boolean;
  availableCollections: Pick<Collection, 'id' | 'name' | 'type'>[];
  placementRules: WidgetPlacementRule[];
  submitButtonText: string;
}

export const WidgetForm: React.FC<WidgetFormProps> = ({
  widget,
  isCreateMode,
  availableCollections,
  placementRules,
  submitButtonText,
}) => {
  const {
    control,
    handleSubmit,
    register,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<WidgetFormValues>({
    resolver: zodResolver(widgetFormSchema) as any,
    defaultValues: widget && !isCreateMode
      ? {
          name: widget.name,
          htmlContent: widget.htmlContent,
          cssContent: widget.cssContent || undefined,
          isActive: widget.isActive,
          displayTarget: widget.displayTarget as 'homepage',
          placementRule: widget.placementRule as WidgetPlacementRule,
          referenceCollectionId: widget.referenceCollectionId,
          sortOrder: widget.sortOrder,
        }
      : {
          name: '',
          htmlContent: '',
          cssContent: undefined,
          isActive: true,
          displayTarget: 'homepage',
          placementRule: WidgetPlacementRule.STANDALONE, // Default to shortcode
          referenceCollectionId: null,
          sortOrder: 0,
        },
  });

  // Version history state
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<any | null>(null);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);

  // Editor state
  const [editorMode, setEditorMode] = useState<EditorMode>('generation-preview');
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  // Initialize hooks
  const aiContext = useAiContext();
  const aiGenerator = useAiGenerator(aiContext, widget);
  const aiImprover = useAiImprover({ aiContext, aiGenerator });

  // Load saved AI context from widget
  useEffect(() => {
    if (widget?.aiContext) {
      try {
        const context = parseAiContext(widget.aiContext as string);

        if (context.promptType) aiGenerator.setPromptType(context.promptType);
        if (context.preferredAiModel) aiGenerator.setSelectedModel(context.preferredAiModel);
        if (typeof context.useStagedMode === 'boolean') aiGenerator.setUseStagedMode(context.useStagedMode);
        if (context.savedImages) aiContext.handleMultiImageSelect(context.savedImages);
        if (context.savedProducts) context.savedProducts.forEach((p: any) => aiContext.handleProductSelect(p));
        if (context.savedCategories) context.savedCategories.forEach((c: any) => aiContext.handleCategorySelect(c));
        if (typeof context.allCategoriesSelected === 'boolean') {
          aiContext.handleToggleAllCategories(context.allCategoriesSelected);
        }

        // Load improvement history
        if (context.improvementHistory) {
          aiImprover.loadHistory(context.improvementHistory);
        }

        // Load staged sections if available
        if (context.stagedSections && context.stagedSections.length > 0) {
          aiGenerator.stagedGeneration.updateSections(context.stagedSections);
        }

        toast.info('Loaded saved AI context for this widget.');
      } catch (e) {
        console.error('Failed to parse widget AI context', e);
      }
    }
  }, [widget]);

  // Auto-open fullscreen when generation starts
  useEffect(() => {
    if (aiGenerator.isLoadingPrompt) {
      // Generation started - open fullscreen immediately
      setEditorMode('generation-preview');
      setIsEditorOpen(true);
    }
  }, [aiGenerator.isLoadingPrompt]);

  // Keep editor open even when content updates
  useEffect(() => {
    if (aiGenerator.generatedContent && !isEditorOpen) {
      setEditorMode('generation-preview');
      setIsEditorOpen(true);
    }
  }, [aiGenerator.generatedContent]);

  /**
   * Accept generated content from preview
   */
  const handleAcceptPreview = () => {
    if (aiGenerator.generatedContent) {
      setValue('htmlContent', aiGenerator.generatedContent.html);
      setValue('cssContent', aiGenerator.generatedContent.css);
      toast.success('Content applied to the form.');
    }
    setIsEditorOpen(false);
    aiGenerator.setGeneratedContent(null);
  };

  /**
   * Request improvement (switch to improvement mode)
   */
  const handleRequestImprovement = () => {
    if (aiGenerator.generatedContent) {
      // Initialize improver with current content
      aiImprover.startImprovement(aiGenerator.generatedContent);

      // If no staged sections, parse HTML into sections
      if (aiGenerator.stagedGeneration.sections.length === 0) {
        const parsedSections = parseHtmlIntoSections(
          aiGenerator.generatedContent.html,
          aiGenerator.generatedContent.css
        );
        // Convert ParsedSection[] to SectionContent[] format
        const convertedSections = parsedSections.map(s => ({
          html: s.html,
          css: s.css,
          sectionIndex: s.index,
          description: s.description,
          id: s.id,
          timestamp: s.timestamp,
        }));
        aiGenerator.stagedGeneration.updateSections(convertedSections);
        toast.info(`Detected ${parsedSections.length} section(s) in your widget.`);
      }

      setEditorMode('improvement');
      // Editor stays open, just switches mode
    }
  };

  /**
   * Accept improved content
   */
  const handleAcceptImprovement = () => {
    if (aiImprover.contentToImprove) {
      setValue('htmlContent', aiImprover.contentToImprove.html);
      setValue('cssContent', aiImprover.contentToImprove.css);
      toast.success('Improved content applied to the form.');
    }
    setIsEditorOpen(false);
    aiImprover.reset();
  };

  /**
   * Show preview of current form content (not AI generated)
   */
  const handleShowPreview = () => {
    const html = watch('htmlContent');
    const css = watch('cssContent');

    if (!html || html.trim().length === 0) {
      toast.error('No content to preview. Add HTML content first.');
      return;
    }

    // Clear any AI-generated content to avoid confusion
    aiGenerator.setGeneratedContent(null);

    // Set temporary preview content
    setEditorMode('live-preview');
    setIsEditorOpen(true);

    // Use a separate state or pass directly to editor
    // For now, we'll set generated content but in live-preview mode
    aiGenerator.setGeneratedContent({ html, css: css || '' });
  };

  /**
   * Improve existing widget content (from form fields)
   */
  const handleImproveExisting = () => {
    const html = watch('htmlContent');
    const css = watch('cssContent');

    if (!html || html.trim().length === 0) {
      toast.error('No content to improve. Add HTML content first.');
      return;
    }

    // Initialize improver with current form content
    const existingContent = { html, css: css || '' };
    aiImprover.startImprovement(existingContent);

    // Parse HTML into sections if not already staged
    const parsedSections = parseHtmlIntoSections(html, css || '');
    const convertedSections = parsedSections.map(s => ({
      html: s.html,
      css: s.css,
      sectionIndex: s.index,
      description: s.description,
      id: s.id,
      timestamp: s.timestamp,
    }));

    // Update staged generation state with parsed sections
    aiGenerator.stagedGeneration.updateSections(convertedSections);

    toast.info(`Detected ${parsedSections.length} section(s) in your widget.`);

    // Open improvement editor
    setEditorMode('improvement');
    setIsEditorOpen(true);
  };

  /**
   * Handle paste from modal
   */
  const handlePaste = (content: { html: string; css: string }) => {
    setValue('htmlContent', content.html);
    setValue('cssContent', content.css);
  };

  /**
   * Version history handlers
   */
  const openHistory = async () => {
    if (widget?.id) {
      setIsHistoryOpen(true);
      const response = await fetch(`/api/widgets/${widget.id}/history`);
      const data = await response.json();
      setHistory(data);
    }
  };

  const handleRestore = async (historyId: string) => {
    if (!widget?.id) return;
    try {
      const response = await fetch(`/api/widgets/${widget.id}/history/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ historyId }),
      });
      if (response.ok) {
        toast.success('Version restored successfully! The page will now reload.');
        setTimeout(() => window.location.reload(), 1500);
      } else {
        throw new Error('Failed to restore version.');
      }
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  const handleDeleteHistory = async (historyId: string) => {
    if (!widget?.id) return;
    try {
      const response = await fetch(`/api/widgets/${widget.id}/history/${historyId}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        toast.success('Version deleted successfully!');
        setHistory(prev => prev.filter(h => h.id !== historyId));
        if (selectedHistoryItem?.id === historyId) {
          setSelectedHistoryItem(null);
        }
      } else {
        throw new Error('Failed to delete version.');
      }
    } catch (error: any) {
      toast.error(error.message);
    }
  };

  /**
   * Form submission with AI context persistence
   */
  const onSubmit = async (data: WidgetFormValues) => {
    const apiUrl = isCreateMode ? '/api/widgets' : `/api/widgets/${widget?.id}`;
    const method = isCreateMode ? 'POST' : 'PUT';

    // Build AI context with all state
    const contextToSave: Partial<AiContext> = {
      promptType: aiGenerator.promptType,
      preferredAiModel: aiGenerator.selectedModel,
      useStagedMode: aiGenerator.useStagedMode,
      savedImages: aiContext.selectedImages,
      savedProducts: aiContext.selectedProducts,
      savedCategories: aiContext.selectedCategories,
      allCategoriesSelected: aiContext.allCategoriesSelected,
      stagedPlan: aiGenerator.stagedGeneration.plan || undefined,
      stagedSections: aiGenerator.stagedGeneration.sections,
      improvementHistory: aiImprover.improvementHistory,
      createdAt: widget?.aiContext ? parseAiContext(widget.aiContext as string).createdAt : Date.now(),
    };

    const submissionData = {
      ...data,
      aiContext: serializeAiContext(contextToSave),
    };

    try {
      const response = await fetch(apiUrl, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submissionData),
      });

      if (response.ok) {
        toast.success(`Widget ${isCreateMode ? 'created' : 'updated'} successfully!`);
        setTimeout(() => {
          window.location.href = '/admin/widgets';
        }, 1000);
      } else {
        const errorData = await response.json().catch(() => ({ message: 'An unexpected error occurred.' }));
        toast.error(errorData.message || `Failed to ${isCreateMode ? 'create' : 'update'} widget.`);
      }
    } catch (error: any) {
      toast.error('An error occurred during submission.');
    }
  };

  // Compute sections for editor - updates whenever sections or plan changes
  const sections = useMemo(() => {
    const stagedSections = aiGenerator.stagedGeneration.sections;
    const plan = aiGenerator.stagedGeneration.plan;

    if (stagedSections.length > 0) {
      return stagedSections.map((s, idx) => ({
        index: idx,
        html: s.html,
        css: s.css,
        description: plan?.sectionDescriptions?.[idx] || `Section ${idx + 1}`,
      }));
    }
    return [];
  }, [
    aiGenerator.stagedGeneration.sections,
    aiGenerator.stagedGeneration.plan,
    aiGenerator.stagedGeneration.sections.length, // Force update when length changes
  ]);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {isCreateMode ? 'Create New Widget' : 'Edit Widget'}
          </h1>
          <p className="text-muted-foreground mt-1">
            {isCreateMode ? 'Add a new dynamic content block to your site.' : `Editing "${widget?.name}"`}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href="/admin/widgets">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to List
          </a>
        </Button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <AiAssistant widget={widget} aiContext={aiContext} aiGenerator={aiGenerator} />

        <WidgetDetails
          register={register}
          errors={errors}
          handleShowPreview={handleShowPreview}
          onPaste={() => setIsPasteModalOpen(true)}
          onImproveExisting={handleImproveExisting}
        />

        <WidgetPlacement
          control={control}
          errors={errors}
          watch={watch}
          register={register}
          availableCollections={availableCollections}
          placementRules={placementRules}
        />

        <div className="flex justify-end gap-2">
          {!isCreateMode && (
            <Button type="button" variant="outline" onClick={openHistory}>
              <Clock className="mr-2 h-4 w-4" /> Version History
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : submitButtonText}
          </Button>
        </div>
      </form>

      {/* Unified Full Screen Editor */}
      <FullScreenEditor
        isOpen={isEditorOpen}
        onClose={() => {
          setIsEditorOpen(false);
          // Clear generated content if in live-preview mode to avoid conflicts
          if (editorMode === 'live-preview') {
            aiGenerator.setGeneratedContent(null);
          }
        }}
        content={editorMode === 'improvement' ? aiImprover.contentToImprove : aiGenerator.generatedContent}
        rawOutput={editorMode === 'improvement' ? aiImprover.rawOutput : undefined}
        mode={editorMode}
        onAccept={
          editorMode === 'improvement'
            ? handleAcceptImprovement
            : editorMode === 'live-preview'
            ? () => {
                toast.info('Already in the form.');
                setIsEditorOpen(false);
              }
            : handleAcceptPreview
        }
        onImprove={editorMode === 'improvement' ? aiImprover.improve : undefined}
        onRequestImprovement={editorMode === 'generation-preview' ? handleRequestImprovement : undefined}
        isProcessing={editorMode === 'improvement' ? aiImprover.isImproving : aiGenerator.isLoadingPrompt}
        processingProgress={aiGenerator.generationProgress}
        aiContext={aiContext}
        promptType={aiGenerator.promptType}
        setPromptType={aiGenerator.setPromptType}
        sections={editorMode === 'improvement' || editorMode === 'generation-preview' ? sections : []}
        currentImprovementTarget={aiImprover.currentImprovementTarget}
        improvementHistory={aiImprover.improvementHistory}
      />

      {/* Version History Modal */}
      <WidgetHistoryModal
        isOpen={isHistoryOpen}
        onOpenChange={setIsHistoryOpen}
        history={history}
        selectedHistoryItem={selectedHistoryItem}
        setSelectedHistoryItem={setSelectedHistoryItem}
        handleRestore={handleRestore}
        handleDeleteHistory={handleDeleteHistory}
        widgetName={widget?.name || ''}
      />

      {/* Paste Modal */}
      <WidgetPasteModal
        isOpen={isPasteModalOpen}
        onOpenChange={setIsPasteModalOpen}
        onApply={handlePaste}
      />
    </div>
  );
};
