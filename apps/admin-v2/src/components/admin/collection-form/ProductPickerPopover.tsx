import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "~/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useMessages } from "~/i18n";
import { collectionFormMessages } from "~/i18n/collection-form";
import { resourceMessages } from "~/i18n/resource";
import type { Product } from "./types";
import { ProductOptionMeta, ProductOptionsStatus, useProductOptions } from "./ProductPickerDialog";

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
  const categoryIds = useMemo(
    () => Array.from(new Set(selectedCategoryIds.map((id) => id.trim()).filter(Boolean))).slice(0, 90),
    [selectedCategoryIds],
  );
  const options = useProductOptions({ open, search: searchTerm, categoryIds, limit: 10 });
  const { query, products } = options;

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
            <ProductOptionsStatus options={options} />
            {options.isLoading || products.length === 0 ? null : (
              <CommandGroup>
                {products.map((product) => (
                  <CommandItem
                    key={product.id}
                    value={product.id}
                    onSelect={() => {
                      onSelectProduct(product);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{product.name}</span>
                      <ProductOptionMeta product={product} />
                    </span>
                    {product.isActive === false ? <Badge variant="attention">{t("draft")}</Badge> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {query.hasNextPage ? (
              <div className="border-t p-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  loading={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchNextPageError ? tr("retry") : t("loadMore")}
                </Button>
              </div>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
