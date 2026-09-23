import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, Loader2 } from "lucide-react";
import { useDebounce } from "~/hooks/use-debounce";
import { collectionProductOptionsQueryOptions } from "~/lib/api-query-options/collections";
import { isCollectionProductOptionDto } from "~/lib/collection-product-options";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "~/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useMessages } from "~/i18n";
import { collectionFormMessages } from "~/i18n/collection-form";
import { resourceMessages } from "~/i18n/resource";
import type { Product } from "./types";

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

interface ProductPickerPopoverProps {
  triggerLabel: string;
  /** Limits the search to these categories (automatic collections). */
  selectedCategoryIds?: string[];
  onSelectProduct: (product: Product) => void;
}

/** Searchable single-product picker (the featured product). */
export function ProductPickerPopover({ triggerLabel, selectedCategoryIds = [], onSelectProduct }: ProductPickerPopoverProps) {
  const t = useMessages(collectionFormMessages);
  const tr = useMessages(resourceMessages);
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm.trim(), SEARCH_DEBOUNCE_MS);
  const categoryIds = useMemo(
    () => Array.from(new Set(selectedCategoryIds.map((id) => id.trim()).filter(Boolean))).slice(0, 90),
    [selectedCategoryIds],
  );

  const productQuery = useInfiniteQuery({
    ...collectionProductOptionsQueryOptions({ categoryIds, search: debouncedSearch, limit: PAGE_SIZE }),
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

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearchTerm("");
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} className="min-w-0 flex-1 justify-between">
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={t("searchProducts")} value={searchTerm} onValueChange={setSearchTerm} />
          <CommandList>
            {isLoading ? (
              <p role="status" className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("searching")}
              </p>
            ) : productQuery.isError && products.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-5">
                <p className="text-muted-foreground">{t("productsLoadFailed")}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void productQuery.refetch()}>
                  {tr("retry")}
                </Button>
              </div>
            ) : products.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground">{t("noProductsFound")}</p>
            ) : (
              <CommandGroup>
                {products.map((product) => (
                  <CommandItem
                    key={product.id}
                    value={product.id}
                    onSelect={() => {
                      if (!isCollectionProductOptionDto(product)) return;
                      onSelectProduct(product);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{product.name}</span>
                      {product.categoryName ? (
                        <span className="block truncate text-muted-foreground">{product.categoryName}</span>
                      ) : null}
                    </span>
                    {product.isActive === false ? <Badge variant="attention">{t("draft")}</Badge> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {productQuery.hasNextPage ? (
              <div className="border-t p-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  loading={productQuery.isFetchingNextPage}
                  onClick={() => void productQuery.fetchNextPage()}
                >
                  {productQuery.isFetchNextPageError ? tr("retry") : t("loadMore")}
                </Button>
              </div>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
