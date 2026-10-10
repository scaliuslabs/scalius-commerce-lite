/**
 * Collection, category, brand and search pages, as the editor's blocks: the
 * title band and its toolbar pieces, the filters and the product grid. They
 * are the theme's `blocks.listing` (and the store-wide grid density), so one
 * change shows on every listing page.
 */
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  STOREFRONT_DENSITIES,
  STOREFRONT_LISTING_FILTER_STYLES,
  STOREFRONT_LISTING_PAGING,
  STOREFRONT_LISTING_TOOLBAR,
  storefrontBlockSwitch,
  storefrontListingFilterDefaultOrder,
  type StorefrontListingFilterGroup,
  type StorefrontListingFilterStyle,
  type StorefrontListingToolbarPiece,
} from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { MediaPreviews } from "../schema-form/resource-fields";
import { BlockSettingsFields, type SetTheme, type Theme } from "../theme-fields";
import { DensitySketch, Sketch, VisualChoice } from "../ThemeChoices";
import { Field, ChoiceField } from "~/components/ui/field";

type MessageKey = keyof (typeof onlineStoreMessages)["en"];
type Listing = Theme["blocks"]["listing"];

const paletteOf = (theme: Theme) => {
  const { colors } = theme.tokens;
  return { paper: colors.background, ink: colors.foreground, line: colors["muted-foreground"], soft: colors.muted, edge: colors.border, accent: colors.primary };
};

function ListingLayoutSketch({ layout, theme }: { layout: "grid" | "list" | "shelves" | "quick-grid"; theme: Theme }) {
  return (
    <Sketch palette={paletteOf(theme)} className="h-16">
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
  const sidebar = filterStyle.startsWith("sidebar");
  return (
    <Sketch palette={paletteOf(theme)} className="h-16">
      <span data-listing-filter-sketch={filterStyle} className="flex min-h-0 flex-1 flex-col gap-1">
        {!sidebar && <span className="flex h-3 gap-1 border-b border-(--sk-edge) pb-1">
          {(filterStyle === "drawer" ? [0] : [0, 1, 2]).map((item) => <span key={item} className="w-1/4 rounded-full bg-(--sk-soft)" />)}
        </span>}
        <span className="flex min-h-0 flex-1 gap-1">
          {sidebar && <span className="flex w-1/3 flex-col gap-1 border-e border-(--sk-edge) pe-1">
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

/** A switch with its label after it and its help underneath (F2), the switch on the first line. */
export function SwitchField({ id, label, help, checked, onCheckedChange }: {
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <ChoiceField
      id={id}
      label={label}
      help={help}
      control={<Switch id={id} checked={checked} aria-describedby={help ? `${id}-help` : undefined} onCheckedChange={onCheckedChange} />}
    />
  );
}

const setListing = (setDraft: SetTheme, update: (listing: Listing) => Listing) =>
  setDraft((current) => ({ ...current, blocks: { ...current.blocks, listing: update(current.blocks.listing) } }));

/** The toolbar pieces a merchant turns on or off; the rest follow the layout. */
const TOOLBAR_SWITCHES = [
  "breadcrumb", "category-banner", "result-count", "sort", "per-page", "applied-chips", "grid-list-toggle", "subcategory-pills", "facet-value-chips",
] as const satisfies readonly StorefrontListingToolbarPiece[];

function toggleToolbarPiece(toolbar: readonly StorefrontListingToolbarPiece[], piece: StorefrontListingToolbarPiece, on: boolean): StorefrontListingToolbarPiece[] {
  const rest = toolbar.filter((each) => each !== piece);
  if (!on) return rest;
  // A piece turned on joins at its registry place, so the stored list stays tidy.
  const order = Object.keys(STOREFRONT_LISTING_TOOLBAR) as StorefrontListingToolbarPiece[];
  return order.filter((each) => each === piece || rest.includes(each));
}

/** The title band: breadcrumb, banner, count, sort and the other toolbar pieces. */
export function ListingToolbarSettings({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(themeEditorMessages);
  const store = useMessages(onlineStoreMessages);
  const listing = theme.blocks.listing;
  return (
    <div className="space-y-4" data-listing-toolbar>
      <p className="text-body text-muted-foreground">{t("toolbarHelp")}</p>
      {TOOLBAR_SWITCHES.map((piece) => (
        <SwitchField
          key={piece}
          id={`theme-listing-toolbar-${piece}`}
          label={t(`toolbar_${piece}`)}
          help={t(`toolbar_${piece}Help`)}
          checked={listing.toolbar.includes(piece)}
          onCheckedChange={(checked) => setListing(setDraft, (current) => ({ ...current, toolbar: toggleToolbarPiece(current.toolbar, piece, checked) }))}
        />
      ))}
      {listing.toolbar.includes("category-banner") ? (
        <SwitchField
          id="theme-listing-phone-banner"
          label={t("phoneBanner")}
          help={t("phoneBannerHelp")}
          checked={listing.phoneBanner}
          onCheckedChange={(phoneBanner) => setListing(setDraft, (current) => ({ ...current, phoneBanner }))}
        />
      ) : null}
      <Field id="theme-listing-description-placement" label={store("listingDescriptionPlacement")} help={store("listingDescriptionPlacementHelp")}>
        <SearchableSelect
          id="theme-listing-description-placement"
          value={listing.descriptionPlacement}
          options={[
            { value: "below", label: store("listingDescriptionBelow") },
            { value: "above", label: store("listingDescriptionAbove") },
          ]}
          onValueChange={(descriptionPlacement) => setListing(setDraft, (current) => ({ ...current, descriptionPlacement: descriptionPlacement as Listing["descriptionPlacement"] }))}
          triggerClassName="w-full"
        />
      </Field>
    </div>
  );
}

/** How the filters look, whether their groups start open, and their order. */
export function ListingFilterSettings({ theme, setDraft, search }: { theme: Theme; setDraft: SetTheme; search: boolean }) {
  const t = useMessages(onlineStoreMessages);
  const editor = useMessages(themeEditorMessages);
  const filters = theme.blocks.listing.filters;
  const order = filters.order ?? storefrontListingFilterDefaultOrder(filters.style);
  const groupName = (group: StorefrontListingFilterGroup) => t(`filterGroup_${group}` as MessageKey);
  const setFilters = (update: (current: Listing["filters"]) => Listing["filters"]) =>
    setListing(setDraft, (current) => ({ ...current, filters: update(current.filters) }));
  const move = (group: StorefrontListingFilterGroup, delta: -1 | 1) => setFilters((current) => {
    const next = [...(current.order ?? storefrontListingFilterDefaultOrder(current.style))];
    const from = next.indexOf(group);
    const to = from + delta;
    if (to < 0 || to >= next.length) return current;
    [next[from], next[to]] = [next[to]!, next[from]!];
    return { ...current, order: next };
  });
  return (
    <div className="space-y-4" data-listing-filter-style>
      <VisualChoice
        label={t("listingFilters")}
        value={filters.style}
        className="grid-cols-2"
        options={STOREFRONT_LISTING_FILTER_STYLES.map((style) => ({
          value: style,
          label: t(({ "sidebar-dense": "filterStyle_dense", "sidebar-comfortable": "filterStyle_comfortable", "bar-dropdowns": "filterStyle_bar", drawer: "filterStyle_drawer" } as const)[style]),
          sketch: <ListingFilterSketch filterStyle={style} theme={theme} />,
        }))}
        onChange={(style) => setFilters((current) => ({ ...current, style, openByDefault: style === "sidebar-dense" || style === "sidebar-comfortable" }))}
      />
      {filters.style !== "bar-dropdowns" ? (
        <SwitchField
          id="theme-listing-filters-open"
          label={editor("filtersOpen")}
          help={editor("filtersOpenHelp")}
          checked={filters.openByDefault}
          onCheckedChange={(openByDefault) => setFilters((current) => ({ ...current, openByDefault }))}
        />
      ) : null}
      {search && filters.style.startsWith("sidebar") ? (
        <SwitchField
          id="theme-listing-search-drawer"
          label={editor("searchFiltersDrawer")}
          help={editor("searchFiltersDrawerHelp")}
          checked={filters.searchPlacement === "drawer"}
          onCheckedChange={(drawer) => setFilters((current) => ({ ...current, searchPlacement: drawer ? "drawer" : "same" }))}
        />
      ) : null}
      <div className="space-y-2" data-listing-filter-order>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <p className="text-body font-medium">{t("filterOrder")}</p>
            <p className="text-body text-muted-foreground">{t("filterOrderHelp")}</p>
          </div>
          {filters.order ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setFilters((current) => {
              const { order: _order, ...rest } = current;
              return rest as Listing["filters"];
            })}>{t("filterOrderReset")}</Button>
          ) : null}
        </div>
        <ol className="divide-y divide-border rounded-lg bg-muted">
          {order.map((group, index) => {
            const name = groupName(group);
            return (
              <li key={group} className="flex min-h-10 items-center gap-1 px-3" data-filter-group={group}>
                <span className="min-w-0 flex-1 text-body">{name}</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveSectionUp", { name })} disabled={index === 0} onClick={() => move(group, -1)}>
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveSectionDown", { name })} disabled={index === order.length - 1} onClick={() => move(group, 1)}>
                  <ArrowDown aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/** The product grid: arrangement, density, phone layout, paging and, for search, its own layout. */
export function ListingGridSettings({ theme, setDraft, media, search }: { theme: Theme; setDraft: SetTheme; media: MediaPreviews; search: boolean }) {
  const t = useMessages(onlineStoreMessages);
  const editor = useMessages(themeEditorMessages);
  const listing = theme.blocks.listing;
  return (
    <div className="space-y-4" data-listing-default>
      <VisualChoice
        label={t("listingDefault")}
        showLabel
        value={listing.layout.variant}
        className="grid-cols-2"
        options={(["grid", "list", "shelves", "quick-grid"] as const).map((layout) => ({
          value: layout,
          label: t(({ grid: "listingGrid", list: "listingList", shelves: "listingShelves", "quick-grid": "listingQuickGrid" } as const)[layout]),
          help: layout === "shelves" ? t("listingShelvesHelp") : layout === "quick-grid" ? t("listingQuickGridHelp") : undefined,
          sketch: <ListingLayoutSketch layout={layout} theme={theme} />,
        }))}
        onChange={(layout) => setListing(setDraft, (current) => ({
          ...current,
          layout: storefrontBlockSwitch("listing", current.layout, layout) as Listing["layout"],
        }))}
      />
      <BlockSettingsFields slot="listing" theme={theme} setDraft={setDraft} media={media} />
      {search ? (
        <VisualChoice
          label={t("listingSearchDefault")}
          showLabel
          value={listing.searchLayout}
          className="grid-cols-3"
          options={(["same", "grid", "list"] as const).map((layout) => ({
            value: layout,
            label: t(({ same: "listingSearchSame", grid: "listingGrid", list: "listingList" } as const)[layout]),
            sketch: <ListingLayoutSketch layout={layout === "same" ? listing.layout.variant : layout} theme={theme} />,
          }))}
          onChange={(searchLayout) => setListing(setDraft, (current) => ({ ...current, searchLayout }))}
        />
      ) : null}
      <VisualChoice
        label={t("listingPhoneLayout")}
        showLabel
        value={listing.phoneLayout}
        className="grid-cols-2"
        options={([
          { value: "grid", label: t("listingPhoneGrid") },
          { value: "list-row", label: t("listingPhoneRows") },
        ] as const).map((option) => ({ ...option, sketch: <ListingLayoutSketch layout={option.value === "grid" ? "grid" : "list"} theme={theme} /> }))}
        onChange={(phoneLayout) => setListing(setDraft, (current) => ({ ...current, phoneLayout }))}
      />
      <Field id="theme-listing-paging" label={editor("paging")}>
        <SearchableSelect
          id="theme-listing-paging"
          value={listing.paging}
          options={STOREFRONT_LISTING_PAGING.map((paging) => ({ value: paging, label: editor(`paging_${paging}`) }))}
          onValueChange={(paging) => setListing(setDraft, (current) => ({ ...current, paging: paging as Listing["paging"] }))}
          triggerClassName="w-full"
        />
      </Field>
      <VisualChoice
        label={t("density")}
        showLabel
        value={theme.tokens.density}
        className="grid-cols-2"
        options={STOREFRONT_DENSITIES.map((value) => ({
          value,
          label: t(`density_${value}` as MessageKey),
          help: t(`density_${value}Help` as MessageKey),
          sketch: <DensitySketch density={value} />,
        }))}
        onChange={(density) => setDraft((current) => ({ ...current, tokens: { ...current.tokens, density } }))}
      />
      <p className="text-body text-muted-foreground">{t("densityHelp")}</p>
    </div>
  );
}
