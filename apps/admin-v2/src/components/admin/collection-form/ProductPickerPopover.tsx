import React, { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, Search } from "lucide-react";
import { useDebounce } from "~/hooks/use-debounce";
import { collectionProductOptionsQueryOptions } from "~/lib/api-query-options/collections";
import { Button } from "../../ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../ui/popover";
import type { Product } from "./types";

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

interface ProductPickerPopoverProps {
  triggerLabel: string;
  searchPlaceholder?: string;
  selectedCategoryIds?: string[];
  excludeProductIds?: string[];
  onSelectProduct: (product: Product) => void;
  buttonClassName?: string;
}

export function ProductPickerPopover({
  triggerLabel,
  searchPlaceholder,
  selectedCategoryIds = [],
  excludeProductIds = [],
  onSelectProduct,
  buttonClassName,
}: ProductPickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm.trim(), SEARCH_DEBOUNCE_MS);
  const categoryIds = useMemo(
    () =>
      Array.from(
        new Set(selectedCategoryIds.map((id) => id.trim()).filter(Boolean)),
      ).slice(0, 90),
    [selectedCategoryIds],
  );
  const excluded = useMemo(() => new Set(excludeProductIds), [excludeProductIds]);

  const productQuery = useInfiniteQuery({
    ...collectionProductOptionsQueryOptions({
      categoryIds,
      search: debouncedSearch,
      limit: PAGE_SIZE,
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
  const availableProducts = useMemo(
    () => displayedProducts.filter((product) => !excluded.has(product.id)),
    [displayedProducts, excluded],
  );
  const totalProducts = productQuery.data?.pages[0]?.pagination.total ?? 0;
  const isDebouncing = searchTerm.trim() !== debouncedSearch;
  const isInitialLoading = isDebouncing || productQuery.isPending ||
    (productQuery.isFetching && displayedProducts.length === 0);
  const isInitialError = productQuery.isError && displayedProducts.length === 0;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearchTerm("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={buttonClassName}
        >
          <span className="truncate">{triggerLabel}</span>
          <Search className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[var(--radix-popover-trigger-width)]"
        align="start"
        sideOffset={4}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={
              searchPlaceholder ||
              (categoryIds.length > 0
                ? "Search selected categories..."
                : "Search products...")
            }
            className="h-10 border-none focus:ring-0"
            value={searchTerm}
            onValueChange={setSearchTerm}
          />
          <CommandList className="max-h-[300px] overflow-auto">
            {isInitialLoading ? (
              <div className="flex items-center justify-center py-6" role="status">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                <span className="text-sm text-muted-foreground">
                  Searching products...
                </span>
              </div>
            ) : isInitialError ? (
              <div className="space-y-2 px-3 py-5 text-center">
                <AlertCircle className="mx-auto h-4 w-4 text-destructive" />
                <p className="text-sm text-muted-foreground">
                  Products could not be loaded.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void productQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <>
                {availableProducts.length > 0 ? (
                  <CommandGroup>
                    {availableProducts.map((product) => (
                      <CommandItem
                        key={product.id}
                        value={product.id}
                        onSelect={() => {
                          onSelectProduct(product);
                          setOpen(false);
                        }}
                        className="cursor-pointer items-start gap-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">
                            {product.name}
                          </span>
                          {product.categoryName ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {product.categoryName}
                            </span>
                          ) : null}
                        </span>
                        {product.isActive === false ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            Draft
                          </span>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {displayedProducts.length > 0
                      ? "Products on this page are already selected."
                      : "No products found."}
                  </div>
                )}

                {productQuery.hasNextPage ? (
                  <div className="border-t p-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      size="sm"
                      onClick={(event) => {
                        event.preventDefault();
                        void productQuery.fetchNextPage();
                      }}
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
