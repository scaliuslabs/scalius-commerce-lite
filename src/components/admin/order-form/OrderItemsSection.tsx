import React from "react";
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
import type { Product } from "./types";

const productsPerPage = 20;
const initialProductsToShow = 20;

export function OrderItemsSection() {
  const { form, products: allProducts, refs } = useOrderForm();

  // State for product searching and selection
  const [searchTerm, setSearchTerm] = React.useState("");
  const [filteredProducts, setFilteredProducts] = React.useState<Product[]>([]);
  const [displayedProducts, setDisplayedProducts] = React.useState<Product[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);

  // State for the currently selected item before it's added to the list
  const [selectedProduct, setSelectedProduct] = React.useState<Product | null>(null);
  const [selectedVariant, setSelectedVariant] = React.useState<string>("");
  const [quantity, setQuantity] = React.useState<number>(1);

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

  const selectProduct = (product: Product) => {
    setSelectedProduct(product);
    setSelectedVariant("");
    setQuantity(1);

    setTimeout(() => {
      const variantSelect = document.getElementById("variant-select-trigger");
      if (variantSelect && product.variants.length > 0) {
        variantSelect.focus();
      } else {
        const quantityInput = document.getElementById("quantity-input");
        quantityInput?.focus();
      }
    }, 100);
  };

  const clearProductSelection = () => {
    setSelectedProduct(null);
    setSelectedVariant("");
    setQuantity(1);
    refs.productSearchButtonRef.current?.focus();
  };

  const calculateDiscountedPrice = (product: Product, variantId: string | null) => {
    const variant = variantId ? product.variants.find((v) => v.id === variantId) : null;
    const basePrice = variant ? variant.price : product.price;

    if (product.discountPercentage && product.discountPercentage > 0) {
      const discountAmount = basePrice * (product.discountPercentage / 100);
      return (basePrice - discountAmount).toFixed(2);
    }
    return basePrice.toFixed(2);
  };

  const handleAddItem = () => {
    if (!selectedProduct) return;

    const variant = selectedVariant ? selectedProduct.variants.find((v) => v.id === selectedVariant) : null;
    let basePrice = variant ? variant.price : selectedProduct.price;

    if (selectedProduct.discountPercentage && selectedProduct.discountPercentage > 0) {
      const discountAmount = basePrice * (selectedProduct.discountPercentage / 100);
      basePrice = basePrice - discountAmount;
    }

    const newItems = [
      ...form.getValues("items"),
      {
        productId: selectedProduct.id,
        variantId: selectedVariant || null,
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
      <CardHeader>
        <CardTitle>Order Items</CardTitle>
        <CardDescription>Add products to the order.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
            />
          )}
        </div>

        <OrderItemsTable />
      </CardContent>
    </Card>
  );
}