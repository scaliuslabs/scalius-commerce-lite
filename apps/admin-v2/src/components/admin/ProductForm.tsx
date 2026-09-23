import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { ErrorBoundary } from "./ErrorBoundary";
import { Form } from "../ui/form";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
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
import { UnsavedChangesGuard } from "./shared/UnsavedChangesGuard";
import { ConfirmDialog } from "./shared/ConfirmDialog";
import { PageHeader } from "./resource/PageHeader";
import { ProductStatusBadge } from "./product-list/product-columns";
import { ProductActionBar } from "./product-form/ProductStickyHeader";
import { ProductPager } from "./product-form/ProductPager";
import {
  AdditionalSectionsCard,
  TitleDescriptionSection,
} from "./product-form/TitleDescriptionSection";
import { ProductImagesSection } from "./product-form/ProductImagesSection";
import { PricingCard } from "./product-form/PricingCard";
import { AttributesSection } from "./product-form/AttributesSection";
import { ProductSearchListing } from "./product-form/ProductSearchListing";
import { StatusCard } from "./product-form/StatusCard";
import { OrganizationCard } from "./product-form/OrganizationCard";
import { useProductSubmit } from "./product-form/hooks/useProductSubmit";
import { generateSlug } from "./product-form/utils";
import {
  DEFAULT_PRODUCT_CONDITION,
  productFormSchema,
  type Category,
  type ProductFormValues,
} from "./product-form/types";
import { getProductEditorSaveStep } from "./product-form/save-orchestration";
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import type { ProductRevisionConflict } from "@/lib/admin-api-error";
import type { ProductCreateComposition } from "./product-form/variants/option-matrix-editor-model";
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
  }) => React.ReactNode;
  createComposition?: ProductCreateComposition | null;
  optionMatrixIssue?: string | null;
  optionMatrixDirty?: boolean;
  optionMatrixSaving?: boolean;
  onOptionMatrixSave?: () => void;
  /** Throws away the product and variant drafts (the route remounts them from the last save). */
  onDiscard: () => void;
}

/** The one product page: add, edit, or view (without products.edit). */
export function ProductForm({
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
  createComposition,
  optionMatrixIssue = null,
  optionMatrixDirty = false,
  optionMatrixSaving = false,
  onOptionMatrixSave,
  onDiscard,
}: ProductFormProps) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const { getStorefrontPath } = useStorefrontUrl();
  const { products: can } = useCatalogActionPermissions();
  // Server checks stay authoritative; this only keeps viewers from editing.
  const readOnly = isEdit ? !can.canEdit : !can.canCreate;
  const [discardOpen, setDiscardOpen] = React.useState(false);

  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    // Check a field when the merchant leaves it, not while they type.
    mode: "onBlur",
    defaultValues: {
      name: "",
      description: null,
      price: 0,
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
      attributes: [],
      additionalInfo: [],
      ...defaultValues,
    },
  });

  const {
    isSubmitting,
    showAlert,
    alertMessage,
    setShowAlert,
    handleSubmit,
    mediaRemovalConflict,
    confirmMediaRemoval,
    cancelMediaRemoval,
  } = useProductSubmit({
    isEdit,
    productId: defaultValues?.id,
    form,
    aggregateRevision,
    revisionConflict,
    onAggregateRevisionChange,
    onRevisionConflict,
    onOpenRevisionConflict,
    onProductSaved,
    createComposition,
    optionMatrixIssue,
  });
  const productFormDirty = form.formState.isDirty;
  const hasUnsavedChanges = productFormDirty || optionMatrixDirty;
  const isSaving = isSubmitting || optionMatrixSaving;
  const requestSave = React.useCallback(() => {
    const step = getProductEditorSaveStep({
      isEdit,
      productFormDirty,
      hasRevisionConflict: revisionConflict !== null,
    });
    if (step === "review-conflict") {
      onOpenRevisionConflict?.();
      return;
    }
    // A variant draft with a problem goes through handleSubmit, which explains it instead of saving.
    if (step === "save-product" || optionMatrixIssue) {
      void form.handleSubmit(handleSubmit)();
      return;
    }
    onOptionMatrixSave?.();
  }, [form, handleSubmit, isEdit, onOpenRevisionConflict, onOptionMatrixSave, optionMatrixIssue, productFormDirty, revisionConflict]);

  // New products take their web address from the title until it is edited.
  React.useEffect(() => {
    if (isEdit) return;
    const subscription = form.watch((value, { name }) => {
      if (name === "name" && value.name && !form.getValues("slugEdited")) {
        // Re-check only to clear an existing error; never flag the address while the title is typed.
        form.setValue("slug", generateSlug(value.name), { shouldValidate: Boolean(form.getFieldState("slug").error) });
      }
    });
    return () => subscription.unsubscribe();
  }, [form, isEdit]);

  const slug = form.watch("slug");
  const affectedCount = mediaRemovalConflict?.affectedCount ?? 0;

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
      <UnsavedChangesGuard isDirty={hasUnsavedChanges} isSubmitting={isSaving} />
      <PageHeader
        title={isEdit ? defaultValues?.name : t("addProduct")}
        backTo="/admin/products"
        badge={isEdit ? <ProductStatusBadge isActive={Boolean(defaultValues?.isActive)} /> : null}
        actions={isEdit && defaultValues?.id ? <ProductPager productId={defaultValues.id} /> : null}
      />
      {readOnly ? <p className="mb-4 text-body text-muted-foreground">{r("readOnly")}</p> : null}
      <Form {...form}>
        <form method="post" onSubmit={form.handleSubmit(handleSubmit)} noValidate>
          <fieldset disabled={readOnly} className="grid min-w-0 gap-4 lg:grid-cols-3">
            <div className="min-w-0 space-y-4 lg:col-span-2">
              <TitleDescriptionSection form={form} readOnly={readOnly} />
              <ProductImagesSection form={form} />
              <PricingCard form={form} />
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
                  {optionManager({
                    skuImages: form.watch("media")
                      .filter((item) => item.kind === "image")
                      .map((item) => ({
                        id: item.id,
                        url: item.url,
                        altText: item.effectiveAltText,
                        isPrimary: item.isPrimary,
                        sortOrder: item.sortOrder,
                        status: item.status,
                      })),
                    productName: form.watch("name"),
                    productPrice: form.watch("price"),
                  })}
                </CardContent>
              </Card>
              <AdditionalSectionsCard form={form} readOnly={readOnly} />
              <AttributesSection form={form} defaultOpen={readOnly} />
              <ProductSearchListing form={form} disabled={readOnly} />
            </div>
            <div className="min-w-0 space-y-4">
              <StatusCard
                form={form}
                storefrontUrl={isEdit && slug ? getStorefrontPath(`/products/${slug}`) : undefined}
              />
              <OrganizationCard form={form} categories={categories} />
            </div>
          </fieldset>

          <AlertDialog open={showAlert} onOpenChange={setShowAlert}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("cantSaveYet")}</AlertDialogTitle>
                <AlertDialogDescription>{alertMessage || r("fixFields")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction>{t("ok")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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
        </form>
      </Form>
      {!readOnly && (hasUnsavedChanges || revisionConflict !== null) ? (
        <ProductActionBar
          isEdit={isEdit}
          isSubmitting={isSaving}
          hasRevisionConflict={revisionConflict !== null}
          onDiscard={() => setDiscardOpen(true)}
          onSave={requestSave}
        />
      ) : null}
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t("discardTitle")}
        description={t("discardBody")}
        confirmLabel={t("discardChanges")}
        cancelLabel={t("continueEditing")}
        onConfirm={onDiscard}
      />
    </ErrorBoundary>
  );
}
