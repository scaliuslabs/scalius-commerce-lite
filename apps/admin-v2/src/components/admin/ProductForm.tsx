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
  OptionDiscoverySection,
  AttributesSection,
  PricingCard,
  StatusCard,
  OrganizationCard,
  InfoBanner,
  useProductSubmit,
  extractUniqueVariantOptionValues,
  productFormSchema,
  cleanMetaDescription,
  hasVariantImagesEnabled,
  getVariantImagesAxis,
  resolveVariantImageAxis,
  reconcileVariantImageMappings,
  generateSlug,
  DEFAULT_PRODUCT_OPTION_LABELS,
  DEFAULT_PRODUCT_OPTION_SCHEMA,
  DEFAULT_PRODUCT_CONDITION,
  type ProductFormValues,
  type ProductVariantImageMappingFormValue,
  type Category,
} from "./product-form";
import type {
  ProductVariant as EditorProductVariant,
  VariantOptionLabels,
} from "./product-form/variants/types";
import type { ProductRevisionConflict } from "@/lib/admin-api-error";

interface ProductFormProps {
  categories: Category[];
  defaultValues?: Partial<
    ProductFormValues & { attributes?: Array<{ attributeId: string; value: string }>; additionalInfo?: Array<{ id: string; title: string; content: string }> }
  >;
  isEdit?: boolean;
  aggregateRevision?: number;
  editorVariants?: EditorProductVariant[];
  revisionConflict?: ProductRevisionConflict | null;
  onAggregateRevisionChange?: (revision: number) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
  onOpenRevisionConflict?: () => void;
  onProductSaved?: (values: ProductFormValues, aggregateRevision: number) => void;
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
}: ProductFormProps) {
  const { storefrontUrl, getStorefrontPath } = useStorefrontUrl();

  // Clean the meta description to avoid showing the marker to users
  const cleanedDefaultValues = React.useMemo(() => {
    if (!defaultValues) return undefined;

    const legacyEnabled = hasVariantImagesEnabled(defaultValues.metaDescription);
    return {
      ...defaultValues,
      metaDescription: cleanMetaDescription(defaultValues.metaDescription),
      variantImagesEnabled:
        defaultValues.variantImagesEnabled ?? legacyEnabled,
      variantImageAxis:
        defaultValues.variantImageAxis
        ?? getVariantImagesAxis(defaultValues.metaDescription),
      variantImageMappings: defaultValues.variantImageMappings ?? [],
    };
  }, [defaultValues]);

  const variants = editorVariants;
  const uniqueOptionOneValues = React.useMemo(
    () => extractUniqueVariantOptionValues(variants, "option1"),
    [variants],
  );
  const uniqueOptionTwoValues = React.useMemo(
    () => extractUniqueVariantOptionValues(variants, "option2"),
    [variants],
  );
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
      variantOption1Label: DEFAULT_PRODUCT_OPTION_LABELS.option1,
      variantOption2Label: DEFAULT_PRODUCT_OPTION_LABELS.option2,
      variantOption1Schema: DEFAULT_PRODUCT_OPTION_SCHEMA.option1,
      variantOption2Schema: DEFAULT_PRODUCT_OPTION_SCHEMA.option2,
      variantImagesEnabled: false,
      variantImageAxis: "option2",
      variantImageMappings: [],
      slug: "",
      images: [],
      slugEdited: false,
      attributes: [],
      additionalInfo: [],
      ...cleanedDefaultValues,
    },
  });

  const enableVariantImages = form.watch("variantImagesEnabled");
  const variantImageAxis = form.watch("variantImageAxis");
  const variantImageMappings = form.watch("variantImageMappings");
  const images = form.watch("images");
  const effectiveVariantImageAxis = React.useMemo(
    () =>
      resolveVariantImageAxis(
        variantImageAxis,
        uniqueOptionOneValues,
        uniqueOptionTwoValues,
      ),
    [uniqueOptionOneValues, uniqueOptionTwoValues, variantImageAxis],
  );
  const optionValuesForAxis = React.useCallback(
    (axis: "option1" | "option2") =>
      axis === "option1" ? uniqueOptionOneValues : uniqueOptionTwoValues,
    [uniqueOptionOneValues, uniqueOptionTwoValues],
  );
  const activeVariantIds = React.useMemo(
    () => variants.filter((variant) => !variant.deletedAt).map((variant) => variant.id),
    [variants],
  );

  const setVariantImageMappings = React.useCallback((
    next: ProductVariantImageMappingFormValue[],
  ) => {
    form.setValue("variantImageMappings", next, { shouldDirty: true });
  }, [form]);

  const setEnableVariantImages = React.useCallback((enabled: boolean) => {
    form.setValue("variantImagesEnabled", enabled, { shouldDirty: true });
    setVariantImageMappings(enabled
      ? reconcileVariantImageMappings({
          mappings: form.getValues("variantImageMappings"),
          images: form.getValues("images"),
          axis: effectiveVariantImageAxis,
          optionValues: optionValuesForAxis(effectiveVariantImageAxis),
          variantIds: activeVariantIds,
          fillMissing: true,
        })
      : []);
  }, [activeVariantIds, effectiveVariantImageAxis, form, optionValuesForAxis, setVariantImageMappings]);

  const setVariantImageAxis = React.useCallback((axis: "option1" | "option2") => {
    form.setValue("variantImageAxis", axis, { shouldDirty: true });
    setVariantImageMappings(reconcileVariantImageMappings({
      mappings: form.getValues("variantImageMappings").filter((mapping) => mapping.variantId),
      images: form.getValues("images"),
      axis,
      optionValues: optionValuesForAxis(axis),
      variantIds: activeVariantIds,
      fillMissing: true,
    }));
  }, [activeVariantIds, form, optionValuesForAxis, setVariantImageMappings]);

  React.useEffect(() => {
    if (effectiveVariantImageAxis !== variantImageAxis) {
      setVariantImageAxis(effectiveVariantImageAxis);
      return;
    }
    const next = reconcileVariantImageMappings({
      mappings: form.getValues("variantImageMappings"),
      images,
      axis: effectiveVariantImageAxis,
      optionValues: optionValuesForAxis(effectiveVariantImageAxis),
      variantIds: activeVariantIds,
      fillMissing: false,
    });
    if (JSON.stringify(next) !== JSON.stringify(form.getValues("variantImageMappings"))) {
      setVariantImageMappings(next);
    }
  }, [activeVariantIds, effectiveVariantImageAxis, form, images, optionValuesForAxis, setVariantImageAxis, setVariantImageMappings, variantImageAxis]);

  const variantOption1Label = form.watch("variantOption1Label");
  const variantOption2Label = form.watch("variantOption2Label");
  const variantOptionLabels = React.useMemo<VariantOptionLabels>(
    () => ({
      option1:
        variantOption1Label?.trim() || DEFAULT_PRODUCT_OPTION_LABELS.option1,
      option2:
        variantOption2Label?.trim() || DEFAULT_PRODUCT_OPTION_LABELS.option2,
    }),
    [variantOption1Label, variantOption2Label],
  );

  // Set up form submission handler
  const { isSubmitting, showAlert, alertMessage, setShowAlert, handleSubmit } =
    useProductSubmit({
      isEdit,
      productId: defaultValues?.id,
      enableVariantImages,
      variantImageAxis: effectiveVariantImageAxis,
      variantImageMappings,
      form,
      aggregateRevision,
      revisionConflict,
      onAggregateRevisionChange,
      onRevisionConflict,
      onOpenRevisionConflict,
      onProductSaved,
    });

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
        isDirty={form.formState.isDirty}
        isSubmitting={isSubmitting}
      />
      <Form {...form}>
        <form
          method="post"
          onSubmit={form.handleSubmit(handleSubmit)}
          className="-mt-4 pb-6"
          noValidate
        >
          <div className="mb-4">
            <h1
              id="product-form-heading"
              tabIndex={-1}
              className="text-xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {isEdit ? "Edit Product" : "Create Product"}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {isEdit
                ? "Update catalog details, merchandising, and discovery settings."
                : "Start as a draft, then publish after pricing, media, and SKU readiness are confirmed."}
            </p>
          </div>
          {/* Two-Column Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
            {/* Left Column - Main Content (2/3 width on large screens) */}
            <div className="lg:col-span-2 space-y-4">
              {/* Title & Description */}
              <TitleDescriptionSection form={form} />

              {/* Product Images */}
              <ProductImagesSection
                form={form}
                enableVariantImages={enableVariantImages}
                setEnableVariantImages={setEnableVariantImages}
                variantImageAxis={effectiveVariantImageAxis}
                setVariantImageAxis={setVariantImageAxis}
                uniqueOptionOneValues={uniqueOptionOneValues}
                uniqueOptionTwoValues={uniqueOptionTwoValues}
                optionLabels={variantOptionLabels}
                variantImageMappings={variantImageMappings}
                setVariantImageMappings={setVariantImageMappings}
                activeVariantIds={activeVariantIds}
              />
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

              {/* Pricing */}
              <PricingCard form={form} />

              {/* SEO */}
              <SeoSection
                form={form}
                variants={variants}
                variantState={
                  isEdit ? "loaded" : "unavailable"
                }
                storefrontUrl={storefrontUrl}
              />

              {/* Catalog option mapping */}
              <OptionDiscoverySection form={form} />

              {/* Attributes */}
              <AttributesSection form={form} />
            </div>
          </div>

          {!isEdit && (
            <div className="mt-4">
              <InfoBanner
                title="Next Steps"
                message="After creating this product, manage its product SKU or add customer options from the edit page."
              />
            </div>
          )}

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
        </form>
      </Form>
      <ProductActionBar
        isEdit={isEdit}
        isSubmitting={isSubmitting}
        isDirty={form.formState.isDirty}
        hasRevisionConflict={revisionConflict !== null}
        onSave={
          revisionConflict
            ? onOpenRevisionConflict
            : () => form.handleSubmit(handleSubmit)()
        }
      />
    </>
    </ErrorBoundary>
  );
}
