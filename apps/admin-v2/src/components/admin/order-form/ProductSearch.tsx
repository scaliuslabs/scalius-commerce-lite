import React from "react";
import { ImageIcon, Loader2, Search } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useOrderForm } from "./OrderFormContext";
import type { Product } from "./types";
import { useCurrency } from "@/hooks/use-currency";
import { useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { resourceMessages } from "@/i18n/resource";
import { discountedUnitPrice } from "./order-item-presentation";

export const PRODUCT_SEARCH_INPUT_ID = "order-product-search";

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
  selectProduct: (product: Product) => void;
  invalid?: boolean;
}

/**
 * The product picker is the search field itself: typing (or focusing it)
 * lists matching products with a thumbnail, price and stock.
 */
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
  selectProduct,
  invalid = false,
}: ProductSearchProps) {
  const { refs } = useOrderForm();
  const { fmt } = useCurrency();
  const t = useMessages(orderFormMessages);
  const r = useMessages(resourceMessages);
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listId = React.useId();
  const showOptions = !isLoading && !isError && displayedProducts.length > 0;
  const active = showOptions ? Math.min(activeIndex, displayedProducts.length - 1) : -1;

  const pick = (product: Product) => {
    selectProduct(product);
    setSearchTerm("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        id={PRODUCT_SEARCH_INPUT_ID}
        ref={refs.productSearchInputRef}
        type="search"
        role="combobox"
        autoComplete="off"
        aria-label={t("addProduct")}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid || undefined}
        placeholder={t("searchProducts")}
        // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
        className="pl-9"
        value={searchTerm}
        onChange={(event) => {
          setSearchTerm(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex(Math.max(0, Math.min(active + step, displayedProducts.length - 1)));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const product = displayedProducts[active];
            if (open && product) pick(product);
            else setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      />
      {open ? (
        <div
          // Clicks inside keep focus in the search field.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto overscroll-contain rounded-xl bg-popover p-1.5 shadow-popover"
        >
          {isLoading ? (
            <p className="flex items-center justify-center gap-2 py-6 text-body text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("searching")}
            </p>
          ) : isError ? (
            <div className="space-y-3 px-4 py-5 text-center">
              <p className="text-body text-muted-foreground">{t("productsFailed")}</p>
              <Button type="button" variant="outline" size="sm" onClick={retry}>
                {r("retry")}
              </Button>
            </div>
          ) : displayedProducts.length === 0 ? (
            <p className="px-4 py-6 text-center text-body text-muted-foreground">{t("noProducts")}</p>
          ) : null}
          <ul id={listId} role="listbox" aria-label={t("products")}>
            {showOptions ? displayedProducts.map((product, index) => {
              const price = discountedUnitPrice(product, null);
              const variantCount = product.variantCount ?? product.variants.length;
              const stock = product.availableStock;
              return (
                <li
                  key={product.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => pick(product)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5",
                    index === active && "bg-accent",
                  )}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                    {product.primaryImage ? (
                      <img
                        src={mediaImageUrl(product.primaryImage, 96)}
                        alt=""
                        className="size-full object-contain"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium">{product.name}</span>
                    <span className="block truncate text-body text-muted-foreground tabular-nums">
                      {price < product.price ? (
                        <>
                          <s>{fmt(product.price)}</s> {fmt(price)}
                        </>
                      ) : fmt(product.price)}
                      {variantCount > 1 ? ` · ${t("variantCount", { count: variantCount })}` : null}
                    </span>
                  </span>
                  {stock === undefined ? null : (
                    <span
                      className={cn(
                        "shrink-0 text-body tabular-nums",
                        stock === 0 ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {stock === null ? t("noStockLimit") : t("inStock", { count: stock })}
                    </span>
                  )}
                </li>
              );
            }) : null}
          </ul>
          {showOptions && hasMore ? (
            <div className="border-t pt-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                loading={isLoadingMore}
                onClick={loadMoreProducts}
              >
                {isLoadMoreError
                  ? r("retry")
                  : t("loadMore", { shown: displayedProducts.length, total: totalProducts })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
