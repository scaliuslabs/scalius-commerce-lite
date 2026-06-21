import React from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import type { Product } from "./types";

const productsPerPage = 10;
const initialProductsToShow = 10;
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
    size: variant.size,
    color: variant.color,
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

export function OrderItemsSection() {
  const { form, products: allProducts, refs } = useOrderForm();
  const queryClient = useQueryClient();

  // State for product searching and selection
  const [searchTerm, setSearchTerm] = React.useState("");
  const [filteredProducts, setFilteredProducts] = React.useState<Product[]>([]);
  const [displayedProducts, setDisplayedProducts] = React.useState<Product[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);

  // State for the currently selected item before it's added to the list
  const [selectedProduct, setSelectedProduct] = React.useState<Product | null>(null);
  const [selectedVariant, setSelectedVariant] = React.useState<string>("");
  const [isLoadingVariants, setIsLoadingVariants] = React.useState(false);
  const [quantity, setQuantity] = React.useState<number>(1);
  const variantLoadTokenRef = React.useRef(0);

  React.useEffect(() => {
    if (allProducts.length > 0) {
      const sortedProducts = [...allProducts].sort((a, b) => (a.id > b.id ? -1 : 1));
      setFilteredProducts(sortedProducts);
      setDisplayedProducts(sortedProducts.slice(0, initialProductsToShow));
      setHasMore(sortedProducts.length > initialProductsToShow);
    }
  }, [allProducts]);

  React.useEffect(() => {
    const lowercasedSearchTerm = searchTerm.toLowerCase().trim();
    if (lowercasedSearchTerm === "") {
      const sortedProducts = [...allProducts].sort((a, b) => (a.id > b.id ? -1 : 1));
      setFilteredProducts(sortedProducts);
      setDisplayedProducts(sortedProducts.slice(0, initialProductsToShow));
      setHasMore(sortedProducts.length > initialProductsToShow);
      setPage(1);
    } else {
      const filtered = allProducts.filter((product) =>
        product.name.toLowerCase().includes(lowercasedSearchTerm)
      );
      setFilteredProducts(filtered);
      setDisplayedProducts(filtered.slice(0, productsPerPage));
      setHasMore(filtered.length > productsPerPage);
      setPage(1);
    }
  }, [searchTerm, allProducts]);

  const loadMoreProducts = () => {
    const nextPage = page + 1;
    const startIndex = (nextPage - 1) * productsPerPage;
    const endIndex = startIndex + productsPerPage;

    setDisplayedProducts([...displayedProducts, ...filteredProducts.slice(startIndex, endIndex)]);
    setPage(nextPage);
    setHasMore(endIndex < filteredProducts.length);
  };

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
            hasMore={hasMore}
            loadMoreProducts={loadMoreProducts}
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

        <OrderItemsTable />
      </CardContent>
    </Card>
  );
}
