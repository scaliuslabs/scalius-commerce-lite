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
import { checkLineProperties, customizationFromView, type LinePropertiesCheck } from "./order-line-properties";
import { normalizeProductRead, normalizeVariants, orderLineFor } from "./order-line";
import { linePropertyErrors, linePropertyFieldId, type LinePropertyError } from "./LinePropertyFields";
import { orderCatalogProductsQueryOptions } from "@/lib/api-query-options/orders";
import type { ApiResult } from "@/lib/api";
import { useDebounce } from "@/hooks/use-debounce";
import type { Product } from "./types";
import { exceededStockMessage, remainingStockForNewOrderLine } from "./manual-order-stock";
import { useLocale, useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";

const ORDER_CATALOG_PAGE_SIZE = 10;
const ORDER_CATALOG_SEARCH_DEBOUNCE_MS = 300;
type ProductVariant = Product["variants"][number];
type CatalogProduct = ApiResult<typeof getApiV1AdminOrdersCatalogProducts>["products"][number];
function normalizeCatalogProduct(product: CatalogProduct): Product {
  return {
    // Catalog rows carry the buyer inputs, so picking one needs only its SKUs.
    customization: customizationFromView(product.customization),
    customizationView: product.customization,
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

/** The inputs a line of this SKU takes: the product's own, and the apps' that apply to the SKU. */
function inputsFor(product: Product, variantId: string | null): NonNullable<Product["customization"]> | null {
  return product.customizationView !== undefined ? customizationFromView(product.customizationView, variantId) : product.customization ?? null;
}

export function OrderItemsSection() {
  const { form, refs, isEdit, amendShipsNothing } = useOrderForm();
  const t = useMessages(orderFormMessages);
  const locale = useLocale();
  const queryClient = useQueryClient();
  const { code, fmt } = useCurrency();
  const minorFactor = 10 ** getDecimalPlaces(code);
  // The buyer inputs typed for the product being added, and why the last Add was refused.
  const [propertyValues, setPropertyValues] = React.useState<Record<string, string>>({});
  // The app choices staff ticked the buyer agrees to (a decline's agreement), by field key.
  const [propertyAgreed, setPropertyAgreed] = React.useState<ReadonlySet<string>>(new Set());
  const [propertyErrors, setPropertyErrors] = React.useState<LinePropertyError[]>([]);

  const [searchTerm, setSearchTerm] = React.useState("");
  const debouncedSearch = useDebounce(
    searchTerm.trim(),
    ORDER_CATALOG_SEARCH_DEBOUNCE_MS,
  );
  const productQuery = useInfiniteQuery(
    orderCatalogProductsQueryOptions({
      search: debouncedSearch,
      limit: ORDER_CATALOG_PAGE_SIZE,
      language: locale,
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
    setPropertyAgreed(new Set());
    setPropertyErrors([]);
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
      orderLineFor(product, variant, lineQuantity, { isEdit, minorFactor, inputs }),
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
    if (variants.length === 1 && !inputsFor(product, variants[0]!.id)) {
      addLine(product, variants[0]!, 1);
      clearProductSelection();
      return;
    }
    setSelectedProduct({ ...product, variants, variantCount: variants.length });
    setSelectedVariant(variants.length === 1 ? variants[0]!.id : "");
    setPropertyValues({});
    setPropertyAgreed(new Set());
    setPropertyErrors([]);
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
    // The buyer's own check (shared `lineInputIssues`): a message under every field to fix.
    const schema = inputsFor(selectedProduct, variant.id);
    // Only the inputs this SKU takes: an app input typed for another SKU is not this line's.
    const values = Object.fromEntries(Object.entries(propertyValues).filter(([key]) => schema?.fields.some((field) => field.key === key)));
    const errors = schema ? linePropertyErrors(schema, values, t, propertyAgreed) : [];
    // The server's strict check stays the last gate (the same rule, as one answer).
    const inputs = checkLineProperties(schema, values, propertyAgreed);
    if (errors.length === 0 && !inputs.ok) {
      const field = schema?.fields.find((candidate) => candidate.key === inputs.key) ?? schema?.fields[0];
      errors.push({ key: field?.key ?? "", message: t("inputInvalid", { label: field?.label ?? "" }) });
    }
    if (!inputs.ok || errors.length > 0) {
      setPropertyErrors(errors);
      if (errors[0]) document.getElementById(linePropertyFieldId(errors[0].key))?.focus();
      return;
    }
    setPropertyErrors([]);
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
                buyerInputs={inputsFor(selectedProduct, selectedVariant || null) ? {
                  schema: inputsFor(selectedProduct, selectedVariant || null)!,
                  values: propertyValues,
                  errors: propertyErrors,
                  onChange: (key, value) => {
                    setPropertyValues((current) => ({ ...current, [key]: value }));
                    // Another choice is another agreement: asked again.
                    setPropertyAgreed((current) => { const next = new Set(current); next.delete(key); return next; });
                    setPropertyErrors((current) => current.filter((entry) => entry.key !== key));
                  },
                  agreed: propertyAgreed,
                  onAgree: (key, agreed) => {
                    setPropertyAgreed((current) => { const next = new Set(current); if (agreed) next.add(key); else next.delete(key); return next; });
                    setPropertyErrors((current) => current.filter((entry) => entry.key !== key));
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
