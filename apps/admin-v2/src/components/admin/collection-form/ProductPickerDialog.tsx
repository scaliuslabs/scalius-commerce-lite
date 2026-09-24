import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImageIcon, Loader2 } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { useCurrency } from "~/hooks/use-currency";
import { useDebounce } from "~/hooks/use-debounce";
import { collectionProductOptionsQueryOptions } from "~/lib/api-query-options/collections";
import { priceRangeText } from "~/lib/format-utils";
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

/**
 * One page-by-page product lookup for the collection pickers and the
 * automatic-collection preview: newest products first, A-Z while searching.
 */
export function useProductOptions({
  open,
  search = "",
  categoryIds = [],
  selectedProductIds = [],
  limit = PAGE_SIZE,
}: {
  open: boolean;
  search?: string;
  categoryIds?: readonly string[];
  selectedProductIds?: readonly string[];
  limit?: number;
}) {
  const debouncedSearch = useDebounce(search.trim(), SEARCH_DEBOUNCE_MS);
  const query = useInfiniteQuery({
    ...collectionProductOptionsQueryOptions({
      search: debouncedSearch,
      limit,
      categoryIds: [...categoryIds],
      selectedProductIds: [...selectedProductIds],
    }),
    enabled: open,
  });
  const products = useMemo(() => {
    const byId = new Map<string, Product>();
    for (const page of query.data?.pages ?? []) {
      for (const product of page.products) byId.set(product.id, product);
    }
    return Array.from(byId.values());
  }, [query.data]);
  const total = query.data?.pages[0]?.pagination.total ?? 0;
  const isLoading = search.trim() !== debouncedSearch || query.isPending || (query.isFetching && products.length === 0);
  return { query, products, total, isLoading, searched: debouncedSearch };
}

/** "৳1,200 · 3 variants · 12 in stock", the resource picker's second line. */
export function ProductOptionMeta({ product }: { product: Product }) {
  const t = useMessages(collectionFormMessages);
  const { fmt } = useCurrency();
  const parts = [
    product.priceRange === undefined ? null : priceRangeText(product.priceRange, fmt) ?? t("noPrice"),
    product.variantCount ? (product.variantCount === 1 ? t("variantOne") : t("variantCount", { count: product.variantCount })) : null,
    product.available === undefined ? null : product.available === null ? t("stockNotTracked") : product.available === 0 ? t("outOfStock") : t("inStock", { count: product.available }),
  ].filter(Boolean);
  return <span className="block truncate tabular-nums text-muted-foreground">{parts.join(" · ")}</span>;
}

export function ProductThumbnail({ image }: { image?: string | null }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
      {image ? (
        <img src={mediaImageUrl(image, 160)} alt="" className="size-full object-contain" loading="lazy" decoding="async" />
      ) : (
        <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}

/** Loading, failed, nothing in the store, or nothing matching the search. */
export function ProductOptionsStatus({ options }: { options: ReturnType<typeof useProductOptions> }) {
  const t = useMessages(collectionFormMessages);
  const tr = useMessages(resourceMessages);
  const { query, products, isLoading, searched } = options;
  if (isLoading) {
    return (
      <p role="status" className="flex items-center justify-center gap-2 px-5 py-10 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("searching")}
      </p>
    );
  }
  if (query.isError && products.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-5 py-10">
        <p className="text-muted-foreground">{t("productsLoadFailed")}</p>
        <Button type="button" variant="outline" onClick={() => void query.refetch()}>
          {tr("retry")}
        </Button>
      </div>
    );
  }
  if (products.length > 0) return null;
  return searched ? (
    <p className="px-5 py-10 text-center text-muted-foreground">{t("noProductsMatch", { term: searched })}</p>
  ) : (
    <div className="flex flex-col items-center gap-3 px-5 py-10 text-center">
      <p className="text-muted-foreground">{t("noProductsYet")}</p>
      <Button type="button" variant="outline" asChild>
        <Link to="/admin/products/new">{t("addProduct")}</Link>
      </Button>
    </div>
  );
}

interface ProductPickerDialogProps {
  selectedProductIds: readonly string[];
  onAddProducts: (products: Product[]) => void;
  /** Collection capacity; the picker never stages more than what is left. */
  maxProducts?: number;
}

/**
 * Polaris resource picker: opens on the newest products with a search field,
 * rows with thumbnail, price and stock, "N selected" with [Cancel] [Add].
 * Products already in the collection come back checked and locked.
 */
export function ProductPickerDialog({ selectedProductIds, onAddProducts, maxProducts = 90 }: ProductPickerDialogProps) {
  const t = useMessages(collectionFormMessages);
  const tr = useMessages(resourceMessages);
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [staged, setStaged] = useState<Map<string, Product>>(() => new Map());
  const existingIds = useMemo(() => new Set(selectedProductIds), [selectedProductIds]);
  const remainingSlots = Math.max(0, maxProducts - existingIds.size);
  const selectionFull = staged.size >= remainingSlots;
  const options = useProductOptions({ open, search: searchTerm, selectedProductIds });
  const { query, products } = options;

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearchTerm("");
      setStaged(new Map());
    }
  }

  function toggle(product: Product) {
    if (existingIds.has(product.id)) return;
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
          <ProductOptionsStatus options={options} />
          {options.isLoading || products.length === 0 ? null : (
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
                      <ProductThumbnail image={product.primaryImage} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{product.name}</span>
                        <ProductOptionMeta product={product} />
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
              {query.hasNextPage ? (
                <li className="p-3">
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    loading={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                  >
                    {query.isFetchNextPageError ? tr("retry") : t("loadMore")}
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
