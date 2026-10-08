import React, { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useWatch } from "react-hook-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FieldErrors } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { useFormWithRefusals } from "~/lib/input-refusals";
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
import { PageHeader } from "@/components/admin/resource/PageHeader";
import { ReadOnlyNotice } from "@/components/admin/resource/ReadOnlyNotice";
import {
  SaveBarProvider,
  SaveErrorBanner,
  SaveNotCompleted,
  useSaveBar,
  useSaveScope,
} from "./shared/SaveBar";
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
  orderChannelSourceInput,
  orderFormSchema,
  type OrderFormInput,
  type OrderFormValues,
  type OrderItem,
  type OrderFormProps,
} from "./order-form/types";
import { OrderFormProvider } from "./order-form/OrderFormContext";
import { CustomerInfoSection, ORDER_ADDRESS_IDS } from "./order-form/CustomerInfoSection";
import { SalesChannelSection } from "./order-form/SalesChannelSection";
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
import { isAdminApiRetryableReadError, readCheckoutRuleErrors, readManualOrderDiscountLimitError } from "@/lib/admin-api-conflicts";
import { useCurrency } from "@/hooks/use-currency";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
  calculateManualOrderDiscountLimit,
  resolveManualOrderDiscountGuidance,
} from "./order-form/manual-order-discount";
import { translate, useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { orderDetailMessages } from "@/i18n/order-detail";
import { orderToastMessages } from "@/i18n/order-toasts";
import { resourceMessages } from "@/i18n/resource";
import { matchesShortcut } from "./layout/shortcuts";
import { addressProblemMessages, useAddressErrors } from "./address/AddressFields";
import {
  emptyAddressDraft,
  orderBillingInput,
  readAddressProblems,
  readBillingAddressProblems,
  type AddressDraft,
  type AddressProblem,
} from "./address/address-draft";
import { BillingSection } from "./order-form/BillingSection";
import { addressMessages } from "@/i18n/address";
import { locationMessages } from "@/i18n/location";
import { addressRulesQueryOptions } from "@/lib/api-query-options/address-rules";

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
  "shippingCountryCode",
  "shippingAddress",
  "shippingAddressLine2",
  "shippingDependentLocality",
  "shippingLocality",
  "shippingAdminArea",
  "shippingPostalCode",
  "city",
  "zone",
  "area",
  "notes",
  "sourceName",
] as const;

const orNull = (value: string | undefined) => value?.trim() || null;

/**
 * No address is sent for a pickup order or one with nothing physical (the
 * server stores none). A Bangladesh address sends its street line and
 * City/Thana/Area ids, as before; another country its canonical fields.
 */
function toOrderAddressInput(values: OrderFormValues) {
  if (!orderNeedsAddress(values)) {
    return { shippingAddress: null, city: null, zone: null, area: null, areaName: null };
  }
  const skip = values.skipAddressValidation ? { skipAddressValidation: true } : {};
  const country = values.shippingCountryCode || "BD";
  if (country !== "BD") {
    return {
      shippingCountryCode: country,
      shippingAddress: values.shippingAddress,
      shippingAddressLine2: orNull(values.shippingAddressLine2),
      shippingDependentLocality: orNull(values.shippingDependentLocality),
      shippingLocality: orNull(values.shippingLocality),
      shippingAdminArea: orNull(values.shippingAdminArea),
      shippingPostalCode: orNull(values.shippingPostalCode),
      shippingCompany: orNull(values.shippingCompany),
      city: null,
      zone: null,
      area: null,
      ...skip,
    };
  }
  return {
    shippingAddress: values.shippingAddress,
    city: values.city,
    zone: values.zone,
    area: values.area,
    cityName: values.cityName ?? undefined,
    zoneName: values.zoneName ?? undefined,
    areaName: values.areaName ?? null,
    ...skip,
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

/**
 * The new order's billing address: "same as delivery" (or a separate one)
 * when it ships; otherwise only what staff entered (none when untouched).
 */
export interface OrderBillingState {
  draft: AddressDraft;
  sameAsShipping: boolean;
  touched: boolean;
}

function toOrderBillingInput(values: OrderFormValues, billing: OrderBillingState) {
  if (orderNeedsAddress(values)) return orderBillingInput(billing.draft, billing.sameAsShipping);
  return billing.touched ? orderBillingInput(billing.draft, false) : {};
}

function toCreateOrderInput(values: OrderFormValues, requestKey: string, billing: OrderBillingState): CreateOrderInput {
  const channelSource = orderChannelSourceInput(values);
  return {
    requestKey,
    ...toOrderBaseContentInput(values),
    ...toOrderBillingInput(values, billing),
    // The order keeps the method's name; a custom charge has none.
    ...(values.shippingMethodId ? { shippingMethodId: values.shippingMethodId } : {}),
    // Where a staff-created order came in (Facebook, walk-in, …); the server stores it as a slug.
    ...(channelSource ? { channelSource } : {}),
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

/**
 * The manual order editor on the page's contextual save bar ("Unsaved order /
 * Discard / Save"), like Shopify's draft order page.
 */
export function OrderForm(props: OrderFormProps) {
  const t = useMessages(orderFormMessages);
  const d = useMessages(orderDetailMessages);
  const isEdit = props.mode === "amend";
  return (
    <SaveBarProvider
      unsavedLabel={isEdit ? undefined : t("unsavedOrder")}
      savedMessage={isEdit ? translate(orderToastMessages, "toast.orderUpdated") : d("toast.orderCreated")}
    >
      <OrderEditor {...props} />
    </SaveBarProvider>
  );
}

function OrderEditor({
  mode,
  products = [],
  defaultValues,
  orderLabel,
  cashToCollect = null,
  savedShippingMethod = null,
  amendShipsNothing = false,
}: OrderFormProps) {
  const isEdit = mode === "amend";
  const t = useMessages(orderFormMessages);
  const r = useMessages(resourceMessages);
  const navigate = useNavigate();
  const scope = useSaveScope();
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
  // The API refused the address once: staff may then keep it, marked.
  const [addressRefused, setAddressRefused] = React.useState(false);
  // The billing address of a new order (an edit changes it in the order's details dialog).
  const [billing, setBilling] = React.useState<OrderBillingState>(() => ({
    draft: emptyAddressDraft(defaultValues?.shippingCountryCode || "BD"),
    sameAsShipping: true,
    touched: false,
  }));
  const [billingProblems, setBillingProblems] = React.useState<AddressProblem[] | null>(null);
  const billingErrors = useAddressErrors(billingProblems, billing.draft.countryCode);
  const addressText = useMessages(addressMessages);
  const placeText = useMessages(locationMessages);
  const queryClient = useQueryClient();
  // The save bar's Save waits here until the review dialog is confirmed or cancelled.
  const confirmation = React.useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null);
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
  const form = useFormWithRefusals<OrderFormInput, unknown, OrderFormValues>({
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
      sourceChoice: null,
      sourceName: "",
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
    quoteCountry,
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
      "shippingCountryCode",
    ],
  });
  // Bangladesh is taxed by City/Thana/Area; another country by its country (until tax regions).
  const abroad = Boolean(quoteCountry && quoteCountry !== "BD");
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
      ...(needsAddress && abroad ? { shippingCountryCode: quoteCountry } : {}),
      city: needsAddress && !abroad ? quoteCity : null,
      zone: needsAddress && !abroad ? quoteZone : null,
      area: needsAddress && !abroad ? quoteArea : null,
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
      // A new order that ships nothing is taxed in the billing country staff entered.
      ...(!isEdit && !needsAddress && billing.touched && billing.draft.countryCode
        ? {
          billingCountryCode: billing.draft.countryCode,
          billingAdminArea: billing.draft.adminArea.trim() || null,
          billingPostalCode: billing.draft.postalCode.trim() || null,
        }
        : {}),
    }),
    [abroad, billing, isEdit, needsAddress, quoteArea, quoteCity, quoteCountry, quoteDiscount, quoteItems, quoteMethodId, quoteShipping, quoteZone],
  );
  const currencyDecimalPlaces = getDecimalPlaces(currencyCode);
  const localDiscountLimit = React.useMemo(
    () => calculateManualOrderDiscountLimit(quoteItems, quoteInput.discountAmount, currencyDecimalPlaces),
    [currencyDecimalPlaces, quoteInput.discountAmount, quoteItems],
  );
  const debouncedQuoteInput = useDebounce(quoteInput, 350);
  const quoteInputIsCurrent =
    JSON.stringify(quoteInput) === JSON.stringify(debouncedQuoteInput);
  const hasQuotePrerequisites = (!needsAddress || abroad || Boolean(quoteInput.city && quoteInput.zone))
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
  // An installed app's rule refused the quote: the summary lists the app's messages.
  const ruleErrors = currentQuoteError ? readCheckoutRuleErrors(currentQuoteError) : null;
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
    ruleErrors,
    errorMessage: currentQuoteError && !authoritativeDiscountLimit && !ruleErrors
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
    for (const name of [
      "customerName", "customerPhone", "shippingCountryCode", "shippingAddress", "shippingAddressLine2",
      "shippingDependentLocality", "shippingLocality", "shippingAdminArea", "shippingPostalCode", "city", "zone",
    ] as const) {
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
    else if (first && first in ORDER_ADDRESS_IDS) document.getElementById(ORDER_ADDRESS_IDS[first as keyof typeof ORDER_ADDRESS_IDS])?.focus();
    else if (first) form.setFocus(first);
  };

  /** The API's refusal of the address, on its fields (worded with the country's labels). */
  const showAddressProblems = (problems: AddressProblem[], countryCode: string) => {
    const rules = countryCode === "BD" ? null : queryClient.getQueryData(addressRulesQueryOptions(countryCode).queryKey) ?? null;
    const messages = addressProblemMessages(problems, rules, addressText, placeText);
    const names = {
      countryCode: "shippingCountryCode", line1: "shippingAddress", line2: "shippingAddressLine2",
      dependentLocality: "shippingDependentLocality", locality: "shippingLocality", adminArea: "shippingAdminArea",
      postalCode: "shippingPostalCode", company: "shippingCompany", city: "city", zone: "zone", area: "area",
    } as const;
    for (const [field, message] of Object.entries(messages)) {
      const name = names[field as keyof typeof names];
      if (name && message) form.setError(name, { type: "server", message });
    }
    setAddressRefused(true);
    const first = FIELD_ORDER.find((name) => name in ORDER_ADDRESS_IDS && form.getFieldState(name).error);
    if (first) document.getElementById(ORDER_ADDRESS_IDS[first as keyof typeof ORDER_ADDRESS_IDS])?.focus();
  };

  /** Resolves once the order is saved; rejects (keeping the edits) when it isn't. */
  const saveValues = async (values: OrderFormValues): Promise<void> => {
    if (!manualQuote.isCurrent) {
      if (manualQuote.discountLimit?.exceeded) {
        form.setFocus("discountAmount");
        throw new SaveNotCompleted(t("fixDiscount"));
      }
      throw new SaveNotCompleted(manualQuote.isLoading
        ? t("waitForTotal")
        : manualQuote.ruleErrors ? t("appRulesTitle") : manualQuote.errorMessage ?? t("totalFailed"));
    }
    if (submitLock.current) throw new SaveNotCompleted(undefined, []);
    // The server stores the names of the places it validates; these only label the review.
    const enrichedValues: OrderFormValues = {
      ...values,
      cityName: values.cityName || undefined,
      zoneName: values.zoneName || undefined,
      areaName: values.area ? values.areaName ?? null : null,
    };

    if (isEdit) {
      const id = enrichedValues.id || orderId;
      // An edit's query previews the amendment (see quoteQuery above).
      const quote = manualQuote.data as ApiResult<typeof postApiV1AdminOrdersByIdAmendmentsPreview> | null;
      if (!id || !values.version || !quote || !("quoteFingerprint" in quote) || !quote.quoteFingerprint) {
        throw new SaveNotCompleted(t("reloadToSave"));
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
      return new Promise<void>((resolve, reject) => {
        confirmation.current = { resolve, reject };
      });
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
            toCreateOrderInput(enrichedValues, submittedRequestKey, billing),
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
      const problems = result.outcome === "error" ? readAddressProblems(result.error) : null;
      if (problems) {
        showAddressProblems(problems, enrichedValues.shippingCountryCode || "BD");
        throw new SaveNotCompleted(r("fixFields"));
      }
      const billingRefusal = result.outcome === "error" ? readBillingAddressProblems(result.error) : null;
      if (billingRefusal) {
        setBillingProblems(billingRefusal);
        throw new SaveNotCompleted(r("fixFields"));
      }
      throw new SaveNotCompleted(result.outcome === "wait"
        ? t("stillCreating")
        : getServerFnError(result.error, t("createFailed")));
    } finally {
      submitLock.current = false;
    }
  };

  /** The save bar's Save (and ⌘S, ⌘/Ctrl+Enter, Enter in a field): validate, then save. */
  const save = () =>
    new Promise<void>((resolve, reject) => {
      void form.handleSubmit(
        (values) => saveValues(values).then(resolve, reject),
        (errors) => {
          focusFirstError(errors);
          reject(new SaveNotCompleted(r("fixFields")));
        },
      )();
    });

  /** Cancelling the review keeps the bar as it was: nothing was saved, nothing failed. */
  const closeConfirm = (saved: boolean) => {
    setConfirmOpen(false);
    const pending = confirmation.current;
    confirmation.current = null;
    if (saved) pending?.resolve();
    else pending?.reject(new SaveNotCompleted(undefined, []));
  };

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
      closeConfirm(true);
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

  useSaveBar({
    // react-hook-form compares every value with the loaded order (or the empty draft).
    dirty: form.formState.isDirty,
    saving: isSubmitting,
    invalid: !canSave || Object.keys(form.formState.errors).length > 0,
    save,
    discard: () => {
      form.reset();
      amendmentRequest.current = null;
      // A new draft never reuses the discarded one's create request.
      if (createRequestKey.current) {
        clearAdminOrderRequestKey(createRequestKey.current);
        createRequestKey.current = getOrCreateAdminOrderRequestKey();
      }
    },
  });

  const saveFromPage = () => {
    if (scope?.dirty && !scope.busy && !isInteractionLocked) void scope.saveAll();
  };

  // Ctrl/Cmd+Enter saves through the save bar, like ⌘S.
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut("submit", e) && scope?.dirty) {
        e.preventDefault();
        saveFromPage();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  });

  const amendError = amendMutation.error ? orderErrorMessage(amendMutation.error) : null;

  return (
    <>
      <PageHeader title={pageTitle} backTo={backTo} />
      {canSave ? null : <ReadOnlyNotice />}
      <Form {...form}>
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            // React bubbles submits from portalled dialogs; only this form saves the page.
            if (event.target === event.currentTarget) saveFromPage();
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          <SaveErrorBanner />
          <OrderFormProvider
            form={form}
            products={products}
            isEdit={isEdit}
            savedShippingMethod={savedShippingMethod}
            amendShipsNothing={isEdit && amendShipsNothing}
            localTotals={localTotals}
            manualQuote={manualQuote}
            addressRefused={addressRefused}
          >
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="min-w-0 space-y-4 lg:col-span-2">
                <OrderItemsSection />
                <SummarySection />
              </div>
              <div className="min-w-0 space-y-4">
                <CustomerInfoSection />
                {isEdit ? null : (
                  <BillingSection
                    ships={needsAddress}
                    sameAsShipping={billing.sameAsShipping}
                    onSameAsShippingChange={(checked) => setBilling((current) => ({ ...current, sameAsShipping: checked, touched: true }))}
                    value={billing.draft}
                    onChange={(draft) => setBilling((current) => ({ ...current, draft, touched: true }))}
                    errors={billingErrors}
                    disabled={isInteractionLocked}
                  />
                )}
                {isEdit ? null : <SalesChannelSection />}
              </div>
            </div>
          </OrderFormProvider>
        </form>
      </Form>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !amendMutation.isPending) closeConfirm(false);
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
            <ul className="list-disc space-y-1 ps-5 text-body text-muted-foreground">
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
    </>
  );
}
