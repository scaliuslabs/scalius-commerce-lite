import React from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useOrderForm } from "./OrderFormContext";
import { ProductSearch } from "./ProductSearch";
import { ItemSelection } from "./ItemSelection";
import { OrderItemsTable } from "./OrderItemsTable";
import { updateOrderItems } from "@/store/orderStore";
import { productVariantsQueryOptions } from "@/lib/api-query-options/products";
import { orderCatalogProductsQueryOptions } from "@/lib/api-query-options/orders";
import { useDebounce } from "@/hooks/use-debounce";
import type { ProductListItemDto } from "@/lib/api-functions/products";
import type { Product } from "./types";

const ORDER_CATALOG_PAGE_SIZE = 10;
const ORDER_CATALOG_SEARCH_DEBOUNCE_MS = 300;
type ProductVariant = Product["variants"][number];
type RawProductVariant = Omit<ProductVariant, "weight"> & {
  weight: number | string | null;
  deletedAt?: unknown;
};

interface ProductVariantsResult {
  variants?: RawProductVariant[];
}

function normalizeVariant(variant: RawProductVariant): ProductVariant {
  return {
    id: variant.id,
    optionCombinationKey: variant.optionCombinationKey,
    selectedOptions: variant.selectedOptions ?? [],
    weight:
      typeof variant.weight === "string"
        ? parseFloat(variant.weight) || null
        : (variant.weight ?? null),
    sku: variant.sku || "",
    price: variant.price ?? 0,
    stock: variant.stock ?? 0,
    reservedStock: variant.reservedStock ?? 0,
    isDefault: variant.isDefault ?? false,
    trackInventory: variant.trackInventory ?? true,
    discountType: variant.discountType ?? null,
    discountPercentage: variant.discountPercentage ?? null,
    discountAmount: variant.discountAmount ?? null,
  };
}

function normalizeVariants(result: unknown): ProductVariant[] {
  const variants = (result as ProductVariantsResult | null)?.variants;
  if (!Array.isArray(variants)) return [];
  return variants.filter((variant) => !variant.deletedAt).map(normalizeVariant);
}

function normalizeCatalogProduct(product: ProductListItemDto): Product {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    discountPercentage: product.discountPercentage ?? null,
    discountType: product.discountType ?? null,
    discountAmount: product.discountAmount ?? null,
    variantCount: product.variantCount ?? 0,
    variants: [],
  };
}

export function OrderItemsSection() {
  const { form, refs } = useOrderForm();
  const queryClient = useQueryClient();

  const [searchTerm, setSearchTerm] = React.useState("");
  const debouncedSearch = useDebounce(
    searchTerm.trim(),
    ORDER_CATALOG_SEARCH_DEBOUNCE_MS,
  );
  const productQuery = useInfiniteQuery(
    orderCatalogProductsQueryOptions({
      search: debouncedSearch,
      limit: ORDER_CATALOG_PAGE_SIZE,
    }),
  );
  const displayedProducts = React.useMemo(() => {
    const byId = new Map<string, Product>();
    for (const page of productQuery.data?.pages ?? []) {
      for (const product of page.products) {
        byId.set(product.id, normalizeCatalogProduct(product));
      }
    }
    return [...byId.values()];
  }, [productQuery.data]);
  const totalProducts = productQuery.data?.pages[0]?.pagination.total ?? 0;
  const isDebouncing = searchTerm.trim() !== debouncedSearch;
  const isInitialProductLoading = isDebouncing || productQuery.isPending
    || (productQuery.isFetching && displayedProducts.length === 0);
  const isInitialProductError = productQuery.isError
    && displayedProducts.length === 0;

  // State for the currently selected item before it's added to the list
  const [selectedProduct, setSelectedProduct] = React.useState<Product | null>(null);
  const [selectedVariant, setSelectedVariant] = React.useState<string>("");
  const [isLoadingVariants, setIsLoadingVariants] = React.useState(false);
  const [quantity, setQuantity] = React.useState<number>(1);
  const [resolvedVariantsById, setResolvedVariantsById] = React.useState<
    Record<string, ProductVariant>
  >({});
  const [resolvedProductsById, setResolvedProductsById] = React.useState<
    Record<string, Product>
  >({});
  const variantLoadTokenRef = React.useRef(0);

  const focusItemInputs = (needsVariantChoice: boolean) => {
    setTimeout(() => {
      const variantSelect = document.getElementById("variant-select-trigger");
      if (variantSelect && needsVariantChoice) {
        variantSelect.focus();
      } else {
        const quantityInput = document.getElementById("quantity-input");
        quantityInput?.focus();
      }
    }, 100);
  };

  const selectProduct = (product: Product) => {
    const loadToken = variantLoadTokenRef.current + 1;
    variantLoadTokenRef.current = loadToken;
    const knownVariants = product.variants || [];
    const shouldLoadVariants =
      knownVariants.length === 0 && (product.variantCount ?? 0) > 0;

    setSelectedProduct({ ...product, variants: knownVariants });
    setResolvedProductsById((current) => ({ ...current, [product.id]: product }));
    setSelectedVariant(knownVariants.length === 1 ? knownVariants[0]!.id : "");
    setQuantity(1);
    setIsLoadingVariants(shouldLoadVariants);

    if (!shouldLoadVariants) {
      focusItemInputs(knownVariants.length > 1);
      return;
    }

    void queryClient
      .ensureQueryData(productVariantsQueryOptions(product.id))
      .then((result) => {
        if (variantLoadTokenRef.current !== loadToken) return;
        const variants = normalizeVariants(result);
        const nextSelectedVariant = variants.length === 1 ? variants[0]!.id : "";
        setSelectedProduct((current) =>
          current?.id === product.id
            ? { ...current, variants, variantCount: variants.length }
            : current,
        );
        setSelectedVariant(nextSelectedVariant);
        focusItemInputs(variants.length > 1);
      })
      .catch((error: unknown) => {
        if (variantLoadTokenRef.current !== loadToken) return;
        console.error("Error loading product variants:", error);
        toast.error("Could not load product SKUs. Please try again before adding this item.");
        focusItemInputs(false);
      })
      .finally(() => {
        if (variantLoadTokenRef.current === loadToken) {
          setIsLoadingVariants(false);
        }
      });
  };

  const clearProductSelection = () => {
    variantLoadTokenRef.current += 1;
    setIsLoadingVariants(false);
    setSelectedProduct(null);
    setSelectedVariant("");
    setQuantity(1);
    refs.productSearchButtonRef.current?.focus();
  };

  const calculateDiscountedPrice = (product: Product, variantId: string | null) => {
    const variant = variantId ? product.variants.find((v) => v.id === variantId) : null;
    const basePrice = variant ? variant.price : product.price;

    // Variant discount overrides product discount
    const variantHasDiscount = variant && (
      (variant.discountType === "flat" && variant.discountAmount && variant.discountAmount > 0) ||
      (variant.discountType === "percentage" && variant.discountPercentage && variant.discountPercentage > 0)
    );

    if (variantHasDiscount && variant) {
      if (variant.discountType === "flat" && variant.discountAmount && variant.discountAmount > 0) {
        return Math.max(0, basePrice - variant.discountAmount).toFixed(2);
      }
      if (variant.discountType === "percentage" && variant.discountPercentage && variant.discountPercentage > 0) {
        return (basePrice - basePrice * (variant.discountPercentage / 100)).toFixed(2);
      }
    }

    // Fall back to product discount
    if (product.discountType === "flat" && product.discountAmount && product.discountAmount > 0) {
      return Math.max(0, basePrice - product.discountAmount).toFixed(2);
    }
    if (product.discountPercentage && product.discountPercentage > 0) {
      const discountAmount = basePrice * (product.discountPercentage / 100);
      return (basePrice - discountAmount).toFixed(2);
    }
    return basePrice.toFixed(2);
  };

  const handleAddItem = () => {
    if (!selectedProduct || isLoadingVariants) return;

    const activeVariants = selectedProduct.variants.filter((variant) => variant.id);
    const variant = selectedVariant
      ? activeVariants.find((v) => v.id === selectedVariant)
      : activeVariants.length === 1
        ? activeVariants[0]
        : null;
    if (!variant) {
      toast.error(
        activeVariants.length === 0
          ? "This product has no active SKU. Add a SKU before creating an order."
          : "Choose a SKU before adding this product.",
      );
      return;
    }
    let basePrice = variant.price;

    // Variant discount overrides product discount
    const variantHasDiscount = variant && (
      (variant.discountType === "flat" && variant.discountAmount && variant.discountAmount > 0) ||
      (variant.discountType === "percentage" && variant.discountPercentage && variant.discountPercentage > 0)
    );

    if (variantHasDiscount && variant) {
      if (variant.discountType === "flat" && variant.discountAmount && variant.discountAmount > 0) {
        basePrice = Math.max(0, basePrice - variant.discountAmount);
      } else if (variant.discountType === "percentage" && variant.discountPercentage && variant.discountPercentage > 0) {
        basePrice = basePrice - basePrice * (variant.discountPercentage / 100);
      }
    } else if (selectedProduct.discountType === "flat" && selectedProduct.discountAmount && selectedProduct.discountAmount > 0) {
      basePrice = Math.max(0, basePrice - selectedProduct.discountAmount);
    } else if (selectedProduct.discountPercentage && selectedProduct.discountPercentage > 0) {
      basePrice = basePrice - basePrice * (selectedProduct.discountPercentage / 100);
    }

    const newItems = [
      ...form.getValues("items"),
      {
        productId: selectedProduct.id,
        variantId: variant.id,
        quantity,
        price: basePrice,
      },
    ];

    // Keep the exact lazy-loaded SKU projection beside the form row. The
    // initial product page may not contain this SKU, but the merchant should
    // still see the choice immediately after adding it.
    setResolvedVariantsById((current) => ({
      ...current,
      [variant.id]: variant,
    }));

    form.setValue("items", newItems, { shouldDirty: true, shouldValidate: true });
    updateOrderItems(newItems); // Sync with nanostore

    clearProductSelection();
  };

  return (
    <Card>
      <CardHeader className="pb-3 pt-4 px-4">
        <CardTitle className="text-base">Order Items</CardTitle>
        <CardDescription className="text-xs">Add products to the order.</CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div className="space-y-4">
          <ProductSearch
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            displayedProducts={displayedProducts}
            hasMore={Boolean(productQuery.hasNextPage)}
            loadMoreProducts={() => void productQuery.fetchNextPage()}
            totalProducts={totalProducts}
            isLoading={isInitialProductLoading}
            isError={isInitialProductError}
            isLoadingMore={productQuery.isFetchingNextPage}
            isLoadMoreError={productQuery.isFetchNextPageError}
            retry={() => void productQuery.refetch()}
            selectedProduct={selectedProduct}
            selectProduct={selectProduct}
            clearProductSelection={clearProductSelection}
            calculateDiscountedPrice={calculateDiscountedPrice}
          />

          {selectedProduct && (
            <ItemSelection
              selectedProduct={selectedProduct}
              selectedVariant={selectedVariant}
              setSelectedVariant={setSelectedVariant}
              quantity={quantity}
              setQuantity={setQuantity}
              handleAddItem={handleAddItem}
              calculateDiscountedPrice={calculateDiscountedPrice}
              isLoadingVariants={isLoadingVariants}
            />
          )}
        </div>

        <OrderItemsTable
          resolvedProductsById={resolvedProductsById}
          resolvedVariantsById={resolvedVariantsById}
        />
      </CardContent>
    </Card>
  );
}
