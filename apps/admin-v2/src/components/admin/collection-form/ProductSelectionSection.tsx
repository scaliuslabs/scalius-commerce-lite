import React from "react";
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
import { Badge } from "../../ui/badge";
import { Trash2, Layers, Package, Search } from "lucide-react";
import type { CollectionFormValues, Category, Product } from "./types";

interface ProductSelectionSectionProps {
  form: UseFormReturn<CollectionFormValues>;
  categories: Category[];
  filteredProducts: Product[];
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
    filteredProducts,
    selectedCategories,
    selectedProducts,
    selectedCategoryIds,
    selectedProductIds,
    addCategory,
    removeCategory,
    addProduct,
    removeProduct,
  }: ProductSelectionSectionProps) {
    const [productSearchOpen, setProductSearchOpen] = React.useState(false);
    const [productSearchTerm, setProductSearchTerm] = React.useState("");

    const searchableProducts = React.useMemo(() => {
      let pool = filteredProducts.filter(
        (prod) => !selectedProductIds.includes(prod.id),
      );
      if (productSearchTerm.trim()) {
        const term = productSearchTerm.toLowerCase().trim();
        pool = pool.filter((prod) =>
          prod.name.toLowerCase().includes(term),
        );
      }
      return pool;
    }, [filteredProducts, selectedProductIds, productSearchTerm]);

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
            <FormDescription>
              All active products from these categories will be included
            </FormDescription>
          </div>

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
                if (!open) setProductSearchTerm("");
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
                    placeholder="Search products..."
                    className="h-10 border-none focus:ring-0"
                    value={productSearchTerm}
                    onValueChange={setProductSearchTerm}
                  />
                  <CommandList className="max-h-[300px] overflow-auto">
                    <CommandEmpty className="py-6 text-center text-sm">
                      No products found.
                    </CommandEmpty>
                    <CommandGroup>
                      {searchableProducts.map((product) => (
                        <CommandItem
                          key={product.id}
                          value={product.name}
                          onSelect={() => {
                            addProduct(product.id);
                            setProductSearchTerm("");
                          }}
                          className="cursor-pointer"
                        >
                          {product.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
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
              Add specific products that will always be included
            </FormDescription>
          </div>
        </CardContent>
      </Card>
    );
  },
);
