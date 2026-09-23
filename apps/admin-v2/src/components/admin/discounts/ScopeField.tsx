import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { Scope, ScopeKind } from "./discount-form";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useDebounce } from "~/hooks/use-debounce";
import { useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import {
  collectionPickerOptionsQueryOptions,
  collectionProductOptionsQueryOptions,
  collectionsByIdsQueryOptions,
} from "~/lib/api-query-options/collections";
import { productsByIdsQueryOptions } from "~/lib/api-query-options/products";

const LIMIT = 90;

interface Option {
  id: string;
  name: string;
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

function useNames(kind: ScopeKind, ids: string[]): Map<string, string> {
  const products = useQuery({ ...productsByIdsQueryOptions(ids), enabled: kind === "products" && ids.length > 0 });
  const collections = useQuery({ ...collectionsByIdsQueryOptions(ids), enabled: kind === "collections" && ids.length > 0 });
  const rows: Option[] = kind === "products" ? products.data?.products ?? [] : collections.data?.collections ?? [];
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * "Applies to" / "Any items from": pick products or collections through a
 * search dialog; the choices show as removable chips under the field.
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
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [staged, setStaged] = useState<Map<string, string>>(new Map());
  const debounced = useDebounce(search.trim(), 300);
  const { query, options } = useOptions(scope.kind, debounced, open);
  const savedNames = useNames(scope.kind, scope.ids);
  const names = useMemo(() => new Map([...savedNames, ...staged]), [savedNames, staged]);
  const isProducts = scope.kind === "products";

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
      <Select
        value={scope.kind}
        disabled={disabled}
        onValueChange={(kind) => onChange({ kind: kind as ScopeKind, ids: [] })}
      >
        <SelectTrigger aria-label={t("appliesTo")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="collections">{t("specificCollections")}</SelectItem>
          <SelectItem value="products">{t("specificProducts")}</SelectItem>
        </SelectContent>
      </Select>
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
            <DialogDescription>{t("selectedCount", { count: staged.size })}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
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
                {t(query.isFetching ? "loading" : "noResults")}
              </p>
            ) : (
              <ul className="divide-y">
                {options.map((option) => (
                  <li key={option.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-body hover:bg-muted">
                      <Checkbox checked={staged.has(option.id)} onCheckedChange={() => toggle(option)} />
                      <span className="truncate">{option.name}</span>
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
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("cancel")}</Button>
            <Button
              type="button"
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
