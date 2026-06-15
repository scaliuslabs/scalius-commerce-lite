import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "../../ui/button";
import {
  Command,
  CommandEmpty,
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
import { getProducts } from "~/lib/api-functions/products";
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
  const [displayedProducts, setDisplayedProducts] = useState<Product[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextSearchLoadRef = useRef(false);

  const loadProducts = useCallback(
    async (page = 1, search = "") => {
      try {
        if (page === 1) {
          setIsSearching(true);
        } else {
          setIsLoadingMore(true);
        }

        if (selectedCategoryIds.length > 1) {
          const allProducts = new Map<string, Product>();
          await Promise.all(
            selectedCategoryIds.map(async (categoryId) => {
              const data = await getProducts({
                data: {
                  limit: 50,
                  page: 1,
                  search: search.trim() || undefined,
                  categoryId,
                },
              });
              for (const product of data.products || []) {
                allProducts.set(product.id, product);
              }
            }),
          );
          const merged = Array.from(allProducts.values());
          setDisplayedProducts(merged);
          setTotalPages(1);
          setTotalProducts(merged.length);
          setCurrentPage(1);
          return;
        }

        const data = await getProducts({
          data: {
            limit: PAGE_SIZE,
            page,
            search: search.trim() || undefined,
            categoryId: selectedCategoryIds[0],
          },
        });

        if (page === 1) {
          setDisplayedProducts(data.products || []);
        } else {
          setDisplayedProducts((prev) => [...prev, ...(data.products || [])]);
        }
        setTotalPages(data.pagination?.totalPages || 1);
        setTotalProducts(data.pagination?.total || 0);
        setCurrentPage(page);
      } catch (error: unknown) {
        if (import.meta.env.DEV) console.error("Error loading products:", error);
      } finally {
        setIsSearching(false);
        setIsLoadingMore(false);
      }
    },
    [selectedCategoryIds],
  );

  useEffect(() => {
    if (!open) return;
    setSearchTerm("");
    setCurrentPage(1);
    skipNextSearchLoadRef.current = true;
    loadProducts(1, "");
  }, [loadProducts, open]);

  useEffect(() => {
    if (!open) return;

    if (skipNextSearchLoadRef.current && searchTerm === "") {
      skipNextSearchLoadRef.current = false;
      return;
    }

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      loadProducts(1, searchTerm);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [loadProducts, open, searchTerm]);

  const excluded = useMemo(() => new Set(excludeProductIds), [excludeProductIds]);
  const availableProducts = useMemo(
    () => displayedProducts.filter((product) => !excluded.has(product.id)),
    [displayedProducts, excluded],
  );

  const loadMoreProducts = () => {
    if (currentPage < totalPages && !isLoadingMore) {
      loadProducts(currentPage + 1, searchTerm);
    }
  };

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
              (selectedCategoryIds.length > 0
                ? "Search within selected categories..."
                : "Search products...")
            }
            className="h-10 border-none focus:ring-0"
            value={searchTerm}
            onValueChange={setSearchTerm}
          />
          <CommandList className="max-h-[300px] overflow-auto">
            {isSearching ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                <span className="text-sm text-muted-foreground">
                  Searching products...
                </span>
              </div>
            ) : (
              <>
                <CommandEmpty className="py-6 text-center text-sm">
                  No products found.
                </CommandEmpty>
                <CommandGroup>
                  {availableProducts.map((product) => (
                    <CommandItem
                      key={product.id}
                      value={product.name}
                      onSelect={() => {
                        onSelectProduct(product);
                        setOpen(false);
                      }}
                      className="cursor-pointer"
                    >
                      {product.name}
                    </CommandItem>
                  ))}
                </CommandGroup>

                {currentPage < totalPages && (
                  <div className="py-2 px-2 border-t">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      size="sm"
                      onClick={(event) => {
                        event.preventDefault();
                        loadMoreProducts();
                      }}
                      disabled={isLoadingMore}
                    >
                      {isLoadingMore ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        <>
                          Load More ({displayedProducts.length} of{" "}
                          {totalProducts})
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
