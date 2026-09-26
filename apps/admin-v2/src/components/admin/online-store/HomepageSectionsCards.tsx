import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
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
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SortableList } from "~/components/admin/shared/SortableList";
import { apiData } from "~/lib/api";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { fetchProducts, productsByIdsQueryOptions } from "~/lib/api-query-options/products";
import type { SearchableSelectLoader } from "~/components/ui/searchable-select";
import { landingHomeMessages } from "~/i18n/landing-home";
import { homepageSectionsQueryOptions } from "~/lib/api-query-options/online-store";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { Field, SectionCard, failSave, useDocumentDraft } from "./shared";

const PRODUCT_PAGE_SIZE = 20;
const landingProductLoader: SearchableSelectLoader = async ({ search, page }) => {
  const result = await fetchProducts({ page, limit: PRODUCT_PAGE_SIZE, ...(search ? { search } : {}) });
  return {
    options: result.products.map((product) => ({ value: product.id, label: product.name })),
    hasMore: page < result.pagination.totalPages,
  };
};

/** What the homepage is, the delivery & returns strip, and the featured categories. */
export function HomepageSectionsCards() {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const { data, refetch } = useSuspenseQuery(homepageSectionsQueryOptions());
  const { data: categoryOptions } = useSuspenseQuery(categoryFormOptionsQueryOptions());
  const { draft, setDraft } = useDocumentDraft<HomepagePresentationConfig>({
    label: t("featuredCategories"),
    saved: data.config,
    fields: (path) => (path === "categoryRail.title" ? "homepage-category-title" : undefined),
    // A landing homepage needs its product (the server would fall back to the catalog).
    invalid: (config) => config.homeMode === "landing" && !config.landingProductId,
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
        <Field id="homepage-category-title" label={t("heading")}>
          <Input
            id="homepage-category-title"
            value={rail.title}
            maxLength={MAX_HOMEPAGE_CATEGORY_RAIL_TITLE_LENGTH}
            onChange={(event) => setRail({ title: event.target.value })}
          />
        </Field>
        {selected.length > 0 ? (
          <SortableList
            items={selected}
            onReorder={(items) => setRail({ categoryIds: items.map((item) => item.id) })}
            renderItem={(item, sortable) => (
              <div
                ref={sortable.ref}
                style={sortable.style}
                className={cn(
                  "flex items-center gap-2 rounded-lg border bg-card p-1",
                  sortable.isDragging && "relative z-10",
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
                <span className="min-w-0 flex-1 truncate text-body font-medium">{item.name}</span>
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

      <LandingHomeCard
        mode={draft.homeMode}
        productId={draft.landingProductId}
        onChange={(homeMode, landingProductId) => setDraft((current) => ({ ...current, homeMode, landingProductId }))}
      />

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

/**
 * A single-product store can open on that product's landing page (the
 * showcase landing template) instead of the catalog homepage.
 */
function LandingHomeCard({ mode, productId, onChange }: {
  mode: HomepagePresentationConfig["homeMode"];
  productId: string | null;
  onChange: (mode: HomepagePresentationConfig["homeMode"], productId: string | null) => void;
}) {
  const t = useMessages(landingHomeMessages);
  const { data } = useQuery(productsByIdsQueryOptions(productId ? [productId] : []));
  const productName = data?.products.find((product) => product.id === productId)?.name;
  return (
    <SectionCard title={t("title")} description={t("description")}>
      <RadioGroup value={mode} onValueChange={(value) => onChange(value as typeof mode, productId)}>
        {(["catalog", "landing"] as const).map((value) => (
          <label key={value} className="flex min-h-11 items-start gap-3 py-1 text-body">
            <RadioGroupItem value={value} className="mt-0.5" />
            <span>
              <span className="block font-medium">{t(value)}</span>
              <span className="block text-muted-foreground">{t(`${value}Help`)}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {mode === "landing" ? (
        <Field id="homepage-landing-product" label={t("product")} error={productId ? undefined : t("chooseProduct")}>
          <SearchableSelect
            id="homepage-landing-product"
            value={productId ?? ""}
            selectedLabel={productName}
            load={landingProductLoader}
            queryKey={["online-store", "landing-product"]}
            onValueChange={(value) => onChange(mode, value || null)}
            placeholder={t("chooseProduct")}
            searchPlaceholder={t("searchProducts")}
            emptyMessage={t("noProducts")}
            triggerClassName="w-full"
          />
        </Field>
      ) : null}
    </SectionCard>
  );
}
