import React, { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import type { FieldErrors, SubmitHandler } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Form } from "@/components/ui/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FormActionBar } from "@/components/admin/FormStickyHeader";
import { PageHeader } from "@/components/admin/resource/PageHeader";
import { UnsavedChangesGuard } from "./shared/UnsavedChangesGuard";
import {
  orderErrorMessage,
  useConfirmManualOrderAmendment,
  useCreateOrder,
} from "@/lib/api-mutations/orders";
import {
  postApiV1AdminOrdersByIdAmendmentsPreview,
  postApiV1AdminOrdersQuote,
  type postApiV1AdminOrders,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "@/lib/api";
import {
  orderFormSchema,
  type OrderFormInput,
  type OrderFormValues,
  type OrderItem,
  type OrderFormProps,
} from "./order-form/types";
import { OrderFormProvider } from "./order-form/OrderFormContext";
import { CustomerInfoSection, ORDER_LOCATION_IDS } from "./order-form/CustomerInfoSection";
import { OrderItemsSection } from "./order-form/OrderItemsSection";
import { SummarySection } from "./order-form/SummarySection";
import { PRODUCT_SEARCH_INPUT_ID } from "./order-form/ProductSearch";
import { orderLineQuantityId } from "./order-form/OrderItemsTable";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import {
  clearAdminOrderRequestKey,
  getOrCreateAdminOrderRequestKey,
  rememberSubmittedAdminOrderRequestKey,
  replaceSubmittedAdminOrderRequestKey,
} from "./order-form/create-order-request-key";
import { executeManualOrderCreateWithRecovery } from "./order-form/manual-order-create-recovery";
import { takeOrderPrefill } from "./order-form/order-prefill";
import { describeAmendment } from "./order-form/amendment-summary";
import { orderItemVariantLabel } from "./order-form/order-item-presentation";
import { orderNeedsAddress } from "./order-form/order-line-properties";
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
type ManualOrderAmendmentInput = { id: string } &
  ApiBody<typeof postApiV1AdminOrdersByIdAmendmentsPreview>;

/** Fields in page order (products, payment, then the side column) for focusing the first error. */
const FIELD_ORDER = [
  "items",
  "shippingCharge",
  "discountAmount",
  "customerName",
  "customerPhone",
  "customerEmail",
  "shippingAddress",
  "city",
  "zone",
  "area",
  "notes",
] as const;

/** No address is sent for a pickup order or one with nothing physical (the server stores none). */
function toOrderAddressInput(values: OrderFormValues) {
  if (!orderNeedsAddress(values)) {
    return { shippingAddress: null, city: null, zone: null, area: null, areaName: null };
  }
  return {
    shippingAddress: values.shippingAddress,
    city: values.city,
    zone: values.zone,
    area: values.area,
    cityName: values.cityName ?? undefined,
    zoneName: values.zoneName ?? undefined,
    areaName: values.areaName ?? null,
  };
}

function toOrderBaseContentInput(values: OrderFormValues) {
  return {
    customerName: values.customerName,
    customerPhone: values.customerPhone,
    customerEmail: values.customerEmail,
    ...toOrderAddressInput(values),
    notes: values.notes,
    discountAmount: values.discountAmount,
    shippingCharge: values.shippingCharge,
  };
}

/**
 * A line's buyer inputs, only on lines added here: a kept line (with its
 * order line id) keeps the inputs frozen when it was placed.
 */
function lineProperties(item: Pick<OrderItem, "orderItemId" | "properties">) {
  return !item.orderItemId && item.properties?.length ? { properties: item.properties } : {};
}

function toCreateOrderInput(values: OrderFormValues, requestKey: string): CreateOrderInput {
  return {
    requestKey,
    ...toOrderBaseContentInput(values),
    // The order keeps the method's name; a custom charge has none.
    ...(values.shippingMethodId ? { shippingMethodId: values.shippingMethodId } : {}),
    items: values.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      ...lineProperties(item),
    })),
  };
}

function toManualOrderAmendmentInput(values: OrderFormValues, id: string): ManualOrderAmendmentInput {
  if (!values.version) throw new Error(translate(orderFormMessages, "reloadToSave"));
  return {
    id,
    expectedVersion: values.version,
    ...toOrderBaseContentInput(values),
    items: values.items.map((item) => ({
      orderItemId: item.orderItemId,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      ...lineProperties(item),
    })),
  };
}

export function OrderForm({
  mode,
  products = [],
  defaultValues,
  orderLabel,
  cashToCollect = null,
  savedShippingMethod = null,
}: OrderFormProps) {
  const isEdit = mode === "amend";
  const t = useMessages(orderFormMessages);
  const r = useMessages(resourceMessages);
  const navigate = useNavigate();
  const { code: currencyCode, fmt } = useCurrency();
  const orderActions = useOrderActionPermissions();
  const canSave = isEdit ? orderActions.canEditOrders : orderActions.canCreateOrders;
  const createMutation = useCreateOrder();
  const amendMutation = useConfirmManualOrderAmendment();
  const amendmentRequest = React.useRef<{ key: string; payload: string } | null>(null);
  // One request per click: set before the request leaves, cleared on failure.
  const submitLock = React.useRef(false);
  // After a successful save the form only navigates away; nothing refetches.
  const [completed, setCompleted] = React.useState(false);
  const [pageError, setPageError] = React.useState<string | null>(null);
  const pageErrorRef = React.useRef<HTMLDivElement>(null);
  // The dialog stays mounted; the last amendment is kept while it animates closed.
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pendingAmendment, setPendingAmendment] = React.useState<{
    input: ManualOrderAmendmentInput;
    quoteFingerprint: string;
    requestKey: string;
    cashAfter: number;
    changes: string[];
  } | null>(null);
  const createRequestKey = React.useRef<string | null>(
    isEdit ? null : getOrCreateAdminOrderRequestKey(),
  );
  const form = useForm<OrderFormInput, unknown, OrderFormValues>({
    resolver: zodResolver(orderFormSchema),
    // Fields validate when the merchant leaves them, then as they fix them.
    mode: "onTouched",
    shouldFocusError: false,
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
      shippingMethodId: null,
      shippingMethodKind: null,
      ...defaultValues,
    },
  });
  const orderId = defaultValues?.id;
  const pageTitle = isEdit ? t("editOrder", { number: orderLabel ?? "" }) : t("createOrder");
  const backTo = isEdit && orderId ? `/admin/orders/${orderId}` : "/admin/orders";

  const [
    quoteCity,
    quoteZone,
    quoteArea,
    quoteItems,
    quoteShipping,
    quoteDiscount,
    quoteMethodId,
    quoteMethodKind,
  ] = useWatch({
    control: form.control,
    name: [
      "city",
      "zone",
      "area",
      "items",
      "shippingCharge",
      "discountAmount",
      "shippingMethodId",
      "shippingMethodKind",
    ],
  });
  const needsAddress = orderNeedsAddress({ items: quoteItems, shippingMethodKind: quoteMethodKind });
  const localTotals = React.useMemo(() => {
    const subtotal = quoteItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shipping = Number(quoteShipping) || 0;
    const discount = Number(quoteDiscount) || 0;
    return { subtotal, shipping, discount, total: subtotal + shipping - discount };
  }, [quoteDiscount, quoteItems, quoteShipping]);
  const quoteInput = React.useMemo(
    () => ({
      // A pickup or no-delivery order is taxed without a destination (store-wide rates only).
      city: needsAddress ? quoteCity : null,
      zone: needsAddress ? quoteZone : null,
      area: needsAddress ? quoteArea : null,
      // Kept lines carry their order line id so they keep their original price.
      items: quoteItems.map((item) => ({
        orderItemId: item.orderItemId,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        ...lineProperties(item),
      })),
      shippingCharge: Number(quoteShipping) || 0,
      discountAmount: quoteDiscount == null ? null : Number(quoteDiscount),
      ...(quoteMethodId ? { shippingMethodId: quoteMethodId } : {}),
    }),
    [needsAddress, quoteArea, quoteCity, quoteDiscount, quoteItems, quoteMethodId, quoteShipping, quoteZone],
  );
  const currencyDecimalPlaces = getDecimalPlaces(currencyCode);
  const localDiscountLimit = React.useMemo(
    () => calculateManualOrderDiscountLimit(quoteItems, quoteInput.discountAmount, currencyDecimalPlaces),
    [currencyDecimalPlaces, quoteInput.discountAmount, quoteItems],
  );
  const debouncedQuoteInput = useDebounce(quoteInput, 350);
  const quoteInputIsCurrent =
    JSON.stringify(quoteInput) === JSON.stringify(debouncedQuoteInput);
  const hasQuotePrerequisites = (!needsAddress || Boolean(quoteInput.city && quoteInput.zone))
    && quoteInput.items.length > 0
    && quoteInput.items.every((item) => Boolean(item.variantId) && item.quantity >= 1 && item.quantity <= 99)
    && quoteInput.shippingCharge >= 0
    && (quoteInput.discountAmount ?? 0) >= 0;
  const canRequestQuote = hasQuotePrerequisites && quoteInputIsCurrent;
  const quoteQuery = useQuery({
    queryKey: [
      ...queryKeys.orders.manualQuote(debouncedQuoteInput),
      isEdit ? `amend:${String(orderId)}:${String(defaultValues?.version)}` : "create",
    ],
    queryFn: (): Promise<
      | ApiResult<typeof postApiV1AdminOrdersQuote>
      | ApiResult<typeof postApiV1AdminOrdersByIdAmendmentsPreview>
    > => {
      if (!isEdit) return apiData(postApiV1AdminOrdersQuote({ body: debouncedQuoteInput }));
      // The total depends only on lines, destination, delivery and discount; the
      // saved contact details keep the preview valid while the merchant types.
      const saved = defaultValues ?? {};
      // An amendment keeps the order's delivery method; only the charge is edited.
      const { shippingMethodId: _method, ...previewInput } = debouncedQuoteInput as typeof debouncedQuoteInput & { shippingMethodId?: string };
      return apiData(postApiV1AdminOrdersByIdAmendmentsPreview({
        path: { id: String(orderId ?? "") },
        body: {
          expectedVersion: saved.version ?? 0,
          customerName: saved.customerName ?? "",
          customerPhone: saved.customerPhone ?? "",
          customerEmail: saved.customerEmail ?? null,
          shippingAddress: needsAddress ? saved.shippingAddress ?? "" : null,
          notes: saved.notes ?? null,
          ...previewInput,
        },
      }));
    },
    // Never re-previewed while the review dialog is open or after the save.
    enabled: canRequestQuote && !confirmOpen && !completed,
    retry: false,
    staleTime: 0,
  });
  const currentQuoteError = quoteInputIsCurrent ? quoteQuery.error : null;
  const authoritativeDiscountLimit = currentQuoteError
    ? readManualOrderDiscountLimitError(currentQuoteError)
    : null;
  const manualQuote = {
    data: quoteQuery.data ?? null,
    isCurrent: canRequestQuote && quoteQuery.isSuccess,
    isLoading: hasQuotePrerequisites && (!quoteInputIsCurrent || quoteQuery.isFetching),
    discountLimit: resolveManualOrderDiscountGuidance({
      discountAmount: quoteInput.discountAmount,
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

  const isSubmitting = createMutation.isPending || amendMutation.isPending || completed;
  const isInteractionLocked = isSubmitting || confirmOpen;
  // An abandoned checkout's "Create order" hands its details over once.
  useEffect(() => {
    if (isEdit) return;
    const prefill = takeOrderPrefill();
    if (!prefill) return;
    const set = { shouldDirty: true };
    for (const name of ["customerName", "customerPhone", "shippingAddress", "city", "zone"] as const) {
      if (prefill[name]) form.setValue(name, prefill[name], set);
    }
    if (prefill.customerEmail) form.setValue("customerEmail", prefill.customerEmail, set);
    if (prefill.area) form.setValue("area", prefill.area, set);
    if (prefill.items.length > 0) form.setValue("items", prefill.items, set);
    // The delivery the buyer saw at checkout, not a custom ৳0.
    if (prefill.shippingCharge !== null) {
      form.setValue("shippingCharge", prefill.shippingCharge, set);
      form.setValue("shippingMethodId", prefill.shippingMethodId, set);
    }
  }, [form, isEdit]);

  // --- SUBMIT ---

  const lineName = (item: OrderItem) => {
    const product = products.find((candidate) => candidate.id === item.productId);
    const name = item.name ?? product?.name ?? t("unknownProduct");
    const variant = product?.variants.find((candidate) => candidate.id === item.variantId);
    const variantText = item.variantLabel !== undefined ? item.variantLabel : variant ? orderItemVariantLabel(variant) : null;
    return variantText ? `${name} (${variantText})` : name;
  };

  const focusFirstError = (errors: FieldErrors<OrderFormInput>) => {
    const first = FIELD_ORDER.find((name) => errors[name]);
    // A line whose quantity is over stock: focus that quantity, whose message says why.
    const line = Array.isArray(errors.items) ? errors.items.findIndex((item) => item?.quantity) : -1;
    if (first === "items" && line >= 0) document.getElementById(orderLineQuantityId(line))?.focus();
    else if (first === "items") document.getElementById(PRODUCT_SEARCH_INPUT_ID)?.focus();
    else if (first === "city" || first === "zone" || first === "area") document.getElementById(ORDER_LOCATION_IDS[first])?.focus();
    else if (first) form.setFocus(first);
  };

  const handleSubmit: SubmitHandler<OrderFormValues> = async (values) => {
    if (!manualQuote.isCurrent) {
      if (manualQuote.discountLimit?.exceeded) form.setFocus("discountAmount");
      return;
    }
    if (submitLock.current) return;
    setPageError(null);
    // The server stores the names of the places it validates; these only label the review.
    const enrichedValues: OrderFormValues = {
      ...values,
      cityName: values.cityName || undefined,
      zoneName: values.zoneName || undefined,
      areaName: values.area ? values.areaName ?? null : null,
    };

    if (isEdit) {
      const id = enrichedValues.id || orderId;
      const quote = manualQuote.data;
      if (!id || !values.version || !quote || !("quoteFingerprint" in quote) || !quote.quoteFingerprint) {
        setPageError(t("reloadToSave"));
        return;
      }
      const input = toManualOrderAmendmentInput(enrichedValues, id);
      const payload = JSON.stringify({ ...input, quoteFingerprint: quote.quoteFingerprint });
      if (amendmentRequest.current?.payload !== payload) {
        amendmentRequest.current = { key: crypto.randomUUID(), payload };
      }
      amendMutation.reset();
      setPendingAmendment({
        input,
        quoteFingerprint: quote.quoteFingerprint,
        requestKey: amendmentRequest.current.key,
        cashAfter: quote.balanceDue,
        changes: describeAmendment(defaultValues ?? {}, enrichedValues, lineName, fmt),
      });
      setConfirmOpen(true);
      return;
    }

    submitLock.current = true;
    try {
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
        setCompleted(true);
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
      setPageError(result.outcome === "wait"
        ? t("stillCreating")
        : getServerFnError(result.error, t("createFailed")));
    } finally {
      submitLock.current = false;
    }
  };

  const submit = () => form.handleSubmit(handleSubmit, focusFirstError)();

  const handleConfirmAmendment = async () => {
    const pending = pendingAmendment;
    if (!confirmOpen || !pending || submitLock.current) return;
    submitLock.current = true;
    try {
      await amendMutation.mutateAsync({
        ...pending.input,
        requestKey: pending.requestKey,
        quoteFingerprint: pending.quoteFingerprint,
      });
      setCompleted(true);
      setConfirmOpen(false);
      void navigate({
        to: "/admin/orders/$orderId",
        params: { orderId: pending.input.id },
      });
    } catch {
      // The error shows in the dialog; the request key is kept for a safe retry.
    } finally {
      submitLock.current = false;
    }
  };

  // A save that failed on the server is explained at the top of the page.
  useEffect(() => {
    if (pageError) pageErrorRef.current?.scrollIntoView({ block: "center" });
  }, [pageError]);

  const quoteBusy = manualQuote.isLoading;
  const canSubmit = canSave && !isInteractionLocked && !quoteBusy;

  // Ctrl/Cmd+Enter saves.
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canSubmit && form.formState.isDirty) {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  });

  const amendError = amendMutation.error ? orderErrorMessage(amendMutation.error) : null;

  return (
    <>
      <UnsavedChangesGuard
        isDirty={form.formState.isDirty}
        isSubmitting={isSubmitting}
      />
      <PageHeader title={pageTitle} backTo={backTo} />
      {pageError ? (
        <Alert ref={pageErrorRef} variant="destructive" className="mb-4">
          <AlertDescription>{pageError}</AlertDescription>
        </Alert>
      ) : null}
      <Form {...form}>
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit && form.formState.isDirty) void submit();
          }}
          noValidate
        >
          <OrderFormProvider
            form={form}
            products={products}
            isEdit={isEdit}
            savedShippingMethod={savedShippingMethod}
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
            <AlertDialogTitle>{t("confirmTitle", { number: orderLabel ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground tabular-nums">
                {pendingAmendment
                  ? cashToCollect != null && cashToCollect !== pendingAmendment.cashAfter
                    ? t("cashChange", { before: fmt(cashToCollect), after: fmt(pendingAmendment.cashAfter) })
                    : t("cashAfter", { after: fmt(pendingAmendment.cashAfter) })
                  : null}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingAmendment && pendingAmendment.changes.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-body text-muted-foreground">
              {pendingAmendment.changes.map((change) => <li key={change}>{change}</li>)}
            </ul>
          ) : null}
          {amendError ? (
            <Alert variant="destructive">
              <AlertDescription>{amendError}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={amendMutation.isPending}>{r("cancel")}</AlertDialogCancel>
            <Button
              type="button"
              loading={amendMutation.isPending}
              onClick={() => void handleConfirmAmendment()}
            >
              {t("confirmSave")}
            </Button>
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
        saveLabel={isEdit ? t("reviewChanges") : t("createOrder")}
        saveDisabledReason={canSave ? t("calculating") : r("readOnly")}
        onDiscard={isEdit
          ? undefined
          : () => {
              if (createRequestKey.current) {
                clearAdminOrderRequestKey(createRequestKey.current);
              }
            }}
        onSave={() => void submit()}
      />
    </>
  );
}
