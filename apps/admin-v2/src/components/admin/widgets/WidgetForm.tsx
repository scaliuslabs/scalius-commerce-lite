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
import { AlertTriangle, ArrowLeft, Check, Clock, Save, X } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import {
  createWidget,
  updateWidget,
  getWidgetHistory,
  createWidgetHistorySnapshot,
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
import { UnsavedChangesGuard } from '../shared/UnsavedChangesGuard';
import { useNavigate } from '@tanstack/react-router';
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
type WidgetContentDraft = { html: string; css: string };

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
    setError,
    formState: { errors, isSubmitting, isDirty },
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
  const [deletingHistoryIds, setDeletingHistoryIds] = useState<Set<string>>(() => new Set());
  const [isPasteModalOpen, setIsPasteModalOpen] = useState(false);

  // Save version state
  const [isSaveVersionOpen, setIsSaveVersionOpen] = useState(false);
  const [versionReason, setVersionReason] = useState("");
  const [isSavingVersion, setIsSavingVersion] = useState(false);

  // Editor state
  const [editorMode, setEditorMode] = useState<EditorMode>('generation-preview');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isAiHelperOpen, setIsAiHelperOpen] = useState(() => isCreateMode);
  const [livePreviewContent, setLivePreviewContent] = useState<WidgetContentDraft | null>(null);

  // Initialize hooks
  const aiContext = useAiContext();
  const aiGenerator = useAiGenerator(aiContext, widget, true);
  const aiImprover = useAiImprover({ aiContext, aiGenerator });

  useEffect(() => {
    if (resetVersionRef.current === widgetFormVersion) return;
    resetVersionRef.current = widgetFormVersion;
    reset(formDefaultValues);
    setHistory([]);
    setSelectedHistoryItem(null);
    setHistoryError(null);
    setIsHistoryLoading(false);
    setDeletingHistoryIds(new Set());
  }, [formDefaultValues, reset, widgetFormVersion]);

  // Load saved AI context from widget
  useEffect(() => {
    if (aiContextVersionRef.current === widgetFormVersion) return;
    aiContextVersionRef.current = widgetFormVersion;

    aiContext.resetContext();
    aiGenerator.cancelGeneration({ silent: true });
    aiGenerator.setPromptType('widget');
    aiGenerator.setUserPrompt('');
    aiGenerator.setSelectedModel('');
    aiGenerator.setGeneratedContent(null);
    aiGenerator.setIsPreviewOpen(false);
    aiGenerator.setUseStagedMode(true);
    aiImprover.reset();
    setEditorMode('generation-preview');
    setIsEditorOpen(false);
    setLivePreviewContent(null);

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
      applyContentToForm(aiGenerator.generatedContent);
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
      applyContentToForm(aiImprover.contentToImprove);
      toast.success('Improved content applied to the form.');
    }
    setIsEditorOpen(false);
    aiImprover.cancel({ silent: true });
    aiImprover.setContentToImprove(null);
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

    // Live preview is only a read-only view of the current form fields.
    aiGenerator.setGeneratedContent(null);
    setLivePreviewContent({ html, css: css || '' });

    setEditorMode('live-preview');
    setIsEditorOpen(true);
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

    if (aiGenerator.isAiSettingsLoading) {
      setIsAiHelperOpen(true);
      toast.info('Widget AI settings are still loading. Try again in a moment.');
      return;
    }

    if (aiGenerator.aiSettingsError) {
      setIsAiHelperOpen(true);
      toast.error(aiGenerator.aiSettingsError);
      return;
    }

    if (!aiGenerator.isApiKeySet) {
      setIsAiHelperOpen(true);
      toast.error('Configure the active provider in General Settings > Widget AI before improving content.');
      return;
    }

    if (!aiGenerator.selectedModel) {
      setIsAiHelperOpen(true);
      toast.error('Select an AI model before improving content.');
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
    applyContentToForm(content);
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

  const handleRestore = (historyId: string) => {
    if (!widget?.id) return;
    const restoredEntry = history.find((entry) => entry.id === historyId);
    if (!restoredEntry) {
      toast.error('Version not found.');
      return;
    }

    applyContentToForm({
      html: restoredEntry.htmlContent,
      css: restoredEntry.cssContent || '',
    });
    setSelectedHistoryItem(restoredEntry);
    setIsHistoryOpen(false);
    toast.success('Version content applied. Save the widget to keep it.');
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
  const onSubmit = async (data: WidgetFormValues) => {
    try {
      const pendingContent = getPendingPreviewContent(data.htmlContent, data.cssContent ?? '');
      if (pendingContent) {
        toast.error('Apply or discard the preview content before saving this widget.');
        setEditorMode(pendingContent.source === 'improvement' ? 'improvement' : 'generation-preview');
        setIsEditorOpen(true);
        return;
      }

      if (data.isActive && data.htmlContent.trim().length === 0) {
        setError('htmlContent', {
          type: 'manual',
          message: 'HTML content is required before publishing this widget.',
        });
        toast.error('Add HTML content before publishing this widget.');
        return;
      }

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
        ...data,
        ...legacyProjectionFromPlacements(data.placements),
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
      const action = isCreateMode
        ? data.isActive
          ? 'created and activated'
          : 'created as a draft'
        : data.isActive
          ? 'saved as active'
          : 'saved as a draft';
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

  const isActive = watch('isActive');
  const watchedHtmlContent = watch('htmlContent') || '';
  const watchedCssContent = watch('cssContent') || '';
  const pendingPreviewContent = getPendingPreviewContent(
    watchedHtmlContent,
    watchedCssContent,
  );
  const shouldGuardNavigation = isDirty || Boolean(pendingPreviewContent);
  const primarySubmitLabel = isCreateMode
    ? isActive
      ? 'Create Active Widget'
      : 'Create Draft'
    : isActive
      ? submitButtonText
      : 'Save Draft';

  function applyContentToForm(content: WidgetContentDraft) {
    setValue('htmlContent', content.html, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    setValue('cssContent', content.css, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
  }

  function getPendingPreviewContent(html: string, css: string) {
    const generated = aiGenerator.generatedContent;
    if (
      generated &&
      (generated.html !== html || generated.css !== css)
    ) {
      return {
        source: 'generation' as const,
        content: generated,
      };
    }

    const improved = aiImprover.contentToImprove;
    if (
      improved &&
      (improved.html !== html || improved.css !== css)
    ) {
      return {
        source: 'improvement' as const,
        content: improved,
      };
    }

    return null;
  }

  function discardPendingPreviewContent() {
    if (!pendingPreviewContent) return;

    if (pendingPreviewContent.source === 'generation') {
      aiGenerator.setGeneratedContent(null);
    } else {
      aiImprover.discardImprovement();
    }

    setIsEditorOpen(false);
    toast.info('Preview content discarded.');
  }

  return (
    <div className="space-y-8">
      <UnsavedChangesGuard
        isDirty={shouldGuardNavigation}
        isSubmitting={isSubmitting}
      />
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
        <AiAssistant
          widget={widget}
          aiContext={aiContext}
          aiGenerator={aiGenerator}
          isOpen={isAiHelperOpen}
          onOpenChange={setIsAiHelperOpen}
        />

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

        {pendingPreviewContent && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <div className="flex min-w-0 items-center gap-2 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                {pendingPreviewContent.source === 'generation'
                  ? 'Generated preview content is not applied to the form yet.'
                  : 'Improved preview content is not applied to the form yet.'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  applyContentToForm(pendingPreviewContent.content);
                  if (pendingPreviewContent.source === 'generation') {
                    aiGenerator.setGeneratedContent(null);
                  } else {
                    aiImprover.cancel({ silent: true });
                    aiImprover.setContentToImprove(null);
                  }
                  toast.success('Preview content applied.');
                }}
              >
                <Check className="mr-2 h-4 w-4" />
                Apply Preview
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={discardPendingPreviewContent}
              >
                <X className="mr-2 h-4 w-4" />
                Discard
              </Button>
            </div>
          </div>
        )}

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
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Saving...' : primarySubmitLabel}
          </Button>
        </div>
      </form>

      {/* Unified Full Screen Editor */}
      <FullScreenEditor
        isOpen={isEditorOpen}
        onClose={() => {
          setIsEditorOpen(false);
          if (editorMode === 'live-preview') {
            setLivePreviewContent(null);
          }
        }}
        onCancelProcessing={
          editorMode === 'improvement'
            ? aiImprover.cancel
            : aiGenerator.cancelGeneration
        }
        content={
          editorMode === 'improvement'
            ? aiImprover.contentToImprove
            : editorMode === 'live-preview'
              ? livePreviewContent
              : aiGenerator.generatedContent
        }
        rawOutput={
          editorMode === 'improvement'
            ? aiImprover.rawOutput
            : editorMode === 'generation-preview'
              ? aiGenerator.rawOutput || undefined
              : undefined
        }
        error={editorMode === 'generation-preview' ? aiGenerator.generationError : undefined}
        mode={editorMode}
        onAccept={
          editorMode === 'improvement'
            ? handleAcceptImprovement
            : editorMode === 'live-preview'
            ? () => {
                toast.info('Already in the form.');
                setIsEditorOpen(false);
                setLivePreviewContent(null);
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
