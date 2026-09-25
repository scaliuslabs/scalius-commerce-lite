import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch, type FieldErrors, type UseFormReturn } from "react-hook-form";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { ErrorBoundary } from "./ErrorBoundary";
import { Form } from "../ui/form";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { ConfirmDialog } from "./shared/ConfirmDialog";
import {
  SaveBarProvider,
  SaveErrorBanner,
  SaveNotCompleted,
  useSaveBar,
  useSaveScope,
} from "./shared/SaveBar";
import { PageHeader } from "./resource/PageHeader";
import { ReadOnlyNotice } from "./resource/ReadOnlyNotice";
import { ProductStatusBadge } from "./product-list/product-columns";
import { ProductPager } from "./product-form/ProductPager";
import {
  AdditionalSectionsCard,
  TitleDescriptionSection,
} from "./product-form/TitleDescriptionSection";
import { ProductImagesSection } from "./product-form/ProductImagesSection";
import { PricingCard } from "./product-form/PricingCard";
import { AttributesSection } from "./product-form/AttributesSection";
import { ProductSearchListing } from "./product-form/ProductSearchListing";
import { FulfilmentCard } from "./product-form/FulfilmentCard";
import { BuyerInputsCard } from "./product-form/BuyerInputsCard";
import { StatusCard } from "./product-form/StatusCard";
import { OrganizationCard } from "./product-form/OrganizationCard";
import { useProductSubmit } from "./product-form/hooks/useProductSubmit";
import { productFieldLabel } from "./product-form/utils";
import { autoHandleFor } from "./search-listing/SearchListingCard";
import {
  DEFAULT_PRODUCT_CONDITION,
  productFormSchema,
  type Category,
  type ProductFormValues,
} from "./product-form/types";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import { useDuplicateProduct, useTrashProduct } from "@/lib/api-mutations/products";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import { saveBarMessages } from "~/i18n/save-bar";
import type { ProductRevisionConflict } from "@/lib/admin-api-error";
import type {
  OptionMatrixEditorHandle,
  ProductCreateComposition,
  ProductFulfilmentMode,
  VariantPriceRange,
} from "./product-form/variants/option-matrix-editor-model";
import type { ProductSkuImageChoice } from "@/lib/api-query-options/products";

interface ProductFormProps {
  categories: Category[];
  defaultValues?: Partial<ProductFormValues>;
  isEdit?: boolean;
  aggregateRevision?: number;
  revisionConflict?: ProductRevisionConflict | null;
  onAggregateRevisionChange?: (revision: number) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
  onOpenRevisionConflict?: () => void;
  onProductSaved?: (values: ProductFormValues, aggregateRevision: number) => void;
  optionManager: (context: {
    skuImages: ProductSkuImageChoice[];
    productName: string;
    productPrice: number;
    isActive: boolean;
    /** The variant editor reports its price range here; with options, variants carry the prices. */
    onPricesChange: (range: VariantPriceRange | null) => void;
    /** The Fulfilment select: one kind for every SKU, or per variant (a column in the table). */
    fulfilmentMode: ProductFulfilmentMode;
  }) => React.ReactNode;
  /** The variant editor rendered by `optionManager`. */
  matrixRef: React.RefObject<OptionMatrixEditorHandle | null>;
  createComposition?: ProductCreateComposition | null;
  optionMatrixIssue?: string | null;
  optionMatrixDirty?: boolean;
  optionMatrixSaving?: boolean;
  /** Saved SKUs, for printing their labels from the page's menu. */
  variantIds?: string[];
  /** Filled with a reader of the unsaved draft (values and changed fields). */
  draftRef?: React.MutableRefObject<ProductDraftReader | null>;
  /** Changes to put back on top of the loaded values, still unsaved (after a conflict). */
  initialEdits?: Partial<ProductFormValues> | null;
  /** Throws away the product and variant drafts (the route remounts them from the last save). */
  onDiscard: () => void;
  /** The saved buyer inputs couldn't be read (a product error, never "no inputs"). */
  customizationSchemaInvalid?: boolean;
}

/** Reads the unsaved product draft: its values and the fields the merchant changed. */
export type ProductDraftReader = () => { values: ProductFormValues; changed: Array<keyof ProductFormValues> };

/** The one product page: add, edit, or view (without products.edit). */
export function ProductForm(props: ProductFormProps) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  return (
    <ErrorBoundary
      fallback={
        <p className="p-4 text-center text-body text-muted-foreground">
          {r("loadFailed")}{" "}
          <Button type="button" variant="link" onClick={() => window.location.reload()}>
            {r("retry")}
          </Button>
        </p>
      }
    >
      {/* The same contextual save bar as every editor; a new product names itself. */}
      <SaveBarProvider
        unsavedLabel={props.isEdit ? undefined : t("unsavedProduct")}
        savedMessage={t(props.isEdit ? "productSaved" : "productAdded")}
      >
        <ProductEditor {...props} />
      </SaveBarProvider>
    </ErrorBoundary>
  );
}

function ProductEditor({
  categories,
  defaultValues,
  isEdit = false,
  aggregateRevision,
  revisionConflict = null,
  onAggregateRevisionChange,
  onRevisionConflict,
  onOpenRevisionConflict,
  onProductSaved,
  optionManager,
  matrixRef,
  createComposition,
  optionMatrixIssue = null,
  optionMatrixDirty = false,
  optionMatrixSaving = false,
  variantIds = [],
  draftRef,
  initialEdits,
  onDiscard,
  customizationSchemaInvalid = false,
}: ProductFormProps) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const s = useMessages(saveBarMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  const { products: can } = useCatalogActionPermissions();
  // Server checks stay authoritative; this only keeps viewers from editing.
  const readOnly = isEdit ? !can.canEdit : !can.canCreate;
  const [trashOpen, setTrashOpen] = React.useState(false);
  const duplicate = useDuplicateProduct();
  const trash = useTrashProduct();

  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    // Check a field when the merchant leaves it, not while they type.
    mode: "onBlur",
    defaultValues: {
      name: "",
      description: null,
      price: null,
      categoryId: "",
      isActive: false,
      discountType: "percentage",
      discountPercentage: 0,
      discountAmount: 0,
      freeDelivery: false,
      metaTitle: null,
      metaDescription: null,
      noIndex: false,
      excludeFromSitemap: false,
      excludeFromProductFeed: false,
      productCondition: DEFAULT_PRODUCT_CONDITION,
      slug: "",
      media: [],
      slugEdited: false,
      variantPriced: false,
      attributes: [],
      additionalInfo: [],
      fulfillmentKind: "physical",
      customizationSchema: [],
      ...defaultValues,
    },
  });

  const {
    isSubmitting,
    submit,
    mediaRemovalConflict,
    confirmMediaRemoval,
    cancelMediaRemoval,
  } = useProductSubmit({
    isEdit,
    productId: defaultValues?.id,
    form,
    aggregateRevision,
    onAggregateRevisionChange,
    onRevisionConflict,
    onProductSaved,
    createComposition,
    onVariantIssue: (path, message) => matrixRef.current?.showServerIssue(path, message) ?? null,
  });
  const productFormDirty = form.formState.isDirty;
  // Read while rendering so react-hook-form keeps tracking which fields changed.
  const dirtyFields = form.formState.dirtyFields;

  // The route reads the draft after a conflict and hands the merchant's changes back once
  // they sit on top of the latest version (still unsaved).
  if (draftRef) {
    draftRef.current = () => ({
      values: form.getValues(),
      changed: (Object.keys(dirtyFields) as Array<keyof ProductFormValues>)
        .filter((key) => key !== "slugEdited" && key !== "variantPriced"),
    });
  }
  React.useEffect(() => {
    if (!initialEdits) return;
    for (const [key, value] of Object.entries(initialEdits)) {
      form.setValue(key as keyof ProductFormValues, value as never, { shouldDirty: true });
    }
    // Applied once, when the form mounts on the latest version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // With options the variants carry the prices: the product price follows the cheapest one,
  // as the server keeps it, and is not the merchant's to edit (or a change to save).
  const [variantPrices, setVariantPrices] = React.useState<VariantPriceRange | null>(null);
  React.useEffect(() => {
    form.resetField("variantPriced", { defaultValue: variantPrices !== null });
    if (variantPrices) form.resetField("price", { defaultValue: variantPrices.min });
  }, [form, variantPrices]);

  /** One line per field that failed the page's own checks, for the save banner. */
  const describeInvalid = (errors: FieldErrors<ProductFormValues>) =>
    (Object.keys(errors) as Array<keyof ProductFormValues>).map((field) => {
      const message = errors[field]?.message;
      return `${productFieldLabel(field)}: ${typeof message === "string" ? message : s("fixErrors")}`;
    });

  const save = async () => {
    if (revisionConflict) {
      onOpenRevisionConflict?.();
      throw new SaveNotCompleted(t("changedElsewhere"));
    }
    // New products send their variants with the product, so their problems block the save too.
    const matrixBlocks = optionMatrixIssue && (!isEdit || optionMatrixDirty);
    let revision: number | undefined;
    if (!isEdit || productFormDirty) {
      let invalid: FieldErrors<ProductFormValues> = {};
      const values = await new Promise<ProductFormValues | null>((resolve) => {
        void form.handleSubmit(resolve, (errors) => {
          invalid = errors;
          resolve(null);
        })();
      });
      if (!values || matrixBlocks) {
        if (matrixBlocks) matrixRef.current?.reveal();
        const lines = [...describeInvalid(invalid), ...(matrixBlocks ? [optionMatrixIssue] : [])];
        throw new SaveNotCompleted(lines[0], lines);
      }
      revision = await submit(values);
    }
    if (isEdit && optionMatrixDirty) await matrixRef.current?.save(revision);
  };

  useSaveBar({
    dirty: !readOnly && (productFormDirty || optionMatrixDirty || revisionConflict !== null),
    saving: isSubmitting || optionMatrixSaving,
    save,
    discard: () => {
      if (revisionConflict) onOpenRevisionConflict?.();
      else onDiscard();
    },
  });
  const scope = useSaveScope();

  // New products show the web address the server will make from the title until it is edited;
  // an address the merchant didn't type is never sent (see formatFormValuesForSubmission).
  React.useEffect(() => {
    if (isEdit) return;
    const subscription = form.watch((value, { name }) => {
      if (name === "name" && !form.getValues("slugEdited")) {
        // Re-check only to clear an existing error; never flag the address while the title is typed.
        form.setValue("slug", autoHandleFor(value.name ?? "", "product"), { shouldValidate: Boolean(form.getFieldState("slug").error) });
      }
    });
    return () => subscription.unsubscribe();
  }, [form, isEdit]);

  const affectedCount = mediaRemovalConflict?.affectedCount ?? 0;
  const productId = defaultValues?.id;
  const productName = defaultValues?.name ?? "";

  const moreActions = isEdit && productId ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          {r("moreActions")}
          <ChevronDown className="ml-1 h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {can.canCreate ? (
          <DropdownMenuItem disabled={duplicate.isPending} onSelect={() => duplicate.mutate({ id: productId, name: productName })}>
            {t("duplicate")}
          </DropdownMenuItem>
        ) : null}
        {variantIds.length > 0 ? (
          <DropdownMenuItem asChild>
            <Link to="/admin/inventory/labels" search={{ variants: variantIds.join(",") }}>{t("printLabels")}</Link>
          </DropdownMenuItem>
        ) : null}
        {can.canDelete ? (
          <DropdownMenuItem variant="destructive" onSelect={() => setTrashOpen(true)}>{r("moveToTrash")}</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <>
      <PageHeader
        title={isEdit ? defaultValues?.name : t("addProduct")}
        backTo="/admin/products"
        badge={isEdit ? <ProductStatusBadge isActive={Boolean(defaultValues?.isActive)} /> : null}
        actions={isEdit && productId ? (
          <>
            {moreActions}
            <ProductPager productId={productId} />
          </>
        ) : null}
      />
      {readOnly ? <ReadOnlyNotice /> : null}
      <Form {...form}>
        <form
          method="post"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            // React bubbles submits from forms in portalled dialogs; only this form saves the page.
            if (event.target === event.currentTarget && scope?.dirty && !scope.busy) void scope.saveAll();
          }}
          className="flex flex-col gap-4 pb-6"
        >
          <SaveErrorBanner />
          <fieldset disabled={readOnly} className="grid min-w-0 gap-4 lg:grid-cols-3">
            <div className="min-w-0 space-y-4 lg:col-span-2">
              <TitleDescriptionSection form={form} readOnly={readOnly} />
              <ProductImagesSection form={form} readOnly={readOnly} />
              <PricingCard form={form} variantPrices={variantPrices} />
              <Card>
                <CardHeader>
                  <CardTitle>{t("variants")}</CardTitle>
                </CardHeader>
                <CardContent
                  onKeyDownCapture={(event) => {
                    // Enter inside the variant table must not submit the product form.
                    if (
                      event.key === "Enter" &&
                      event.target instanceof HTMLElement &&
                      event.target.closest("[data-variant-editor]") &&
                      !event.target.closest("[data-option-value-composer]")
                    ) {
                      event.preventDefault();
                    }
                  }}
                >
                  <ProductVariants form={form} optionManager={optionManager} onPricesChange={setVariantPrices} />
                </CardContent>
              </Card>
              <FulfilmentCard form={form} hasOptions={variantPrices !== null} />
              <BuyerInputsCard
                form={form}
                readOnly={readOnly}
                savedInvalid={customizationSchemaInvalid}
                conflict={revisionConflict && dirtyFields.customizationSchema && onOpenRevisionConflict
                  ? { onReview: onOpenRevisionConflict }
                  : null}
              />
              <AdditionalSectionsCard form={form} readOnly={readOnly} />
              <AttributesSection form={form} defaultOpen={readOnly} />
              <ProductSearchListing form={form} disabled={readOnly} />
            </div>
            {/* On phones the status comes first; the rest of the side column follows the main cards. */}
            <div className="min-w-0 space-y-4 max-lg:contents">
              <div className="max-lg:order-first">
                <ProductStatusCard form={form} isEdit={isEdit} getStorefrontPath={getStorefrontPath} />
              </div>
              <OrganizationCard form={form} categories={categories} />
            </div>
          </fieldset>
          {readOnly ? null : (
            // Shopify repeats Save at the end of the page, under a divider.
            <div className="flex justify-end border-t pt-4">
              <Button type="submit" loading={Boolean(scope?.busy)} disabled={!scope?.dirty}>
                {s("save")}
              </Button>
            </div>
          )}
        </form>
      </Form>
      <AlertDialog
        open={mediaRemovalConflict !== null}
        onOpenChange={(open) => { if (!open) cancelMediaRemoval(); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeVariantPhotosTitle", { count: affectedCount })}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeVariantPhotosBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          {mediaRemovalConflict?.affectedSkus.length ? (
            <ul className="max-h-40 space-y-1 overflow-y-auto text-body">
              {mediaRemovalConflict.affectedSkus.map((sku) => (
                <li key={sku.id} className="truncate">{sku.sku}</li>
              ))}
              {affectedCount > mediaRemovalConflict.affectedSkus.length ? (
                <li className="text-muted-foreground">
                  {t("andMore", { count: affectedCount - mediaRemovalConflict.affectedSkus.length })}
                </li>
              ) : null}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelMediaRemoval}>{t("keepPhotos")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isSubmitting}
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                void confirmMediaRemoval();
              }}
            >
              {t("removePhotos")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConfirmDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title={t("trashProductTitle", { name: productName })}
        description={t("trashProductBody")}
        confirmLabel={r("moveToTrash")}
        cancelLabel={r("cancel")}
        loadingLabel={r("working")}
        variant="default"
        isLoading={trash.isPending}
        onConfirm={() => {
          if (productId && aggregateRevision) trash.mutate({ id: productId, expectedAggregateRevision: aggregateRevision });
        }}
      />
    </>
  );
}

// The editor's root must not re-render while the merchant types: these two
// read the fields they show with useWatch, so a keystroke in the title
// re-renders them, not the whole page.

function ProductStatusCard({ form, isEdit, getStorefrontPath }: {
  form: UseFormReturn<ProductFormValues>;
  isEdit: boolean;
  getStorefrontPath: (path: string) => string;
}) {
  const slug = useWatch({ control: form.control, name: "slug" });
  return (
    <StatusCard
      form={form}
      storefrontUrl={isEdit && slug ? getStorefrontPath(`/products/${slug}`) : undefined}
    />
  );
}

function ProductVariants({ form, optionManager, onPricesChange }: {
  form: UseFormReturn<ProductFormValues>;
  optionManager: ProductFormProps["optionManager"];
  onPricesChange: (range: VariantPriceRange | null) => void;
}) {
  const [media, name, price, isActive, fulfilmentMode] = useWatch({
    control: form.control,
    name: ["media", "name", "price", "isActive", "fulfillmentKind"],
  });
  const skuImages = React.useMemo(() => (media ?? [])
    .filter((item) => item.kind === "image")
    .map((item) => ({
      id: item.id,
      url: item.url,
      altText: item.effectiveAltText,
      isPrimary: item.isPrimary,
      sortOrder: item.sortOrder,
      status: item.status,
    })), [media]);
  // The title and price only seed unsaved variants' SKUs and prices: the
  // variant table catches up after the keystroke has painted.
  const productName = React.useDeferredValue(name ?? "");
  const productPrice = React.useDeferredValue(Number.isFinite(price) ? price ?? 0 : 0);
  const mode = fulfilmentMode ?? "physical";
  return React.useMemo(
    () => optionManager({ skuImages, productName, productPrice, isActive: Boolean(isActive), onPricesChange, fulfilmentMode: mode }),
    [optionManager, skuImages, productName, productPrice, isActive, onPricesChange, mode],
  );
}
