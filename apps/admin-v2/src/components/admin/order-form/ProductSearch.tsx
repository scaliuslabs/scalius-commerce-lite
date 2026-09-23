import React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Loader2, Search, X } from "lucide-react";
import { useOrderForm } from "./OrderFormContext";
import type { Product } from "./types";
import { useCurrency } from "@/hooks/use-currency";
import { useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { resourceMessages } from "@/i18n/resource";
import { discountedUnitPrice } from "./order-item-presentation";

interface ProductSearchProps {
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  displayedProducts: Product[];
  hasMore: boolean;
  loadMoreProducts: () => void;
  totalProducts: number;
  isLoading: boolean;
  isError: boolean;
  isLoadingMore: boolean;
  isLoadMoreError: boolean;
  retry: () => void;
  selectedProduct: Product | null;
  isLoadingVariants: boolean;
  selectProduct: (product: Product) => void;
  clearProductSelection: () => void;
}

/** Product picker: server-backed catalog search with "load more". */
export function ProductSearch({
  searchTerm,
  setSearchTerm,
  displayedProducts,
  hasMore,
  loadMoreProducts,
  totalProducts,
  isLoading,
  isError,
  isLoadingMore,
  isLoadMoreError,
  retry,
  selectedProduct,
  isLoadingVariants,
  selectProduct,
  clearProductSelection,
}: ProductSearchProps) {
  const { refs } = useOrderForm();
  const { fmt } = useCurrency();
  const t = useMessages(orderFormMessages);
  const r = useMessages(resourceMessages);
  const [open, setOpen] = React.useState(false);

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="product-search-button"
            ref={refs.productSearchButtonRef}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={t("addProduct")}
            className="min-w-0 flex-1 justify-between"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
              }
            }}
          >
            <span className="truncate">
              {selectedProduct ? selectedProduct.name : t("searchProducts")}
            </span>
            {isLoadingVariants ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-label={t("loadingVariants")} />
            ) : (
              <Search className="h-4 w-4 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 sm:w-96" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t("searchProducts")}
              value={searchTerm}
              onValueChange={setSearchTerm}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  refs.productSearchButtonRef.current?.focus();
                }
              }}
            />
            <CommandList>
              {isLoading ? (
                <p className="flex items-center justify-center gap-2 py-8 text-body text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("searching")}
                </p>
              ) : isError ? (
                <div className="space-y-3 px-4 py-6 text-center">
                  <p className="text-body text-muted-foreground">{t("productsFailed")}</p>
                  <Button type="button" variant="outline" size="sm" onClick={retry}>
                    {r("retry")}
                  </Button>
                </div>
              ) : displayedProducts.length === 0 ? (
                <p className="px-4 py-8 text-center text-body text-muted-foreground">
                  {t("noProducts")}
                </p>
              ) : (
                <CommandGroup>
                  {displayedProducts.map((product) => {
                    const price = discountedUnitPrice(product, null);
                    const variantCount = product.variantCount ?? product.variants.length;
                    return (
                      <CommandItem
                        key={product.id}
                        value={product.id}
                        onSelect={() => {
                          selectProduct(product);
                          setSearchTerm("");
                          setOpen(false);
                        }}
                        className="flex items-start justify-between"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{product.name}</p>
                          <p className="text-body text-muted-foreground">
                            {price < product.price ? (
                              <>
                                <s>{fmt(product.price)}</s> {fmt(price)}
                              </>
                            ) : fmt(product.price)}
                          </p>
                        </div>
                        {variantCount > 1 ? (
                          <span className="shrink-0 text-body text-muted-foreground">
                            {t("variantCount", { count: variantCount })}
                          </span>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
              {!isLoading && !isError && hasMore ? (
                <div className="border-t p-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={isLoadingMore}
                    onClick={(e) => {
                      e.preventDefault();
                      loadMoreProducts();
                    }}
                  >
                    {isLoadingMore
                      ? t("loading")
                      : isLoadMoreError
                        ? r("retry")
                        : t("loadMore", { shown: displayedProducts.length, total: totalProducts })}
                  </Button>
                </div>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedProduct ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={clearProductSelection}
          aria-label={t("clearProduct")}
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}
