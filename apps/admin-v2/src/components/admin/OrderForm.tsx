// src/components/admin/OrderForm.tsx
import React, { useCallback, useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import type { SubmitHandler } from "react-hook-form";
import { Form } from "@/components/ui/form";
import { toast } from "sonner";
import { OrderStatus } from "@/types/api-responses";
import { FormActionBar } from "@/components/admin/FormStickyHeader";
import { useNavigate } from "@tanstack/react-router";
import { UnsavedChangesGuard } from "./shared/UnsavedChangesGuard";
import {
  updateOrderItems,
  updateShippingCharge,
  updateDiscountAmount,
} from "@/store/orderStore";
import { getDeliveryLocations } from "@/lib/api-functions/delivery";
import { useCreateOrder, useUpdateOrder } from "@/lib/api-mutations/orders";
import type {
  CreateOrderInput,
  QuoteManualOrderInput,
  UpdateOrderInput,
} from "@/lib/api-functions/orders";
import { quoteManualOrder } from "@/lib/api-functions/orders";

// Imports for our new, refactored components and types
import {
  orderFormSchema,
  type OrderFormValues,
  type DeliveryLocation,
  type OrderFormProps,
} from "./order-form/types";
import { OrderFormProvider } from "./order-form/OrderFormContext";
import { CustomerInfoSection } from "./order-form/CustomerInfoSection";
import { OrderItemsSection } from "./order-form/OrderItemsSection";
import { SummarySection } from "./order-form/SummarySection";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import {
  clearAdminOrderRequestKey,
  getOrCreateAdminOrderRequestKey,
  rememberSubmittedAdminOrderRequestKey,
  replaceSubmittedAdminOrderRequestKey,
} from "./order-form/create-order-request-key";
import { executeManualOrderCreateWithRecovery } from "./order-form/manual-order-create-recovery";
import { useDebounce } from "@/hooks/use-debounce";
import { queryKeys } from "@/lib/query-keys";
import { getServerFnError } from "@/lib/api-mutations/shared";
import {
  isAdminApiRetryableReadError,
  readManualOrderDiscountLimitError,
} from "@/lib/admin-api-error";
import { useCurrency } from "@/hooks/use-currency";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
  calculateManualOrderDiscountLimit,
  resolveManualOrderDiscountGuidance,
} from "./order-form/manual-order-discount";

function toOrderBaseContentInput(values: OrderFormValues) {
  return {
    customerName: values.customerName,
    customerPhone: values.customerPhone,
    customerEmail: values.customerEmail,
    shippingAddress: values.shippingAddress,
    city: values.city,
    zone: values.zone,
    area: values.area,
    cityName: values.cityName,
    zoneName: values.zoneName,
    areaName: values.areaName ?? null,
    notes: values.notes,
    discountAmount: values.discountAmount,
    shippingCharge: values.shippingCharge,
  };
}

function toSellableLines(values: OrderFormValues) {
  return values.items.map(({ productId, variantId, quantity }) => ({
    productId,
    variantId,
    quantity,
  }));
}

function toCreateOrderInput(
  values: OrderFormValues,
  requestKey: string,
): CreateOrderInput {
  return {
    requestKey,
    ...toOrderBaseContentInput(values),
    items: toSellableLines(values),
  };
}

function toUpdateOrderInput(
  values: OrderFormValues,
  id: string,
): UpdateOrderInput {
  if (!values.version) {
    throw new Error("Order version is missing. Reload the editor before saving.");
  }
  return {
    ...toOrderBaseContentInput(values),
    items: values.items,
    id,
    expectedVersion: values.version,
    status: values.status ?? OrderStatus.PENDING,
  };
}

export function OrderForm({
  products,
  defaultValues,
  isEdit = false,
}: OrderFormProps) {
  const navigate = useNavigate();
  const { code: currencyCode } = useCurrency();
  const orderActions = useOrderActionPermissions();
  const canSave = isEdit
    ? orderActions.canEditOrders
    : orderActions.canCreateOrders;
  const createMutation = useCreateOrder();
  const updateMutation = useUpdateOrder();
  const createRequestKey = React.useRef<string | null>(
    isEdit ? null : getOrCreateAdminOrderRequestKey(),
  );
  const form = useForm<OrderFormValues>({
    resolver: zodResolver(orderFormSchema),
    defaultValues: {
      customerName: "",
      customerPhone: "",
      customerEmail: null,
      shippingAddress: "",
      city: "",
      zone: "",
      area: null,
      notes: null,
      items: [],
      discountAmount: null,
      shippingCharge: 0,
      status: OrderStatus.PENDING,
      ...defaultValues,
    },
  });

  const [
    quoteCity,
    quoteZone,
    quoteArea,
    quoteItems,
    quoteShipping,
    quoteDiscount,
  ] = useWatch({
    control: form.control,
    name: [
      "city",
      "zone",
      "area",
      "items",
      "shippingCharge",
      "discountAmount",
    ],
  });
  const quoteInput = React.useMemo<QuoteManualOrderInput>(
    () => ({
      city: quoteCity,
      zone: quoteZone,
      area: quoteArea,
      items: quoteItems.map(({ productId, variantId, quantity }) => ({
        productId,
        variantId,
        quantity,
      })),
      shippingCharge: quoteShipping,
      discountAmount: quoteDiscount,
    }),
    [quoteArea, quoteCity, quoteDiscount, quoteItems, quoteShipping, quoteZone],
  );
  const currencyDecimalPlaces = getDecimalPlaces(currencyCode);
  const localDiscountLimit = React.useMemo(
    () => isEdit
      ? null
      : calculateManualOrderDiscountLimit(
          quoteItems,
          quoteDiscount,
          currencyDecimalPlaces,
        ),
    [currencyDecimalPlaces, isEdit, quoteDiscount, quoteItems],
  );
  const debouncedQuoteInput = useDebounce(quoteInput, 350);
  const quoteInputIsCurrent =
    JSON.stringify(quoteInput) === JSON.stringify(debouncedQuoteInput);
  const hasQuotePrerequisites = !isEdit
    && Boolean(quoteInput.city && quoteInput.zone)
    && quoteInput.items.length > 0
    && quoteInput.items.every((item) => Boolean(item.variantId));
  const canRequestQuote = hasQuotePrerequisites
    && quoteInputIsCurrent;
  const quoteQuery = useQuery({
    queryKey: queryKeys.orders.manualQuote(debouncedQuoteInput),
    queryFn: () => quoteManualOrder({ data: debouncedQuoteInput }),
    enabled: canRequestQuote,
    retry: false,
    staleTime: 0,
  });
  const currentQuoteError = quoteInputIsCurrent ? quoteQuery.error : null;
  const authoritativeDiscountLimit = currentQuoteError
    ? readManualOrderDiscountLimitError(currentQuoteError)
    : null;
  const manualQuote = React.useMemo(
    () => {
      const discountLimit = resolveManualOrderDiscountGuidance({
        discountAmount: quoteDiscount,
        authoritativeErrorLimit: authoritativeDiscountLimit,
        successfulQuote: quoteInputIsCurrent
          && quoteQuery.isSuccess
          && quoteQuery.data
          ? quoteQuery.data
          : null,
        localLimit: localDiscountLimit,
        localCurrencyCode: currencyCode,
        localDecimalPlaces: currencyDecimalPlaces,
      });

      return {
        data: quoteQuery.data ?? null,
        isCurrent:
          isEdit ||
          (canRequestQuote && quoteInputIsCurrent && quoteQuery.isSuccess),
        isLoading:
          !isEdit &&
          hasQuotePrerequisites &&
          (!quoteInputIsCurrent || quoteQuery.isFetching),
        discountLimit,
        errorMessage: currentQuoteError && !authoritativeDiscountLimit
          ? getServerFnError(
              currentQuoteError,
              "Could not calculate the order total",
            )
          : null,
        canRetry: currentQuoteError
          ? isAdminApiRetryableReadError(currentQuoteError)
          : false,
        retry: () => {
          void quoteQuery.refetch();
        },
      };
    },
    [
      authoritativeDiscountLimit,
      canRequestQuote,
      currencyCode,
      currencyDecimalPlaces,
      currentQuoteError,
      hasQuotePrerequisites,
      isEdit,
      localDiscountLimit,
      quoteDiscount,
      quoteInputIsCurrent,
      quoteQuery,
    ],
  );

  const isSubmitting = createMutation.isPending || updateMutation.isPending;
  const [locations, setLocations] = React.useState<{
    cities: DeliveryLocation[];
    zones: DeliveryLocation[];
    areas: DeliveryLocation[];
  }>({ cities: [], zones: [], areas: [] });
  const [isLoading, setIsLoading] = React.useState({
    zones: false,
    areas: false,
  });

  // --- API CALLS ---

  const loadCities = useCallback(async () => {
    try {
      const data = await getDeliveryLocations({ data: { type: "city" } });
      setLocations((prev) => ({ ...prev, cities: data.locations as DeliveryLocation[] }));
    } catch (error: unknown) {
      console.error("Error loading cities:", error);
      toast.error("Could not load city list. Please refresh the page.");
    }
  }, []);

  const loadZones = useCallback(async (cityId: string) => {
    if (!cityId) {
      setLocations((prev) => ({ ...prev, zones: [], areas: [] }));
      form.setValue("zone", "");
      form.setValue("area", null);
      return;
    }
    setIsLoading((prev) => ({ ...prev, zones: true }));
    try {
      const data = await getDeliveryLocations({ data: { type: "zone", parentId: cityId } });
      setLocations((prev) => ({ ...prev, zones: data.locations as DeliveryLocation[], areas: [] }));
      form.setValue("area", null);
    } catch (error: unknown) {
      console.error("Error loading zones:", error);
      toast.error("Could not load zone list. Please refresh the page.");
    } finally {
      setIsLoading((prev) => ({ ...prev, zones: false }));
    }
  }, [form]);

  const loadAreas = useCallback(async (zoneId: string) => {
    if (!zoneId) {
      setLocations((prev) => ({ ...prev, areas: [] }));
      form.setValue("area", null);
      return;
    }
    setIsLoading((prev) => ({ ...prev, areas: true }));
    try {
      const data = await getDeliveryLocations({ data: { type: "area", parentId: zoneId } });
      setLocations((prev) => ({ ...prev, areas: data.locations as DeliveryLocation[] }));
    } catch (error: unknown) {
      console.error("Error loading areas:", error);
      toast.error("Could not load area list. Please refresh the page.");
    } finally {
      setIsLoading((prev) => ({ ...prev, areas: false }));
    }
  }, [form]);

  // --- FORM SUBMISSION ---

  const handleSubmit = useCallback<SubmitHandler<OrderFormValues>>(async (values) => {
    if (!isEdit && !manualQuote.isCurrent) {
      toast.error("Wait for the final tax and total before creating this order.");
      return;
    }
    // Find the location objects from state based on the selected IDs
    const city = locations.cities.find((c) => c.id === values.city);
    const zone = locations.zones.find((z) => z.id === values.zone);
    const area = values.area
      ? locations.areas.find((a) => a.id === values.area)
      : null;

    const enrichedValues: OrderFormValues = {
      ...values,
      cityName: city?.name,
      zoneName: zone?.name,
      areaName: area?.name ?? null,
    };

    if (isEdit) {
      const orderId = enrichedValues.id || defaultValues?.id;
      if (!orderId) {
        toast.error("Missing order ID. Please refresh and try again.");
        return;
      }
      try {
        updateMutation.mutate(toUpdateOrderInput(enrichedValues, orderId), {
          onSuccess: () => {
            void navigate({ to: "/admin/orders" });
          },
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Reload the editor before saving this order.",
        );
      }
    } else {
      const requestKey = createRequestKey.current ?? getOrCreateAdminOrderRequestKey();
      createRequestKey.current = requestKey;
      const result = await executeManualOrderCreateWithRecovery({
        requestKey,
        submit: (submittedRequestKey) => {
          rememberSubmittedAdminOrderRequestKey(submittedRequestKey);
          return createMutation.mutateAsync(
            toCreateOrderInput(enrichedValues, submittedRequestKey),
          );
        },
        replaceRequestKey: replaceSubmittedAdminOrderRequestKey,
      });
      createRequestKey.current = result.requestKey;

      if (result.outcome === "created") {
        clearAdminOrderRequestKey(result.requestKey);
        void navigate({
          to: "/admin/orders/$orderId",
          params: { orderId: result.order.id },
        });
        return;
      }
      if (result.outcome === "open-existing") {
        clearAdminOrderRequestKey(result.requestKey);
        toast.info("Your earlier submission already created this order.", {
          description: "Opening it instead of risking a duplicate order.",
        });
        void navigate({
          to: "/admin/orders/$orderId",
          params: { orderId: result.orderId },
        });
        return;
      }
      if (result.outcome === "wait") {
        toast.warning("Your earlier submission is still finishing.", {
          description:
            "Your changes are preserved. Wait a moment, then create the order again.",
        });
        return;
      }
      toast.error(getServerFnError(result.error, "Failed to create order"));
    }
  }, [createMutation, defaultValues?.id, isEdit, locations, manualQuote.isCurrent, navigate, updateMutation]);

  // --- DATA LOADING AND SIDE EFFECTS ---

  useEffect(() => {
    // Sync default values with nanostore on initial load
    if (defaultValues) {
      updateOrderItems(defaultValues.items || []);
      updateShippingCharge(defaultValues.shippingCharge || 0);
      updateDiscountAmount(defaultValues.discountAmount || null);
    }

    // Load initial data
    void loadCities();
    if (isEdit && defaultValues?.city) {
      void loadZones(defaultValues.city);
    }
    if (isEdit && defaultValues?.zone) {
      void loadAreas(defaultValues.zone);
    }
  }, [defaultValues, isEdit, loadAreas, loadCities, loadZones]);

  // Effect to handle Ctrl+Enter for form submission
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (
          canSave &&
          manualQuote.isCurrent &&
          !isSubmitting &&
          form.getValues("items").length > 0
        ) {
          e.preventDefault();
          void form.handleSubmit(handleSubmit)();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [canSave, form, handleSubmit, isSubmitting, manualQuote.isCurrent]);

  const canSubmit = canSave && manualQuote.isCurrent;

  return (
    <>
      <UnsavedChangesGuard
        isDirty={form.formState.isDirty}
        isSubmitting={isSubmitting}
      />
      <Form {...form}>
        <form
          method="post"
          onSubmit={canSubmit && form.formState.isDirty
            ? form.handleSubmit(handleSubmit)
            : (event) => event.preventDefault()}
          className="-mt-4 pb-6 space-y-4"
          noValidate
        >
          <div className="flex min-h-8 items-center px-1">
            <h1 className="text-lg font-semibold leading-none tracking-tight text-foreground">
              {isEdit ? (
                <>
                  Edit order
                  {defaultValues?.id ? (
                    <>
                      {" "}
                      <span className="ml-2 font-mono text-sm font-medium text-muted-foreground">
                        #{defaultValues.id}
                      </span>
                    </>
                  ) : null}
                </>
              ) : "New order"}
            </h1>
          </div>
          <OrderFormProvider
            form={form}
            products={products}
            isEdit={isEdit}
            locations={locations}
            setLocations={setLocations}
            isLoading={isLoading}
            setIsLoading={setIsLoading}
            loadZones={loadZones}
            loadAreas={loadAreas}
            isSubmitting={isSubmitting}
            manualQuote={manualQuote}
          >
            <CustomerInfoSection />
            <OrderItemsSection />
            <SummarySection />

            <input type="hidden" {...form.register("cityName")} />
            <input type="hidden" {...form.register("zoneName")} />
            <input type="hidden" {...form.register("areaName")} />
          </OrderFormProvider>
        </form>
      </Form>
      <FormActionBar
        title="Orders"
        isEdit={isEdit}
        isSubmitting={isSubmitting}
        isDirty={form.formState.isDirty}
        cancelUrl="/admin/orders"
        newUrl="/admin/orders/new"
        newLabel="New order"
        canCreateNew={orderActions.canCreateOrders}
        canSave={canSubmit}
        saveLabel={isEdit ? undefined : "Create confirmed order"}
        saveDisabledReason={!canSave
          ? isEdit
            ? "You do not have permission to edit orders."
            : "You do not have permission to create orders."
          : "Add an item and choose its delivery destination to calculate the final total."}
        onDiscard={isEdit
          ? undefined
          : () => {
              if (createRequestKey.current) {
                clearAdminOrderRequestKey(createRequestKey.current);
              }
            }}
        onSave={() => form.handleSubmit(handleSubmit)()}
      />
    </>
  );
}
