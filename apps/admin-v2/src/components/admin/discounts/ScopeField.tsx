import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ImageIcon, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { mediaImageUrl } from "@scalius/shared/media-variants";

import type { Scope, ScopeKind } from "./discount-form";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { useCurrency } from "~/hooks/use-currency";
import { useDebounce } from "~/hooks/use-debounce";
import { formatNumber, useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import {
  collectionPickerOptionsQueryOptions,
  collectionProductOptionsQueryOptions,
  collectionsByIdsQueryOptions,
} from "~/lib/api-query-options/collections";
import { productsByIdsQueryOptions } from "~/lib/api-query-options/products";
import { priceRangeText, type BuyerPriceRange } from "~/lib/format-utils";

const LIMIT = 90;

interface Option {
  id: string;
  name: string;
  priceRange?: BuyerPriceRange | null;
  primaryImage?: string | null;
  isActive?: boolean;
}

function useOptions(kind: ScopeKind, search: string, enabled: boolean) {
  const products = useInfiniteQuery({
    ...collectionProductOptionsQueryOptions({ search, limit: 20 }),
    enabled: enabled && kind === "products",
  });
  const collections = useInfiniteQuery({
    ...collectionPickerOptionsQueryOptions({ search, limit: 20 }),
    enabled: enabled && kind === "collections",
  });
  const query = kind === "products" ? products : collections;
  const options: Option[] = kind === "products"
    ? (products.data?.pages ?? []).flatMap((page) => page.products)
    : (collections.data?.pages ?? []).flatMap((page) => page.collections);
  return { query, options };
}

/** The picked products or collections, by id (name, and price range for products). */
export function useScopeItems(scope: Scope): Map<string, Option> {
  const { kind, ids } = scope;
  const products = useQuery({ ...productsByIdsQueryOptions(ids), enabled: kind === "products" && ids.length > 0 });
  const collections = useQuery({ ...collectionsByIdsQueryOptions(ids), enabled: kind === "collections" && ids.length > 0 });
  const rows: Option[] = kind === "products" ? products.data?.products ?? [] : collections.data?.collections ?? [];
  return new Map(rows.map((row) => [row.id, row]));
}

/** "Panjabi, Attar and 1 more"; "3 products" until the names load. */
export function useScopeLabel(): (scope: Scope, items: Map<string, Option>) => string {
  const t = useMessages(discountsMessages);
  return (scope, items) => {
    const names = scope.ids.map((id) => items.get(id)?.name).filter((name): name is string => Boolean(name));
    if (names.length < scope.ids.length) {
      const count = scope.ids.length;
      return scope.kind === "products"
        ? count === 1 ? t("countProduct") : t("countProducts", { count: formatNumber(count) })
        : count === 1 ? t("countCollection") : t("countCollections", { count: formatNumber(count) });
    }
    return names.length <= 2
      ? names.join(", ")
      : t("namesMore", { names: names.slice(0, 2).join(", "), count: formatNumber(names.length - 2) });
  };
}

/**
 * "Applies to" / "Any items from": pick products or collections in a
 * resource picker (thumbnail, price, "N selected" and Add); the choices show
 * as removable chips under the field.
 */
export function ScopeField({
  scope,
  onChange,
  error,
  disabled,
}: {
  scope: Scope;
  onChange: (scope: Scope) => void;
  error?: string;
  disabled?: boolean;
}) {
  const t = useMessages(discountsMessages);
  const { fmt } = useCurrency();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [staged, setStaged] = useState<Map<string, string>>(new Map());
  const debounced = useDebounce(search.trim(), 300);
  const { query, options } = useOptions(scope.kind, debounced, open);
  const saved = useScopeItems(scope);
  const names = useMemo(
    () => new Map([...[...saved].map(([id, row]) => [id, row.name] as const), ...staged]),
    [saved, staged],
  );
  const isProducts = scope.kind === "products";
  const unchanged = staged.size === scope.ids.length && scope.ids.every((id) => staged.has(id));

  function openPicker(initialSearch = "") {
    setSearch(initialSearch);
    setStaged(new Map(scope.ids.map((id) => [id, names.get(id) ?? id])));
    setOpen(true);
  }

  function toggle(option: Option) {
    setStaged((current) => {
      const next = new Map(current);
      if (next.has(option.id)) next.delete(option.id);
      else if (next.size < LIMIT) next.set(option.id, option.name);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <NativeSelect
        value={scope.kind}
        disabled={disabled}
        onValueChange={(kind) => onChange({ kind: kind as ScopeKind, ids: [] })}
        aria-label={t("appliesTo")}
      >
        <option value="collections">{t("specificCollections")}</option>
        <option value="products">{t("specificProducts")}</option>
      </NativeSelect>
      <div className="flex gap-2">
        <div className="flex-1">
          <Input
            value=""
            type="search"
            disabled={disabled}
            placeholder={t(isProducts ? "searchProducts" : "searchCollections")}
            aria-label={t(isProducts ? "searchProducts" : "searchCollections")}
            aria-invalid={error ? true : undefined}
            onChange={(event) => openPicker(event.target.value)}
            onClick={() => openPicker()}
          />
        </div>
        <Button type="button" variant="outline" disabled={disabled} onClick={() => openPicker()}>
          <Search aria-hidden />
          {t("browse")}
        </Button>
      </div>
      {error ? <p className="text-body text-destructive">{error}</p> : null}
      {scope.ids.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {scope.ids.map((id) => (
            <li key={id} className="flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-body">
              <span className="max-w-60 truncate">{names.get(id) ?? "…"}</span>
              {disabled ? null : (
                <button
                  type="button"
                  className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={t("remove", { name: names.get(id) ?? id })}
                  onClick={() => onChange({ ...scope, ids: scope.ids.filter((item) => item !== id) })}
                >
                  <X className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(isProducts ? "addProducts" : "addCollections")}</DialogTitle>
            <DialogDescription className="sr-only">{t(isProducts ? "searchProducts" : "searchCollections")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t(isProducts ? "searchProducts" : "searchCollections")}
            aria-label={t(isProducts ? "searchProducts" : "searchCollections")}
          />
          <div className="max-h-96 overflow-y-auto rounded-md border">
            {query.isError ? (
              <p className="p-4 text-body text-muted-foreground">{t("loadFailed")}</p>
            ) : options.length === 0 ? (
              <p className="p-4 text-body text-muted-foreground" aria-live="polite">
                {t(query.isPending || query.isFetching ? "loading" : "noResults")}
              </p>
            ) : (
              <ul className="divide-y">
                {options.map((option) => (
                  <li key={option.id}>
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2 text-body hover:bg-muted">
                      <Checkbox checked={staged.has(option.id)} onCheckedChange={() => toggle(option)} />
                      {isProducts ? (
                        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                          {option.primaryImage ? (
                            <img src={mediaImageUrl(option.primaryImage, 160)} alt="" className="size-full object-contain" loading="lazy" decoding="async" />
                          ) : (
                            <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                          )}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">{option.name}</span>
                      {option.isActive === false ? <Badge variant="attention">{t("statusDraft")}</Badge> : null}
                      {option.priceRange !== undefined ? <span className="shrink-0 tabular-nums text-muted-foreground">{priceRangeText(option.priceRange, fmt) ?? t("noPrice")}</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {query.hasNextPage ? (
              <div className="border-t p-2">
                <Button type="button" variant="ghost" className="w-full" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  {t("loadMore")}
                </Button>
              </div>
            ) : null}
          </div>
          <DialogFooter className="sm:items-center">
            <p className="text-body text-muted-foreground sm:mr-auto" aria-live="polite">
              {t("selectedCount", { count: formatNumber(staged.size) })}
            </p>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button
              type="button"
              disabled={unchanged}
              onClick={() => {
                onChange({ ...scope, ids: [...staged.keys()] });
                setOpen(false);
              }}
            >
              {t("add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
