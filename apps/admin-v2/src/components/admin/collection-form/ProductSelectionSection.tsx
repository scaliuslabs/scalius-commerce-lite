import React, { useState, useEffect, useRef, useCallback } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  FormDescription,
  FormLabel,
} from "../../ui/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Button } from "../../ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../ui/command";
import { Alert, AlertDescription } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Trash2, Layers, Package, Search, Loader2, Info } from "lucide-react";
import { getProducts } from "~/lib/api.functions";
import type { CollectionFormValues, Category, Product } from "./types";

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

interface ProductSelectionSectionProps {
  form: UseFormReturn<CollectionFormValues>;
  categories: Category[];
  selectedCategories: Category[];
  selectedProducts: Product[];
  selectedCategoryIds: string[];
  selectedProductIds: string[];
  addCategory: (id: string) => void;
  removeCategory: (id: string) => void;
  addProduct: (id: string) => void;
  removeProduct: (id: string) => void;
}

export const ProductSelectionSection = React.memo(
  function ProductSelectionSection({
    categories,
    selectedCategories,
    selectedProducts,
    selectedCategoryIds,
    selectedProductIds,
    addCategory,
    removeCategory,
    addProduct,
    removeProduct,
  }: ProductSelectionSectionProps) {
    const [productSearchOpen, setProductSearchOpen] = useState(false);
    const [productSearchTerm, setProductSearchTerm] = useState("");

    // Paginated product state
    const [displayedProducts, setDisplayedProducts] = useState<Product[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [totalProducts, setTotalProducts] = useState(0);

    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Track the category filter that was used for the current displayed results
    const lastCategoryFilterRef = useRef<string | undefined>(undefined);

    const loadProducts = useCallback(
      async (page = 1, search?: string) => {
        try {
          if (page === 1) {
            setIsSearching(true);
          } else {
            setIsLoadingMore(true);
          }

          // When only 1 category selected, use server-side filter.
          // When multiple selected, fetch all and filter client-side.
          const categoryId =
            selectedCategoryIds.length === 1
              ? selectedCategoryIds[0]
              : undefined;

          lastCategoryFilterRef.current = categoryId;

          const data = (await getProducts({
            data: {
              limit: selectedCategoryIds.length > 1 ? 100 : PAGE_SIZE,
              page: selectedCategoryIds.length > 1 ? 1 : page,
              search: search?.trim() || undefined,
              categoryId,
            },
          })) as {
            products?: Product[];
            pagination?: { totalPages: number; total: number };
          };

          if (data.products) {
            // When multiple categories selected, filter client-side
            let filtered = data.products;
            if (selectedCategoryIds.length > 1) {
              const catSet = new Set(selectedCategoryIds);
              filtered = data.products.filter(
                (p) => p.categoryId && catSet.has(p.categoryId),
              );
            }

            if (page === 1) {
              setDisplayedProducts(filtered);
            } else {
              setDisplayedProducts((prev) => [...prev, ...filtered]);
            }
            setTotalPages(selectedCategoryIds.length > 1 ? 1 : (data.pagination?.totalPages || 1));
            setTotalProducts(selectedCategoryIds.length > 1 ? filtered.length : (data.pagination?.total || 0));
            setCurrentPage(page);
          }
        } catch (error: unknown) {
          console.error("Error loading products:", error);
        } finally {
          setIsSearching(false);
          setIsLoadingMore(false);
        }
      },
      [selectedCategoryIds],
    );

    // Load products when the popover opens
    useEffect(() => {
      if (productSearchOpen) {
        setProductSearchTerm("");
        setCurrentPage(1);
        loadProducts(1, "");
      }
    }, [productSearchOpen, loadProducts]);

    // Debounced search when the search term changes
    useEffect(() => {
      if (!productSearchOpen) return;

      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      searchTimeoutRef.current = setTimeout(() => {
        loadProducts(1, productSearchTerm);
      }, SEARCH_DEBOUNCE_MS);

      return () => {
        if (searchTimeoutRef.current) {
          clearTimeout(searchTimeoutRef.current);
        }
      };
    }, [productSearchTerm]);

    // Reload when category selection changes while popover is open
    useEffect(() => {
      if (!productSearchOpen) return;

      const currentCategoryId =
        selectedCategoryIds.length > 0 ? selectedCategoryIds[0] : undefined;

      // Only reload if the effective category filter actually changed
      if (currentCategoryId !== lastCategoryFilterRef.current) {
        loadProducts(1, productSearchTerm);
      }
    }, [selectedCategoryIds, productSearchOpen]);

    const loadMoreProducts = () => {
      if (currentPage < totalPages && !isLoadingMore) {
        loadProducts(currentPage + 1, productSearchTerm);
      }
    };

    // Filter out already-selected products from the displayed list
    const availableProducts = React.useMemo(() => {
      const selectedSet = new Set(selectedProductIds);
      return displayedProducts.filter((p) => !selectedSet.has(p.id));
    }, [displayedProducts, selectedProductIds]);

    const hasSpecificProducts = selectedProductIds.length > 0;
    const hasCategoriesOnly =
      selectedCategoryIds.length > 0 && !hasSpecificProducts;

    return (
      <Card>
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-base">Product Selection</CardTitle>
          <CardDescription className="text-xs">
            Choose categories or specific products to include
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {/* Category Selection */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-muted-foreground" />
              <FormLabel>Categories</FormLabel>
            </div>
            <div className="flex gap-2">
              <Select
                onValueChange={(value) => {
                  if (value) addCategory(value);
                }}
                value=""
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select categories to include..." />
                </SelectTrigger>
                <SelectContent className="rounded-xl bg-background max-h-[300px]">
                  {categories
                    .filter((cat) => !selectedCategoryIds.includes(cat.id))
                    .map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {selectedCategories.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedCategories.map((category) => (
                  <Badge
                    key={category.id}
                    variant="secondary"
                    className="flex items-center gap-1 pr-1.5"
                  >
                    <span className="truncate max-w-[180px]">
                      {category.name}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0 ml-1 hover:bg-destructive/20"
                      onClick={() => removeCategory(category.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                      <span className="sr-only">Remove</span>
                    </Button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Informational text about how categories/products interact */}
          {hasCategoriesOnly && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                All active products from selected categories will be shown on
                the storefront (up to max products limit).
              </AlertDescription>
            </Alert>
          )}

          {hasSpecificProducts && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                These specific products will be shown in the collection.
                {selectedCategoryIds.length > 0
                  ? " Category selection is used to filter the product search below only."
                  : ""}
              </AlertDescription>
            </Alert>
          )}

          {/* Product Selection */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              <FormLabel>Specific Products (Optional)</FormLabel>
            </div>
            <Popover
              open={productSearchOpen}
              onOpenChange={(open) => {
                setProductSearchOpen(open);
                if (!open) {
                  setProductSearchTerm("");
                }
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={productSearchOpen}
                  className="w-full justify-between font-normal"
                >
                  Search products to add...
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
                      selectedCategoryIds.length > 0
                        ? "Search within selected categories..."
                        : "Search products..."
                    }
                    className="h-10 border-none focus:ring-0"
                    value={productSearchTerm}
                    onValueChange={setProductSearchTerm}
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
                                addProduct(product.id);
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
                              variant="outline"
                              className="w-full"
                              size="sm"
                              onClick={(e) => {
                                e.preventDefault();
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
            {selectedProducts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedProducts.map((product) => (
                  <Badge
                    key={product.id}
                    variant="outline"
                    className="flex items-center gap-1 pr-1.5"
                  >
                    <span className="truncate max-w-[180px]">
                      {product.name}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0 ml-1 hover:bg-destructive/20"
                      onClick={() => removeProduct(product.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                      <span className="sr-only">Remove</span>
                    </Button>
                  </Badge>
                ))}
              </div>
            )}
            <FormDescription>
              Add specific products that will always be included regardless of
              category selection
            </FormDescription>
          </div>
        </CardContent>
      </Card>
    );
  },
);
