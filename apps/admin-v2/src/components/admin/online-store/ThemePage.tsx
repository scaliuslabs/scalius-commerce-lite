import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  postApiV1AdminSettingsThemeDraft,
  postApiV1AdminSettingsThemePublish,
} from "@scalius/api-client/sdk";
import {
  STOREFRONT_DENSITIES,
  STOREFRONT_LISTING_FILTER_STYLES,
  storefrontListingFilterDefaultOrder,
  STOREFRONT_PRODUCT_STICKY,
  storefrontBlockSwitch,
  storefrontBlockVariants,
  type ResolvedStorefrontThemeLayout,
  type StoreShape,
  type StorefrontTemplateId,
  type StorefrontThemeDocument,
  type StorefrontListingFilterStyle,
  type StorefrontListingFilterGroup,
} from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Switch } from "~/components/ui/switch";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { SaveBarProvider, SaveConflict } from "~/components/admin/shared/SaveBar";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { apiData } from "~/lib/api";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import {
  themeWorkspaceQueryOptions,
  type ThemeWorkspaceDocument,
} from "~/lib/api-query-options/online-store";
import { fetchProducts, productsByIdsQueryOptions } from "~/lib/api-query-options/products";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { ProductAppBlocksCard } from "./ProductAppBlocks";
import { Field, OnlineStorePage, SectionCard, actionErrorText, useDocumentDraft } from "./shared";
import { ThemePreviewAction } from "./ThemePreviewAction";
import {
  CardStyleSketch,
  DensitySketch,
  HeaderRows,
  BuyBoxSketch,
  ProductPageSketch,
  ProductTile,
  Sketch,
  VisualChoice,
} from "./ThemeChoices";
import { useMediaPreviews } from "./schema-form/resource-fields";
import { BlockSettingsFields, ColorFields, FitNote, useFitReason, variantRenders, type SetTheme } from "./theme-fields";
import { TypographyCard } from "./TypographyCard";
import {
  OPTIONAL_PRODUCT_MODULES,
  TEMPLATE_THEMES,
  appBlocksByKey,
  applyTemplate,
  blockFallback,
  blockVariant,
  productAppBlockFieldForPath,
  productAppBlocksInvalid,
  resolveThemeForStore,
  selectedTemplate,
  setBlockVariant,
  THEME_FIELD_IDS,
  themeDraftInvalid,
  themeFieldForPath,
  toggleProductModule,
  type ThemeBlockSlot,
} from "./theme-settings";

type Theme = StorefrontThemeDocument;
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** A template's whole look in its own colours: header shape and product cards, as this store renders them. */
function TemplatePreview({ theme, layout }: { theme: Theme; layout: ResolvedStorefrontThemeLayout }) {
  const { colors, radius } = theme.tokens;
  return (
    <Sketch
      palette={{
        paper: colors.background,
        ink: colors.foreground,
        line: colors["muted-foreground"],
        soft: colors.muted,
        edge: colors.border,
        accent: colors.primary,
      }}
      className="h-28"
    >
      {theme.template === "marketplace" ? (
        <span
          data-marketplace-preview
          style={{ "--sk-purchase": colors.accent } as CSSProperties}
          className="flex min-h-0 flex-1 flex-col gap-1"
        >
          <span data-marketplace-header className="flex h-7 shrink-0 flex-col gap-1 rounded-xs bg-(--sk-ink) p-1">
            <span className="flex items-center gap-1">
              <span className="h-1 w-4 bg-(--sk-paper)" />
              <span className="flex h-2 flex-1 overflow-clip rounded-xs bg-(--sk-paper)">
                <span className="ml-auto w-2 bg-(--sk-purchase)" />
              </span>
              <span className="size-1 rounded-full bg-(--sk-paper)" />
              <span className="size-1 rounded-full bg-(--sk-paper)" />
            </span>
            <span className="flex gap-1">
              <span className="h-0.5 w-4 bg-(--sk-paper)" />
              <span className="h-0.5 w-3 bg-(--sk-paper)" />
              <span className="h-0.5 w-3 bg-(--sk-paper)" />
            </span>
          </span>
          <span className="flex min-h-0 flex-1 gap-1">
            <span data-marketplace-category-grid className="grid min-w-0 flex-1 grid-cols-2 gap-1 border-r border-(--sk-edge) pr-1">
              {[0, 1, 2, 3].map((index) => (
                <span key={index} className="flex min-h-0 flex-col gap-0.5 rounded-xs border border-(--sk-edge) p-0.5">
                  <span className="min-h-0 flex-1 bg-(--sk-soft)" />
                  <span className="h-0.5 w-3/4 bg-(--sk-line)" />
                  <span className="h-0.5 w-1/2 bg-(--sk-ink)" />
                </span>
              ))}
            </span>
            <span data-marketplace-search-list className="flex min-w-0 flex-1 flex-col gap-1">
              {[0, 1].map((index) => (
                <span key={index} data-marketplace-result-row className="flex min-h-0 flex-1 gap-1 border-b border-(--sk-edge) pb-0.5 last:border-0">
                  <span className="aspect-square h-full max-h-7 shrink-0 rounded-xs bg-(--sk-soft)" />
                  <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                    <span className="h-1 w-4/5 bg-(--sk-line)" />
                    <span className="h-0.5 w-2/3 bg-(--sk-line)" />
                    <span className="h-1 w-1/3 bg-(--sk-ink)" />
                    <span className="h-1 w-1/2 rounded-full bg-(--sk-purchase)" />
                  </span>
                </span>
              ))}
            </span>
          </span>
        </span>
      ) : (
        <>
          <HeaderRows kind={layout.header} />
          <span className="mt-1 flex justify-center gap-1.5">
            {[0, 1, 2].map((index) => (
              <ProductTile key={index} card={layout.productCard} radius={radius} badge={index === 0} className="max-w-11" />
            ))}
          </span>
        </>
      )}
    </Sketch>
  );
}

function ListingLayoutSketch({ layout, theme }: { layout: "grid" | "list" | "shelves" | "quick-grid"; theme: Theme }) {
  const { colors } = theme.tokens;
  return (
    <Sketch palette={{
      paper: colors.background,
      ink: colors.foreground,
      line: colors["muted-foreground"],
      soft: colors.muted,
      edge: colors.border,
      accent: colors.primary,
    }} className="h-16">
      {layout === "shelves" ? (
        <span data-listing-layout-sketch={layout} className="flex min-h-0 flex-1 flex-col gap-1">
          {[0, 1].map((row) => (
            <span key={row} className="flex min-h-0 flex-1 flex-col gap-0.5">
              <span className="h-0.5 w-1/3 bg-(--sk-ink)" />
              <span className="grid min-h-0 flex-1 grid-cols-3 gap-1">
                {[0, 1, 2].map((card) => <span key={card} className="bg-(--sk-soft)" />)}
              </span>
            </span>
          ))}
        </span>
      ) : (
        <span data-listing-layout-sketch={layout} className={layout === "list" ? "flex min-h-0 flex-1 flex-col gap-1" : `grid min-h-0 flex-1 ${layout === "quick-grid" ? "grid-cols-4" : "grid-cols-3"} gap-1`}>
          {(layout === "quick-grid" ? [0, 1, 2, 3] : [0, 1, 2]).map((index) => (
            <span key={index} className={layout === "list" ? "flex min-h-0 flex-1 gap-1 border-b border-(--sk-edge) pb-0.5 last:border-0" : "flex min-h-0 flex-col gap-0.5 rounded-xs border border-(--sk-edge) p-0.5"}>
              <span className={layout === "list" ? "aspect-square h-full shrink-0 bg-(--sk-soft)" : "min-h-0 flex-1 bg-(--sk-soft)"} />
              <span className={layout === "list" ? "flex min-w-0 flex-1 flex-col justify-center gap-0.5" : "h-0.5 w-3/4 bg-(--sk-ink)"}>
                {layout === "list" && <><span className="h-0.5 w-4/5 bg-(--sk-line)" /><span className="h-0.5 w-1/3 bg-(--sk-ink)" /></>}
              </span>
            </span>
          ))}
        </span>
      )}
    </Sketch>
  );
}

function ListingFilterSketch({ filterStyle, theme }: { filterStyle: StorefrontListingFilterStyle; theme: Theme }) {
  const colors = theme.tokens.colors;
  const sidebar = filterStyle.startsWith("sidebar");
  return (
    <Sketch palette={{ paper: colors.background, ink: colors.foreground, line: colors["muted-foreground"], soft: colors.muted, edge: colors.border, accent: colors.primary }} className="h-16">
      <span data-listing-filter-sketch={filterStyle} className="flex min-h-0 flex-1 flex-col gap-1">
        {!sidebar && <span className="flex h-3 gap-1 border-b border-(--sk-edge) pb-1">
          {(filterStyle === "drawer" ? [0] : [0, 1, 2]).map((item) => <span key={item} className="w-1/4 rounded-full bg-(--sk-soft)" />)}
        </span>}
        <span className="flex min-h-0 flex-1 gap-1">
          {sidebar && <span className="flex w-1/3 flex-col gap-1 border-r border-(--sk-edge) pr-1">
            {[0, 1, 2, 3].map((item) => <span key={item} className="h-1 rounded-full bg-(--sk-line)" />)}
          </span>}
          <span className="grid min-w-0 flex-1 grid-cols-3 gap-1">
            {[0, 1, 2].map((item) => <span key={item} className="rounded-xs bg-(--sk-soft)" />)}
          </span>
        </span>
      </span>
    </Sketch>
  );
}

function SwitchField({
  id,
  label,
  help,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  help: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-note`} className="text-body text-muted-foreground">{help}</p>
      </div>
      <span className="flex h-lh items-center">
        <Switch id={id} checked={checked} aria-describedby={`${id}-note`} onCheckedChange={onCheckedChange} />
      </span>
    </div>
  );
}

const HOME_PRODUCT_PAGE_SIZE = 20;
const loadHomeProducts: SearchableSelectLoader = async ({ search, page }) => {
  const result = await fetchProducts({ page, limit: HOME_PRODUCT_PAGE_SIZE, ...(search ? { search } : {}) });
  return {
    options: result.products.map((product) => ({ value: product.id, label: product.name })),
    hasMore: page < result.pagination.totalPages,
  };
};

/**
 * What `/` shows: the homepage sections, or one product's page (a store that
 * sells one product). A one-product homepage cannot be saved without its product.
 */
function HomeModeCard({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(onlineStoreMessages);
  const mode = theme.pages.homeMode;
  const productId = mode.kind === "product" ? mode.productId : "";
  // Switching to sections and back keeps the product chosen before.
  const [lastProduct, setLastProduct] = useState(productId);
  const { data } = useQuery(productsByIdsQueryOptions(productId ? [productId] : []));
  const productName = data?.products.find((product) => product.id === productId)?.name;
  const setMode = (homeMode: Theme["pages"]["homeMode"]) =>
    setDraft((current) => ({ ...current, pages: { ...current.pages, homeMode } }));
  return (
    <SectionCard title={t("homeMode")} description={t("homeModeHelp")}>
      <RadioGroup
        value={mode.kind}
        aria-label={t("homeMode")}
        onValueChange={(kind) => setMode(kind === "product" ? { kind: "product", productId: productId || lastProduct } : { kind: "sections" })}
      >
        {(["sections", "product"] as const).map((value) => (
          <label key={value} className="flex min-h-11 items-start gap-3 py-1 text-body">
            <RadioGroupItem value={value} className="mt-0.5" />
            <span>
              <span className="block font-medium">{t(`homeMode_${value}`)}</span>
              <span className="block text-muted-foreground">{t(`homeMode_${value}Help`)}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {mode.kind === "product" ? (
        <Field id={THEME_FIELD_IDS.homeProduct} label={t("homeProduct")} error={productId ? undefined : t("chooseProduct")}>
          <SearchableSelect
            id={THEME_FIELD_IDS.homeProduct}
            value={productId}
            selectedLabel={productName}
            load={loadHomeProducts}
            queryKey={["online-store", "home-product"]}
            onValueChange={(value) => {
              setLastProduct(value);
              setMode({ kind: "product", productId: value });
            }}
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

/**
 * The theme, card by card. Choices are resolved against the store's shape
 * with the storefront's own resolver, so a choice that does not fit the
 * store says what buyers see instead.
 */
function ThemeCards({ workspace, refetch }: {
  workspace: ThemeWorkspaceDocument;
  refetch: () => Promise<unknown>;
}) {
  const t = useMessages(onlineStoreMessages);
  const editor = useMessages(themeEditorMessages);
  const queryClient = useQueryClient();
  const storeShape = workspace.storeShape as StoreShape;
  const media = useMediaPreviews(workspace.media);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const appBlocks = useMemo(() => appBlocksByKey(workspace.apps), [workspace.apps]);
  const { draft: theme, dirty, setDraft } = useDocumentDraft<Theme>({
    label: t("themeTitle"),
    saved: workspace.draft.theme as Theme,
    fields: (path, draft) => themeFieldForPath(path) ?? productAppBlockFieldForPath(path, draft),
    invalid: (draft) => themeDraftInvalid(draft) || productAppBlocksInvalid(draft, appBlocks),
    reload: refetch,
    save: async (next) => {
      try {
        const result = await apiData(postApiV1AdminSettingsThemeDraft({
          body: {
            expectedDraftRevision: workspace.draft.revision,
            basePublishedRevision: workspace.draft.basePublishedRevision,
            theme: next,
          },
        }));
        queryClient.setQueryData(themeWorkspaceQueryOptions().queryKey, (previous) => previous && {
          ...previous,
          draft: result,
        });
        setActionError(null);
      } catch (error) {
        if (isAdminApiConflictError(error)) throw new SaveConflict();
        throw error;
      }
    },
  });
  const hasSavedDraft = workspace.draft.revision > 0;
  const hasUnpublishedDraft = hasSavedDraft && JSON.stringify(workspace.draft.theme) !== JSON.stringify(workspace.published.theme);
  const actionDisabled = dirty || publishing;
  const publish = async () => {
    setPublishing(true);
    setActionError(null);
    try {
      const result = await apiData(postApiV1AdminSettingsThemePublish({
        body: {
          expectedPublishedRevision: workspace.published.revision,
          expectedDraftRevision: workspace.draft.revision,
        },
      }));
      queryClient.setQueryData(themeWorkspaceQueryOptions().queryKey, (previous) => previous && {
        ...previous,
        ...result,
      });
      toast.success(t("themePublished"));
    } catch (error) {
      if (isAdminApiConflictError(error)) await refetch();
      setActionError(isAdminApiConflictError(error) ? t("themeActionConflict") : actionErrorText(error));
    } finally {
      setPublishing(false);
    }
  };
  const option = (key: string) => t(key as MessageKey);
  const filterOrder = theme.blocks.listing.filters.order
    ?? storefrontListingFilterDefaultOrder(theme.blocks.listing.filters.style);
  const filterGroupName = (group: StorefrontListingFilterGroup) => t(`filterGroup_${group}` as MessageKey);
  const moveFilterGroup = (group: StorefrontListingFilterGroup, delta: -1 | 1) => setDraft((current) => {
    const next = [...(current.blocks.listing.filters.order
      ?? storefrontListingFilterDefaultOrder(current.blocks.listing.filters.style))];
    const from = next.indexOf(group);
    const to = from + delta;
    if (to < 0 || to >= next.length) return current;
    [next[from], next[to]] = [next[to]!, next[from]!];
    return { ...current, blocks: { ...current.blocks, listing: {
      ...current.blocks.listing, filters: { ...current.blocks.listing.filters, order: next },
    } } };
  });
  const resolved = resolveThemeForStore(theme, storeShape);
  const fitReason = useFitReason(resolved.facts);
  // A changed look matches no template: say which one it is based on, and
  // confirm before another template replaces the merchant's layout choices.
  // Content (logo, words, slides, chosen categories) stays either way.
  const selected = selectedTemplate(theme);
  const [pendingTemplate, setPendingTemplate] = useState<StorefrontTemplateId | null>(null);
  const chooseTemplate = (id: StorefrontTemplateId) => {
    if (selected === null) setPendingTemplate(id);
    else setDraft((current) => applyTemplate(id, current));
  };
  const setBlock = (slot: ThemeBlockSlot) => (variant: string) =>
    setDraft((current) => setBlockVariant(current, slot, variant));
  const blockOptions = <Render,>(slot: ThemeBlockSlot, prefix: string, sketch: (render: Render, variant: string) => ReactNode, help = false) =>
    storefrontBlockVariants(slot).map((value) => ({
      value,
      label: option(`${prefix}_${value}`),
      help: help ? option(`${prefix}_${value}Help`) : undefined,
      sketch: sketch(variantRenders<Render>(slot, value), value),
    }));
  const fitNote = (slot: ThemeBlockSlot, prefix: string) => (
    <FitNote
      fallback={blockFallback(resolved, slot)}
      name={(variant) => option(`${prefix}_${variant}`)}
      reason={fitReason}
    />
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <p role="status" className="text-body text-muted-foreground">
          {dirty ? t("themeSaveDraftFirst") : hasUnpublishedDraft ? t("themeDraftNotLive") : t("themeLive")}
        </p>
        <Button type="button" disabled={actionDisabled || !hasUnpublishedDraft} loading={publishing} onClick={() => setConfirmPublish(true)}>
          {t("themePublish")}
        </Button>
      </div>
      {actionError ? <p role="alert" className="text-body text-destructive">{actionError}</p> : null}
      <SectionCard
        title={editor("title")}
        description={editor("customizeHelp")}
        action={
          <Button asChild>
            <Link to="/admin/online-store/theme/editor">{editor("customize")}</Link>
          </Button>
        }
      />
      <ThemePreviewAction draftRevision={workspace.draft.revision} disabled={actionDisabled} />
      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title={t("themePublishConfirmTitle")}
        description={t("themePublishConfirmBody")}
        confirmLabel={t("themePublish")}
        variant="default"
        onConfirm={() => { setConfirmPublish(false); void publish(); }}
      />
      <SectionCard title={t("themeTemplates")} description={t("themeTemplatesHelp")}>
        {selected === null ? (
          <p className="text-body text-muted-foreground" role="status">
            {t("templateCustomBasedOn", { name: option(`template_${theme.template}`) })}
          </p>
        ) : null}
        <VisualChoice
          label={t("themeTemplates")}
          value={selected}
          className="grid-cols-2 sm:grid-cols-3"
          options={TEMPLATE_THEMES.map((template) => ({
            value: template.id,
            label: option(`template_${template.id}`),
            help: option(`template_${template.id}Help`),
            sketch: <TemplatePreview theme={template.theme} layout={resolveThemeForStore(template.theme, storeShape).layout} />,
          }))}
          onChange={chooseTemplate}
        />
        <ConfirmDialog
          open={pendingTemplate !== null}
          onOpenChange={(open) => { if (!open) setPendingTemplate(null); }}
          title={t("templateReplaceTitle", { name: pendingTemplate ? option(`template_${pendingTemplate}`) : "" })}
          description={t("templateReplaceBody")}
          confirmLabel={t("templateReplaceConfirm")}
          variant="default"
          onConfirm={() => {
            const id = pendingTemplate;
            setPendingTemplate(null);
            if (id) setDraft((current) => applyTemplate(id, current));
          }}
        />
      </SectionCard>

      <SectionCard title={t("colors")}>
        <ColorFields theme={theme} setDraft={setDraft} />
      </SectionCard>

      <TypographyCard theme={theme} setDraft={setDraft} />

      <SectionCard title={t("productCards")}>
        <VisualChoice
          label={t("productCards")}
          value={blockVariant(theme, "card")}
          className="sm:grid-cols-3"
          options={blockOptions<Omit<ResolvedStorefrontThemeLayout["productCard"], "imageRatio">>("card", "cardStyle", (card, variant) => (
            <CardStyleSketch variant={variant} card={{ ...(variant === "quick-add" && theme.blocks.card.variant === variant ? resolved.layout.productCard : card), imageRatio: resolved.layout.productCard.imageRatio }} />
          ), true)}
          onChange={setBlock("card")}
        />
        <BlockSettingsFields slot="card" theme={theme} setDraft={setDraft} media={media} />
      </SectionCard>

      <SectionCard title={t("listingDefault")} description={t("listingDefaultHelp")}>
          <div data-listing-default className="space-y-4">
            <VisualChoice
              label={t("listingDefault")}
              value={theme.blocks.listing.layout.variant}
              className="grid-cols-2 sm:grid-cols-4"
              options={(["grid", "list", "shelves", "quick-grid"] as const).map((layout) => ({
                value: layout,
                label: t(({ grid: "listingGrid", list: "listingList", shelves: "listingShelves", "quick-grid": "listingQuickGrid" } as const)[layout]),
                help: layout === "shelves" ? t("listingShelvesHelp") : layout === "quick-grid" ? t("listingQuickGridHelp") : undefined,
                sketch: <ListingLayoutSketch layout={layout} theme={theme} />,
              }))}
              onChange={(layout) => setDraft((current) => ({
                ...current,
                blocks: {
                  ...current.blocks,
                  listing: {
                    ...current.blocks.listing,
                    layout: storefrontBlockSwitch("listing", current.blocks.listing.layout, layout) as Theme["blocks"]["listing"]["layout"],
                  },
                },
              }))}
            />
            <BlockSettingsFields slot="listing" theme={theme} setDraft={setDraft} media={media} />
            <SwitchField
              id="theme-listing-view-toggle"
              label={t("listingViewSwitch")}
              help={t("listingViewSwitchHelp")}
              checked={theme.blocks.listing.toolbar.includes("grid-list-toggle")}
              onCheckedChange={(checked) => setDraft((current) => ({
                ...current,
                blocks: {
                  ...current.blocks,
                  listing: {
                    ...current.blocks.listing,
                    toolbar: checked
                      ? [...current.blocks.listing.toolbar, "grid-list-toggle"]
                      : current.blocks.listing.toolbar.filter((piece) => piece !== "grid-list-toggle"),
                  },
                },
              }))}
            />
            {theme.blocks.listing.links === "tabs" && <SwitchField
              id="theme-listing-category-tabs"
              label={t("listingCategoryTabs")}
              help={t("listingCategoryTabsHelp")}
              checked={theme.blocks.listing.toolbar.includes("subcategory-pills")}
              onCheckedChange={(checked) => setDraft((current) => ({
                ...current,
                blocks: {
                  ...current.blocks,
                  listing: {
                    ...current.blocks.listing,
                    toolbar: checked
                      ? [...current.blocks.listing.toolbar, "subcategory-pills"]
                      : current.blocks.listing.toolbar.filter((piece) => piece !== "subcategory-pills"),
                  },
                },
              }))}
            />}
            {theme.blocks.listing.links === "tabs" && <SwitchField
              id="theme-listing-facet-chips"
              label={t("listingFacetChips")}
              help={t("listingFacetChipsHelp")}
              checked={theme.blocks.listing.toolbar.includes("facet-value-chips")}
              onCheckedChange={(checked) => setDraft((current) => ({
                ...current,
                blocks: {
                  ...current.blocks,
                  listing: {
                    ...current.blocks.listing,
                    toolbar: checked
                      ? [...current.blocks.listing.toolbar, "facet-value-chips"]
                      : current.blocks.listing.toolbar.filter((piece) => piece !== "facet-value-chips"),
                  },
                },
              }))}
            />}
            <VisualChoice
              label={t("listingSearchDefault")}
              showLabel
              value={theme.blocks.listing.searchLayout}
              className="grid-cols-3"
              options={(["same", "grid", "list"] as const).map((layout) => ({
                value: layout,
                label: t(({ same: "listingSearchSame", grid: "listingGrid", list: "listingList" } as const)[layout]),
                sketch: <ListingLayoutSketch layout={layout === "same" ? theme.blocks.listing.layout.variant : layout} theme={theme} />,
              }))}
              onChange={(searchLayout) => setDraft((current) => ({
                ...current,
                blocks: { ...current.blocks, listing: { ...current.blocks.listing, searchLayout } },
              }))}
            />
            <VisualChoice
              label={t("listingPhoneLayout")}
              showLabel
              value={theme.blocks.listing.phoneLayout}
              className="grid-cols-2"
              options={([
                { value: "grid", label: t("listingPhoneGrid") },
                { value: "list-row", label: t("listingPhoneRows") },
              ] as const).map((option) => ({ ...option, sketch: <ListingLayoutSketch layout={option.value === "grid" ? "grid" : "list"} theme={theme} /> }))}
              onChange={(phoneLayout) => setDraft((current) => ({
                ...current,
                blocks: { ...current.blocks, listing: { ...current.blocks.listing, phoneLayout } },
              }))}
            />
            <div className="space-y-1">
              <Label htmlFor="theme-listing-description-placement">{t("listingDescriptionPlacement")}</Label>
              <p className="text-body text-muted-foreground">{t("listingDescriptionPlacementHelp")}</p>
              <SearchableSelect
                id="theme-listing-description-placement"
                value={theme.blocks.listing.descriptionPlacement}
                options={([
                  { value: "below", label: t("listingDescriptionBelow") },
                  { value: "above", label: t("listingDescriptionAbove") },
                ] as const)}
                onValueChange={(descriptionPlacement) => setDraft((current) => ({
                  ...current,
                  blocks: { ...current.blocks, listing: { ...current.blocks.listing, descriptionPlacement: descriptionPlacement as "above" | "below" } },
                }))}
                triggerClassName="w-full"
              />
            </div>
          </div>
      </SectionCard>

      <SectionCard title={t("listingFilters")} description={t("listingFiltersHelp")}>
        <div data-listing-filter-style>
          <VisualChoice
            label={t("listingFilters")}
            value={theme.blocks.listing.filters.style}
            className="grid-cols-2 sm:grid-cols-4"
            options={STOREFRONT_LISTING_FILTER_STYLES.map((style) => ({
              value: style,
              label: t(({
                "sidebar-dense": "filterStyle_dense",
                "sidebar-comfortable": "filterStyle_comfortable",
                "bar-dropdowns": "filterStyle_bar",
                drawer: "filterStyle_drawer",
              } as const)[style]),
              sketch: <ListingFilterSketch filterStyle={style} theme={theme} />,
            }))}
            onChange={(style) => setDraft((current) => ({
              ...current,
              blocks: {
                ...current.blocks,
                listing: {
                  ...current.blocks.listing,
                  filters: {
                    ...current.blocks.listing.filters,
                    style,
                    openByDefault: style === "sidebar-dense" || style === "sidebar-comfortable",
                  },
                },
              },
            }))}
          />
        </div>
        <div className="mt-5 space-y-2" data-listing-filter-order>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-body font-medium">{t("filterOrder")}</p>
              <p className="text-caption text-muted-foreground">{t("filterOrderHelp")}</p>
            </div>
            {theme.blocks.listing.filters.order && (
              <Button type="button" variant="outline" size="sm" onClick={() => setDraft((current) => {
                const filters = { ...current.blocks.listing.filters };
                delete filters.order;
                return { ...current, blocks: { ...current.blocks, listing: { ...current.blocks.listing, filters } } };
              })}>{t("filterOrderReset")}</Button>
            )}
          </div>
          <ol className="divide-y rounded-lg border">
            {filterOrder.map((group, index) => {
              const name = filterGroupName(group);
              return <li key={group} className="flex min-h-11 items-center gap-2 px-3" data-filter-group={group}>
                <span className="min-w-0 flex-1 text-body">{name}</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveSectionUp", { name })}
                  aria-disabled={index === 0} onClick={() => moveFilterGroup(group, -1)}><ArrowUp aria-hidden="true" /></Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveSectionDown", { name })}
                  aria-disabled={index === filterOrder.length - 1} onClick={() => moveFilterGroup(group, 1)}><ArrowDown aria-hidden="true" /></Button>
              </li>;
            })}
          </ol>
        </div>
      </SectionCard>

      <SectionCard title={t("density")} description={t("densityHelp")}>
        <VisualChoice
          label={t("density")}
          value={theme.tokens.density}
          className="grid-cols-2"
          options={STOREFRONT_DENSITIES.map((value) => ({
            value,
            label: option(`density_${value}`),
            help: option(`density_${value}Help`),
            sketch: <DensitySketch density={value} />,
          }))}
          onChange={(density) => setDraft((current) => ({ ...current, tokens: { ...current.tokens, density } }))}
        />
      </SectionCard>

      <SectionCard title={t("productPage")}>
        <VisualChoice
          label={t("productPage")}
          value={blockVariant(theme, "gallery")}
          options={blockOptions<ResolvedStorefrontThemeLayout["productPage"]>("gallery", "productPage", (layout) => <ProductPageSketch layout={layout} />)}
          onChange={setBlock("gallery")}
        />
        <BlockSettingsFields slot="gallery" theme={theme} setDraft={setDraft} media={media} />
      </SectionCard>

      <SectionCard title={t("purchasePanel")}>
        <VisualChoice
          label={t("purchasePanel")}
          value={blockVariant(theme, "buyBox")}
          className="grid-cols-2 sm:grid-cols-4"
          options={blockOptions<ResolvedStorefrontThemeLayout["buyBox"]>("buyBox", "buyBox", (box) => <BuyBoxSketch box={box} />)}
          onChange={setBlock("buyBox")}
        />
        {fitNote("buyBox", "buyBox")}
        <BlockSettingsFields slot="buyBox" theme={theme} setDraft={setDraft} media={media} />
      </SectionCard>

      <SectionCard title={t("productPageExtras")} description={t("productPageExtrasHelp")}>
        <div className="space-y-4" data-product-page-extras>
          {OPTIONAL_PRODUCT_MODULES.map((module) => (
            <SwitchField
              key={module}
              id={`theme-product-module-${module}`}
              label={t(`productModule_${module}`)}
              help={t(`productModule_${module}Help`)}
              checked={theme.blocks.product.below.includes(module)}
              onCheckedChange={(checked) => setDraft((current) => ({
                ...current,
                blocks: { ...current.blocks, product: { ...current.blocks.product, below: toggleProductModule(current.blocks.product.below, module, checked) } },
              }))}
            />
          ))}
          <SwitchField
            id="theme-sticky-phone-buy-bar"
            label={t("stickyPhoneBuyBar")}
            help={t("stickyPhoneBuyBarHelp")}
            checked={theme.blocks.product.sticky.phoneBottom === "buy-bar"}
            onCheckedChange={(checked) => setDraft((current) => ({
              ...current,
              blocks: { ...current.blocks, product: { ...current.blocks.product, sticky: { ...current.blocks.product.sticky, phoneBottom: checked ? "buy-bar" : "none" } } },
            }))}
          />
          <SwitchField
            id="theme-sticky-phone-anchor-bar"
            label={t("stickyPhoneAnchorBar")}
            help={t("stickyPhoneAnchorBarHelp")}
            checked={theme.blocks.product.sticky.phoneTop === "anchor-bar"}
            onCheckedChange={(checked) => setDraft((current) => ({
              ...current,
              blocks: { ...current.blocks, product: { ...current.blocks.product, sticky: { ...current.blocks.product.sticky, phoneTop: checked ? "anchor-bar" : "none" } } },
            }))}
          />
          <div className="space-y-1">
            <Label htmlFor="theme-sticky-desktop">{t("stickyDesktop")}</Label>
            <p className="text-body text-muted-foreground">{t("stickyDesktopHelp")}</p>
            <SearchableSelect
              id="theme-sticky-desktop"
              value={theme.blocks.product.sticky.desktop}
              options={STOREFRONT_PRODUCT_STICKY.desktop.map((value) => ({ value, label: t(`stickyDesktop_${value}`) }))}
              onValueChange={(desktop) => setDraft((current) => ({
                ...current,
                blocks: { ...current.blocks, product: { ...current.blocks.product, sticky: { ...current.blocks.product.sticky, desktop: desktop as Theme["blocks"]["product"]["sticky"]["desktop"] } } },
              }))}
              triggerClassName="w-full"
            />
          </div>
        </div>
      </SectionCard>

      <ProductAppBlocksCard theme={theme} apps={workspace.apps} setDraft={setDraft} />

      <HomeModeCard theme={theme} setDraft={setDraft} />

    </>
  );
}

function ThemeSettings() {
  const { data: workspace, refetch } = useSuspenseQuery(themeWorkspaceQueryOptions());
  return <ThemeCards workspace={workspace} refetch={refetch} />;
}

/**
 * The Theme page, the theme's overview: what it is based on, its colours,
 * fonts and store-wide page layouts (cards, listings, product pages), with
 * Customize opening the editor for homepage sections, the logo, header and
 * footer. One draft: Save stores it privately, Preview shows it, Publish
 * makes it live.
 */
export function ThemePage() {
  const t = useMessages(onlineStoreMessages);
  return (
    <SaveBarProvider savedMessage={t("themeDraftSaved")}>
      <OnlineStorePage title={t("themeTitle")}>
        <ThemeSettings />
      </OnlineStorePage>
    </SaveBarProvider>
  );
}
