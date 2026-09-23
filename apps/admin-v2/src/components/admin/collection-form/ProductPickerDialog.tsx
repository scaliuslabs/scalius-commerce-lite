import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ImageIcon, Loader2 } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { useDebounce } from "~/hooks/use-debounce";
import { collectionProductOptionsQueryOptions } from "~/lib/api-query-options/collections";
import { isCollectionProductOptionDto } from "~/lib/collection-product-options";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { collectionFormMessages } from "~/i18n/collection-form";
import { resourceMessages } from "~/i18n/resource";
import type { Product } from "./types";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

interface ProductPickerDialogProps {
  selectedProductIds: readonly string[];
  onAddProducts: (products: Product[]) => void;
  /** Collection capacity; the picker never stages more than what is left. */
  maxProducts?: number;
}

/**
 * Polaris resource picker: opens on a search field, rows with thumbnails,
 * "N selected" with [Cancel] [Add]. Products already in the collection come
 * back checked and locked.
 */
export function ProductPickerDialog({ selectedProductIds, onAddProducts, maxProducts = 90 }: ProductPickerDialogProps) {
  const t = useMessages(collectionFormMessages);
  const tr = useMessages(resourceMessages);
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [staged, setStaged] = useState<Map<string, Product>>(() => new Map());
  const debouncedSearch = useDebounce(searchTerm.trim(), SEARCH_DEBOUNCE_MS);
  const existingIds = useMemo(() => new Set(selectedProductIds), [selectedProductIds]);
  const remainingSlots = Math.max(0, maxProducts - existingIds.size);
  const selectionFull = staged.size >= remainingSlots;

  const productQuery = useInfiniteQuery({
    ...collectionProductOptionsQueryOptions({
      search: debouncedSearch,
      limit: PAGE_SIZE,
      selectedProductIds: Array.from(selectedProductIds),
    }),
    enabled: open,
  });

  const products = useMemo(() => {
    const byId = new Map<string, Product>();
    for (const page of productQuery.data?.pages ?? []) {
      for (const product of page.products) byId.set(product.id, product);
    }
    return Array.from(byId.values());
  }, [productQuery.data]);
  const isLoading = searchTerm.trim() !== debouncedSearch || productQuery.isPending ||
    (productQuery.isFetching && products.length === 0);

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearchTerm("");
      setStaged(new Map());
    }
  }

  function toggle(product: Product) {
    if (!isCollectionProductOptionDto(product) || existingIds.has(product.id)) return;
    setStaged((current) => {
      const next = new Map(current);
      if (next.has(product.id)) next.delete(product.id);
      else if (next.size < remainingSlots) next.set(product.id, product);
      return next;
    });
  }

  function add() {
    if (staged.size === 0) return;
    onAddProducts(Array.from(staged.values()));
    changeOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={remainingSlots === 0}>
          {t("addProducts")}
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="gap-0 p-0 sm:max-w-2xl">
        <div className="space-y-4 p-5">
          <DialogHeader>
            <DialogTitle>{t("addProducts")}</DialogTitle>
          </DialogHeader>
          <Input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t("searchProducts")}
            aria-label={t("searchProducts")}
          />
        </div>

        <div className="max-h-[min(52dvh,30rem)] min-h-40 overflow-y-auto overscroll-contain border-t">
          {isLoading ? (
            <p role="status" className="flex items-center justify-center gap-2 px-5 py-10 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("searching")}
            </p>
          ) : productQuery.isError && products.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-5 py-10">
              <p className="text-muted-foreground">{t("productsLoadFailed")}</p>
              <Button type="button" variant="outline" onClick={() => void productQuery.refetch()}>
                {tr("retry")}
              </Button>
            </div>
          ) : products.length === 0 ? (
            <p className="px-5 py-10 text-center text-muted-foreground">{t("noProductsFound")}</p>
          ) : (
            <ul className="divide-y">
              {products.map((product) => {
                const added = existingIds.has(product.id);
                const checked = added || staged.has(product.id);
                return (
                  <li key={product.id}>
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 px-5 py-2 hover:bg-accent">
                      <Checkbox
                        checked={checked}
                        disabled={added || (!checked && selectionFull)}
                        onCheckedChange={() => toggle(product)}
                        aria-label={product.name}
                      />
                      <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                        {product.primaryImage ? (
                          <img src={mediaImageUrl(product.primaryImage, 160)} alt="" className="size-full object-contain" loading="lazy" decoding="async" />
                        ) : (
                          <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{product.name}</span>
                        <span className="block truncate text-muted-foreground">{product.categoryName || t("noCategory")}</span>
                      </span>
                      {added ? (
                        <Badge variant="secondary">{t("added")}</Badge>
                      ) : product.isActive === false ? (
                        <Badge variant="attention">{t("draft")}</Badge>
                      ) : null}
                    </label>
                  </li>
                );
              })}
              {productQuery.hasNextPage ? (
                <li className="p-3">
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    loading={productQuery.isFetchingNextPage}
                    onClick={() => void productQuery.fetchNextPage()}
                  >
                    {productQuery.isFetchNextPageError ? tr("retry") : t("loadMore")}
                  </Button>
                </li>
              ) : null}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
          <p className="tabular-nums text-muted-foreground" aria-live="polite">
            {staged.size > 0 && selectionFull
              ? t("selectedLimit", { count: staged.size })
              : tr("selected", { count: staged.size })}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
              {tr("cancel")}
            </Button>
            <Button type="button" disabled={staged.size === 0} onClick={add}>
              {t("add")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
