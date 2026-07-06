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
  type ProductFormValues,
  type Category,
} from "./product-form";

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
      slug: "",
      images: [],
      slugEdited: false,
      attributes: [],
      additionalInfo: [],
      ...cleanedDefaultValues,
    },
  });

  // Set up form submission handler
  const { isSubmitting, showAlert, alertMessage, setShowAlert, handleSubmit } =
    useProductSubmit({
      isEdit,
      productId: defaultValues?.id,
      enableVariantImages,
      variantImageAxis: effectiveVariantImageAxis,
      form,
    });

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
