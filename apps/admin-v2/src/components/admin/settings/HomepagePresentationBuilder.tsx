import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_HOMEPAGE_PRESENTATION,
  MAX_HOMEPAGE_CATEGORY_IDS,
  type HomepagePresentationConfig,
} from "@scalius/shared/homepage-presentation";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { Badge } from "~/components/ui/badge";
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

  useEffect(() => {
    if (!presentationQuery.data) return;
    setConfig(cloneConfig(presentationQuery.data.config));
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
  const dirty = saved
    ? JSON.stringify(config) !== JSON.stringify(saved.config)
    : false;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!saved) throw new Error("Reload homepage settings before saving.");
      return saveHomepagePresentation({
        data: { ...config, expectedRevision: saved.revision },
      });
    },
    onSuccess: (document) => {
      setSaved(document);
      setConfig(cloneConfig(document.config));
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
      <div className="flex items-center justify-center py-14">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
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
    <div className="max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Homepage</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Choose what buyers see after featured content.
          </p>
        </div>
        <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
          r{saved?.revision ?? "—"}
        </Badge>
      </div>

      <section className="rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
          <div>
            <Label htmlFor="homepage-category-rail" className="text-sm font-medium">
              Category rail
            </Label>
            <p className="text-xs text-muted-foreground">
              Shown after the first featured collection.
            </p>
          </div>
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

        <div className={cn(
          "space-y-3 px-4 py-4",
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
              className="min-h-11 md:min-h-9"
            />
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
                    <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
                      {item.category.status}
                    </Badge>
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
            <div className="rounded-lg border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
              Add the categories buyers should discover first.
            </div>
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
          <p className="text-xs text-muted-foreground">
            Drag to set the order. Draft and internal categories do not appear.
          </p>
        </div>
      </section>

      <section className="flex items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3">
        <div>
          <Label htmlFor="homepage-trust-strip" className="text-sm font-medium">
            Delivery & returns strip
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Shows available delivery and return details.
          </p>
        </div>
        <Switch
          className="relative after:absolute after:-inset-x-1.5 after:-inset-y-3"
          id="homepage-trust-strip"
          checked={config.trustStrip.enabled}
          onCheckedChange={(enabled) => setConfig((current) => ({
            ...current,
            trustStrip: { enabled },
          }))}
        />
      </section>

      {dirty ? (
        <div className="grid grid-cols-2 gap-2 border-t pt-4 sm:flex sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 md:min-h-10"
            onClick={() => saved && setConfig(cloneConfig(saved.config))}
            disabled={!dirty || saveMutation.isPending || !saved}
          >
            <RotateCcw className="size-4" />
            Reset
          </Button>
          <Button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending || !saved}
            className="min-h-11 min-w-28 md:min-h-10"
          >
            {saveMutation.isPending ? (
              <><Loader2 className="mr-2 size-4 animate-spin" /> Saving…</>
            ) : "Save homepage"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
