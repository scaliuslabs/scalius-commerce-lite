import React from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import type { getApiV1AdminOrdersCatalogProducts } from "@scalius/api-client/sdk";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useOrderForm } from "./OrderFormContext";
import { ProductSearch } from "./ProductSearch";
import { ItemSelection } from "./ItemSelection";
import { OrderItemsTable } from "./OrderItemsTable";
import { productQueryOptions, productVariantsQueryOptions } from "@/lib/api-query-options/products";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { useCurrency } from "@/hooks/use-currency";
import {
  checkLineProperties,
  customizationFromView,
  type CustomizationView,
  type LinePropertiesCheck,
} from "./order-line-properties";
import { linePropertyFieldId } from "./LinePropertyFields";
import { orderCatalogProductsQueryOptions } from "@/lib/api-query-options/orders";
import type { ApiResult } from "@/lib/api";
import { useDebounce } from "@/hooks/use-debounce";
import type { Product } from "./types";
import {
  exceededStockMessage,
  remainingStockForNewOrderLine,
  trackedAvailableStock,
} from "./manual-order-stock";
import { discountedUnitPrice, orderItemVariantLabel } from "./order-item-presentation";
import { useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";

const ORDER_CATALOG_PAGE_SIZE = 10;
const ORDER_CATALOG_SEARCH_DEBOUNCE_MS = 300;
type ProductVariant = Product["variants"][number];
type CatalogProduct = ApiResult<typeof getApiV1AdminOrdersCatalogProducts>["products"][number];
type RawProductVariant = Omit<ProductVariant, "weight"> & {
  weight: number | string | null;
  deletedAt?: unknown;
};

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
    fulfillmentKind: variant.fulfillmentKind ?? "physical",
  };
}

function normalizeVariants(result: unknown): ProductVariant[] {
  const variants = (result as { variants?: RawProductVariant[] } | null)?.variants;
  if (!Array.isArray(variants)) return [];
  return variants.filter((variant) => !variant.deletedAt).map(normalizeVariant);
}

/** A product read: its SKUs plus the buyer inputs it asks for. */
function normalizeProductRead(result: unknown): { variants: ProductVariant[]; customization: Product["customization"] } {
  const view = (result as { customizationSchema?: CustomizationView | null } | null)?.customizationSchema;
  return { variants: normalizeVariants(result), customization: customizationFromView(view) };
}

function normalizeCatalogProduct(product: CatalogProduct): Product {
  return {
    // Catalog rows carry the buyer inputs, so picking one needs only its SKUs.
    customization: customizationFromView(product.customization),
    id: product.id,
    name: product.name,
    price: product.price,
    discountPercentage: product.discountPercentage ?? null,
    discountType: product.discountType ?? null,
    discountAmount: product.discountAmount ?? null,
    variantCount: product.variantCount ?? 0,
    primaryImage: product.primaryImage,
    priceRange: product.priceRange,
    availableStock: product.availableStock,
    variants: [],
  };
}

export function OrderItemsSection() {
  const { form, refs, isEdit, amendShipsNothing } = useOrderForm();
  const t = useMessages(orderFormMessages);
  const queryClient = useQueryClient();
  const { code, fmt } = useCurrency();
  const minorFactor = 10 ** getDecimalPlaces(code);
  // The buyer inputs typed for the product being added, and why the last Add was refused.
  const [propertyValues, setPropertyValues] = React.useState<Record<string, string>>({});
  const [propertyError, setPropertyError] = React.useState<{ key: string | null; message: string } | null>(null);

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

  // The product whose variant is being chosen (products with several variants).
  const [selectedProduct, setSelectedProduct] = React.useState<Product | null>(null);
  const [selectedVariant, setSelectedVariant] = React.useState<string>("");
  const [isLoadingVariants, setIsLoadingVariants] = React.useState(false);
  const [quantity, setQuantity] = React.useState<number>(1);
  // Why the last pick couldn't be added (out of stock, variants failed).
  const [pickerMessage, setPickerMessage] = React.useState<string | null>(null);
  // Loaded variants, kept so quantity edits on added lines respect their stock.
  const [resolvedVariantsById, setResolvedVariantsById] = React.useState<
    Record<string, ProductVariant>
  >({});
  const variantLoadTokenRef = React.useRef(0);
  const itemsError = form.formState.errors.items;
  const itemsErrorMessage = itemsError?.message ?? itemsError?.root?.message;

  const clearProductSelection = () => {
    variantLoadTokenRef.current += 1;
    setIsLoadingVariants(false);
    setSelectedProduct(null);
    setPropertyValues({});
    setPropertyError(null);
    setSelectedVariant("");
    setQuantity(1);
    refs.productSearchInputRef.current?.focus();
  };

  /** Adds one line unless it would exceed the tracked stock. */
  const addLine = (
    product: Product,
    variant: ProductVariant,
    lineQuantity: number,
    inputs: Extract<LinePropertiesCheck, { ok: true }> | null = null,
  ) => {
    const currentItems = form.getValues("items");
    // The order keeps its delivery method: one that ships nothing can't take goods (the server refuses them).
    if (isEdit && amendShipsNothing && (variant.fulfillmentKind ?? "physical") === "physical") {
      setPickerMessage(`${product.name}: ${t("noDeliveryForGoods")}`);
      return false;
    }
    const remainingStock = isEdit
      ? null
      : remainingStockForNewOrderLine(variant, currentItems);
    if (remainingStock !== null && lineQuantity > remainingStock) {
      setPickerMessage(`${product.name}: ${exceededStockMessage(remainingStock)}`);
      return false;
    }
    setPickerMessage(null);
    setResolvedVariantsById((current) => ({ ...current, [variant.id]: variant }));
    form.setValue("items", [
      ...currentItems,
      {
        productId: product.id,
        variantId: variant.id,
        quantity: lineQuantity,
        // The product/variant sale applies to the base; surcharges are added whole (Wave A §3.3).
        price: discountedUnitPrice(product, variant) + (inputs ? inputs.surchargeMinor / minorFactor : 0),
        name: product.name,
        variantLabel: orderItemVariantLabel(variant),
        available: isEdit ? null : trackedAvailableStock(variant),
        fulfillmentKind: variant.fulfillmentKind ?? "physical",
        ...(inputs && inputs.properties.length > 0
          ? { properties: inputs.properties, propertiesDisplay: inputs.resolved }
          : {}),
      },
    ], { shouldDirty: true, shouldValidate: true });
    return true;
  };

  const showVariants = (product: Product, variants: ProductVariant[]) => {
    if (variants.length === 0) {
      setPickerMessage(`${product.name}: ${t("noActiveVariant")}`);
      clearProductSelection();
      return;
    }
    // One variant and nothing to ask: add it straight away at quantity 1, as Shopify does.
    if (variants.length === 1 && !product.customization) {
      addLine(product, variants[0]!, 1);
      clearProductSelection();
      return;
    }
    setSelectedProduct({ ...product, variants, variantCount: variants.length });
    setSelectedVariant(variants.length === 1 ? variants[0]!.id : "");
    setPropertyValues({});
    setPropertyError(null);
    setQuantity(1);
    setTimeout(() => document.getElementById("variant-select-trigger")?.focus(), 0);
  };

  const selectProduct = (product: Product) => {
    const loadToken = variantLoadTokenRef.current + 1;
    variantLoadTokenRef.current = loadToken;
    setPickerMessage(null);
    const knownVariants = product.variants || [];
    if (knownVariants.length > 0 || (product.variantCount ?? 0) === 0) {
      showVariants(product, knownVariants);
      return;
    }

    setSelectedProduct({ ...product, variants: [] });
    setIsLoadingVariants(true);
    // Rows that carry their buyer inputs need only the SKUs; any other product is read whole.
    const known = product.customization;
    const read = known !== undefined
      ? queryClient.ensureQueryData(productVariantsQueryOptions(product.id)).then((result) => ({ variants: normalizeVariants(result), customization: known }))
      : queryClient.ensureQueryData(productQueryOptions(product.id)).then(normalizeProductRead);
    void read
      .then(({ variants, customization }) => {
        if (variantLoadTokenRef.current !== loadToken) return;
        setIsLoadingVariants(false);
        showVariants({ ...product, customization }, variants);
      })
      .catch(() => {
        if (variantLoadTokenRef.current !== loadToken) return;
        setPickerMessage(t("variantsFailed"));
        clearProductSelection();
      });
  };

  const handleAddItem = () => {
    if (!selectedProduct) return;
    const variant = selectedProduct.variants.find((v) => v.id === selectedVariant);
    if (!variant) {
      setPickerMessage(t("chooseVariantFirst"));
      return;
    }
    // The server's own check (shared): required inputs filled, choices from the list.
    const inputs = checkLineProperties(selectedProduct.customization ?? null, propertyValues);
    if (!inputs.ok) {
      const field = selectedProduct.customization?.fields.find((candidate) => candidate.key === inputs.key);
      setPropertyError({
        key: inputs.key,
        message: t(inputs.reason === "required" ? "inputRequired" : "inputInvalid", { label: field?.label ?? "" }),
      });
      if (inputs.key) document.getElementById(linePropertyFieldId(inputs.key))?.focus();
      return;
    }
    setPropertyError(null);
    if (addLine(selectedProduct, variant, quantity, inputs)) clearProductSelection();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("products")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
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
            selectProduct={selectProduct}
            invalid={Boolean(itemsErrorMessage || pickerMessage)}
          />
          {pickerMessage || itemsErrorMessage ? (
            <p className="text-body text-destructive" role="alert">
              {pickerMessage ?? itemsErrorMessage}
            </p>
          ) : null}
        </div>

        {selectedProduct ? (
          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-body font-medium">{selectedProduct.name}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={clearProductSelection}
                aria-label={t("clearProduct")}
              >
                <X className="size-4" />
              </Button>
            </div>
            {isLoadingVariants ? (
              <p className="flex items-center gap-2 text-body text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("loadingVariants")}
              </p>
            ) : (
              <ItemSelection
                selectedProduct={selectedProduct}
                selectedVariant={selectedVariant}
                setSelectedVariant={setSelectedVariant}
                quantity={quantity}
                setQuantity={setQuantity}
                handleAddItem={handleAddItem}
                buyerInputs={selectedProduct.customization ? {
                  schema: selectedProduct.customization,
                  values: propertyValues,
                  error: propertyError,
                  onChange: (key, value) => {
                    setPropertyValues((current) => ({ ...current, [key]: value }));
                    setPropertyError((current) => (current?.key === key ? null : current));
                  },
                  surcharge: (priceMinor) => fmt(priceMinor / minorFactor),
                } : null}
              />
            )}
          </div>
        ) : null}

        <OrderItemsTable resolvedVariantsById={resolvedVariantsById} />
      </CardContent>
    </Card>
  );
}
