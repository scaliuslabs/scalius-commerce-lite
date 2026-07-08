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
import { registerAdminAssistantSurface } from "./assistant/page-state";
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
  useProductVariants,
  productFormSchema,
  cleanMetaDescription,
  hasVariantImagesEnabled,
  getVariantImagesAxis,
  resolveVariantImageAxis,
  generateSlug,
  DEFAULT_PRODUCT_OPTION_LABELS,
  DEFAULT_PRODUCT_OPTION_SCHEMA,
  DEFAULT_PRODUCT_CONDITION,
  type ProductFormValues,
  type Category,
} from "./product-form";
import {
  buildProductAssistantSurfaceLabel,
  countProductAssistantValidationErrors,
} from "./product-form/assistantSurface";
import type { VariantOptionLabels } from "./product-form/variants/types";

interface ProductFormProps {
  categories: Category[];
  defaultValues?: Partial<
    ProductFormValues & { attributes?: Array<{ attributeId: string; value: string }>; additionalInfo?: Array<{ id: string; title: string; content: string }> }
  >;
  isEdit?: boolean;
}

export function ProductForm({
  categories,
  defaultValues,
  isEdit = false,
}: ProductFormProps) {
  const { storefrontUrl, getStorefrontPath } = useStorefrontUrl();

  // Clean the meta description to avoid showing the marker to users
  const cleanedDefaultValues = React.useMemo(() => {
    if (!defaultValues) return undefined;

    return {
      ...defaultValues,
      metaDescription: cleanMetaDescription(defaultValues.metaDescription),
    };
  }, [defaultValues]);

  // Handle variant specific images independently from form schema
  const [enableVariantImages, setEnableVariantImages] = React.useState(
    hasVariantImagesEnabled(defaultValues?.metaDescription) || false,
  );
  const [variantImageAxis, setVariantImageAxis] = React.useState(
    getVariantImagesAxis(defaultValues?.metaDescription),
  );

  const {
    variants,
    uniqueOptionOneValues,
    uniqueOptionTwoValues,
    isLoading: variantsLoading,
  } = useProductVariants({
    productId: defaultValues?.id,
    isEdit,
  });
  const effectiveVariantImageAxis = React.useMemo(
    () =>
      resolveVariantImageAxis(
        variantImageAxis,
        uniqueOptionOneValues,
        uniqueOptionTwoValues,
      ),
    [uniqueOptionOneValues, uniqueOptionTwoValues, variantImageAxis],
  );

  React.useEffect(() => {
    if (effectiveVariantImageAxis !== variantImageAxis) {
      setVariantImageAxis(effectiveVariantImageAxis);
    }
  }, [effectiveVariantImageAxis, variantImageAxis]);

  // Initialize form
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: {
      name: "",
      description: null,
      price: 0,
      categoryId: "",
      isActive: true,
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
      slug: "",
      images: [],
      slugEdited: false,
      attributes: [],
      additionalInfo: [],
      ...cleanedDefaultValues,
    },
  });

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
      form,
    });

  // Assistant context is allowlisted product drafting state only; never widen to raw form values.
  const assistantSurfaceId = isEdit
    ? "product-edit-form"
    : "product-create-form";
  const assistantName = form.watch("name");
  const assistantDescription = form.watch("description");
  const assistantSlug = form.watch("slug");
  const assistantCanonicalPath = form.watch("canonicalPath");
  const assistantIsActive = form.watch("isActive");
  const assistantNoIndex = form.watch("noIndex");
  const assistantExcludeFromSitemap = form.watch("excludeFromSitemap");
  const assistantExcludeFromProductFeed = form.watch("excludeFromProductFeed");
  const assistantValidationErrorCount = countProductAssistantValidationErrors(
    form.formState.errors,
  );
  const assistantSurfaceLabel = React.useMemo(
    () =>
      buildProductAssistantSurfaceLabel({
        mode: isEdit ? "edit" : "create",
        name: assistantName,
        description: assistantDescription,
        isActive: assistantIsActive,
        slug: assistantSlug,
        canonicalPath: assistantCanonicalPath,
        noIndex: assistantNoIndex,
        excludeFromSitemap: assistantExcludeFromSitemap,
        excludeFromProductFeed: assistantExcludeFromProductFeed,
      }),
    [
      assistantCanonicalPath,
      assistantDescription,
      assistantExcludeFromProductFeed,
      assistantExcludeFromSitemap,
      assistantIsActive,
      assistantName,
      assistantNoIndex,
      assistantSlug,
      isEdit,
    ],
  );
  const assistantSurfaceHandleRef = React.useRef<ReturnType<
    typeof registerAdminAssistantSurface
  > | null>(null);

  React.useEffect(() => {
    const handle = registerAdminAssistantSurface({
      id: assistantSurfaceId,
      kind: "form",
    });
    assistantSurfaceHandleRef.current = handle;

    return () => {
      handle.unregister();
      if (assistantSurfaceHandleRef.current === handle) {
        assistantSurfaceHandleRef.current = null;
      }
    };
  }, [assistantSurfaceId]);

  React.useEffect(() => {
    assistantSurfaceHandleRef.current?.update({
      id: assistantSurfaceId,
      label: assistantSurfaceLabel,
      dirty: form.formState.isDirty,
      submitting: isSubmitting,
      validationErrorCount: assistantValidationErrorCount,
    });
  }, [
    assistantSurfaceId,
    assistantSurfaceLabel,
    assistantValidationErrorCount,
    form.formState.isDirty,
    isSubmitting,
  ]);

  // Auto-generate slug from name - ONLY for new products
  React.useEffect(() => {
    if (!isEdit) {
      const subscription = form.watch((value, { name }) => {
        if (name === "name" && value.name && !form.getValues("slugEdited")) {
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
                  isEdit ? (variantsLoading ? "loading" : "loaded") : "unavailable"
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
        onSave={() => form.handleSubmit(handleSubmit)()}
      />
    </>
    </ErrorBoundary>
  );
}
