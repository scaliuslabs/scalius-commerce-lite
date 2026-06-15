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
  const { getStorefrontPath } = useStorefrontUrl();

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

  // Fetch variants and extract unique colors (React Query auto-refetches on invalidation)
  const { uniqueColorOptions } = useProductVariants({
    productId: defaultValues?.id,
    isEdit,
  });

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
        <form onSubmit={form.handleSubmit(handleSubmit)} className="-mt-4 pb-6">
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
                uniqueColorOptions={uniqueColorOptions}
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
              <SeoSection form={form} />

              {/* Attributes */}
              <AttributesSection form={form} />
            </div>
          </div>

          {!isEdit && (
            <div className="mt-4">
              <InfoBanner
                title="Next Steps"
                message="After creating this product, you can add variants (different sizes, colors, or SKUs) and manage inventory on the edit page."
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
