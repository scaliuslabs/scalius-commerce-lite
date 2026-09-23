import React, { useCallback, useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SubmitHandler } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Form } from "@/components/ui/form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { OrderStatus } from "@/lib/admin-order-status-policy";
import { FormActionBar } from "@/components/admin/FormStickyHeader";
import { PageHeader } from "@/components/admin/resource/PageHeader";
import { UnsavedChangesGuard } from "./shared/UnsavedChangesGuard";
import {
  deliveryLocationsQueryOptions,
  getDeliveryLocations,
} from "@/lib/api-query-options/delivery";
import {
  useConfirmManualOrderAmendment,
  useCreateOrder,
  useUpdateOrder,
} from "@/lib/api-mutations/orders";
import {
  postApiV1AdminOrdersByIdAmendmentsPreview,
  postApiV1AdminOrdersQuote,
  type postApiV1AdminOrders,
  type putApiV1AdminOrdersById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "@/lib/api";
import {
  orderFormSchema,
  type OrderFormInput,
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
import { translate, useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { resourceMessages } from "@/i18n/resource";

type CreateOrderInput = ApiBody<typeof postApiV1AdminOrders>;
type UpdateOrderInput = { id: string } & ApiBody<typeof putApiV1AdminOrdersById>;
type QuoteManualOrderInput = ApiBody<typeof postApiV1AdminOrdersQuote>;
type ManualOrderAmendmentInput = { id: string } &
  ApiBody<typeof postApiV1AdminOrdersByIdAmendmentsPreview>;

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

function toCreateOrderInput(
  values: OrderFormValues,
  requestKey: string,
): CreateOrderInput {
  return {
    requestKey,
    ...toOrderBaseContentInput(values),
    items: values.items.map(({ productId, variantId, quantity }) => ({
      productId,
      variantId,
      quantity,
    })),
  };
}

function requireVersion(values: OrderFormValues): number {
  if (!values.version) throw new Error(translate(orderFormMessages, "reloadToSave"));
  return values.version;
}

function toUpdateOrderInput(values: OrderFormValues, id: string): UpdateOrderInput {
  return {
    ...toOrderBaseContentInput(values),
    items: values.items,
    id,
    expectedVersion: requireVersion(values),
    status: values.status ?? OrderStatus.PENDING,
  };
}

function toManualOrderAmendmentInput(
  values: OrderFormValues,
  id: string,
): ManualOrderAmendmentInput {
  return {
    id,
    expectedVersion: requireVersion(values),
    ...toOrderBaseContentInput(values),
    items: values.items.map(({ orderItemId, productId, variantId, quantity }) => ({
      orderItemId,
      productId,
      variantId,
      quantity,
    })),
  };
}

export function OrderForm({ mode, products = [], defaultValues }: OrderFormProps) {
  const isEdit = mode !== "create";
  const isAmend = mode === "amend";
  // Create and amend save against a current server quote; full edit has none.
  const usesQuote = mode !== "edit";
  const t = useMessages(orderFormMessages);
  const r = useMessages(resourceMessages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { code: currencyCode, fmt } = useCurrency();
  const orderActions = useOrderActionPermissions();
  const canSave = isEdit ? orderActions.canEditOrders : orderActions.canCreateOrders;
  const createMutation = useCreateOrder();
  const updateMutation = useUpdateOrder();
  const amendMutation = useConfirmManualOrderAmendment();
  const amendmentRequest = React.useRef<{ key: string; payload: string } | null>(null);
  // The dialog stays mounted; the last amendment is kept while it animates closed.
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pendingAmendment, setPendingAmendment] = React.useState<{
    input: ManualOrderAmendmentInput;
    orderId: string;
    quoteFingerprint: string;
    requestKey: string;
    formattedTotal: string;
  } | null>(null);
  const createRequestKey = React.useRef<string | null>(
    isEdit ? null : getOrCreateAdminOrderRequestKey(),
  );
  const form = useForm<OrderFormInput, unknown, OrderFormValues>({
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
  const orderId = defaultValues?.id;
  const pageTitle = isEdit ? t("editOrder", { id: String(orderId ?? "") }) : t("createOrder");
  const backTo = isEdit && orderId ? `/admin/orders/${orderId}` : "/admin/orders";

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
  const localTotals = React.useMemo(() => {
    const subtotal = quoteItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shipping = quoteShipping || 0;
    const discount = quoteDiscount || 0;
    return { subtotal, shipping, discount, total: subtotal + shipping - discount };
  }, [quoteDiscount, quoteItems, quoteShipping]);
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
    () => usesQuote
      ? calculateManualOrderDiscountLimit(quoteItems, quoteDiscount, currencyDecimalPlaces)
      : null,
    [currencyDecimalPlaces, quoteDiscount, quoteItems, usesQuote],
  );
  const debouncedQuoteInput = useDebounce(quoteInput, 350);
  const quoteInputIsCurrent =
    JSON.stringify(quoteInput) === JSON.stringify(debouncedQuoteInput);
  const hasQuotePrerequisites = usesQuote
    && Boolean(quoteInput.city && quoteInput.zone)
    && quoteInput.items.length > 0
    && quoteInput.items.every((item) => Boolean(item.variantId));
  const canRequestQuote = hasQuotePrerequisites && quoteInputIsCurrent;
  const quoteQuery = useQuery({
    queryKey: [
      ...queryKeys.orders.manualQuote(debouncedQuoteInput),
      isAmend ? `amend:${String(orderId)}:${String(defaultValues?.version)}` : "create",
    ],
    queryFn: () => {
      if (!isAmend) return apiData(postApiV1AdminOrdersQuote({ body: debouncedQuoteInput }));
      const id = String(orderId ?? "");
      const { id: _id, ...amendment } = toManualOrderAmendmentInput(form.getValues(), id);
      return apiData(postApiV1AdminOrdersByIdAmendmentsPreview({
        path: { id },
        body: { ...amendment, ...debouncedQuoteInput },
      }));
    },
    enabled: canRequestQuote,
    retry: false,
    staleTime: 0,
  });
  const currentQuoteError = quoteInputIsCurrent ? quoteQuery.error : null;
  const authoritativeDiscountLimit = currentQuoteError
    ? readManualOrderDiscountLimitError(currentQuoteError)
    : null;
  const manualQuote = {
    data: quoteQuery.data ?? null,
    isCurrent: !usesQuote || (canRequestQuote && quoteQuery.isSuccess),
    isLoading: hasQuotePrerequisites && (!quoteInputIsCurrent || quoteQuery.isFetching),
    discountLimit: resolveManualOrderDiscountGuidance({
      discountAmount: quoteDiscount,
      authoritativeErrorLimit: authoritativeDiscountLimit,
      successfulQuote: quoteInputIsCurrent && quoteQuery.isSuccess && quoteQuery.data
        ? quoteQuery.data
        : null,
      localLimit: localDiscountLimit,
      localCurrencyCode: currencyCode,
      localDecimalPlaces: currencyDecimalPlaces,
    }),
    errorMessage: currentQuoteError && !authoritativeDiscountLimit
      ? getServerFnError(currentQuoteError, t("totalFailed"))
      : null,
    canRetry: currentQuoteError ? isAdminApiRetryableReadError(currentQuoteError) : false,
    retry: () => {
      void quoteQuery.refetch();
    },
  };

  const isSubmitting = createMutation.isPending
    || updateMutation.isPending
    || amendMutation.isPending;
  const isInteractionLocked = isSubmitting || confirmOpen;
  const [locations, setLocations] = React.useState<{
    cities: DeliveryLocation[];
    zones: DeliveryLocation[];
    areas: DeliveryLocation[];
  }>({ cities: [], zones: [], areas: [] });
  const [isLoading, setIsLoading] = React.useState({ zones: false, areas: false });

  // --- DELIVERY AREAS ---

  const loadCities = useCallback(async () => {
    try {
      const data = await queryClient.ensureQueryData(
        deliveryLocationsQueryOptions({ type: "city" }),
      );
      setLocations((prev) => ({ ...prev, cities: data.locations as DeliveryLocation[] }));
    } catch {
      toast.error(translate(orderFormMessages, "locationsFailed"));
    }
  }, [queryClient]);

  // Pickers reset the child selections themselves, so these only load lists
  // (an edit must keep its saved area while zones and areas load together).
  const loadZones = useCallback(async (cityId: string) => {
    setIsLoading((prev) => ({ ...prev, zones: true }));
    try {
      const data = await getDeliveryLocations({ type: "zone", parentId: cityId });
      setLocations((prev) => ({ ...prev, zones: data.locations as DeliveryLocation[] }));
    } catch {
      toast.error(translate(orderFormMessages, "locationsFailed"));
    } finally {
      setIsLoading((prev) => ({ ...prev, zones: false }));
    }
  }, []);

  const loadAreas = useCallback(async (zoneId: string) => {
    setIsLoading((prev) => ({ ...prev, areas: true }));
    try {
      const data = await getDeliveryLocations({ type: "area", parentId: zoneId });
      setLocations((prev) => ({ ...prev, areas: data.locations as DeliveryLocation[] }));
    } catch {
      toast.error(translate(orderFormMessages, "locationsFailed"));
    } finally {
      setIsLoading((prev) => ({ ...prev, areas: false }));
    }
  }, []);

  // --- SUBMIT ---

  const handleSubmit: SubmitHandler<OrderFormValues> = async (values) => {
    if (usesQuote && !manualQuote.isCurrent) {
      toast.info(t("calculating"));
      return;
    }
    const city = locations.cities.find((c) => c.id === values.city);
    const zone = locations.zones.find((z) => z.id === values.zone);
    const area = values.area ? locations.areas.find((a) => a.id === values.area) : null;
    const enrichedValues: OrderFormValues = {
      ...values,
      cityName: city?.name,
      zoneName: zone?.name,
      areaName: area?.name ?? null,
    };

    if (isEdit) {
      const id = enrichedValues.id || orderId;
      if (!id) {
        toast.error(t("reloadToSave"));
        return;
      }
      try {
        if (isAmend) {
          const input = toManualOrderAmendmentInput(enrichedValues, id);
          const quote = manualQuote.data;
          if (!quote || !("quoteFingerprint" in quote) || typeof quote.quoteFingerprint !== "string" || !quote.quoteFingerprint) {
            toast.error(t("totalChanged"));
            return;
          }
          const payload = JSON.stringify({ ...input, quoteFingerprint: quote.quoteFingerprint });
          if (amendmentRequest.current?.payload !== payload) {
            amendmentRequest.current = { key: crypto.randomUUID(), payload };
          }
          setPendingAmendment({
            input,
            orderId: id,
            quoteFingerprint: quote.quoteFingerprint,
            requestKey: amendmentRequest.current.key,
            formattedTotal: fmt(quote.totalAmount),
          });
          setConfirmOpen(true);
          return;
        }
        updateMutation.mutate(toUpdateOrderInput(enrichedValues, id), {
          onSuccess: () => {
            void navigate({ to: "/admin/orders/$orderId", params: { orderId: id } });
          },
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("reloadToSave"));
      }
      return;
    }

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

    if (result.outcome === "created" || result.outcome === "open-existing") {
      clearAdminOrderRequestKey(result.requestKey);
      if (result.outcome === "open-existing") {
        toast.info(t("alreadyCreated"), { description: t("alreadyCreatedHint") });
      }
      void navigate({
        to: "/admin/orders/$orderId",
        params: {
          orderId: result.outcome === "created" ? result.order.id : result.orderId,
        },
      });
      return;
    }
    if (result.outcome === "wait") {
      toast.warning(t("stillCreating"), { description: t("stillCreatingHint") });
      return;
    }
    toast.error(getServerFnError(result.error, t("createFailed")));
  };

  const handleConfirmAmendment = async () => {
    const pending = pendingAmendment;
    if (!confirmOpen || !pending || amendMutation.isPending) return;
    try {
      await amendMutation.mutateAsync({
        ...pending.input,
        requestKey: pending.requestKey,
        quoteFingerprint: pending.quoteFingerprint,
      });
      setConfirmOpen(false);
      void navigate({
        to: "/admin/orders/$orderId",
        params: { orderId: pending.orderId },
      });
    } catch {
      // The mutation hook shows the error; the request key is kept for a safe retry.
    }
  };

  useEffect(() => {
    void loadCities();
    if (isEdit && defaultValues?.city) void loadZones(defaultValues.city);
    if (isEdit && defaultValues?.zone) void loadAreas(defaultValues.zone);
  }, [defaultValues, isEdit, loadAreas, loadCities, loadZones]);

  const canSubmit = canSave && manualQuote.isCurrent && !isInteractionLocked;

  // Ctrl/Cmd+Enter saves.
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey)
        && e.key === "Enter"
        && canSubmit
        && form.getValues("items").length > 0
      ) {
        e.preventDefault();
        void form.handleSubmit(handleSubmit)();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  });

  return (
    <>
      <UnsavedChangesGuard
        isDirty={form.formState.isDirty}
        isSubmitting={isSubmitting}
      />
      <PageHeader title={pageTitle} backTo={backTo} />
      <Form {...form}>
        <form
          method="post"
          onSubmit={canSubmit && form.formState.isDirty
            ? form.handleSubmit(handleSubmit)
            : (event) => event.preventDefault()}
          noValidate
        >
          <OrderFormProvider
            form={form}
            products={products}
            isEdit={isEdit}
            usesQuote={usesQuote}
            locations={locations}
            isLoading={isLoading}
            loadZones={loadZones}
            loadAreas={loadAreas}
            localTotals={localTotals}
            manualQuote={manualQuote}
          >
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="min-w-0 space-y-4 lg:col-span-2">
                <OrderItemsSection />
                <SummarySection />
              </div>
              <div className="min-w-0 space-y-4">
                <CustomerInfoSection />
              </div>
            </div>
          </OrderFormProvider>
        </form>
      </Form>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !amendMutation.isPending) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmBody", { total: pendingAmendment?.formattedTotal ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={amendMutation.isPending}>{r("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={amendMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmAmendment();
              }}
            >
              {t("confirmSave")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <FormActionBar
        title={pageTitle}
        isEdit={isEdit}
        isSubmitting={isSubmitting}
        isDirty={form.formState.isDirty}
        cancelUrl={backTo}
        canSave={canSubmit}
        saveLabel={isAmend ? t("reviewChanges") : isEdit ? r("save") : t("createOrder")}
        saveDisabledReason={canSave ? t("needsTotal") : r("readOnly")}
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
