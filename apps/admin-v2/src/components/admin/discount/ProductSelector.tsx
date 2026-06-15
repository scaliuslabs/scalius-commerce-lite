//src/components/admin/discount/ProductSelector.tsx
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Button } from "../../ui/button";
import { Check, ChevronsUpDown, Loader2, Tag, X } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Badge } from "../../ui/badge";
import { useCurrency } from "~/hooks/use-currency";
import { getProducts, getProductsByIds } from "~/lib/api-functions/products";

// Product interface based on what's used in OrderForm
interface Product {
  id: string;
  name: string;
  price: number;
  primaryImage?: string | null;
  discountPercentage?: number | null;
  variants?: Array<{
    id: string;
    size: string | null;
    color: string | null;
    price: number;
  }>;
}

interface ProductSelectorProps {
  selectedProducts: Product[];
  onChange: (products: Product[]) => void;
  buttonLabel?: string;
  className?: string;
  isLoading?: boolean;
  maxItems?: number;
}

export function ProductSelector({
  selectedProducts = [] as Product[],
  onChange,
  buttonLabel = "Select Products",
  className,
  isLoading = false,
  maxItems,
}: ProductSelectorProps) {
  const { symbol } = useCurrency();
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [displayedProducts, setDisplayedProducts] = useState<Product[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResolutionSignatureRef = useRef("");
  const skipNextSearchLoadRef = useRef(false);

  // Main function to load products
  const loadProducts = useCallback(async (page = 1, search = "") => {
    try {
      if (page === 1) {
        setIsSearching(true);
      } else {
        setIsLoadingMore(true);
      }

      const data = await getProducts({
        data: {
          limit: 10,
          page,
          search: search.trim() || undefined,
        },
      });

      if (data.products) {
        if (page === 1) {
          // Replace products on first page
          setDisplayedProducts(data.products);
        } else {
          // Append products for pagination
          setDisplayedProducts((prev) => [...prev, ...(data.products || [])]);
        }

        setTotalPages(data.pagination?.totalPages || 1);
        setTotalProducts(data.pagination?.total || 0);
        setCurrentPage(page);
      }
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error("Error loading products:", error);
    } finally {
      setIsSearching(false);
      setIsLoadingMore(false);
    }
  }, []);

  // Load initial products when dropdown opens
  useEffect(() => {
    if (open) {
      skipNextSearchLoadRef.current = true;
      loadProducts(1, "");
    }
  }, [open, loadProducts]);

  // Handle search input changes
  useEffect(() => {
    if (!open) return;

    if (skipNextSearchLoadRef.current && searchTerm === "") {
      skipNextSearchLoadRef.current = false;
      return;
    }

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // Reset to first page when search term changes
    setCurrentPage(1);

    searchTimeoutRef.current = setTimeout(() => {
      loadProducts(1, searchTerm);
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchTerm, open, loadProducts]);

  useEffect(() => {
    const unresolvedIds = selectedProducts
      .filter((product) => product.name === product.id || !product.name)
      .map((product) => product.id);
    const signature = unresolvedIds.join("|");
    if (!signature || signature === lastResolutionSignatureRef.current) return;

    lastResolutionSignatureRef.current = signature;
    let cancelled = false;

    const resolveNames = async () => {
      try {
        const data = await getProductsByIds({ data: { ids: unresolvedIds } });
        const productMap = new Map(data.products.map((product) => [product.id, product]));
        const resolved = selectedProducts.map((selected) => {
          const found = productMap.get(selected.id);
          return found && (selected.name === selected.id || !selected.name)
            ? { ...selected, ...found }
            : selected;
        });

        if (!cancelled && resolved.some((item, index) => item.name !== selectedProducts[index].name)) {
          onChange(resolved);
        }
      } catch (error: unknown) {
        if (import.meta.env.DEV) console.error("Error resolving product names:", error);
      }
    };

    void resolveNames();
    return () => {
      cancelled = true;
    };
  }, [onChange, selectedProducts]);

  // Load more products for pagination
  const loadMoreProducts = () => {
    if (currentPage < totalPages && !isLoadingMore) {
      loadProducts(currentPage + 1, searchTerm);
    }
  };

  // Handle product selection
  const handleSelectProduct = (product: Product) => {
    // Check if product is already selected
    const isSelected = selectedProducts.some((p) => p.id === product.id);

    if (isSelected) {
      // Remove product if already selected
      onChange(selectedProducts.filter((p) => p.id !== product.id));
    } else {
      // Check max items limit
      if (maxItems && selectedProducts.length >= maxItems) {
        return;
      }

      // Add product
      onChange([...selectedProducts, product]);
    }
  };

  // Memoize selected product lookup for better performance
  const selectedProductsMap = useMemo(() => {
    const map = new Map<string, boolean>();
    selectedProducts.forEach((product) => {
      map.set(product.id, true);
    });
    return map;
  }, [selectedProducts]);

  return (
    <div className={className}>
      <Popover
        open={open}
        onOpenChange={(newOpen) => {
          setOpen(newOpen);
          if (!newOpen) {
            // Reset search when closing
            setSearchTerm("");
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
            disabled={isLoading}
          >
            <div className="flex items-center gap-2">
              <Tag className="h-4 w-4" />
              <span className="truncate">
                {selectedProducts.length > 0
                  ? `${selectedProducts.length} product${selectedProducts.length > 1 ? "s" : ""} selected`
                  : buttonLabel}
              </span>
            </div>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search products..."
              value={searchTerm}
              onValueChange={setSearchTerm}
            />
            <CommandList>
              <CommandEmpty>
                {isSearching ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" />
                    <span>Searching products...</span>
                  </div>
                ) : (
                  "No products found."
                )}
              </CommandEmpty>
              <CommandGroup>
                {displayedProducts.map((product) => {
                  const isSelected = selectedProductsMap.has(product.id);
                  return (
                    <CommandItem
                      key={product.id}
                      value={product.id}
                      onSelect={() => handleSelectProduct(product)}
                    >
                      <div className="flex items-center justify-between w-full">
                        <div className="flex items-center gap-2 truncate">
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4 shrink-0",
                              isSelected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          {product.primaryImage ? (
                            <img
                              src={product.primaryImage}
                              alt=""
                              className="h-6 w-6 rounded object-cover shrink-0"
                            />
                          ) : (
                            <div className="h-6 w-6 rounded bg-muted flex items-center justify-center shrink-0">
                              <Tag className="h-3 w-3 text-muted-foreground" />
                            </div>
                          )}
                          <span className="truncate">{product.name}</span>
                        </div>
                        <div className="text-sm text-muted-foreground shrink-0 ml-2">
                          {symbol}{product.price}
                        </div>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>

              {currentPage < totalPages && (
                <div className="py-2 px-2 border-t">
                  <Button
                    variant="outline"
                    className="w-full"
                    size="sm"
                    onClick={loadMoreProducts}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        Load More ({displayedProducts.length} of {totalProducts}
                        )
                      </>
                    )}
                  </Button>
                </div>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Show selected products as badges */}
      {selectedProducts.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {selectedProducts.map((product) => (
            <Badge
              key={product.id}
              variant="secondary"
              className="flex items-center gap-1 pr-1.5"
            >
              <span className="truncate max-w-[180px]">{product.name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-4 w-4 p-0 ml-1"
                onClick={() =>
                  onChange(selectedProducts.filter((p) => p.id !== product.id))
                }
              >
                <X className="h-3 w-3" />
                <span className="sr-only">Remove</span>
              </Button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
