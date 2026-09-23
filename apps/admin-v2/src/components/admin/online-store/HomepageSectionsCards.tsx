import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { GripVertical, Trash2 } from "lucide-react";
import { postApiV1AdminSettingsHomepagePresentation } from "@scalius/api-client/sdk";
import {
  MAX_HOMEPAGE_CATEGORY_IDS,
  MAX_HOMEPAGE_CATEGORY_RAIL_TITLE_LENGTH,
  type HomepagePresentationConfig,
} from "@scalius/shared/homepage-presentation";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { SortableList } from "~/components/admin/shared/SortableList";
import { apiData } from "~/lib/api";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { homepageSectionsQueryOptions } from "~/lib/api-query-options/online-store";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { SectionCard, failSave, useDocumentDraft } from "./shared";

/** Featured categories and the delivery & returns strip on the homepage. */
export function HomepageSectionsCards() {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const { data, refetch } = useSuspenseQuery(homepageSectionsQueryOptions());
  const { data: categoryOptions } = useSuspenseQuery(categoryFormOptionsQueryOptions());
  const { draft, setDraft } = useDocumentDraft<HomepagePresentationConfig>({
    saved: data.config,
    save: async (config) => {
      try {
        const saved = await apiData(postApiV1AdminSettingsHomepagePresentation({
          body: { ...config, expectedRevision: data.revision },
        }));
        queryClient.setQueryData(homepageSectionsQueryOptions().queryKey, saved);
      } catch (error) {
        failSave(error, () => void refetch());
      }
    },
  });
  const rail = draft.categoryRail;
  const setRail = (updates: Partial<HomepagePresentationConfig["categoryRail"]>) =>
    setDraft((current) => ({ ...current, categoryRail: { ...current.categoryRail, ...updates } }));
  const categories = categoryOptions.categories;
  const byId = new Map(categories.map((category) => [category.id, category]));
  const selected = rail.categoryIds.map((id) => ({ id, name: byId.get(id)?.name ?? t("unavailableCategory") }));
  const full = selected.length >= MAX_HOMEPAGE_CATEGORY_IDS;

  return (
    <>
      <SectionCard
        title={t("featuredCategories")}
        description={t("featuredCategoriesHelp")}
        action={
          <Switch
            checked={rail.enabled}
            aria-label={t("featuredCategories")}
            onCheckedChange={(enabled) => setRail({ enabled })}
          />
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="homepage-category-title">{t("heading")}</Label>
          <Input
            id="homepage-category-title"
            value={rail.title}
            maxLength={MAX_HOMEPAGE_CATEGORY_RAIL_TITLE_LENGTH}
            onChange={(event) => setRail({ title: event.target.value })}
          />
        </div>
        {selected.length > 0 ? (
          <SortableList
            items={selected}
            onReorder={(items) => setRail({ categoryIds: items.map((item) => item.id) })}
            renderItem={(item, sortable) => (
              <div
                ref={sortable.ref}
                style={sortable.style}
                className={cn(
                  "flex items-center gap-2 rounded-lg border bg-background p-1",
                  sortable.isDragging && "relative z-10 shadow-md",
                )}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 cursor-grab touch-none"
                  aria-label={t("reorderItem", { name: item.name })}
                  {...sortable.dragHandleProps}
                >
                  <GripVertical />
                </Button>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={t("removeItem", { name: item.name })}
                  onClick={() => setRail({ categoryIds: rail.categoryIds.filter((id) => id !== item.id) })}
                >
                  <Trash2 />
                </Button>
              </div>
            )}
          />
        ) : null}
        <SearchableSelect
          value=""
          onValueChange={(id) => setRail({ categoryIds: [...rail.categoryIds, id] })}
          options={categories
            .filter((category) => category.status === "published" && !rail.categoryIds.includes(category.id))
            .map((category) => ({ value: category.id, label: category.name }))}
          placeholder={full ? t("categoryLimit", { count: MAX_HOMEPAGE_CATEGORY_IDS }) : t("addCategory")}
          searchPlaceholder={t("searchCategories")}
          emptyMessage={t("noMoreCategories")}
          disabled={full}
          ariaLabel={t("addCategory")}
          triggerClassName="w-full"
        />
      </SectionCard>

      <SectionCard
        title={t("trustStrip")}
        description={t("trustStripHelp")}
        action={
          <Switch
            checked={draft.trustStrip.enabled}
            aria-label={t("trustStrip")}
            onCheckedChange={(enabled) => setDraft((current) => ({ ...current, trustStrip: { enabled } }))}
          />
        }
      />
    </>
  );
}
