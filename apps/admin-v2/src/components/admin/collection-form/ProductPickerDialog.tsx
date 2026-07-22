import React, { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Check, ImageIcon, Loader2, Search } from "lucide-react";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { cn } from "@scalius/shared/utils";
import { useDebounce } from "~/hooks/use-debounce";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";
import { collectionProductOptionsQueryOptions } from "~/lib/api-query-options/collections";
import { isCollectionProductOptionDto } from "~/lib/collection-product-options";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import type { Product } from "./types";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

interface ProductPickerDialogProps {
  selectedProductIds: readonly string[];
  onAddProducts: (products: Product[]) => void;
  maxProducts?: number;
  disabled?: boolean;
}

export function ProductPickerDialog({
  selectedProductIds,
  onAddProducts,
  maxProducts = 90,
  disabled = false,
}: ProductPickerDialogProps) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [stagedProducts, setStagedProducts] = useState<Map<string, Product>>(
    () => new Map(),
  );
  const debouncedSearch = useDebounce(searchTerm.trim(), SEARCH_DEBOUNCE_MS);
  const existingIds = useMemo(
    () => new Set(selectedProductIds),
    [selectedProductIds],
  );
  const remainingSlots = Math.max(0, maxProducts - existingIds.size);

  const productQuery = useInfiniteQuery({
    ...collectionProductOptionsQueryOptions({
      search: debouncedSearch,
      limit: PAGE_SIZE,
      selectedProductIds: Array.from(selectedProductIds),
    }),
    enabled: open,
  });

  const displayedProducts = useMemo(() => {
    const byId = new Map<string, Product>();
    for (const page of productQuery.data?.pages ?? []) {
      for (const product of page.products) byId.set(product.id, product);
    }
    return Array.from(byId.values());
  }, [productQuery.data]);
  const totalProducts = productQuery.data?.pages[0]?.pagination.total ?? 0;
  const isDebouncing = searchTerm.trim() !== debouncedSearch;
  const isInitialLoading = isDebouncing || productQuery.isPending ||
    (productQuery.isFetching && displayedProducts.length === 0);
  const isInitialError = productQuery.isError && displayedProducts.length === 0;

  function resetTransientState() {
    setSearchTerm("");
    setStagedProducts(new Map());
  }

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) resetTransientState();
  }

  function toggleProduct(product: Product) {
    if (!isCollectionProductOptionDto(product) || existingIds.has(product.id)) {
      return;
    }
    setStagedProducts((current) => {
      const next = new Map(current);
      if (next.has(product.id)) {
        next.delete(product.id);
      } else if (next.size < remainingSlots) {
        next.set(product.id, product);
      }
      return next;
    });
  }

  function addProducts() {
    if (stagedProducts.size === 0) return;
    onAddProducts(Array.from(stagedProducts.values()));
    changeOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full justify-between font-normal sm:h-9"
          disabled={disabled || remainingSlots === 0}
        >
          <span>Add products</span>
          <Search className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-2xl gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-3rem)]">
        <DialogHeader className="px-4 pb-3 pt-4 pr-14 text-left sm:px-5 sm:pb-4 sm:pt-5 sm:pr-14">
          <DialogTitle>Add products</DialogTitle>
          <DialogDescription>
            Select products, then add them to the collection.
          </DialogDescription>
        </DialogHeader>

        <div className="border-y px-4 py-3 sm:px-5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search products"
              aria-label="Search products"
              className="h-11 pl-9 sm:h-10"
            />
          </div>
        </div>

        <div className="max-h-[min(52dvh,30rem)] overflow-y-auto overscroll-contain">
          {isInitialLoading ? (
            <div className="flex items-center justify-center px-4 py-10" role="status">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <span className="text-sm text-muted-foreground">
                Searching products...
              </span>
            </div>
          ) : isInitialError ? (
            <div className="space-y-3 px-4 py-8 text-center">
              <AlertCircle className="mx-auto h-5 w-5 text-destructive" />
              <p className="text-sm text-muted-foreground">
                Products could not be loaded.
              </p>
              <Button
                type="button"
                variant="outline"
                className="h-11 sm:h-9"
                onClick={() => void productQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : displayedProducts.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No products found.
            </p>
          ) : (
            <>
              <ul className="divide-y" aria-label="Products">
                {displayedProducts.map((product) => {
                  const isAlreadyAdded = existingIds.has(product.id);
                  const isStaged = stagedProducts.has(product.id);
                  const selectionFull = stagedProducts.size >= remainingSlots;
                  const rowDisabled = isAlreadyAdded || (!isStaged && selectionFull);
                  const checked = isAlreadyAdded || isStaged;

                  return (
                    <li key={product.id}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        aria-label={isAlreadyAdded
                          ? `${product.name}, already added`
                          : `${checked ? "Remove" : "Select"} ${product.name}`}
                        disabled={rowDisabled}
                        onClick={() => toggleProduct(product)}
                        className={cn(
                          "flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left outline-none transition-colors focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-12 sm:px-5",
                          rowDisabled
                            ? "cursor-not-allowed opacity-60"
                            : "cursor-pointer hover:bg-accent/70",
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded border border-primary",
                            checked
                              ? "bg-primary text-primary-foreground"
                              : "bg-background",
                          )}
                          aria-hidden="true"
                        >
                          {checked ? <Check className="h-4 w-4" /> : null}
                        </span>
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted sm:h-9 sm:w-9">
                          {product.primaryImage ? (
                            <img
                              src={getOptimizedImageUrl(
                                product.primaryImage,
                                ADMIN_IMAGE_PRESETS.productMicro,
                              )}
                              alt=""
                              className="h-full w-full object-contain object-center"
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <ImageIcon
                              className="h-4 w-4 text-muted-foreground"
                              aria-hidden="true"
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {product.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {product.categoryName || "Uncategorized"}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {isAlreadyAdded
                            ? "Added"
                            : product.isActive === false
                              ? "Draft"
                              : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {productQuery.hasNextPage ? (
                <div className="border-t p-3 sm:px-5">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full sm:h-9"
                    onClick={() => void productQuery.fetchNextPage()}
                    disabled={productQuery.isFetchingNextPage}
                  >
                    {productQuery.isFetchingNextPage ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </>
                    ) : productQuery.isFetchNextPageError ? (
                      "Retry loading more"
                    ) : (
                      `Load more (${displayedProducts.length} of ${totalProducts})`
                    )}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="border-t bg-muted/20 px-4 py-3 sm:flex sm:items-center sm:justify-between sm:gap-4 sm:px-5">
          <p className="mb-3 text-xs tabular-nums text-muted-foreground sm:mb-0" aria-live="polite">
            {stagedProducts.size === 0
              ? `${remainingSlots} ${remainingSlots === 1 ? "place" : "places"} available`
              : `${stagedProducts.size} selected`}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:h-9"
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="h-11 sm:h-9"
              disabled={stagedProducts.size === 0}
              onClick={addProducts}
            >
              {stagedProducts.size === 0
                ? "Add products"
                : `Add ${stagedProducts.size} ${stagedProducts.size === 1 ? "product" : "products"}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
