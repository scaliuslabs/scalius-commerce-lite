/**
 * Controls for settings that name store records: categories and collections
 * (one, or an ordered list), a product, a running promotion, an image from
 * Files and a storefront link. The settings form picks them by setting key.
 */
import { useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ImageIcon, Search, Trash2 } from "lucide-react";
import { getApiV1AdminCollections } from "@scalius/api-client/sdk";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { canonicalStorefrontLink } from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { MediaManager, type MediaFile } from "~/components/admin/media-manager";
import { useServerFieldError } from "~/components/admin/shared/SaveBar";
import { apiData } from "~/lib/api";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { collectionsByIdsQueryOptions } from "~/lib/api-query-options/collections";
import { discountsQueryOptions } from "~/lib/api-query-options/discounts";
import { fetchProducts } from "~/lib/api-query-options/products";
import { formatDateTime, useMessages } from "~/i18n";
import { fieldMessages } from "~/i18n/field";
import { onlineStoreMessages } from "~/i18n/online-store";
import { NavigationResourcePicker } from "../NavigationResourcePicker";
import { mediaPreview, moveAt, removeAt, type SectionMediaPreview } from "./media-previews";
import { Field } from "~/components/ui/field";

export { mediaPreview, moveAt, removeAt, replaceAt, useMediaPreviews, type MediaPreviews, type SectionMediaPreview } from "./media-previews";

/**
 * A link a theme document stores (an announcement, a slide, a card): typed
 * or browsed, written in its canonical form when the field is left. Text
 * that is not a usable link stays as typed and is marked.
 */
export function LinkField({ id, label, help, value, onChange, error, nullable = true, optional = false }: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  value: string | null;
  onChange: (link: string | null) => void;
  error?: string;
  /** False for a link the setting requires: cleared text stays "" instead of null. */
  nullable?: boolean;
  /** Says "(optional)" after the label. */
  optional?: boolean;
}) {
  const t = useMessages(onlineStoreMessages);
  const [left, setLeft] = useState(false);
  const server = useServerFieldError(id);
  const text = value ?? "";
  const unusable = text.trim() !== "" && canonicalStorefrontLink(text) !== text;
  const shown = error ?? server.error ?? (unusable && (left || server.revealed) ? t("linkInvalid") : undefined);
  const note = shown ?? help;
  const empty = nullable ? null : "";
  const change = (next: string | null) => {
    server.clear();
    onChange(next);
  };
  return (
    <Field id={id} label={label} optional={optional}>
      <div className="flex gap-2">
        <Input
          id={id}
          value={text}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t("linkPlaceholder")}
          aria-invalid={shown ? true : undefined}
          aria-describedby={note ? `${id}-note` : undefined}
          onChange={(event) => change(event.target.value === "" ? empty : event.target.value)}
          onBlur={() => {
            setLeft(true);
            if (!text.trim()) {
              if (value !== empty) change(empty);
              return;
            }
            const canonical = canonicalStorefrontLink(text);
            if (canonical && canonical !== text) change(canonical);
          }}
        />
        <NavigationResourcePicker
          id={`${id}-browse`}
          type="collection"
          types={["collection", "category", "product", "page"]}
          value=""
          trigger={
            <Button type="button" variant="outline" aria-label={t("browseLinks")}>
              <Search aria-hidden="true" />
              {t("browse")}
            </Button>
          }
          onValueChange={(option) => change(canonicalStorefrontLink(option.url) ?? option.url)}
        />
      </div>
      {shown ? (
        <p id={`${id}-note`} role="alert" className="text-body text-destructive">{shown}</p>
      ) : help ? (
        <p id={`${id}-note`} className="text-body text-muted-foreground">{help}</p>
      ) : null}
    </Field>
  );
}

/**
 * One image from Files, stored as its media id: a preview, Select or Change,
 * and Remove when `onRemove` is given. A rejected save marks it by `id`.
 */
export function MediaField({ id, label, help, mediaId, previews, onPick, onRemove, error, fit = "cover", optional = false }: {
  id: string;
  label: string;
  /** Says "(optional)" after the label. */
  optional?: boolean;
  help?: ReactNode;
  mediaId: string | null;
  previews: ReadonlyMap<string, SectionMediaPreview>;
  onPick: (image: SectionMediaPreview) => void;
  onRemove?: () => void;
  error?: string;
  /** `contain` for logos and icons, which must show whole. */
  fit?: "cover" | "contain";
}) {
  const t = useMessages(onlineStoreMessages);
  const fields = useMessages(fieldMessages);
  const server = useServerFieldError(id);
  const shown = error ?? server.error;
  const preview = mediaId ? previews.get(mediaId) : undefined;
  return (
    // The label sits above, as every other field's does; the image and its buttons below it.
    <div id={id} role="group" aria-labelledby={`${id}-label`} className="space-y-1.5">
      <p id={`${id}-label`} className="text-body font-medium">
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> {fields("optional")}</span> : null}
      </p>
      {help ? <p className="text-body text-muted-foreground">{help}</p> : null}
      <div className="flex items-center gap-3">
      <div className="grid h-16 w-24 shrink-0 place-items-center overflow-clip rounded-lg border bg-muted">
        {preview ? (
          <img
            src={mediaImageUrl(preview.url, 320)}
            alt=""
            className={fit === "contain" ? "max-h-full max-w-full object-contain" : "size-full object-cover"}
          />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap gap-2">
          <MediaManager
            capability="image"
            onSelect={(file) => {
              server.clear();
              onPick(mediaPreview(file));
            }}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-invalid={shown ? true : undefined}
                aria-describedby={shown ? `${id}-note` : undefined}
              >
                {mediaId ? t("changeImage") : t("selectImage")}
              </Button>
            }
          />
          {mediaId && onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                server.clear();
                onRemove();
              }}
            >
              {t("remove")}
            </Button>
          ) : null}
        </div>
        {shown ? <p id={`${id}-note`} role="alert" className="text-body text-destructive">{shown}</p> : null}
      </div>
      </div>
    </div>
  );
}

/** Chosen records or values in order: move up or down, remove, and the control that adds one. */
export function PickList({ label, help, items, onChange, error, children }: {
  label: ReactNode;
  help?: ReactNode;
  items: ReadonlyArray<{ id: string; name: string }>;
  onChange: (ids: string[]) => void;
  error?: string;
  children: ReactNode;
}) {
  const t = useMessages(onlineStoreMessages);
  const ids = items.map((item) => item.id);
  return (
    <fieldset className="space-y-2">
      <legend className="text-body font-medium">{label}</legend>
      {help ? <p className="text-body text-muted-foreground">{help}</p> : null}
      {items.length > 0 ? (
        <ol className="divide-y rounded-lg border">
          {items.map((item, index) => (
            <li key={item.id} className="flex min-h-11 items-center gap-1 py-1 pe-1 ps-3">
              <span className="min-w-0 flex-1 truncate text-body">{item.name}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveSectionUp", { name: item.name })} disabled={index === 0} onClick={() => onChange(moveAt(ids, index, -1))}>
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveSectionDown", { name: item.name })} disabled={index === items.length - 1} onClick={() => onChange(moveAt(ids, index, 1))}>
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeItem", { name: item.name })} onClick={() => onChange(removeAt(ids, index))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      {children}
      {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
    </fieldset>
  );
}

/** Published categories, in the merchant's order. */
export function CategoryPicks({ id, label, ids, max, minimum, error, onChange }: {
  id: string;
  label: ReactNode;
  ids: readonly string[];
  max: number;
  minimum: number;
  error?: string;
  onChange: (ids: string[]) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const { data } = useQuery(categoryFormOptionsQueryOptions());
  const categories = data?.categories ?? [];
  const names = new Map(categories.map((category) => [category.id, category.name]));
  const full = ids.length >= max;
  return (
    <PickList
      label={label}
      help={t("tileCategoriesHelp", { count: max, minimum })}
      items={ids.map((each) => ({ id: each, name: names.get(each) ?? (data ? t("unavailableCategory") : t("loading")) }))}
      onChange={onChange}
      error={error}
    >
      <SearchableSelect
        id={id}
        value=""
        disabled={full}
        options={categories
          .filter((category) => category.status === "published" && !ids.includes(category.id))
          .map((category) => ({ value: category.id, label: category.name }))}
        onValueChange={(next) => {
          if (next && !ids.includes(next)) onChange([...ids, next]);
        }}
        placeholder={full ? t("categoryLimit", { count: max }) : t("addCategory")}
        searchPlaceholder={t("searchCategories")}
        emptyMessage={t("noMoreCategories")}
        ariaLabel={t("addCategory")}
        triggerClassName="w-full"
      />
    </PickList>
  );
}

const loadCollections: SearchableSelectLoader = async ({ search, page, signal }) => {
  const data = await apiData(getApiV1AdminCollections({ query: { page, limit: 20, search: search || undefined }, signal }));
  return {
    options: data.collections.map((collection) => ({ value: collection.id, label: collection.name })),
    hasMore: data.pagination.page < data.pagination.totalPages,
  };
};

/** Collections in the merchant's order. */
export function CollectionPicks({ id, label, ids, max, error, onChange }: {
  id: string;
  label: ReactNode;
  ids: readonly string[];
  max: number;
  error?: string;
  onChange: (ids: string[]) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  // Names of collections picked in this session show before the lookup returns.
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({});
  const lookup = useQuery({ ...collectionsByIdsQueryOptions(ids), placeholderData: keepPreviousData });
  const names = new Map((lookup.data?.collections ?? []).map((collection) => [collection.id, collection.name]));
  const full = ids.length >= max;
  return (
    <PickList
      label={label}
      help={t("sectionCollectionsHelp", { count: max })}
      items={ids.map((each) => ({
        id: each,
        name: picked[each] ?? names.get(each) ?? (lookup.isSuccess && !lookup.isPlaceholderData ? t("unavailableCollection") : t("loading")),
      }))}
      onChange={onChange}
      error={error}
    >
      <SearchableSelect
        id={id}
        value=""
        disabled={full}
        load={loadCollections}
        queryKey={["homepage-section-collections"]}
        onValueChange={(next, option) => {
          if (!next || ids.includes(next)) return;
          if (option) setPicked((current) => ({ ...current, [next]: option.label }));
          onChange([...ids, next]);
        }}
        placeholder={full ? t("collectionLimit", { count: max }) : t("addCollection")}
        searchPlaceholder={t("searchCollections")}
        emptyMessage={t("noCollections")}
        ariaLabel={t("addCollection")}
        triggerClassName="w-full"
      />
    </PickList>
  );
}

/** One collection. */
export function CollectionSelect({ id, value, onChange, invalid }: {
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
      aria-invalid={invalid || undefined}
      triggerClassName="w-full"
    />
  );
}

/** One published category (or the one already chosen). */
export function CategorySelect({ id, value, onChange, invalid }: {
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
      aria-invalid={invalid || undefined}
      triggerClassName="w-full"
    />
  );
}

const PRODUCT_PAGE_SIZE = 20;
const loadProducts: SearchableSelectLoader = async ({ search, page }) => {
  const result = await fetchProducts({ page, limit: PRODUCT_PAGE_SIZE, ...(search ? { search } : {}) });
  return {
    options: result.products.map((product) => ({ value: product.id, label: product.name })),
    hasMore: page < result.pagination.totalPages,
  };
};

/** One product, searched in the catalogue; `name` shows the chosen one before its page loads. */
export function ProductSelect({ id, value, name, onChange, clearable = false, invalid = false }: {
  id: string;
  value: string;
  name?: string;
  /** "" when cleared. */
  onChange: (id: string) => void;
  clearable?: boolean;
  invalid?: boolean;
}) {
  const t = useMessages(onlineStoreMessages);
  return (
    <SearchableSelect
      id={id}
      value={value}
      selectedLabel={name}
      load={loadProducts}
      queryKey={["online-store", "products"]}
      clearable={clearable}
      onValueChange={onChange}
      placeholder={t("chooseProduct")}
      searchPlaceholder={t("searchProducts")}
      emptyMessage={t("noProducts")}
      aria-invalid={invalid || undefined}
      triggerClassName="w-full"
    />
  );
}

/** A deal's countdown: a running discount with an end date, or none. */
export function PromotionSelect({ id, value, onChange }: {
  id: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  // Running discounts (a page of them): a countdown needs one with an end date.
  const { data: page } = useQuery(discountsQueryOptions({ view: "active", limit: 90 }));
  const data = page?.discounts;
  const now = Date.now();
  const live = (data ?? []).filter((discount) =>
    discount.deletedAt === null
    && discount.status !== "archived"
    && discount.endsAt !== null
    && Date.parse(discount.endsAt) > now);
  const options = live.map((discount) => ({
    value: discount.id,
    label: discount.title?.trim() || discount.name,
    description: t("promotionEnds", {
      date: formatDateTime(new Date(discount.endsAt!), { dateStyle: "medium", timeStyle: "short" }),
    }),
  }));
  const saved = (data ?? []).find((discount) => discount.id === value);
  return (
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
      triggerClassName="w-full"
    />
  );
}
