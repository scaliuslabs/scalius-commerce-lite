import React from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, X } from "lucide-react";
import { useOrderForm } from "./OrderFormContext";
import type { Product } from "./types";

interface ProductSearchProps {
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  displayedProducts: Product[];
  hasMore: boolean;
  loadMoreProducts: () => void;
  selectedProduct: Product | null;
  selectProduct: (product: Product) => void;
  clearProductSelection: () => void;
  calculateDiscountedPrice: (product: Product, variantId: string | null) => string;
}

export function ProductSearch({
  searchTerm,
  setSearchTerm,
  displayedProducts,
  hasMore,
  loadMoreProducts,
  selectedProduct,
  selectProduct,
  clearProductSelection,
  calculateDiscountedPrice,
}: ProductSearchProps) {
  const { refs } = useOrderForm();
  const [productSearchOpen, setProductSearchOpen] = React.useState(false);

  return (
    <div className="flex gap-2 items-end">
      <div className="flex-1">
        <label htmlFor="product-search-button" className="mb-2 block font-medium text-sm">
          Search Products
        </label>
        <Popover
          open={productSearchOpen}
          onOpenChange={setProductSearchOpen}
        >
          <PopoverTrigger asChild>
            <Button
              id="product-search-button"
              ref={refs.productSearchButtonRef}
              variant="outline"
              role="combobox"
              aria-expanded={productSearchOpen}
              className="w-full justify-between"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "ArrowDown") {
                  e.preventDefault();
                  setProductSearchOpen(true);
                }
              }}
            >
              {selectedProduct ? (
                <div className="flex items-center gap-2 truncate">
                  <span className="truncate">{selectedProduct.name}</span>
                  {selectedProduct.discountPercentage ? (
                    <Badge variant="secondary" className="text-xs">
                      {selectedProduct.discountPercentage}% OFF
                    </Badge>
                  ) : null}
                </div>
              ) : (
                "Search for products..."
              )}
              <Search className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="p-0 w-[calc(100vw-2rem)] sm:w-[500px] md:w-[600px]"
            align="start"
            sideOffset={4}
          >
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search products..."
                className="h-10 border-none focus:ring-0"
                value={searchTerm}
                onValueChange={setSearchTerm}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setProductSearchOpen(false);
                    refs.productSearchButtonRef.current?.focus();
                  }
                }}
              />
              <CommandList className="max-h-[400px] overflow-auto">
                <CommandEmpty className="py-6 text-center text-sm">
                  No products found. Try a different search term.
                </CommandEmpty>
                <CommandGroup heading="Products">
                  {displayedProducts.map((product) => (
                    <CommandItem
                      key={product.id}
                      value={product.name} // Use name for Command's internal filtering
                      onSelect={() => {
                        selectProduct(product);
                        setProductSearchOpen(false);
                      }}
                      className="flex justify-between py-3 px-4 cursor-pointer hover:bg-accent"
                    >
                      <div className="flex-1 overflow-hidden">
                        <div className="font-medium truncate">{product.name}</div>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          {product.discountPercentage ? (
                            <>
                              <span className="line-through text-xs text-muted-foreground">
                                ৳{product.price.toLocaleString()}
                              </span>
                              <span className="text-xs text-green-600 font-medium">
                                ৳
                                {parseFloat(
                                  calculateDiscountedPrice(product, null)
                                ).toLocaleString()}
                              </span>
                              <Badge variant="secondary" className="text-xs h-5">
                                {product.discountPercentage}% OFF
                              </Badge>
                            </>
                          ) : (
                            <span className="text-xs">
                              ৳{product.price.toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center ml-2">
                        {product.variants.length > 0 ? (
                          <Badge variant="outline">
                            {product.variants.length}{" "}
                            {product.variants.length === 1 ? "variant" : "variants"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">No variants</Badge>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                  {hasMore && (
                    <div className="p-3 flex justify-center border-t">
                      <Button
                        variant="link"
                        size="sm"
                        onClick={(e) => {
                          e.preventDefault();
                          loadMoreProducts();
                        }}
                        className="w-full"
                      >
                        Load More Products
                      </Button>
                    </div>
                  )}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {selectedProduct && (
        <Button
          variant="ghost"
          size="icon"
          onClick={clearProductSelection}
          className="shrink-0"
          aria-label="Clear selected product"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}