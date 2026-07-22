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
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";

export interface DiscountProductOption {
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
  selectedProducts: DiscountProductOption[];
  onChange: (products: DiscountProductOption[]) => void;
  buttonLabel?: string;
  className?: string;
  isLoading?: boolean;
  maxItems?: number;
}

export function ProductSelector({
  selectedProducts = [] as DiscountProductOption[],
  onChange,
  buttonLabel = "Select products",
  className,
  isLoading = false,
  maxItems,
}: ProductSelectorProps) {
  const { symbol } = useCurrency();
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [displayedProducts, setDisplayedProducts] = useState<DiscountProductOption[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastResolutionSignatureRef = useRef("");
  const skipNextSearchLoadRef = useRef(false);
  const loadRequestRef = useRef(0);

  const loadProducts = useCallback(async (page = 1, search = "") => {
    const requestId = ++loadRequestRef.current;
    try {
      setLoadError(null);
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

      if (requestId !== loadRequestRef.current) return;

      if (data.products) {
        if (page === 1) {
          setDisplayedProducts(data.products);
        } else {
          setDisplayedProducts((prev) => [...prev, ...(data.products || [])]);
        }

        setTotalPages(data.pagination?.totalPages || 1);
        setTotalProducts(data.pagination?.total || 0);
        setCurrentPage(page);
      }
    } catch (error: unknown) {
      if (import.meta.env.DEV) console.error("Error loading products:", error);
      if (requestId === loadRequestRef.current) {
        setLoadError("Products could not be loaded.");
      }
    } finally {
      if (requestId === loadRequestRef.current) {
        setIsSearching(false);
        setIsLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    if (open) {
      skipNextSearchLoadRef.current = true;
      loadProducts(1, "");
    }
  }, [open, loadProducts]);

  useEffect(() => {
    if (!open) return;

    if (skipNextSearchLoadRef.current && searchTerm === "") {
      skipNextSearchLoadRef.current = false;
      return;
    }

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

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
        if (!cancelled) lastResolutionSignatureRef.current = "";
      }
    };

    void resolveNames();
    return () => {
      cancelled = true;
    };
  }, [onChange, selectedProducts]);

  const loadMoreProducts = () => {
    if (currentPage < totalPages && !isLoadingMore) {
      loadProducts(currentPage + 1, searchTerm);
    }
  };

  const handleSelectProduct = (product: DiscountProductOption) => {
    const isSelected = selectedProducts.some((p) => p.id === product.id);

    if (isSelected) {
      onChange(selectedProducts.filter((p) => p.id !== product.id));
    } else {
      if (maxItems && selectedProducts.length >= maxItems) {
        return;
      }

      // Add product
      onChange([...selectedProducts, product]);
    }
  };

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
            setSearchTerm("");
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-11 w-full justify-between sm:h-9"
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
        <PopoverContent
          align="start"
          collisionPadding={16}
          className="w-[min(22rem,calc(100vw-2rem))] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              aria-label="Search products"
              placeholder="Search products..."
              value={searchTerm}
              onValueChange={setSearchTerm}
              className="h-11 border-none focus:ring-0 sm:h-10"
            />
            <CommandList className="max-h-[min(50vh,20rem)] overflow-auto">
              {loadError ? (
                <div role="alert" className="m-2 rounded-md border border-destructive/30 p-3 text-sm">
                  <p className="text-destructive">{loadError}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 h-11 sm:h-8"
                    onClick={() => void loadProducts(1, searchTerm)}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              <CommandEmpty>
                {loadError ? null : isSearching ? (
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
                  const atLimit = Boolean(
                    maxItems && selectedProducts.length >= maxItems && !isSelected,
                  );
                  return (
                    <CommandItem
                      key={product.id}
                      value={product.id}
                      onSelect={() => handleSelectProduct(product)}
                      disabled={atLimit}
                      className="min-h-11 cursor-pointer sm:min-h-8"
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
                              src={getOptimizedImageUrl(
                                product.primaryImage,
                                ADMIN_IMAGE_PRESETS.productMicro,
                              )}
                              alt=""
                              className="h-6 w-6 shrink-0 rounded bg-muted object-contain object-center"
                              loading="lazy"
                              decoding="async"
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
                    type="button"
                    variant="outline"
                    className="h-11 w-full sm:h-8"
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
                        Load more ({displayedProducts.length} of {totalProducts}
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
                type="button"
                variant="ghost"
                size="icon"
                className="-my-2 ml-1 h-11 w-11 p-0 sm:my-0 sm:h-5 sm:w-5"
                aria-label={`Remove ${product.name}`}
                onClick={() =>
                  onChange(selectedProducts.filter((p) => p.id !== product.id))
                }
              >
                <X className="h-3 w-3" />
                <span className="sr-only">Remove {product.name}</span>
              </Button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
