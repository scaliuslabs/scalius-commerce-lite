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
import { WidgetPlacementRule, type Widget, type Collection, type WidgetHistoryEntry, type Category } from '@/types/api-responses';
import { widgetFormSchema, type WidgetFormValues } from '@/lib/form-schemas';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { ArrowLeft, Clock, Save } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import {
  createWidget,
  updateWidget,
  getWidgetHistory,
  createWidgetHistorySnapshot,
  restoreWidgetHistory,
  deleteWidgetHistory,
} from '~/lib/api.functions';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseAiContext, AiContextSchema, type AiContext, type ProductReference, type CategoryReference } from '@scalius/core/modules/ai/ai-context-schema';
import { parseHtmlIntoSections } from '@scalius/shared/html-section-parser';
import type { ProductSearchResult } from './widget-form/types';
import { useAiContext } from './widget-form/useAiContext';
import { useAiGenerator } from './widget-form/useAiGenerator';
import { useAiImprover } from './widget-form/useAiImprover';
import { AiAssistant } from './widget-form/AiAssistant';
import { WidgetDetails } from './widget-form/WidgetDetails';
import { WidgetPlacement } from './widget-form/WidgetPlacement';
import { FullScreenEditor, type EditorMode } from './widget-form/FullScreenEditor';
import { WidgetHistoryModal } from './widget-form/WidgetHistoryModal';
import { WidgetPasteModal } from './widget-form/WidgetPasteModal';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { getServerFnError } from '~/lib/api-helpers';

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
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const {
    control,
    handleSubmit,
    register,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<WidgetFormValues>({
    resolver: zodResolver(widgetFormSchema),
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
          placementRule: WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
          referenceCollectionId: null,
          sortOrder: 0,
        },
  });

  // Version history state
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [history, setHistory] = useState<WidgetHistoryEntry[]>([]);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<WidgetHistoryEntry | null>(null);
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);

  // Save version state
  const [isSaveVersionOpen, setIsSaveVersionOpen] = useState(false);
  const [versionReason, setVersionReason] = useState("");

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
        if (context.savedProducts) context.savedProducts.forEach((p: ProductReference) => aiContext.handleProductSelect(p as ProductSearchResult));
        if (context.savedCategories) context.savedCategories.forEach((c: CategoryReference) => aiContext.handleCategorySelect(c as unknown as Category));
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
      } catch (e: unknown) {
        if (import.meta.env.DEV) console.error('Failed to parse widget AI context', e);
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
    if (!aiGenerator.canAcceptGenerated) {
      toast.error('Generation is not ready to apply.');
      return;
    }
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
      try {
        const data = await getWidgetHistory({ data: { widgetId: widget.id } });
        setHistory(data as WidgetHistoryEntry[]);
      } catch (error: unknown) {
        toast.error('Failed to load version history');
        setHistory([]);
      }
    }
  };

  const handleRestore = async (historyId: string) => {
    if (!widget?.id) return;
    try {
      await restoreWidgetHistory({ data: { widgetId: widget.id, historyId } });
      toast.success('Version restored successfully!');
      router.invalidate();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Failed to restore version');
    }
  };

  const handleDeleteHistory = async (historyId: string) => {
    if (!widget?.id) return;
    try {
      await deleteWidgetHistory({ data: { widgetId: widget.id, historyId } });
      toast.success('Version deleted successfully!');
      setHistory(prev => prev.filter(h => h.id !== historyId));
      if (selectedHistoryItem?.id === historyId) {
        setSelectedHistoryItem(null);
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete version');
    }
  };

  const handleSaveVersion = async () => {
    if (!widget?.id) return;
    try {
      await createWidgetHistorySnapshot({
        data: {
          widgetId: widget.id,
          snapshot: { reason: versionReason.trim() || 'Manual save' },
        },
      });
      toast.success('Version saved!');
      setIsSaveVersionOpen(false);
      setVersionReason('');
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Failed to save version');
    }
  };

  /**
   * Form submission with AI context persistence
   */
  const onSubmit = async (data: WidgetFormValues) => {
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

    // Pass aiContext as a validated object (not a string).
    // The API schema expects z.record() and the service calls JSON.stringify() before DB insert.
    const validatedContext = AiContextSchema.parse({
      ...contextToSave,
      lastModified: Date.now(),
    });

    const submissionData = {
      ...data,
      aiContext: validatedContext as unknown as Record<string, unknown>,
    };

    try {
      if (isCreateMode) {
        await createWidget({ data: submissionData });
      } else {
        await updateWidget({ data: { ...submissionData, id: widget!.id } });
        queryClient.invalidateQueries({ queryKey: ['widgets', 'detail', widget!.id] });
      }
      // Invalidate queries so list page shows fresh data
      queryClient.invalidateQueries({ queryKey: ['widgets', 'list'] });
      toast.success(`Widget ${isCreateMode ? 'created' : 'updated'} successfully!`);
      void navigate({ to: '/admin/widgets' });
    } catch (error: unknown) {
      toast.error(
        getServerFnError(error, `Failed to ${isCreateMode ? 'create' : 'update'} widget`),
      );
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
          <Link to="/admin/widgets">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to List
          </Link>
        </Button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <AiAssistant widget={widget} aiContext={aiContext} aiGenerator={aiGenerator} />

        <WidgetDetails
          register={register}
          watch={watch}
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
            <>
              <Button type="button" variant="outline" onClick={() => setIsSaveVersionOpen(true)}>
                <Save className="mr-2 h-4 w-4" /> Save Version
              </Button>
              <Button type="button" variant="outline" onClick={openHistory}>
                <Clock className="mr-2 h-4 w-4" /> Version History
              </Button>
            </>
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
        rawOutput={editorMode === 'improvement' ? aiImprover.rawOutput : aiGenerator.rawOutput || undefined}
        error={editorMode === 'generation-preview' ? aiGenerator.generationError : undefined}
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
        canAccept={editorMode === 'generation-preview' ? aiGenerator.canAcceptGenerated : true}
        processingProgress={aiGenerator.generationProgress}
        aiContext={aiContext}
        promptType={aiGenerator.promptType}
        setPromptType={aiGenerator.setPromptType}
        sections={editorMode === 'improvement' || editorMode === 'generation-preview' ? sections : []}
        currentImprovementTarget={aiImprover.currentImprovementTarget}
        improvementHistory={aiImprover.improvementHistory}
      />

      {/* Save Version Dialog */}
      <AlertDialog open={isSaveVersionOpen} onOpenChange={setIsSaveVersionOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save Version</AlertDialogTitle>
            <AlertDialogDescription>
              Save the current widget content as a version you can restore later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Label htmlFor="versionReason">Reason (optional)</Label>
            <Input
              id="versionReason"
              value={versionReason}
              onChange={(e) => setVersionReason(e.target.value)}
              placeholder="e.g., Before redesign, Final version, etc."
              className="mt-2"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setVersionReason('')}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSaveVersion}>Save Version</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
