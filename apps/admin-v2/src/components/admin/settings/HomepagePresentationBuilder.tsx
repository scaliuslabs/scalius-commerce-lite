import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, LayoutGrid, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_HOMEPAGE_PRESENTATION,
  MAX_HOMEPAGE_CATEGORY_IDS,
  type HomepagePresentationConfig,
} from "@scalius/shared/homepage-presentation";
import { cn } from "@scalius/shared/utils";
import { mergeUneditedFields } from "~/hooks/use-settings-form";
import {
  ContextualSaveBar,
  EmptyState,
  InlineHelp,
  SettingsSection,
  SkeletonPage,
  StatusBadge,
} from "~/components/admin/shell";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { getCategoryFormOptions } from "~/lib/api-functions/categories";
import {
  getHomepagePresentation,
  saveHomepagePresentation,
  type HomepagePresentationDocument,
} from "~/lib/api-functions/homepage-presentation";
import { queryKeys } from "~/lib/query-keys";
import { SortableList } from "../shared/SortableList";
import { SettingsLoadFailure } from "./SettingsLoadFailure";

function cloneConfig(config: HomepagePresentationConfig): HomepagePresentationConfig {
  return {
    categoryRail: {
      ...config.categoryRail,
      categoryIds: [...config.categoryRail.categoryIds],
    },
    trustStrip: { ...config.trustStrip },
  };
}

function mergeHomepageConfig(
  current: HomepagePresentationConfig,
  baseline: HomepagePresentationConfig,
  incoming: HomepagePresentationConfig,
): HomepagePresentationConfig {
  return {
    categoryRail: mergeUneditedFields(
      current.categoryRail,
      baseline.categoryRail,
      incoming.categoryRail,
    ),
    trustStrip: mergeUneditedFields(
      current.trustStrip,
      baseline.trustStrip,
      incoming.trustStrip,
    ),
  };
}

interface HomepageSaveVariables {
  config: HomepagePresentationConfig;
  expectedRevision: number;
}

export function HomepagePresentationBuilder({
  onDraftStateChange,
}: {
  onDraftStateChange?: (state: {
    isDirty: boolean;
    isSubmitting: boolean;
  }) => void;
}) {
  const queryClient = useQueryClient();
  const presentationQuery = useQuery({
    queryKey: queryKeys.settings.homepagePresentation(),
    queryFn: getHomepagePresentation,
  });
  const categoriesQuery = useQuery({
    queryKey: queryKeys.categories.formOptions(),
    queryFn: getCategoryFormOptions,
  });
  const [config, setConfig] = useState<HomepagePresentationConfig>(() =>
    cloneConfig(DEFAULT_HOMEPAGE_PRESENTATION)
  );
  const [saved, setSaved] = useState<HomepagePresentationDocument | null>(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  useEffect(() => {
    if (!presentationQuery.data) return;
    const previousSaved = savedRef.current;
    if (previousSaved && presentationQuery.data.revision < previousSaved.revision) {
      return;
    }
    const baseline = previousSaved?.config ?? DEFAULT_HOMEPAGE_PRESENTATION;
    setConfig((current) => mergeHomepageConfig(current, baseline, presentationQuery.data!.config));
    savedRef.current = presentationQuery.data;
    setSaved(presentationQuery.data);
  }, [presentationQuery.data]);

  const categories = useMemo(
    () => categoriesQuery.data?.categories ?? [],
    [categoriesQuery.data?.categories],
  );
  const categoriesById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );
  const selectedCategories = config.categoryRail.categoryIds.map((id) => ({
    id,
    category: categoriesById.get(id) ?? null,
  }));
  const addOptions = categories
    .filter((category) => !config.categoryRail.categoryIds.includes(category.id))
    .map((category) => ({
      value: category.id,
      label: category.name,
      keywords: [category.status],
    }));
  const dirty = saved ? JSON.stringify(config) !== JSON.stringify(saved.config) : false;

  const saveMutation = useMutation({
    mutationFn: async ({ config: submittedConfig, expectedRevision }: HomepageSaveVariables) => {
      return saveHomepagePresentation({
        data: { ...submittedConfig, expectedRevision },
      });
    },
    onSuccess: (document, variables) => {
      const previousSaved = savedRef.current;
      if (previousSaved && document.revision < previousSaved.revision) return;
      savedRef.current = document;
      setSaved(document);
      setConfig((current) => mergeHomepageConfig(current, variables.config, document.config));
      queryClient.setQueryData(
        queryKeys.settings.homepagePresentation(),
        document,
      );
      toast.success("Homepage presentation saved.");
    },
    onError: (error) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.settings.homepagePresentation(),
      });
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "Homepage presentation could not be saved.",
      );
    },
  });

  useEffect(() => {
    onDraftStateChange?.({
      isDirty: dirty,
      isSubmitting: saveMutation.isPending,
    });
  }, [dirty, onDraftStateChange, saveMutation.isPending]);

  if (presentationQuery.isLoading || categoriesQuery.isLoading) {
    return (
      <SkeletonPage
        showHeader={false}
        sections={2}
        rowsPerSection={3}
        label="Loading homepage presentation"
      />
    );
  }

  if (presentationQuery.isError || categoriesQuery.isError) {
    return (
      <SettingsLoadFailure
        title="Homepage presentation unavailable"
        error={presentationQuery.error ?? categoriesQuery.error}
        fallback="The saved homepage modules or category choices could not be loaded."
        onRetry={() => {
          void presentationQuery.refetch();
          void categoriesQuery.refetch();
        }}
      />
    );
  }

  return (
    <div className="max-w-5xl">
      {/*
        The parent workspace already owns the leave-page guard through
        `onDraftStateChange`, so this bar saves without a second blocker.
      */}
      <ContextualSaveBar
        isDirty={dirty || saveMutation.isPending}
        saving={saveMutation.isPending}
        saveDisabled={!dirty || saveMutation.isPending || !saved}
        saveDisabledReason="Change a homepage module before saving."
        saveLabel="Save homepage"
        blockNavigation={false}
        // The settings section picker is sticky on narrow widths.
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={() => saved && setConfig(cloneConfig(saved.config))}
        onSave={() => saved && saveMutation.mutate({
          config: cloneConfig(config),
          expectedRevision: saved.revision,
        })}
      />

      <div className="space-y-6">
        <div>
          <h2 className="text-base font-semibold">Homepage</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Choose what buyers see after featured content.
          </p>
        </div>

        <SettingsSection
          title="Category rail"
          description="Shows a scrollable row of categories after the first featured collection."
          actions={
            <div className="flex items-center gap-3">
              <Label htmlFor="homepage-category-rail" className="text-sm font-normal">
                Show the rail
              </Label>
              <Switch
                className="relative after:absolute after:-inset-x-1.5 after:-inset-y-3"
                id="homepage-category-rail"
                checked={config.categoryRail.enabled}
                onCheckedChange={(enabled) => setConfig((current) => ({
                  ...current,
                  categoryRail: { ...current.categoryRail, enabled },
                }))}
              />
            </div>
          }
        >
          <div className={cn(
            "space-y-3",
            !config.categoryRail.enabled && "opacity-60",
          )}>
            <div className="space-y-1.5">
              <Label htmlFor="homepage-category-title" className="text-xs">
                Heading
              </Label>
              <Input
                id="homepage-category-title"
                value={config.categoryRail.title}
                onChange={(event) => setConfig((current) => ({
                  ...current,
                  categoryRail: {
                    ...current.categoryRail,
                    title: event.target.value,
                  },
                }))}
                disabled={!config.categoryRail.enabled}
                maxLength={80}
                aria-describedby="homepage-category-title-help"
                className="min-h-11 sm:min-h-9"
              />
              <InlineHelp id="homepage-category-title-help">
                Sits above the rail on the storefront.
              </InlineHelp>
            </div>

            {selectedCategories.length > 0 ? (
              <SortableList
                items={selectedCategories}
                onReorder={(items) => setConfig((current) => ({
                  ...current,
                  categoryRail: {
                    ...current.categoryRail,
                    categoryIds: items.map((item) => item.id),
                  },
                }))}
                renderItem={(item, sortable) => (
                  <div
                    ref={sortable.ref}
                    style={sortable.style}
                    className={cn(
                      "flex min-h-12 items-center gap-2 rounded-lg border bg-background px-2 md:min-h-10",
                      sortable.isDragging && "relative z-10 shadow-md",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`Reorder ${item.category?.name ?? "unavailable category"}`}
                      className="grid size-11 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground hover:bg-muted md:size-8 active:cursor-grabbing"
                      {...sortable.dragHandleProps}
                    >
                      <GripVertical className="size-4" />
                    </button>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {item.category?.name ?? "Unavailable category"}
                    </span>
                    {item.category?.status && item.category.status !== "published" ? (
                      <StatusBadge
                        tone="attention"
                        dot={false}
                        srLabel="Category status:"
                        className="shrink-0 capitalize"
                      >
                        {item.category.status}
                      </StatusBadge>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0 text-muted-foreground hover:text-destructive md:size-8"
                      aria-label={`Remove ${item.category?.name ?? "unavailable category"}`}
                      onClick={() => setConfig((current) => ({
                        ...current,
                        categoryRail: {
                          ...current.categoryRail,
                          categoryIds: current.categoryRail.categoryIds.filter(
                            (id) => id !== item.id,
                          ),
                        },
                      }))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              />
            ) : (
              <EmptyState
                compact
                icon={LayoutGrid}
                heading="No categories in the rail"
                body="Add the categories buyers should discover first."
              />
            )}

            <SearchableSelect
              value=""
              onValueChange={(id) => setConfig((current) => ({
                ...current,
                categoryRail: {
                  ...current.categoryRail,
                  categoryIds: [...current.categoryRail.categoryIds, id],
                },
              }))}
              options={addOptions}
              placeholder={
                selectedCategories.length >= MAX_HOMEPAGE_CATEGORY_IDS
                  ? "Category limit reached"
                  : "Add category"
              }
              searchPlaceholder="Search categories…"
              emptyMessage="No more categories to add."
              disabled={
                !config.categoryRail.enabled ||
                selectedCategories.length >= MAX_HOMEPAGE_CATEGORY_IDS
              }
              ariaLabel="Add category to homepage"
              triggerClassName="w-full"
            />
            <InlineHelp>
              Drag to set the order. Draft and internal categories do not appear.
            </InlineHelp>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Delivery and returns strip"
          description="Repeats the delivery and return details you have already configured."
        >
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="homepage-trust-strip" className="text-sm font-medium">
              Show the strip
            </Label>
            <Switch
              className="relative after:absolute after:-inset-x-1.5 after:-inset-y-3"
              id="homepage-trust-strip"
              checked={config.trustStrip.enabled}
              onCheckedChange={(enabled) => setConfig((current) => ({
                ...current,
                trustStrip: { enabled },
              }))}
            />
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
