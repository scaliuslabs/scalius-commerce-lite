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

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  WidgetPlacementAnchorType,
  WidgetPlacementRule,
  WidgetPlacementScope,
  WidgetPlacementSlot,
  type Widget,
  type WidgetHistoryEntry,
  type Category,
} from '@/types/api-responses';
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
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseAiContext, AiContextSchema, type AiContext } from '@scalius/core/modules/ai/ai-context-schema';
import { parseHtmlIntoSections } from '@scalius/shared/html-section-parser';
import type { MediaFile, ProductSearchResult } from './widget-form/types';
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
import {
  isSupportedWidgetPlacementScope,
  isWidgetCollectionSlot,
  normalizeWidgetPlacementSlotForScope,
  type SupportedWidgetPlacementScopeValue,
} from '@scalius/shared/widget-placement';

interface WidgetFormProps {
  widget?: Widget | null;
  isCreateMode: boolean;
  submitButtonText: string;
}

type WidgetPlacementFormValue = NonNullable<WidgetFormValues["placements"]>[number];
type SupportedWidgetPlacement = NonNullable<Widget["placements"]>[number] & {
  scope: SupportedWidgetPlacementScopeValue;
};

function homepagePlacement(
  slot: WidgetPlacementSlot,
  sortOrder: number,
  anchorId?: string | null,
): WidgetPlacementFormValue {
  return {
    scope: WidgetPlacementScope.HOMEPAGE,
    scopeId: null,
    slot,
    anchorType:
      slot === WidgetPlacementSlot.BEFORE_COLLECTION ||
      slot === WidgetPlacementSlot.AFTER_COLLECTION
        ? WidgetPlacementAnchorType.COLLECTION
        : null,
    anchorId: anchorId ?? null,
    sortOrder,
    isActive: true,
  };
}

function placementsFromLegacyWidget(widget: Widget): WidgetPlacementFormValue[] {
  switch (widget.placementRule) {
    case WidgetPlacementRule.BEFORE_COLLECTION:
      return [homepagePlacement(WidgetPlacementSlot.BEFORE_COLLECTION, widget.sortOrder, widget.referenceCollectionId)];
    case WidgetPlacementRule.AFTER_COLLECTION:
      return [homepagePlacement(WidgetPlacementSlot.AFTER_COLLECTION, widget.sortOrder, widget.referenceCollectionId)];
    case WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE:
      return [homepagePlacement(WidgetPlacementSlot.BOTTOM, widget.sortOrder)];
    case WidgetPlacementRule.FIXED_TOP_HOMEPAGE:
      return [homepagePlacement(WidgetPlacementSlot.TOP, widget.sortOrder)];
    case WidgetPlacementRule.STANDALONE:
    default:
      return [];
  }
}

function normalizePlacementForForm(
  placement: SupportedWidgetPlacement,
): WidgetPlacementFormValue {
  const slot = normalizeWidgetPlacementSlotForScope(
    placement.scope,
    placement.slot,
  ) as WidgetPlacementSlot;
  const anchorType = isWidgetCollectionSlot(slot)
    ? WidgetPlacementAnchorType.COLLECTION
    : null;
  return {
    id: placement.id,
    scope: placement.scope,
    scopeId: placement.scopeId ?? null,
    slot,
    anchorType,
    anchorId: isWidgetCollectionSlot(slot) ? placement.anchorId ?? null : null,
    sortOrder: placement.sortOrder,
    isActive: placement.isActive,
  };
}

function placementsForForm(widget: Widget | null | undefined): WidgetPlacementFormValue[] {
  if (!widget) {
    return [];
  }

  if (widget.placements && widget.placements.length > 0) {
    return widget.placements
      .filter(
        (placement): placement is SupportedWidgetPlacement =>
          placement.deletedAt == null &&
          isSupportedWidgetPlacementScope(placement.scope),
      )
      .map(normalizePlacementForForm);
  }

  return placementsFromLegacyWidget(widget);
}

function legacyProjectionFromPlacements(placements: WidgetPlacementFormValue[] | undefined) {
  const placement = placements?.find((item) => item.isActive) ?? placements?.[0];
  if (!placement || placement.scope !== WidgetPlacementScope.HOMEPAGE) {
    return {
      displayTarget: "homepage" as const,
      placementRule: WidgetPlacementRule.STANDALONE,
      referenceCollectionId: null,
      sortOrder: 0,
    };
  }

  if (placement.slot === WidgetPlacementSlot.BEFORE_COLLECTION) {
    return {
      displayTarget: "homepage" as const,
      placementRule: WidgetPlacementRule.BEFORE_COLLECTION,
      referenceCollectionId: placement.anchorId ?? null,
      sortOrder: placement.sortOrder,
    };
  }

  if (placement.slot === WidgetPlacementSlot.AFTER_COLLECTION) {
    return {
      displayTarget: "homepage" as const,
      placementRule: WidgetPlacementRule.AFTER_COLLECTION,
      referenceCollectionId: placement.anchorId ?? null,
      sortOrder: placement.sortOrder,
    };
  }

  return {
    displayTarget: "homepage" as const,
    placementRule:
      placement.slot === WidgetPlacementSlot.BOTTOM
        ? WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE
        : WidgetPlacementRule.FIXED_TOP_HOMEPAGE,
    referenceCollectionId: null,
    sortOrder: placement.sortOrder,
  };
}

function getWidgetFormDefaultValues(
  widget: Widget | null | undefined,
  isCreateMode: boolean,
): WidgetFormValues {
  if (widget && !isCreateMode) {
    return {
      name: widget.name,
      htmlContent: widget.htmlContent,
      cssContent: widget.cssContent || undefined,
      isActive: widget.isActive,
      displayTarget: widget.displayTarget as 'homepage',
      placementRule: widget.placementRule as WidgetPlacementRule,
      referenceCollectionId: widget.referenceCollectionId,
      sortOrder: widget.sortOrder,
      placements: placementsForForm(widget),
    };
  }

  return {
    name: '',
    htmlContent: '',
    cssContent: undefined,
    isActive: false,
    displayTarget: 'homepage',
    placementRule: WidgetPlacementRule.STANDALONE,
    referenceCollectionId: null,
    sortOrder: 0,
    placements: placementsForForm(null),
  };
}

function getSavedAiContextCreatedAt(aiContext: string | null | undefined): number {
  if (!aiContext) return Date.now();
  try {
    const savedContext = parseAiContext(aiContext);
    return typeof savedContext.createdAt === 'number'
      ? savedContext.createdAt
      : Date.now();
  } catch {
    return Date.now();
  }
}

export const WidgetForm: React.FC<WidgetFormProps> = ({
  widget,
  isCreateMode,
  submitButtonText,
}) => {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const widgetFormVersion = isCreateMode
    ? 'create'
    : widget
      ? `${widget.id}:${String(widget.updatedAt)}`
      : 'empty';
  const formDefaultValues = useMemo(
    () => getWidgetFormDefaultValues(widget, isCreateMode),
    [widget, isCreateMode],
  );
  const resetVersionRef = useRef<string | null>(null);
  const aiContextVersionRef = useRef<string | null>(null);
  const {
    control,
    handleSubmit,
    register,
    watch,
    setValue,
    reset,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<WidgetFormValues>({
    resolver: zodResolver(widgetFormSchema),
    defaultValues: formDefaultValues,
  });

  // Version history state
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [history, setHistory] = useState<WidgetHistoryEntry[]>([]);
  const [selectedHistoryItem, setSelectedHistoryItem] = useState<WidgetHistoryEntry | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isRestoringHistory, setIsRestoringHistory] = useState(false);
  const [deletingHistoryIds, setDeletingHistoryIds] = useState<Set<string>>(() => new Set());
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);

  // Save version state
  const [isSaveVersionOpen, setIsSaveVersionOpen] = useState(false);
  const [versionReason, setVersionReason] = useState("");
  const [isSavingVersion, setIsSavingVersion] = useState(false);

  // Editor state
  const [editorMode, setEditorMode] = useState<EditorMode>('generation-preview');
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  // Initialize hooks
  const aiContext = useAiContext();
  const aiGenerator = useAiGenerator(aiContext, widget);
  const aiImprover = useAiImprover({ aiContext, aiGenerator });

  useEffect(() => {
    if (resetVersionRef.current === widgetFormVersion) return;
    resetVersionRef.current = widgetFormVersion;
    reset(formDefaultValues);
    setHistory([]);
    setSelectedHistoryItem(null);
    setHistoryError(null);
    setIsHistoryLoading(false);
    setIsRestoringHistory(false);
    setDeletingHistoryIds(new Set());
  }, [formDefaultValues, reset, widgetFormVersion]);

  // Load saved AI context from widget
  useEffect(() => {
    if (aiContextVersionRef.current === widgetFormVersion) return;
    aiContextVersionRef.current = widgetFormVersion;

    aiContext.resetContext();
    aiGenerator.setPromptType('widget');
    aiGenerator.setUserPrompt('');
    aiGenerator.setSelectedModel('');
    aiGenerator.setGeneratedContent(null);
    aiGenerator.setIsPreviewOpen(false);
    aiGenerator.setUseStagedMode(true);
    aiGenerator.stagedGeneration.reset();
    aiImprover.reset();
    setEditorMode('generation-preview');
    setIsEditorOpen(false);

    if (!widget?.aiContext) {
      return;
    }

    try {
      const context = parseAiContext(widget.aiContext as string);

      aiGenerator.setPromptType(context.promptType);
      if (context.preferredAiModel) aiGenerator.setSelectedModel(context.preferredAiModel);
      aiGenerator.setUseStagedMode(context.useStagedMode);
      aiContext.replaceContext({
        images: context.savedImages as unknown as MediaFile[],
        products: context.savedProducts as ProductSearchResult[],
        categories: context.savedCategories as unknown as Category[],
        allCategories: context.allCategoriesSelected,
      });

      if (context.improvementHistory.length > 0) {
        aiImprover.loadHistory(context.improvementHistory);
      }

      if (context.stagedSections.length > 0) {
        aiGenerator.stagedGeneration.updateSections(context.stagedSections);
      }

      if (
        context.savedImages.length > 0 ||
        context.savedProducts.length > 0 ||
        context.savedCategories.length > 0 ||
        context.allCategoriesSelected ||
        context.stagedSections.length > 0 ||
        context.improvementHistory.length > 0
      ) {
        toast.info('Loaded saved AI context for this widget.');
      }
    } catch (e: unknown) {
      if (import.meta.env.DEV) console.error('Failed to parse widget AI context', e);
    }
  }, [widgetFormVersion]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setIsHistoryLoading(true);
      setHistoryError(null);
      setSelectedHistoryItem(null);
      setHistory([]);
      try {
        const data = await getWidgetHistory({ data: { widgetId: widget.id } });
        const entries = data as WidgetHistoryEntry[];
        setHistory(entries);
        setSelectedHistoryItem(entries[0] ?? null);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to load version history';
        setHistoryError(message);
        toast.error(message);
        setHistory([]);
      } finally {
        setIsHistoryLoading(false);
      }
    }
  };

  const handleRestore = async (historyId: string) => {
    if (!widget?.id) return;
    const restoredEntry = history.find((entry) => entry.id === historyId);
    setIsRestoringHistory(true);
    try {
      await restoreWidgetHistory({ data: { widgetId: widget.id, historyId } });
      if (restoredEntry) {
        reset({
          ...getValues(),
          htmlContent: restoredEntry.htmlContent,
          cssContent: restoredEntry.cssContent || undefined,
        });
        setSelectedHistoryItem(restoredEntry);
      }
      try {
        const refreshedHistory = await getWidgetHistory({ data: { widgetId: widget.id } });
        const entries = refreshedHistory as WidgetHistoryEntry[];
        setHistory(entries);
        setSelectedHistoryItem(
          entries.find((entry) => entry.id === historyId) ?? restoredEntry ?? entries[0] ?? null,
        );
      } catch {
        // The restored form content is already applied; a history refresh can recover on next open.
      }
      toast.success('Version restored successfully!');
      void router.invalidate();
      queryClient.invalidateQueries({ queryKey: ['widgets', 'detail', widget.id] });
      queryClient.invalidateQueries({ queryKey: ['widgets', 'list'] });
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Failed to restore version');
    } finally {
      setIsRestoringHistory(false);
    }
  };

  const handleDeleteHistory = async (historyId: string) => {
    if (!widget?.id) return;
    setDeletingHistoryIds((prev) => new Set(prev).add(historyId));
    try {
      await deleteWidgetHistory({ data: { widgetId: widget.id, historyId } });
      toast.success('Version deleted successfully!');
      setHistory(prev => prev.filter(h => h.id !== historyId));
      if (selectedHistoryItem?.id === historyId) {
        setSelectedHistoryItem(null);
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete version');
    } finally {
      setDeletingHistoryIds((prev) => {
        const next = new Set(prev);
        next.delete(historyId);
        return next;
      });
    }
  };

  const handleSaveVersion = async () => {
    if (!widget?.id) return;
    const htmlContent = watch('htmlContent');
    const cssContent = watch('cssContent');
    if (!htmlContent || htmlContent.trim().length === 0) {
      toast.error('Add HTML content before saving a version.');
      return;
    }

    setIsSavingVersion(true);
    try {
      const entry = await createWidgetHistorySnapshot({
        data: {
          widgetId: widget.id,
          snapshot: {
            reason: versionReason.trim() || 'Manual save',
            htmlContent,
            cssContent: cssContent ?? null,
          },
        },
      }) as WidgetHistoryEntry;
      toast.success('Version saved!');
      setHistory(prev => [entry, ...prev.filter(item => item.id !== entry.id)]);
      setSelectedHistoryItem(entry);
      setIsSaveVersionOpen(false);
      setVersionReason('');
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Failed to save version');
    } finally {
      setIsSavingVersion(false);
    }
  };

  /**
   * Form submission with AI context persistence
   */
  const onSubmit = async (
    data: WidgetFormValues,
    intent: 'save' | 'draft' | 'publish' = 'save',
  ) => {
    try {
      if (
        intent === 'publish' &&
        data.placements.length > 0 &&
        !data.placements.some((placement) => placement.isActive)
      ) {
        toast.error('Activate at least one placement before publishing this widget.');
        return;
      }

      const activationData = {
        ...data,
        isActive:
          intent === 'draft'
            ? false
            : intent === 'publish'
              ? true
              : data.isActive,
      };

      // Build AI context with all state.
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
        createdAt: getSavedAiContextCreatedAt(widget?.aiContext),
      };

      // Pass aiContext as a validated object (not a string).
      // The API schema expects z.record() and the service calls JSON.stringify() before DB insert.
      const validatedContext = AiContextSchema.parse({
        ...contextToSave,
        lastModified: Date.now(),
      });

      const submissionData = {
        ...activationData,
        ...legacyProjectionFromPlacements(activationData.placements),
        aiContext: validatedContext as unknown as Record<string, unknown>,
      };

      if (isCreateMode) {
        await createWidget({ data: submissionData });
      } else {
        await updateWidget({ data: { ...submissionData, id: widget!.id } });
        queryClient.invalidateQueries({ queryKey: ['widgets', 'detail', widget!.id] });
      }
      // Invalidate queries so list page shows fresh data
      queryClient.invalidateQueries({ queryKey: ['widgets', 'list'] });
      const action =
        intent === 'draft'
          ? 'saved as draft'
          : intent === 'publish'
            ? 'published'
            : isCreateMode
              ? 'created'
              : 'updated';
      toast.success(`Widget ${action} successfully!`);
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

      <form onSubmit={handleSubmit((data) => onSubmit(data, 'save'))} className="space-y-6">
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
          setValue={setValue}
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
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => {
              void handleSubmit((data) => onSubmit(data, 'draft'))();
            }}
          >
            {isSubmitting ? 'Saving...' : 'Save Draft'}
          </Button>
          {!isCreateMode && (
            <Button
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Saving...' : submitButtonText}
            </Button>
          )}
          <Button
            type="button"
            disabled={isSubmitting}
            onClick={() => {
              void handleSubmit((data) => onSubmit(data, 'publish'))();
            }}
          >
            {isSubmitting
              ? 'Publishing...'
              : isCreateMode
                ? 'Create & Publish'
                : 'Publish'}
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
            <Button type="button" onClick={handleSaveVersion} disabled={isSavingVersion}>
              {isSavingVersion ? 'Saving...' : 'Save Version'}
            </Button>
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
        isLoading={isHistoryLoading}
        error={historyError}
        isRestoring={isRestoringHistory}
        deletingHistoryIds={deletingHistoryIds}
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
