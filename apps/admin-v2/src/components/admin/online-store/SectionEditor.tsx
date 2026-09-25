import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageIcon, Pencil, Trash2 } from "lucide-react";
import { getApiV1AdminCollections } from "@scalius/api-client/sdk";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import {
  STOREFRONT_MAX_SECTIONS,
  STOREFRONT_SECTION_REGISTRY,
  storefrontSectionDefault,
  storefrontSectionNeedsContent,
  type StorefrontProductSource,
  type StorefrontSection,
  type StorefrontSectionOf,
  type StorefrontSectionType,
} from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { MediaManager } from "~/components/admin/media-manager";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { apiData } from "~/lib/api";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { collectionsByIdsQueryOptions } from "~/lib/api-query-options/collections";
import { discountsQueryOptions } from "~/lib/api-query-options/discounts";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { HomepageOrder } from "./ThemeChoices";

type MessageKey = keyof (typeof onlineStoreMessages)["en"];
type Section = StorefrontSection;
type Settings<Type extends StorefrontSectionType> = StorefrontSectionOf<Type>["settings"];

/** An image the section editor can preview: the saved sections' images plus this session's picks. */
export interface SectionMediaPreview {
  id: string;
  url: string;
  alt: string;
}

/** Section types with a settings form here. The rest show store data only. */
const EDITABLE = new Set<StorefrontSectionType>([
  "usp-strip",
  "category-tiles",
  "product-rail",
  "product-grid",
  "deal-block",
  "product-tabs",
  "shop-by",
  "banner-mosaic",
  "brand-wall",
  "recently-viewed",
  "banner",
  "endless-grid",
  "seo-text",
]);

/** What "Add section" offers: every editable type, plus the data-only ones. */
const ADDABLE: readonly StorefrontSectionType[] = [
  "category-tiles",
  "collections",
  "product-rail",
  "product-grid",
  "deal-block",
  "product-tabs",
  "shop-by",
  "banner-mosaic",
  "banner",
  "brand-wall",
  "recently-viewed",
  "usp-strip",
  "endless-grid",
  "seo-text",
];

const SOURCE_KINDS = ["newest", "on-sale", "popular", "collection", "category"] as const;

/** A new section id: the type, then -2, -3… until it is free. */
export function newSectionId(type: StorefrontSectionType, sections: readonly Section[]): string {
  const taken = new Set(sections.map((each) => each.id));
  if (!taken.has(type)) return type;
  for (let number = 2; ; number += 1) {
    if (!taken.has(`${type}-${number}`)) return `${type}-${number}`;
  }
}

/** Settings errors by path under `settings` ("cards.0.href"), as message keys with values. */
export function sectionErrors(section: Section): Map<string, { key: MessageKey; values?: Record<string, number> }> {
  const result = STOREFRONT_SECTION_REGISTRY[section.type].schema.safeParse(section);
  const errors = new Map<string, { key: MessageKey; values?: Record<string, number> }>();
  if (result.success) return errors;
  for (const issue of result.error.issues) {
    const path = issue.path.slice(1).join(".");
    if (errors.has(path)) continue;
    if (issue.code === "too_small" && issue.origin === "array") {
      errors.set(path, { key: "fieldCount", values: { count: Number(issue.minimum) } });
    } else if (issue.code === "too_big") {
      errors.set(path, { key: "fieldTooLong" });
    } else if (issue.code === "invalid_format" || /\.href$|^href$/.test(path)) {
      errors.set(path, { key: "linkInvalid" });
    } else {
      errors.set(path, { key: "fieldRequired" });
    }
  }
  return errors;
}

type FieldError = (path: string) => string | undefined;

function Field({ id, label, help, error, children }: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help ? <p className="text-body text-muted-foreground">{help}</p> : null}
      {error ? <p id={`${id}-note`} role="alert" className="text-body text-destructive">{error}</p> : null}
    </div>
  );
}

function TextField({ id, label, help, value, onChange, error, multiline = false }: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  multiline?: boolean;
}) {
  const invalid = error ? { "aria-invalid": true, "aria-describedby": `${id}-note` } : {};
  return (
    <Field id={id} label={label} help={help} error={error}>
      {multiline ? (
        <Textarea id={id} value={value} rows={6} onChange={(event) => onChange(event.target.value)} {...invalid} />
      ) : (
        <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} {...invalid} />
      )}
    </Field>
  );
}

function ChoiceField<Value extends string | number>({ id, label, help, value, options, onChange }: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
}) {
  return (
    <Field id={id} label={label} help={help}>
      <NativeSelect
        id={id}
        value={String(value)}
        onValueChange={(next) => onChange(options.find((option) => String(option.value) === next)!.value)}
      >
        {options.map((option) => <option key={option.value} value={String(option.value)}>{option.label}</option>)}
      </NativeSelect>
    </Field>
  );
}

const numbers = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => ({ value: from + index, label: formatNumber(from + index) }));

/** One image from Files: a preview, then Select or Change. */
function MediaField({ label, mediaId, previews, onPick, error }: {
  label: string;
  mediaId: string | null;
  previews: ReadonlyMap<string, SectionMediaPreview>;
  onPick: (image: SectionMediaPreview) => void;
  error?: string;
}) {
  const t = useMessages(onlineStoreMessages);
  const preview = mediaId ? previews.get(mediaId) : undefined;
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-16 w-24 shrink-0 place-items-center overflow-clip rounded-lg border bg-muted">
        {preview ? (
          <img src={mediaImageUrl(preview.url, 320)} alt="" className="size-full object-cover" />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-body font-medium">{label}</p>
        <MediaManager
          capability="image"
          onSelect={(file) => onPick({ id: file.id, url: file.url, alt: file.altText?.trim() ?? "" })}
          trigger={
            <Button type="button" variant="outline" size="sm">
              {mediaId ? t("changeImage") : t("selectImage")}
            </Button>
          }
        />
        {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

const loadCollections: SearchableSelectLoader = async ({ search, page, signal }) => {
  const data = await apiData(getApiV1AdminCollections({ query: { page, limit: 20, search: search || undefined }, signal }));
  return {
    options: data.collections.map((collection) => ({ value: collection.id, label: collection.name })),
    hasMore: data.pagination.page < data.pagination.totalPages,
  };
};

function CollectionSelect({ id, value, onChange, invalid }: {
  id: string;
  value: string;
  onChange: (id: string) => void;
  invalid: boolean;
}) {
  const t = useMessages(onlineStoreMessages);
  const chosen = useQuery({ ...collectionsByIdsQueryOptions(value ? [value] : []), enabled: Boolean(value) });
  return (
    <SearchableSelect
      id={id}
      value={value}
      load={loadCollections}
      queryKey={["homepage-section-collections"]}
      selectedLabel={chosen.data?.collections.find((collection) => collection.id === value)?.name}
      onValueChange={onChange}
      placeholder={t("pickCollection")}
      searchPlaceholder={t("searchCollections")}
      emptyMessage={t("noCollections")}
      ariaLabel={t("pickCollection")}
      aria-invalid={invalid || undefined}
      triggerClassName="w-full"
    />
  );
}

function CategorySelect({ id, value, onChange, invalid }: {
  id: string;
  value: string;
  onChange: (id: string) => void;
  invalid: boolean;
}) {
  const t = useMessages(onlineStoreMessages);
  const { data } = useQuery(categoryFormOptionsQueryOptions());
  const options = (data?.categories ?? [])
    .filter((category) => category.status === "published" || category.id === value)
    .map((category) => ({ value: category.id, label: category.name }));
  return (
    <SearchableSelect
      id={id}
      value={value}
      options={options}
      onValueChange={onChange}
      placeholder={t("pickCategory")}
      searchPlaceholder={t("searchCategories")}
      emptyMessage={t("noMoreCategories")}
      ariaLabel={t("pickCategory")}
      aria-invalid={invalid || undefined}
      triggerClassName="w-full"
    />
  );
}

/** Where a row, grid, deal or tab takes its products from. */
function SourceField({ id, label, source, onChange, error }: {
  id: string;
  label: ReactNode;
  source: StorefrontProductSource;
  onChange: (source: StorefrontProductSource) => void;
  error: FieldError;
}) {
  const t = useMessages(onlineStoreMessages);
  const setKind = (kind: StorefrontProductSource["kind"]) => {
    if (kind === source.kind) return;
    onChange(kind === "collection" ? { kind, collectionId: "" } : kind === "category" ? { kind, categoryId: "" } : { kind });
  };
  const pickError = source.kind === "collection" ? error("source.collectionId") : source.kind === "category" ? error("source.categoryId") : undefined;
  return (
    <Field id={id} label={label} error={pickError}>
      <div className="space-y-2">
        <NativeSelect id={id} value={source.kind} onValueChange={(kind) => setKind(kind as StorefrontProductSource["kind"])}>
          {SOURCE_KINDS.map((kind) => <option key={kind} value={kind}>{t(`productSource_${kind}`)}</option>)}
        </NativeSelect>
        {source.kind === "collection" ? (
          <CollectionSelect
            id={`${id}-collection`}
            value={source.collectionId}
            invalid={Boolean(pickError)}
            onChange={(collectionId) => onChange({ kind: "collection", collectionId })}
          />
        ) : null}
        {source.kind === "category" ? (
          <CategorySelect
            id={`${id}-category`}
            value={source.categoryId}
            invalid={Boolean(pickError)}
            onChange={(categoryId) => onChange({ kind: "category", categoryId })}
          />
        ) : null}
      </div>
    </Field>
  );
}

/** A deal's countdown: a running discount with an end date, or none. */
function PromotionField({ id, value, onChange }: {
  id: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const { data } = useQuery(discountsQueryOptions());
  const now = Date.now() / 1000;
  const live = (data ?? []).filter((discount) =>
    discount.deletedAtEpochSeconds === null
    && discount.status !== "archived"
    && discount.endsAtEpochSeconds !== null
    && discount.endsAtEpochSeconds > now);
  const options = live.map((discount) => ({
    value: discount.id,
    label: discount.title?.trim() || discount.name,
    description: t("promotionEnds", {
      date: formatDateTime(new Date(discount.endsAtEpochSeconds! * 1000), { dateStyle: "medium", timeStyle: "short" }),
    }),
  }));
  const saved = (data ?? []).find((discount) => discount.id === value);
  return (
    <Field id={id} label={t("dealPromotion")} help={t("dealPromotionHelp")}>
      <SearchableSelect
        id={id}
        value={value ?? ""}
        options={options}
        clearable
        selectedLabel={saved ? saved.title?.trim() || saved.name : undefined}
        onValueChange={(next) => onChange(next || null)}
        placeholder={t("dealNoPromotion")}
        searchPlaceholder={t("searchPromotions")}
        emptyMessage={t("noPromotions")}
        ariaLabel={t("dealPromotion")}
        triggerClassName="w-full"
      />
    </Field>
  );
}

/** A list of repeatable items with Add and per-item Remove. */
function ItemList({ label, help, count, max, addLabel, onAdd, error, children }: {
  label: string;
  help: string;
  count: number;
  max: number;
  addLabel: string;
  onAdd: () => void;
  error?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-body font-medium">{label}</legend>
      <p className="text-body text-muted-foreground">{help}</p>
      {children}
      {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
      {count < max ? <Button type="button" variant="outline" size="sm" onClick={onAdd}>{addLabel}</Button> : null}
    </fieldset>
  );
}

function ItemRow({ removeLabel, onRemove, children }: { removeLabel: string; onRemove: () => void; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 border-t border-border pt-3">
      <div className="min-w-0 flex-1 space-y-3">{children}</div>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={removeLabel} onClick={onRemove}>
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

const replaceAt = <Item,>(items: readonly Item[], index: number, item: Item) =>
  items.map((each, at) => (at === index ? item : each));
const removeAt = <Item,>(items: readonly Item[], index: number) => items.filter((_, at) => at !== index);

/** The settings form for one section; `update` replaces its settings. */
function SettingsForm({ section, update, error, previews, onPickMedia }: {
  section: Section;
  update: (settings: Section["settings"]) => void;
  error: FieldError;
  previews: ReadonlyMap<string, SectionMediaPreview>;
  onPickMedia: (image: SectionMediaPreview) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const id = (field: string) => `section-${section.id}-${field}`;
  const titleField = (settings: { title: string }, set: (title: string) => void, help: ReactNode = t("sectionTitleHelp")) => (
    <TextField id={id("title")} label={t("sectionTitle")} help={help} value={settings.title} onChange={set} error={error("title")} />
  );
  const pick = (set: (image: SectionMediaPreview) => void) => (image: SectionMediaPreview) => {
    onPickMedia(image);
    set(image);
  };

  switch (section.type) {
    case "usp-strip": {
      const settings = section.settings;
      const set = (next: Partial<Settings<"usp-strip">>) => update({ ...settings, ...next });
      const items = settings.source.kind === "custom" ? settings.source.items : [];
      const setItems = (next: Array<{ title: string; detail: string }>) => set({ source: { kind: "custom", items: next } });
      return (
        <>
          <ChoiceField
            id={id("style")}
            label={t("sectionStyle")}
            value={settings.style}
            options={(["icons", "ticker"] as const).map((value) => ({ value, label: t(`uspStyle_${value}`) }))}
            onChange={(style) => set({ style })}
          />
          <ChoiceField
            id={id("source")}
            label={t("uspSource")}
            value={settings.source.kind}
            options={(["delivery-facts", "custom"] as const).map((value) => ({ value, label: t(`uspSource_${value}`) }))}
            onChange={(kind) => set({ source: kind === "custom" ? { kind, items: [{ title: "", detail: "" }] } : { kind } })}
          />
          {settings.source.kind === "custom" ? (
            <ItemList
              label={t("uspSource_custom")}
              help=""
              count={items.length}
              max={4}
              addLabel={t("addPoint")}
              onAdd={() => setItems([...items, { title: "", detail: "" }])}
              error={error("source.items")}
            >
              {items.map((item, index) => (
                <ItemRow key={index} removeLabel={t("removePoint", { number: index + 1 })} onRemove={() => setItems(removeAt(items, index))}>
                  <TextField
                    id={id(`point-${index}`)}
                    label={t("uspItemTitle", { number: index + 1 })}
                    value={item.title}
                    error={error(`source.items.${index}.title`)}
                    onChange={(title) => setItems(replaceAt(items, index, { ...item, title }))}
                  />
                  <TextField
                    id={id(`point-${index}-detail`)}
                    label={t("uspItemDetail", { number: index + 1 })}
                    value={item.detail}
                    error={error(`source.items.${index}.detail`)}
                    onChange={(detail) => setItems(replaceAt(items, index, { ...item, detail }))}
                  />
                </ItemRow>
              ))}
            </ItemList>
          ) : null}
        </>
      );
    }
    case "category-tiles":
      return (
        <ChoiceField
          id={id("style")}
          label={t("sectionStyle")}
          value={section.settings.style}
          options={(["icons", "round", "photo", "quad"] as const).map((value) => ({ value, label: t(`tileStyle_${value}`) }))}
          onChange={(style) => update({ style })}
        />
      );
    case "product-rail": {
      const settings = section.settings;
      return (
        <>
          {titleField(settings, (title) => update({ ...settings, title }))}
          <SourceField id={id("source")} label={t("productSource")} source={settings.source} error={error} onChange={(source) => update({ ...settings, source })} />
          <ChoiceField id={id("limit")} label={t("productLimit")} value={settings.limit} options={numbers(4, 24)} onChange={(limit) => update({ ...settings, limit })} />
        </>
      );
    }
    case "product-grid": {
      const settings = section.settings;
      return (
        <>
          {titleField(settings, (title) => update({ ...settings, title }))}
          <SourceField id={id("source")} label={t("productSource")} source={settings.source} error={error} onChange={(source) => update({ ...settings, source })} />
          <div className="grid grid-cols-2 gap-3">
            <ChoiceField id={id("columns")} label={t("gridColumns")} value={settings.columns} options={numbers(2, 6)} onChange={(columns) => update({ ...settings, columns })} />
            <ChoiceField id={id("rows")} label={t("gridRows")} value={settings.rows} options={numbers(1, 6)} onChange={(rows) => update({ ...settings, rows })} />
          </div>
        </>
      );
    }
    case "deal-block": {
      // The retired typed-in end date is dropped on the first edit.
      const { endsAt: _retired, ...settings } = section.settings;
      return (
        <>
          {titleField(settings, (title) => update({ ...settings, title }))}
          <SourceField id={id("source")} label={t("productSource")} source={settings.source} error={error} onChange={(source) => update({ ...settings, source })} />
          <PromotionField id={id("promotion")} value={settings.promotionId ?? null} onChange={(promotionId) => update({ ...settings, promotionId })} />
        </>
      );
    }
    case "product-tabs": {
      const settings = section.settings;
      const setTabs = (tabs: Settings<"product-tabs">["tabs"]) => update({ ...settings, tabs });
      return (
        <>
          {titleField(settings, (title) => update({ ...settings, title }))}
          <ChoiceField id={id("limit")} label={t("productLimit")} value={settings.limit} options={numbers(4, 12)} onChange={(limit) => update({ ...settings, limit })} />
          <ItemList
            label={t("productTabs")}
            help={t("productTabsHelp")}
            count={settings.tabs.length}
            max={4}
            addLabel={t("addTab")}
            onAdd={() => setTabs([...settings.tabs, { label: "", source: { kind: "newest" } }])}
            error={error("tabs")}
          >
            {settings.tabs.map((tab, index) => (
              <ItemRow key={index} removeLabel={t("removeTab", { number: index + 1 })} onRemove={() => setTabs(removeAt(settings.tabs, index))}>
                <TextField
                  id={id(`tab-${index}`)}
                  label={t("tabLabel", { number: index + 1 })}
                  value={tab.label}
                  error={error(`tabs.${index}.label`)}
                  onChange={(label) => setTabs(replaceAt(settings.tabs, index, { ...tab, label }))}
                />
                <SourceField
                  id={id(`tab-${index}-source`)}
                  label={t("tabSource", { number: index + 1 })}
                  source={tab.source}
                  error={(path) => error(`tabs.${index}.${path}`)}
                  onChange={(source) => setTabs(replaceAt(settings.tabs, index, { ...tab, source }))}
                />
              </ItemRow>
            ))}
          </ItemList>
        </>
      );
    }
    case "shop-by": {
      const settings = section.settings;
      const setCards = (cards: Settings<"shop-by">["cards"]) => update({ ...settings, cards });
      return (
        <>
          {titleField(settings, (title) => update({ ...settings, title }), undefined)}
          <ItemList
            label={t("shopByCards")}
            help={t("shopByHelp")}
            count={settings.cards.length}
            max={8}
            addLabel={t("addCard")}
            onAdd={() => setCards([...settings.cards, { mediaId: "", title: "", href: "" }])}
          >
            {settings.cards.map((card, index) => (
              <ItemRow key={index} removeLabel={t("removeCard", { number: index + 1 })} onRemove={() => setCards(removeAt(settings.cards, index))}>
                <MediaField
                  label={t("cardNumber", { number: index + 1 })}
                  mediaId={card.mediaId || null}
                  previews={previews}
                  error={error(`cards.${index}.mediaId`)}
                  onPick={pick((image) => setCards(replaceAt(settings.cards, index, { ...card, mediaId: image.id })))}
                />
                <TextField
                  id={id(`card-${index}`)}
                  label={t("cardTitle", { number: index + 1 })}
                  value={card.title}
                  error={error(`cards.${index}.title`)}
                  onChange={(title) => setCards(replaceAt(settings.cards, index, { ...card, title }))}
                />
                <TextField
                  id={id(`card-${index}-link`)}
                  label={t("sectionLink")}
                  value={card.href}
                  error={error(`cards.${index}.href`)}
                  onChange={(href) => setCards(replaceAt(settings.cards, index, { ...card, href }))}
                />
              </ItemRow>
            ))}
          </ItemList>
        </>
      );
    }
    case "banner-mosaic": {
      const settings = section.settings;
      const setTiles = (tiles: Settings<"banner-mosaic">["tiles"]) => update({ ...settings, tiles });
      return (
        <ItemList
          label={t("mosaicTiles")}
          help={t("mosaicHelp")}
          count={settings.tiles.length}
          max={5}
          addLabel={t("addTile")}
          onAdd={() => setTiles([...settings.tiles, { mediaId: "", alt: "", href: null }])}
        >
          {settings.tiles.map((tile, index) => (
            <ItemRow key={index} removeLabel={t("removeTile", { number: index + 1 })} onRemove={() => setTiles(removeAt(settings.tiles, index))}>
              <MediaField
                label={t("tileNumber", { number: index + 1 })}
                mediaId={tile.mediaId || null}
                previews={previews}
                error={error(`tiles.${index}.mediaId`)}
                onPick={pick((image) => setTiles(replaceAt(settings.tiles, index, { ...tile, mediaId: image.id, alt: tile.alt || image.alt })))}
              />
              <TextField
                id={id(`tile-${index}-alt`)}
                label={t("sectionImageAlt")}
                value={tile.alt}
                error={error(`tiles.${index}.alt`)}
                onChange={(alt) => setTiles(replaceAt(settings.tiles, index, { ...tile, alt }))}
              />
              <TextField
                id={id(`tile-${index}-link`)}
                label={t("sectionLink")}
                value={tile.href ?? ""}
                error={error(`tiles.${index}.href`)}
                onChange={(href) => setTiles(replaceAt(settings.tiles, index, { ...tile, href: href.trim() ? href : null }))}
              />
            </ItemRow>
          ))}
        </ItemList>
      );
    }
    case "brand-wall": {
      const settings = section.settings;
      return (
        <>
          {titleField(settings, (title) => update({ ...settings, title }), t("brandWallHelp"))}
          <ChoiceField
            id={id("style")}
            label={t("sectionStyle")}
            value={settings.style}
            options={(["rail", "grid"] as const).map((value) => ({ value, label: t(`brandStyle_${value}`) }))}
            onChange={(style) => update({ ...settings, style })}
          />
        </>
      );
    }
    case "recently-viewed":
      return titleField(section.settings, (title) => update({ title }), t("recentlyViewedHelp"));
    case "endless-grid": {
      const settings = section.settings;
      return (
        <>
          {titleField(settings, (title) => update({ ...settings, title }))}
          <ChoiceField
            id={id("page-size")}
            label={t("endlessPageSize")}
            value={settings.pageSize}
            options={([12, 24, 36] as const).map((value) => ({ value, label: formatNumber(value) }))}
            onChange={(pageSize) => update({ ...settings, pageSize })}
          />
        </>
      );
    }
    case "seo-text": {
      const settings = section.settings;
      return (
        <>
          <TextField id={id("heading")} label={t("heading")} value={settings.heading} error={error("heading")} onChange={(heading) => update({ ...settings, heading })} />
          <TextField id={id("body")} label={t("seoBody")} help={t("seoBodyHelp")} multiline value={settings.body} error={error("body")} onChange={(body) => update({ ...settings, body })} />
        </>
      );
    }
    case "banner": {
      const settings = section.settings;
      const cta = settings.cta ?? { label: "", href: "" };
      const setCta = (next: { label: string; href: string }) =>
        update({ ...settings, cta: next.label.trim() || next.href.trim() ? next : null });
      return (
        <>
          <ChoiceField
            id={id("layout")}
            label={t("bannerLayout")}
            value={settings.layout}
            options={(["full", "two-up", "four-up"] as const).map((value) => ({ value, label: t(`bannerLayout_${value}`) }))}
            onChange={(layout) => update({ ...settings, layout })}
          />
          <MediaField
            label={t("sectionImage")}
            mediaId={settings.mediaId}
            previews={previews}
            onPick={pick((image) => update({ ...settings, mediaId: image.id }))}
          />
          {settings.mediaId ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => update({ ...settings, mediaId: null })}>{t("remove")}</Button>
          ) : null}
          <TextField id={id("heading")} label={t("heading")} value={settings.heading} error={error("heading")} onChange={(heading) => update({ ...settings, heading })} />
          <TextField id={id("text")} label={t("sectionBannerText")} value={settings.text} error={error("text")} onChange={(text) => update({ ...settings, text })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField id={id("cta-label")} label={t("sectionBannerButton")} value={cta.label} error={error("cta.label")} onChange={(label) => setCta({ ...cta, label })} />
            <TextField id={id("cta-link")} label={t("sectionLink")} value={cta.href} error={error("cta.href")} onChange={(href) => setCta({ ...cta, href })} />
          </div>
        </>
      );
    }
    default:
      return <p className="text-body text-muted-foreground">{t("sectionNoSettings")}</p>;
  }
}

interface Editing {
  section: Section;
  initial: Section;
  isNew: boolean;
}

/**
 * The homepage section editor: the sections in order (move up and down),
 * each with Edit and Remove, plus Add section. Settings open in a dialog and
 * reach the theme draft on Done, so the page's save bar saves them with the
 * rest of the theme. A section with nothing to show says so on its row;
 * buyers never see it.
 */
export function SectionEditor({ sections, notes, media, onChange }: {
  sections: readonly Section[];
  /** Why a section does not show on the store, by section id (fit rules, not yet built). */
  notes: Readonly<Record<string, string>>;
  /** The saved sections' images, for previews. */
  media: readonly SectionMediaPreview[];
  onChange: (sections: Section[]) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const [picked, setPicked] = useState<ReadonlyMap<string, SectionMediaPreview>>(new Map());
  const previews = new Map([...media.map((each) => [each.id, each] as const), ...picked]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [open, setOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [adding, setAdding] = useState("");
  const dirty = editing !== null && JSON.stringify(editing.section) !== JSON.stringify(editing.initial);
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, onClose: () => setOpen(false) });

  const start = (section: Section, isNew: boolean) => {
    setEditing({ section, initial: section, isNew });
    setAttempted(false);
    setOpen(true);
  };
  const add = (type: StorefrontSectionType) => {
    const section = storefrontSectionDefault(type, newSectionId(type, sections)) as Section;
    if (EDITABLE.has(type)) start(section, true);
    else onChange([...sections, section]);
  };
  const errors = editing && attempted ? sectionErrors(editing.section) : new Map();
  const error: FieldError = (path) => {
    const found = errors.get(path);
    return found ? t(found.key, found.values) : undefined;
  };
  const done = () => {
    if (!editing) return;
    const parsed = STOREFRONT_SECTION_REGISTRY[editing.section.type].schema.safeParse(editing.section);
    if (!parsed.success) {
      setAttempted(true);
      return;
    }
    const next = parsed.data as Section;
    onChange(editing.isNew
      ? [...sections, next]
      : sections.map((each) => (each.id === next.id ? next : each)));
    setOpen(false);
  };
  const rowNotes = Object.fromEntries(sections.flatMap((section) => {
    if (notes[section.id]) return [[section.id, notes[section.id]!]];
    return storefrontSectionNeedsContent(section) ? [[section.id, t("sectionNeedsContent")]] : [];
  }));
  const full = sections.length >= STOREFRONT_MAX_SECTIONS;
  const hasHero = sections.some((section) => section.type === "hero");
  const editingName = editing ? t(`section_${editing.section.type}` as MessageKey) : "";

  return (
    <>
      <HomepageOrder
        sections={sections}
        notes={rowNotes}
        onChange={onChange}
        actions={(section, name) => (
          <>
            {EDITABLE.has(section.type) ? (
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("editSection", { name })} onClick={() => start(section, false)}>
                <Pencil aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("removeSection", { name })}
              onClick={() => onChange(sections.filter((each) => each.id !== section.id))}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </>
        )}
      />
      <div className="space-y-1.5 border-t border-border px-4 py-3">
        <NativeSelect
          value={adding}
          placeholder={t("addSection")}
          aria-label={t("addSection")}
          disabled={full}
          onValueChange={(type) => {
            setAdding("");
            add(type as StorefrontSectionType);
          }}
        >
          {ADDABLE.filter((type) => type !== "hero" || !hasHero).map((type) => (
            <option key={type} value={type}>{t(`section_${type}` as MessageKey)}</option>
          ))}
        </NativeSelect>
        {full ? <p className="text-body text-muted-foreground">{t("sectionLimit", { count: STOREFRONT_MAX_SECTIONS })}</p> : null}
      </div>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : requestClose())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingName}</DialogTitle>
            <DialogDescription className="sr-only">{t("editSection", { name: editingName })}</DialogDescription>
          </DialogHeader>
          <form
            method="post"
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              done();
            }}
          >
            {editing ? (
              <SettingsForm
                key={`${editing.section.id}:${editing.isNew}`}
                section={editing.section}
                update={(settings) => setEditing((current) => current && {
                  ...current,
                  section: { ...current.section, settings } as Section,
                })}
                error={error}
                previews={previews}
                onPickMedia={(image) => setPicked((current) => new Map(current).set(image.id, image))}
              />
            ) : null}
            {attempted && errors.size > 0 ? (
              <p role="alert" className="text-body text-destructive">{t("sectionFixErrors")}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={requestClose}>{t("cancel")}</Button>
              <Button type="submit">{t("sectionDone")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}
