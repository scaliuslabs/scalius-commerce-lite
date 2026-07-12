import React from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Form } from "../ui/form";
import { UnsavedChangesGuard } from "./shared/UnsavedChangesGuard";
import { ProductActionBar } from "./product-form/ProductStickyHeader";
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
import { useStorefrontUrl } from "@/hooks/use-storefront-url";
import {
  ProductImagesSection,
  TitleDescriptionSection,
  SeoSection,
  AttributesSection,
  PricingCard,
  StatusCard,
  OrganizationCard,
  useProductSubmit,
  productFormSchema,
  generateSlug,
  DEFAULT_PRODUCT_CONDITION,
  type ProductFormValues,
  type Category,
} from "./product-form";
import type { ProductSeoDiagnosticVariant } from "@/lib/product-seo-diagnostics";
import type { ProductRevisionConflict } from "@/lib/admin-api-error";
import type { ProductOptionMatrixInput } from "@/lib/api-functions/products";
import type { ProductSkuImageChoice } from "@/types/api-responses";

interface ProductFormProps {
  categories: Category[];
  defaultValues?: Partial<
    ProductFormValues & { attributes?: Array<{ attributeId: string; value: string }>; additionalInfo?: Array<{ id: string; title: string; content: string }> }
  >;
  isEdit?: boolean;
  aggregateRevision?: number;
  editorVariants?: ProductSeoDiagnosticVariant[];
  revisionConflict?: ProductRevisionConflict | null;
  onAggregateRevisionChange?: (revision: number) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
  onOpenRevisionConflict?: () => void;
  onProductSaved?: (values: ProductFormValues, aggregateRevision: number) => void;
  optionManager?: React.ReactNode | ((context: {
    skuImages: ProductSkuImageChoice[];
    productName: string;
    productPrice: number;
  }) => React.ReactNode);
  optionMatrixDraft?: Omit<ProductOptionMatrixInput, "expectedAggregateRevision"> | null;
  optionMatrixIssue?: string | null;
  optionMatrixDirty?: boolean;
  optionMatrixSaving?: boolean;
  onOptionMatrixSave?: () => void;
}

export function ProductForm({
  categories,
  defaultValues,
  isEdit = false,
  aggregateRevision,
  editorVariants = [],
  revisionConflict = null,
  onAggregateRevisionChange,
  onRevisionConflict,
  onOpenRevisionConflict,
  onProductSaved,
  optionManager,
  optionMatrixDraft,
  optionMatrixIssue = null,
  optionMatrixDirty = false,
  optionMatrixSaving = false,
  onOptionMatrixSave,
}: ProductFormProps) {
  const { storefrontUrl, getStorefrontPath } = useStorefrontUrl();

  const variants = editorVariants;
  // Initialize form
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
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

  // Set up form submission handler
  const {
    isSubmitting,
    showAlert,
    alertMessage,
    setShowAlert,
    handleSubmit,
    mediaRemovalConflict,
    confirmMediaRemoval,
    cancelMediaRemoval,
  } =
    useProductSubmit({
      isEdit,
      productId: defaultValues?.id,
      form,
      aggregateRevision,
      revisionConflict,
      onAggregateRevisionChange,
      onRevisionConflict,
      onOpenRevisionConflict,
      onProductSaved,
      optionMatrixDraft,
      optionMatrixIssue,
    });
  const hasUnsavedChanges = form.formState.isDirty || optionMatrixDirty;
  const isSaving = isSubmitting || optionMatrixSaving;

  // Auto-generate slug from name - ONLY for new products
  React.useEffect(() => {
    if (!isEdit) {
      const subscription = form.watch((value, { name }) => {
        if (
          name === "name" &&
          value.name &&
          !form.getValues("slugEdited")
        ) {
          const slug = generateSlug(value.name);
          form.setValue("slug", slug, {
            shouldValidate: true,
          });
        }
      });
      return () => subscription.unsubscribe();
    }
  }, [form, isEdit]);

  return (
    <ErrorBoundary fallback={<div className="p-4 text-center text-muted-foreground">Something went wrong loading the product form. <button onClick={() => window.location.reload()} className="underline">Reload</button></div>}>
    <>
      <UnsavedChangesGuard
        isDirty={hasUnsavedChanges}
        isSubmitting={isSaving}
      />
      <Form {...form}>
        <form
          method="post"
          onSubmit={form.handleSubmit(handleSubmit)}
          className="-mt-3 pb-5"
          noValidate
        >
          <div className="mb-3">
            <h1
              id="product-form-heading"
              tabIndex={-1}
              className="text-xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {isEdit ? "Edit product" : "Create product"}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {isEdit
                ? "Update catalog details, merchandising, and discovery settings."
                : "Start as a draft, then publish after pricing, media, and SKU readiness are confirmed."}
            </p>
          </div>
          {/* Two-Column Layout */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 lg:gap-4">
            {/* Left Column - Main Content (2/3 width on large screens) */}
            <div className="space-y-3 lg:col-span-2">
              {/* Title & Description */}
              <TitleDescriptionSection form={form} />

              {/* Product Images */}
              <ProductImagesSection form={form} />

              {/* Product composition belongs in the main reading flow. */}
              <PricingCard form={form} />

              <AttributesSection form={form} />
            </div>

            {/* Right Column - Settings & Metadata (1/3 width on large screens) */}
            <div className="space-y-3">
              {/* Status */}
              <StatusCard
                form={form}
                isEdit={isEdit}
                storefrontUrl={
                  isEdit && form.watch("slug")
                    ? getStorefrontPath(`/products/${form.watch("slug")}`)
                    : undefined
                }
              />

              {/* Organization */}
              <OrganizationCard
                form={form}
                categories={categories}
                isEdit={isEdit}
              />

              <SeoSection
                form={form}
                variants={variants}
                variantState={isEdit ? "loaded" : "unavailable"}
                storefrontUrl={storefrontUrl}
                defaultOpen={false}
              />
            </div>
          </div>

          <div id="product-options" className="mt-3">
            {optionManager ? (
              <div
                onKeyDownCapture={(event) => {
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
                {typeof optionManager === "function"
                  ? optionManager({
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
                    })
                  : optionManager}
              </div>
            ) : (
              <div className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                Customer options are unavailable for this product.
              </div>
            )}
          </div>

          <AlertDialog open={showAlert} onOpenChange={setShowAlert}>
            <AlertDialogContent aria-describedby="alert-description">
              <AlertDialogHeader>
                <AlertDialogTitle>Validation Error</AlertDialogTitle>
                <AlertDialogDescription id="alert-description">
                  {alertMessage || "Please check the form for errors."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction>OK</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog
            open={mediaRemovalConflict !== null}
            onOpenChange={(open) => { if (!open) cancelMediaRemoval(); }}
          >
            <AlertDialogContent aria-describedby="sku-media-removal-description">
              <AlertDialogHeader>
                <AlertDialogTitle>Remove SKU images?</AlertDialogTitle>
                <AlertDialogDescription id="sku-media-removal-description">
                  {mediaRemovalConflict?.affectedCount ?? 0} active {mediaRemovalConflict?.affectedCount === 1 ? "SKU uses" : "SKUs use"} media being removed. Confirming clears only those exact assignments; each SKU will use its automatic product image.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {mediaRemovalConflict?.affectedSkus.length ? (
                <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/20 p-2 text-xs">
                  {mediaRemovalConflict.affectedSkus.map((sku) => (
                    <li key={sku.id} className="flex items-center justify-between gap-3">
                      <span className="truncate font-medium">{sku.sku}</span>
                      <span className="shrink-0 text-muted-foreground">Automatic product image</span>
                    </li>
                  ))}
                  {mediaRemovalConflict.affectedCount > mediaRemovalConflict.affectedSkus.length ? (
                    <li className="text-muted-foreground">+{mediaRemovalConflict.affectedCount - mediaRemovalConflict.affectedSkus.length} more</li>
                  ) : null}
                </ul>
              ) : null}
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelMediaRemoval}>Keep media</AlertDialogCancel>
                <AlertDialogAction
                  disabled={isSubmitting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={(event) => {
                    event.preventDefault();
                    void confirmMediaRemoval();
                  }}
                >
                  {isSubmitting ? "Removing…" : "Remove media"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </form>
      </Form>
      <ProductActionBar
        isEdit={isEdit}
        isSubmitting={isSaving}
        isDirty={hasUnsavedChanges}
        hasRevisionConflict={revisionConflict !== null}
        onSave={
          revisionConflict
            ? onOpenRevisionConflict
            : form.formState.isDirty || !isEdit
              ? () => form.handleSubmit(handleSubmit)()
              : onOptionMatrixSave
        }
      />
    </>
    </ErrorBoundary>
  );
}
